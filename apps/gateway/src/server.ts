import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProviderError, type ChatRequest } from '@modelforge/shared-types';
import { JsonStore, ModelForgeService, nowIso, newId } from '@modelforge/core';
import { ProviderRegistry } from '@modelforge/provider-adapters';
import { CredentialVault, assertSafeUpstreamUrl, safeEqual } from '@modelforge/security';
import { Logger, MetricsRegistry, newCorrelationId } from '@modelforge/observability';
import { loadConfig, type AppConfig } from '@modelforge/config';

/**
 * ModelForge gateway + admin API (single Fastify process for standalone use;
 * the /v1 surface can be split out behind the same service layer).
 *
 *  /v1/*   OpenAI-compatible gateway (models, chat/completions — incl. SSE)
 *  /api/*  Admin API consumed by the dashboard
 *  /health, /metrics (Prometheus)
 *
 * Security defaults: binds to loopback, admin/gateway keys optional locally
 * but enforced when configured, request body capped, upstream URLs pass the
 * SSRF guard, secrets never leave the vault (only masked hints are served).
 */

const ChatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(z.unknown())]),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
  })).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.boolean().optional(),
  tools: z.array(z.unknown()).optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
});

const ConnectionSchema = z.object({
  providerId: z.string().min(1),
  label: z.string().min(1).max(120),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
});

const ModelSchema = z.object({
  connectionId: z.string().min(1),
  providerModelId: z.string().min(1),
  displayName: z.string().optional(),
  alias: z.string().max(120).optional(),
  capabilities: z.array(z.string()).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  pricing: z.object({
    inputPerMillion: z.number().nonnegative().optional(),
    outputPerMillion: z.number().nonnegative().optional(),
    currency: z.literal('USD'),
    source: z.enum(['provider', 'configured', 'estimated']),
  }).optional(),
});

export interface GatewayHandle {
  app: FastifyInstance;
  service: ModelForgeService;
  store: JsonStore;
  config: AppConfig;
}

