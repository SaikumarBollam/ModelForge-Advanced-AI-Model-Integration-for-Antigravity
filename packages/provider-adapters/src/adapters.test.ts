import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from './catalog.js';
import { OpenAiCompatibleAdapter } from './openai-compatible.js';
import { AnthropicAdapter } from './anthropic.js';
import type { AdapterContext } from '@modelforge/provider-sdk';

/** Build a fake fetch that records requests and returns a canned response. */
function fakeFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(responseBody), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fn, calls };
}

const ctx = (fetchFn: typeof fetch): AdapterContext => ({
  connectionId: 'test', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-1234567890', timeoutMs: 5000, fetchFn,
});

describe('ProviderRegistry', () => {
  it('registers the full catalog with unique ids', () => {
    const registry = new ProviderRegistry();
    const defs = registry.listDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(20);
    expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length);
    for (const id of ['openai', 'anthropic', 'google-gemini', 'ollama', 'groq', 'deepseek', 'vllm', 'lmstudio']) {
      expect(registry.getAdapter(id), id).toBeDefined();
    }
  });
});

describe('OpenAiCompatibleAdapter', () => {
  it('discovers models and sends bearer auth', async () => {
    const { fn, calls } = fakeFetch({ data: [{ id: 'gpt-test' }, { id: 'gpt-test-mini' }] });
    const adapter = new OpenAiCompatibleAdapter(new ProviderRegistry().getDefinition('openai')!);
    const models = await adapter.listModels(ctx(fn));
    expect(models.map((m) => m.providerModelId)).toEqual(['gpt-test', 'gpt-test-mini']);
    expect((calls[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test-1234567890');
  });

  it('completes a chat and maps usage as provider-reported', async () => {
    const { fn } = fakeFetch({
      id: 'chatcmpl-1', model: 'gpt-test',
      choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
    const adapter = new OpenAiCompatibleAdapter(new ProviderRegistry().getDefinition('openai')!);
    const res = await adapter.chat(ctx(fn), { model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('Hello!');
    expect(res.usage).toMatchObject({ promptTokens: 10, completionTokens: 2, estimated: false });
  });

  it('normalizes 401 to AUTH_FAILED and 429 quota to QUOTA_EXCEEDED', async () => {
    const adapter = new OpenAiCompatibleAdapter(new ProviderRegistry().getDefinition('openai')!);
    await expect(adapter.listModels(ctx(fakeFetch({ error: { message: 'bad key' } }, 401).fn)))
      .rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(adapter.listModels(ctx(fakeFetch({ error: { message: 'insufficient quota' } }, 429).fn)))
      .rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });
});

describe('AnthropicAdapter', () => {
  it('translates messages and hoists the system prompt', async () => {
    const { fn, calls } = fakeFetch({
      id: 'msg_1', model: 'claude-test',
      content: [{ type: 'text', text: 'Hi there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    const adapter = new AnthropicAdapter();
    const res = await adapter.chat(ctx(fn), {
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(res.content).toBe('Hi there');
    expect(res.usage.estimated).toBe(false);
    const sent = JSON.parse(String(calls[0]!.init?.body)) as { system?: string; messages: unknown[] };
    expect(sent.system).toBe('Be terse.');
    expect(sent.messages).toHaveLength(1);
    expect((calls[0]!.init?.headers as Record<string, string>)['x-api-key']).toBe('sk-test-1234567890');
  });
});
