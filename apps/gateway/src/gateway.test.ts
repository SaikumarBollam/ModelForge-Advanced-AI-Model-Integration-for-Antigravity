import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGateway } from './server.js';

/**
 * End-to-end gateway tests with a fake upstream provider.
 * No real credentials are used; live-provider tests belong in
 * tests/provider-contracts and are gated on env credentials.
 */

function upstreamFetch() {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/models')) {
      return Response.json({ data: [{ id: 'fake-1' }, { id: 'fake-2' }] });
    }
    if (u.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
      if (body.stream) {
        const sse = [
          'data: {"id":"c1","choices":[{"delta":{"content":"Hel"}}]}',
          'data: {"id":"c1","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
          'data: [DONE]',
        ].join('\n\n');
        return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        id: 'c1', model: 'fake-1',
        choices: [{ message: { content: 'Hello from fake upstream' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'mf-gw-'));
  const handle = await buildGateway({ dataDir, fetchFn: upstreamFetch(), masterKey: 'test-master-key-0123456789abcdef' });
  return handle;
}

describe('gateway', () => {
  it('serves health and the provider catalog', async () => {
    const { app } = await setup();
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    const providers = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(providers.statusCode).toBe(200);
    expect((providers.json() as unknown[]).length).toBeGreaterThanOrEqual(20);
    await app.close();
  });

  it('runs the full flow: connect -> discover -> alias -> chat -> stream -> usage', async () => {
    const { app } = await setup();
    const connRes = await app.inject({
      method: 'POST', url: '/api/connections',
      payload: { providerId: 'openai', label: 'Fake', baseUrl: 'https://fake.example.com/v1', apiKey: 'sk-fake-1234567890' },
    });
    expect(connRes.statusCode).toBe(201);
    const conn = connRes.json() as { id: string; credentialHint?: string };
    expect(conn.credentialHint).toBe('sk-…7890');
    expect(connRes.body).not.toContain('sk-fake-1234567890');

    const discover = await app.inject({ method: 'POST', url: `/api/connections/${conn.id}/discover` });
    expect(discover.statusCode).toBe(200);
    expect((discover.json() as { discovered: number }).discovered).toBe(2);

    const models = await app.inject({ method: 'GET', url: '/api/models' });
    const model = (models.json() as Array<{ id: string }>)[0]!;
    await app.inject({ method: 'PATCH', url: `/api/models/${encodeURIComponent(model.id)}`, payload: { alias: 'my-model' } });

    const listed = await app.inject({ method: 'GET', url: '/v1/models' });
    expect((listed.json() as { data: Array<{ id: string }> }).data.map((m) => m.id)).toContain('my-model');

    const chat = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'my-model', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(chat.statusCode).toBe(200);
    const chatJson = chat.json() as { choices: Array<{ message: { content: string } }>; usage: { total_tokens: number } };
    expect(chatJson.choices[0]!.message.content).toBe('Hello from fake upstream');
    expect(chatJson.usage.total_tokens).toBe(7);

    const stream = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'my-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain('Hel');
    expect(stream.body).toContain('[DONE]');

    const usage = await app.inject({ method: 'GET', url: '/api/usage' });
    expect((usage.json() as unknown[]).length).toBeGreaterThanOrEqual(1);

    const summary = await app.inject({ method: 'GET', url: '/api/analytics/summary' });
    expect((summary.json() as { totalRequests: number }).totalRequests).toBeGreaterThanOrEqual(1);
    await app.close();
  });

  it('diagnostics report stages independently and do not claim generation without a model', async () => {
    const { app } = await setup();
    const connRes = await app.inject({
      method: 'POST', url: '/api/connections',
      // localhost is used so the DNS/connectivity stage passes without network;
      // the injected fetchFn intercepts all provider traffic regardless of host.
      payload: { providerId: 'openai', label: 'Fake', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-fake-1234567890' },
    });
    const conn = connRes.json() as { id: string };
    const diag = await app.inject({
      method: 'POST', url: `/api/connections/${conn.id}/diagnose`,
      payload: { testGeneration: true },
    });
    expect(diag.statusCode).toBe(200);
    const report = diag.json() as { stages: Array<{ stage: string; status: string }>; generationVerified: boolean };
    expect(report.stages.find((s) => s.stage === 'model-listing')?.status).toBe('passed');
    expect(report.stages.find((s) => s.stage === 'generation')?.status).toBe('not-tested');
    expect(report.generationVerified).toBe(false);
    await app.close();
  });

  it('rejects invalid chat payloads and unknown models with normalized errors', async () => {
    const { app } = await setup();
    const bad = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'x' } });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST', url: '/v1/chat/completions',
      payload: { model: 'nope', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