export async function buildGateway(overrides: Partial<AppConfig> & { fetchFn?: typeof fetch } = {}): Promise<GatewayHandle> {
  const config = { ...loadConfig(), ...overrides };
  const logger = new Logger(config.logLevel);
  const metrics = new MetricsRegistry();
  const store = new JsonStore(config.dataDir);
  const vault = new CredentialVault(config.dataDir, config.masterKey);
  const registry = new ProviderRegistry();
  const service = new ModelForgeService({ store, vault, registry, fetchFn: overrides.fetchFn });

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  app.addHook('onRequest', async (req, reply) => {
    (req as FastifyRequest & { correlationId: string }).correlationId = newCorrelationId();
    reply.header('x-correlation-id', (req as FastifyRequest & { correlationId: string }).correlationId);
  });

  const requireKey = (expected: string | undefined) => async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    if (!expected) return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] as string | undefined) ?? '';
    if (!safeEqual(token, expected)) {
      await reply.code(401).send({ error: { message: 'Unauthorized', type: 'auth_error' } });
    }
  };

  app.setErrorHandler(async (err, req, reply) => {
    const correlationId = (req as FastifyRequest & { correlationId?: string }).correlationId;
    if (err instanceof ProviderError) {
      const status = err.status ?? statusForCode(err.code);
      logger.warn('provider error', { correlationId, code: err.code, status });
      return reply.code(status).send({ error: { message: err.message, type: err.code, code: err.code } });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: { message: err.message, type: 'invalid_request' } });
    }
    logger.error('unhandled error', { correlationId, error: err instanceof Error ? err.message : String(err) });
    return reply.code(500).send({ error: { message: 'Internal server error', type: 'internal' } });
  });

  // ------------------------------------------------------------- health/metrics
  app.get('/health', async () => ({ status: 'ok', version: '0.1.0', ts: nowIso() }));
  app.get('/metrics', async (_req, reply) => reply.type('text/plain').send(metrics.toPrometheus()));

  // ------------------------------------------------------------- OpenAI-compatible gateway
  const v1 = { preHandler: requireKey(config.gatewayApiKey) };

  app.get('/v1/models', v1, async () => ({
    object: 'list',
    data: store.listModels().filter((m) => m.enabled).map((m) => ({
      id: m.alias ?? m.id,
      object: 'model',
      created: Math.floor(new Date(m.createdAt).getTime() / 1000),
      owned_by: m.providerId,
    })),
  }));

  app.post('/v1/chat/completions', v1, async (req, reply) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { message: parsed.error.issues.map((i) => i.message).join('; '), type: 'invalid_request' } });
    }
    const body = parsed.data as unknown as ChatRequest & { stream?: boolean };
    const correlationId = (req as FastifyRequest & { correlationId: string }).correlationId;
    const started = Date.now();
    metrics.inc('modelforge_requests_total', { model: body.model });

    if (body.stream) {
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-correlation-id': correlationId,
      });
      let firstTokenAt: number | undefined;
      try {
        for await (const chunk of service.router.chatStream(body.model, body)) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          reply.raw.write(`data: ${JSON.stringify(toOpenAiChunk(chunk, body.model))}\n\n`);
        }
        reply.raw.write('data: [DONE]\n\n');
        metrics.observeLatency('modelforge_request_latency', { model: body.model }, Date.now() - started);
        void firstTokenAt;
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError('Stream failed', { code: 'UPSTREAM_ERROR' });
        reply.raw.write(`data: ${JSON.stringify({ error: { message: pe.message, type: pe.code } })}\n\n`);
        metrics.inc('modelforge_errors_total', { model: body.model, code: pe.code });
      } finally {
        reply.raw.end();
      }
      return reply;
    }

    const result = await service.router.chat(body.model, body);
    metrics.observeLatency('modelforge_request_latency', { model: body.model }, result.latencyMs);
    const r = result.response;
    return {
      id: r.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: r.content, ...(r.toolCalls ? { tool_calls: r.toolCalls } : {}) },
        finish_reason: r.finishReason ?? 'stop',
      }],
      usage: {
        prompt_tokens: r.usage.promptTokens ?? 0,
        completion_tokens: r.usage.completionTokens ?? 0,
        total_tokens: r.usage.totalTokens ?? (r.usage.promptTokens ?? 0) + (r.usage.completionTokens ?? 0),
      },
      // ModelForge extensions (ignored by strict OpenAI clients):
      modelforge: {
        correlationId,
        routedModel: result.target.model.id,
        provider: result.target.model.providerId,
        attempts: result.attempts,
        usageEstimated: r.usage.estimated,
      },
    };
  });

  // ------------------------------------------------------------- admin API
  const api = { preHandler: requireKey(config.adminApiKey) };

  app.get('/api/providers', api, async () => registry.listDefinitions());
  app.get('/api/connections', api, async () => store.listConnections());
  app.post('/api/connections', api, async (req, reply) => {
    const parsed = ConnectionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    if (parsed.data.baseUrl) {
      await assertSafeUpstreamUrl(parsed.data.baseUrl, { allowPrivate: config.allowPrivateUpstreams });
    }
    const conn = service.createConnection(parsed.data);
    logger.info('connection created', { connectionId: conn.id, providerId: conn.providerId });
    return reply.code(201).send(conn);
  });
  app.patch('/api/connections/:id', api, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.baseUrl === 'string') {
      await assertSafeUpstreamUrl(body.baseUrl, { allowPrivate: config.allowPrivateUpstreams });
    }
    try {
      return service.updateConnection(id, body as never);
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : 'Not found' });
    }
  });
  app.delete('/api/connections/:id', api, async (req, reply) => {
    service.deleteConnection((req.params as { id: string }).id);
    return reply.code(204).send();
  });
  app.post('/api/connections/:id/discover', api, async (req) => {
    const { id } = req.params as { id: string };
    return service.discoverModels(id);
  });
  app.post('/api/connections/:id/diagnose', api, async (req) => {
    const { id } = req.params as { id: string };
    const conn = store.getConnection(id);
    if (!conn) throw new ProviderError(`Connection ${id} not found`, { code: 'MODEL_NOT_FOUND', status: 404 });
    const body = (req.body ?? {}) as { modelId?: string; testGeneration?: boolean; testStreaming?: boolean; testTools?: boolean };
    return service.diagnostics.run(conn, body);
  });

  app.get('/api/models', api, async (req) => {
    const q = req.query as { providerId?: string; connectionId?: string; search?: string; capability?: string };
    return store.listModels().filter((m) =>
      (!q.providerId || m.providerId === q.providerId) &&
      (!q.connectionId || m.connectionId === q.connectionId) &&
      (!q.capability || m.capabilities.includes(q.capability as never)) &&
      (!q.search || `${m.displayName} ${m.providerModelId} ${m.alias ?? ''}`.toLowerCase().includes(q.search.toLowerCase())));
  });
  app.post('/api/models', api, async (req, reply) => {
    const parsed = ModelSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    const d = parsed.data;
    const conn = store.getConnection(d.connectionId);
    if (!conn) return reply.code(404).send({ error: 'Connection not found' });
    const model = {
      id: `${d.connectionId}:${d.providerModelId}`,
      connectionId: d.connectionId,
      providerId: conn.providerId,
      providerModelId: d.providerModelId,
      displayName: d.displayName ?? d.providerModelId,
      alias: d.alias,
      enabled: true,
      source: 'manual' as const,
      capabilities: (d.capabilities ?? []) as never,
      contextWindow: d.contextWindow,
      maxOutputTokens: d.maxOutputTokens,
      pricing: d.pricing,
      availability: 'unknown' as const,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    return reply.code(201).send(store.upsertModel(model));
  });
  app.patch('/api/models/:id', api, async (req, reply) => {
    const model = store.getModel(decodeURIComponent((req.params as { id: string }).id));
    if (!model) return reply.code(404).send({ error: 'Model not found' });
    return store.upsertModel({ ...model, ...(req.body as object), updatedAt: nowIso() });
  });
  app.delete('/api/models/:id', api, async (req, reply) => {
    store.deleteModel(decodeURIComponent((req.params as { id: string }).id));
    return reply.code(204).send();
  });
  app.post('/api/models/:id/duplicate', api, async (req, reply) => {
    const model = store.getModel(decodeURIComponent((req.params as { id: string }).id));
    if (!model) return reply.code(404).send({ error: 'Model not found' });
    const copy = {
      ...model,
      id: `${model.id}-copy-${newId('')}`,
      providerModelId: `${model.providerModelId}-copy`,
      displayName: `${model.displayName} (copy)`,
      alias: undefined,
      source: 'manual' as const,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    return reply.code(201).send(store.upsertModel(copy));
  });

  app.get('/api/chains', api, async () => store.listFallbackChains());
  app.post('/api/chains', api, async (req, reply) => {
    const body = req.body as { name: string; targets: string[] };
    if (!body?.name || !Array.isArray(body.targets)) return reply.code(400).send({ error: 'name and targets[] required' });
    return reply.code(201).send(store.upsertFallbackChain({ id: newId('chain'), name: body.name, targets: body.targets, enabled: true }));
  });
  app.delete('/api/chains/:id', api, async (req, reply) => {
    store.deleteFallbackChain((req.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get('/api/policies', api, async () => store.listRoutingPolicies());
  app.post('/api/policies', api, async (req, reply) => {
    const body = req.body as { name: string; strategy: never; candidates: string[]; capability?: never; fallbackChainId?: string };
    if (!body?.name || !Array.isArray(body.candidates)) return reply.code(400).send({ error: 'name and candidates[] required' });
    return reply.code(201).send(store.upsertRoutingPolicy({
      id: newId('policy'), name: body.name, strategy: body.strategy ?? 'explicit',
      candidates: body.candidates, capability: body.capability, fallbackChainId: body.fallbackChainId, enabled: true,
    }));
  });
  app.delete('/api/policies/:id', api, async (req, reply) => {
    store.deleteRoutingPolicy((req.params as { id: string }).id);
    return reply.code(204).send();
  });

  app.get('/api/servers', api, async () => store.listServers());
  app.post('/api/servers', api, async (req, reply) => {
    const body = req.body as { label: string; kind: never; baseUrl: string; host?: string };
    if (!body?.label || !body?.baseUrl) return reply.code(400).send({ error: 'label and baseUrl required' });
    await assertSafeUpstreamUrl(body.baseUrl, { allowPrivate: config.allowPrivateUpstreams });
    return reply.code(201).send(store.upsertServer({
      id: newId('srv'), label: body.label, kind: body.kind ?? 'custom', baseUrl: body.baseUrl,
      host: body.host ?? new URL(body.baseUrl).hostname, enabled: true, lastHealth: 'unknown',
    }));
  });
  app.delete('/api/servers/:id', api, async (req, reply) => {
    store.deleteServer((req.params as { id: string }).id);
    return reply.code(204).send();
  });
  app.post('/api/servers/:id/health', api, async (req) => {
    const server = store.listServers().find((s) => s.id === (req.params as { id: string }).id);
    if (!server) throw new ProviderError('Server not found', { code: 'MODEL_NOT_FOUND', status: 404 });
    const started = Date.now();
    try {
      const res = await fetch(`${server.baseUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(5000) });
      const updated = { ...server, lastHealth: res.ok ? 'healthy' as const : 'down' as const };
      store.upsertServer(updated);
      return { server: updated, latencyMs: Date.now() - started, httpStatus: res.status };
    } catch (err) {
      const updated = { ...server, lastHealth: 'down' as const };
      store.upsertServer(updated);
      return { server: updated, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : 'unreachable' };
    }
  });

  app.get('/api/usage', api, async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 200), 1000);
    return store.listUsage(limit);
  });
  app.get('/api/analytics/summary', api, async () => {
    const usage = store.listUsage(5000);
    const totalRequests = usage.length;
    const errors = usage.filter((u) => u.status === 'error').length;
    const promptTokens = usage.reduce((n, u) => n + u.promptTokens, 0);
    const completionTokens = usage.reduce((n, u) => n + u.completionTokens, 0);
    const costs = usage.map((u) => u.estimatedCostUsd).filter((c): c is number => c !== undefined);
    const latencies = usage.map((u) => u.latencyMs);
    return {
      totalRequests,
      errorRate: totalRequests ? errors / totalRequests : 0,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : undefined,
      costRecords: costs.length,
      avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    };
  });

  app.get('/api/health/connections', api, async () => store.listConnections().map((conn) => {
    const circuit = service.router.breaker.get(conn.id);
    return {
      connectionId: conn.id,
      providerId: conn.providerId,
      label: conn.label,
      state: !conn.enabled ? 'unknown' : circuit.state === 'open' ? 'down' : circuit.failures > 0 ? 'degraded' : 'healthy',
      latencyMs: circuit.lastLatencyMs,
      checkedAt: nowIso(),
      circuit: circuit.state,
    };
  }));

  app.get('/api/config/export', api, async () => {
    // Secrets are never exported — only vault presence flags travel.
    return { exportedAt: nowIso(), includesSecrets: false, config: store.exportConfig() };
  });
  app.post('/api/config/import', api, async (req, reply) => {
    const body = req.body as { config?: unknown };
    if (!body?.config || typeof body.config !== 'object') return reply.code(400).send({ error: 'config object required' });
    store.importConfig(body.config as never);
    return { ok: true };
  });

  app.get('/api/gpus', api, async () => {
    const { detectGpus, detectCudaVersion } = await import('@modelforge/core');
    const gpus = await detectGpus();
    return { gpus, cudaVersion: await detectCudaVersion(), detected: gpus.length > 0 };
  });

  app.get('/api/antigravity/status', api, async () => {
    const { detectAntigravity } = await import('@modelforge/antigravity');
    return detectAntigravity({ gatewayUrl: `http://${config.host}:${config.port}/v1` });
  });

  // ------------------------------------------------------------- dashboard static files
  const dashboardDist = join(process.cwd(), 'apps/dashboard/dist');
  if (existsSync(dashboardDist)) {
    const fastifyStatic = (await import('@fastify/static')).default;
    await app.register(fastifyStatic, { root: dashboardDist, prefix: '/ui/' });
    app.get('/ui', async (_req, reply) => reply.redirect('/ui/'));
  }

  logger.info('ModelForge gateway ready', { host: config.host, port: config.port, dataDir: config.dataDir });
  return { app, service, store, config };
}

function statusForCode(code: string): number {
  switch (code) {
    case 'AUTH_FAILED': return 401;
    case 'MODEL_NOT_FOUND': return 404;
    case 'MODEL_ACCESS_DENIED': return 403;
    case 'RATE_LIMITED': case 'QUOTA_EXCEEDED': return 429;
    case 'TIMEOUT': return 504;
    case 'CIRCUIT_OPEN': return 503;
    case 'INVALID_REQUEST': return 400;
    default: return 502;
  }
}

function toOpenAiChunk(chunk: { id: string; model: string; delta: string; finishReason?: string; usage?: unknown }, requestedModel: string) {
  return {
    id: chunk.id || `chatcmpl-${randomUUID().slice(0, 8)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: chunk.finishReason ?? null }],
    ...(chunk.usage ? { usage: chunk.usage } : {}),
  };
}
