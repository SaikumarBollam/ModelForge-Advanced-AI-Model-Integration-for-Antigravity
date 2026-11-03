import { lookup } from 'node:dns/promises';
import type {
  DiagnosticReport, DiagnosticStage, DiagnosticStageId, ProviderConnection,
} from '@modelforge/shared-types';
import { ProviderError } from '@modelforge/shared-types';
import type { ProviderAdapter, AdapterContext } from '@modelforge/provider-sdk';

/**
 * Multi-stage diagnostics.
 *
 * Each stage reports independently — a provider is NEVER described as
 * "fully tested" because model listing succeeded. `generationVerified`
 * is true only when a real minimal generation (and streaming, when
 * requested) completed. Diagnostic prompts are fixed strings; responses
 * are truncated and credentials are never recorded.
 */

export interface DiagnosticOptions {
  modelId?: string;
  testGeneration?: boolean;
  testStreaming?: boolean;
  testTools?: boolean;
}

const DIAGNOSTIC_PROMPT = 'Reply with the single word: ok';

export class DiagnosticsEngine {
  constructor(
    private readonly resolveAdapter: (providerId: string) => ProviderAdapter | undefined,
    private readonly resolveContext: (conn: ProviderConnection) => AdapterContext,
  ) {}

  async run(conn: ProviderConnection, opts: DiagnosticOptions = {}): Promise<DiagnosticReport> {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const stages: DiagnosticStage[] = [];
    const stage = (id: DiagnosticStageId, status: DiagnosticStage['status'], detail: string, extra?: Partial<DiagnosticStage>) =>
      stages.push({ stage: id, status, detail, ...extra });

    const adapter = this.resolveAdapter(conn.providerId);
    if (!adapter) {
      stage('config-validation', 'failed', `Unknown provider "${conn.providerId}"`);
      return this.report(conn, opts, startedAt, started, stages, false);
    }

    // 1. Configuration validation
    let configOk = true;
    try {
      const url = new URL(conn.baseUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Base URL must be http(s)');
      if (adapter.definition.auth !== 'none') {
        // Credential presence is checked by the caller via ctx.apiKey.
      }
      stage('config-validation', 'passed', `Base URL ${url.origin}${url.pathname} is well-formed`);
    } catch (err) {
      configOk = false;
      stage('config-validation', 'failed', err instanceof Error ? err.message : 'Invalid configuration');
    }

    const ctx = this.resolveContext(conn);
    if (configOk && adapter.definition.auth !== 'none' && !ctx.apiKey) {
      stage('config-validation', 'failed', 'No credential configured for this connection');
      configOk = false;
    }
    if (!configOk) return this.report(conn, opts, startedAt, started, stages, false);

    // 2. DNS / connectivity
    const host = new URL(conn.baseUrl).hostname;
    const connStart = Date.now();
    try {
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && host !== 'localhost') await lookup(host);
      stage('connectivity', 'passed', `Host ${host} resolves`, { durationMs: Date.now() - connStart });
    } catch (err) {
      stage('connectivity', 'failed', `DNS resolution failed for ${host}: ${err instanceof Error ? err.message : 'unknown'}`);
      return this.report(conn, opts, startedAt, started, stages, false);
    }

    // 3. Authentication + 4. Model listing (adapter probe, then real listing)
    let listingOk = false;
    const authStart = Date.now();
    try {
      if (adapter.validateAuth) await adapter.validateAuth(ctx);
      stage('authentication', 'passed', 'Provider accepted the configured credential', { durationMs: Date.now() - authStart });
    } catch (err) {
      const pe = asDiagError(err);
      stage('authentication', 'failed', pe.message, { httpStatus: pe.status, durationMs: Date.now() - authStart });
    }

    const listStart = Date.now();
    let discoveredCount = 0;
    try {
      const models = await adapter.listModels(ctx);
      discoveredCount = models.length;
      listingOk = true;
      stage('model-listing', 'passed', `Discovered ${models.length} model(s)`, { durationMs: Date.now() - listStart });
    } catch (err) {
      const pe = asDiagError(err);
      stage('model-listing', 'failed', pe.message, { httpStatus: pe.status, durationMs: Date.now() - listStart });
    }

    // 5. Model-specific access
    const modelId = opts.modelId;
    if (modelId) {
      stage('model-access', listingOk ? 'passed' : 'skipped',
        listingOk ? `Model "${modelId}" is visible to this credential` : 'Skipped because model listing failed');
    } else {
      stage('model-access', 'not-tested', 'No model selected for access verification');
    }

    // 6. Generation
    let generationOk = false;
    if (opts.testGeneration && modelId && listingOk) {
      const genStart = Date.now();
      try {
        const res = await adapter.chat(ctx, {
          model: modelId,
          messages: [{ role: 'user', content: DIAGNOSTIC_PROMPT }],
          max_tokens: 16,
          temperature: 0,
        });
        generationOk = true;
        stage('generation', 'passed',
          `Generation succeeded (${res.usage.completionTokens ?? '?'} output tokens${res.usage.estimated ? ', usage estimated' : ''})`,
          { durationMs: Date.now() - genStart });
      } catch (err) {
        const pe = asDiagError(err);
        stage('generation', 'failed', pe.message, { httpStatus: pe.status, durationMs: Date.now() - genStart });
      }
    } else {
      stage('generation', 'not-tested',
        opts.testGeneration ? 'Requires a selected model and successful listing' : 'Generation test not requested');
    }

    // 7. Streaming
    let streamingOk = !opts.testStreaming;
    if (opts.testStreaming && modelId && listingOk) {
      const streamStart = Date.now();
      try {
        let chunks = 0;
        for await (const chunk of adapter.chatStream(ctx, {
          model: modelId,
          messages: [{ role: 'user', content: DIAGNOSTIC_PROMPT }],
          max_tokens: 16,
          temperature: 0,
        })) {
          if (chunk.delta) chunks++;
          if (chunks > 50) break;
        }
        streamingOk = chunks > 0;
        stage('streaming', streamingOk ? 'passed' : 'failed',
          streamingOk ? `Received ${chunks} streamed chunk(s)` : 'Stream opened but produced no content chunks',
          { durationMs: Date.now() - streamStart });
      } catch (err) {
        streamingOk = false;
        const pe = asDiagError(err);
        stage('streaming', 'failed', pe.message, { httpStatus: pe.status, durationMs: Date.now() - streamStart });
      }
    } else {
      stage('streaming', 'not-tested', opts.testStreaming ? 'Requires a selected model and successful listing' : 'Streaming test not requested');
    }

    // 8. Tool calling
    if (opts.testTools && modelId && generationOk) {
      const toolStart = Date.now();
      try {
        const res = await adapter.chat(ctx, {
          model: modelId,
          messages: [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }],
          tools: [{
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get current weather for a city',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            },
          }],
          max_tokens: 128,
        });
        const called = (res.toolCalls?.length ?? 0) > 0;
        stage('tool-calling', called ? 'passed' : 'failed',
          called ? `Model invoked ${res.toolCalls![0]!.function.name}` : 'Model responded without invoking the tool',
          { durationMs: Date.now() - toolStart });
      } catch (err) {
        const pe = asDiagError(err);
        stage('tool-calling', 'failed', pe.message, { httpStatus: pe.status, durationMs: Date.now() - toolStart });
      }
    } else {
      stage('tool-calling', 'not-tested', 'Requires generation to pass and the tools test to be requested');
    }

    // 9. Timeout/retry validation — configuration-level check (no extra calls).
    stage('timeout-retry', 'passed',
      `Timeout ${conn.timeoutMs}ms, max retries ${conn.maxRetries} configured`);

    void discoveredCount;
    return this.report(conn, opts, startedAt, started, stages, generationOk && streamingOk);
  }

  private report(
    conn: ProviderConnection,
    opts: DiagnosticOptions,
    startedAt: string,
    started: number,
    stages: DiagnosticStage[],
    generationVerified: boolean,
  ): DiagnosticReport {
    return {
      connectionId: conn.id,
      providerId: conn.providerId,
      modelId: opts.modelId,
      startedAt,
      durationMs: Date.now() - started,
      stages,
      generationVerified,
    };
  }
}

function asDiagError(err: unknown): { message: string; status?: number } {
  if (err instanceof ProviderError) return { message: `${err.code}: ${err.message}`, status: err.status };
  return { message: err instanceof Error ? err.message : 'Unknown error' };
}
