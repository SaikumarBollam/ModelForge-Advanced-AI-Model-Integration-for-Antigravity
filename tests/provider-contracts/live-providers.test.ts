/**
 * Provider contract tests.
 *
 * These run ONLY when real credentials are present in the environment
 * (e.g. OPENAI_API_KEY). Without credentials they are skipped — ModelForge
 * never claims live integration success from fixtures.
 *
 * Run: OPENAI_API_KEY=... npx vitest run tests/provider-contracts
 */
import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../packages/provider-adapters/src/index.js';

const LIVE_PROVIDERS: Array<{ providerId: string; envVar: string; modelEnvVar: string }> = [
  { providerId: 'openai', envVar: 'OPENAI_API_KEY', modelEnvVar: 'OPENAI_TEST_MODEL' },
  { providerId: 'anthropic', envVar: 'ANTHROPIC_API_KEY', modelEnvVar: 'ANTHROPIC_TEST_MODEL' },
  { providerId: 'google-gemini', envVar: 'GEMINI_API_KEY', modelEnvVar: 'GEMINI_TEST_MODEL' },
  { providerId: 'groq', envVar: 'GROQ_API_KEY', modelEnvVar: 'GROQ_TEST_MODEL' },
  { providerId: 'deepseek', envVar: 'DEEPSEEK_API_KEY', modelEnvVar: 'DEEPSEEK_TEST_MODEL' },
];

describe('live provider contracts (credential-gated)', () => {
  for (const { providerId, envVar, modelEnvVar } of LIVE_PROVIDERS) {
    const apiKey = process.env[envVar];
    const model = process.env[modelEnvVar];
    const run = apiKey ? it : it.skip;

    run(`${providerId}: lists models`, async () => {
      const registry = new ProviderRegistry();
      const adapter = registry.getAdapter(providerId)!;
      const def = registry.getDefinition(providerId)!;
      const models = await adapter.listModels({
        connectionId: 'live-test', baseUrl: def.defaultBaseUrl, apiKey, timeoutMs: 30_000,
      });
      expect(models.length).toBeGreaterThan(0);
    });

    const runGen = apiKey && model ? it : it.skip;
    runGen(`${providerId}: generates with ${modelEnvVar}`, async () => {
      const registry = new ProviderRegistry();
      const adapter = registry.getAdapter(providerId)!;
      const def = registry.getDefinition(providerId)!;
      const res = await adapter.chat(
        { connectionId: 'live-test', baseUrl: def.defaultBaseUrl, apiKey, timeoutMs: 60_000 },
        { model: model!, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 16 },
      );
      expect(res.content.length).toBeGreaterThan(0);
    });
  }
});
