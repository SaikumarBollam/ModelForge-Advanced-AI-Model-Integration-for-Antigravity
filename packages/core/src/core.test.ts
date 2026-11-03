import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonStore } from './store.js';
import { CredentialVault } from '@modelforge/security';
import { ProviderRegistry } from '@modelforge/provider-adapters';
import { ModelForgeService } from './service.js';
import { CircuitBreaker, withRetries } from './resilience.js';
import { ProviderError } from '@modelforge/shared-types';

function makeService(fetchFn: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'mf-core-'));
  const store = new JsonStore(dir);
  const vault = new CredentialVault(dir, 'test-master-key-0123456789abcdef');
  const registry = new ProviderRegistry();
  const service = new ModelForgeService({ store, vault, registry, fetchFn });
  return { store, vault, registry, service, dir };
}

function chatFetch(failStatus = 0) {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (failStatus) {
      return new Response(JSON.stringify({ error: { message: 'upstream boom' } }), { status: failStatus });
    }
    if (u.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'test-model-1' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      id: 'c1', model: 'test-model-1',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }), { status: 200 });
  }) as typeof fetch;
}

describe('ModelForgeService + RoutingEngine', () => {
  it('creates a connection, discovers models, and routes a chat by alias', async () => {
    const { service, store } = makeService(chatFetch());
    const conn = service.createConnection({ providerId: 'openai', label: 'Test', apiKey: 'sk-test-1234567890' });
    expect(conn.hasCredential).toBe(true);
    expect(conn.credentialHint).toBe('sk-…7890');
    // Store must never contain the plaintext key.
    expect(JSON.stringify(store.listConnections())).not.toContain('sk-test-1234567890');

    const { discovered } = await service.discoverModels(conn.id);
    expect(discovered).toBe(1);
    const model = store.listModels()[0]!;
    store.upsertModel({ ...model, alias: 'fast' });

    const result = await service.router.chat('fast', { model: 'fast', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.response.content).toBe('ok');
    expect(store.listUsage()).toHaveLength(1);
    expect(store.listUsage()[0]).toMatchObject({ status: 'success', promptTokens: 5 });
  });

  it('falls back to the next target when the first returns a retryable 502', async () => {
    let calls = 0;
    const flaky = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
      calls++;
      if (u.includes('bad')) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 502 });
      return new Response(JSON.stringify({
        id: 'c', model: 'm', choices: [{ message: { content: 'from-good' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200 });
    }) as typeof fetch;
    const { service, store } = makeService(flaky);
    const bad = service.createConnection({ providerId: 'openai', label: 'Bad', baseUrl: 'https://bad.example.com/v1', apiKey: 'sk-bad-12345678' });
    const good = service.createConnection({ providerId: 'openai', label: 'Good', baseUrl: 'https://good.example.com/v1', apiKey: 'sk-good-12345678' });
    await service.discoverModels(bad.id);
    await service.discoverModels(good.id);
    store.upsertFallbackChain({ id: 'chain1', name: 'Main', targets: [`${bad.id}:m`, `${good.id}:m`], enabled: true });
    const result = await service.router.chat('chain:chain1', { model: 'chain:chain1', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.response.content).toBe('from-good');
    expect(result.attempts.length).toBeGreaterThanOrEqual(2);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('CircuitBreaker', () => {
  it('opens after threshold failures and reports state', () => {
    const breaker = new CircuitBreaker(3, 60_000);
    expect(breaker.isAvailable('c1')).toBe(true);
    breaker.recordFailure('c1');
    breaker.recordFailure('c1');
    expect(breaker.isAvailable('c1')).toBe(true);
    breaker.recordFailure('c1');
    expect(breaker.isAvailable('c1')).toBe(false);
    breaker.recordSuccess('c1', 42);
    expect(breaker.isAvailable('c1')).toBe(true);
    expect(breaker.get('c1').lastLatencyMs).toBe(42);
  });
});

describe('withRetries', () => {
  it('retries retryable errors and gives up on non-retryable ones', async () => {
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts < 3) throw new ProviderError('boom', { code: 'UPSTREAM_ERROR', retryable: true });
      return 'done';
    };
    await expect(withRetries(flaky, { maxRetries: 3, baseDelayMs: 1 })).resolves.toBe('done');
    expect(attempts).toBe(3);
    await expect(withRetries(async () => {
      throw new ProviderError('bad request', { code: 'INVALID_REQUEST' });
    }, { maxRetries: 3, baseDelayMs: 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});
