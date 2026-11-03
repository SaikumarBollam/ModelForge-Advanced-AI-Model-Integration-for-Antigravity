import type {
  ChatRequest, ChatResponse, ChatStreamChunk, ProviderDefinition,
} from '@modelforge/shared-types';
import {
  estimateTokens, fetchJson, joinUrl, normalizeHttpError,
  type AdapterContext, type DiscoveredModel, type ProviderAdapter,
} from '@modelforge/provider-sdk';

/**
 * Google Gemini (Generative Language API) adapter.
 * Auth via x-goog-api-key header. Translates normalized chat <-> Gemini
 * contents/parts format, including function declarations/calls.
 */

export const GEMINI_DEFINITION: ProviderDefinition = {
  id: 'google-gemini',
  displayName: 'Google Gemini',
  kind: 'hosted',
  protocol: 'google-generative',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  auth: 'api-key-header',
  authHeaderName: 'x-goog-api-key',
  docsUrl: 'https://ai.google.dev/gemini-api/docs',
  capabilities: ['text', 'coding', 'reasoning', 'vision', 'audio', 'tool-calling', 'structured-output', 'embeddings'],
  supportsDiscovery: true,
  supportsStreaming: true,
  envVar: 'GEMINI_API_KEY',
};

function headers(ctx: AdapterContext): Record<string, string> {
  return { 'content-type': 'application/json', 'x-goog-api-key': ctx.apiKey ?? '' };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: { name: string; args?: unknown } }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  modelVersion?: string;
}

function toGeminiBody(req: ChatRequest): Record<string, unknown> {
  const system = req.messages.filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  const contents = req.messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: typeof m.content === 'string'
      ? [{ text: m.content }]
      : m.content.map((p) => (p.type === 'text' ? { text: p.text } : { text: `[image: ${p.image_url.url}]` })),
  }));
  const body: Record<string, unknown> = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (req.tools?.length) {
    body.tools = [{
      functionDeclarations: req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    }];
  }
  return body;
}

function fromGemini(json: GeminiResponse, req: ChatRequest): ChatResponse {
  const candidate = json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? '').join('');
  const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => ({
    id: `call_${i}`,
    type: 'function' as const,
    function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args ?? {}) },
  }));
  const usage = json.usageMetadata
    ? {
        promptTokens: json.usageMetadata.promptTokenCount,
        completionTokens: json.usageMetadata.candidatesTokenCount,
        totalTokens: json.usageMetadata.totalTokenCount,
        estimated: false,
      }
    : { completionTokens: estimateTokens(text), estimated: true };
  return {
    id: `gemini-${Date.now()}`,
    model: json.modelVersion ?? req.model,
    content: text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: candidate?.finishReason,
    usage,
    providerMeta: json.modelVersion ? { modelVersion: json.modelVersion } : undefined,
  };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly definition = GEMINI_DEFINITION;

  async listModels(ctx: AdapterContext): Promise<DiscoveredModel[]> {
    const json = (await fetchJson(ctx, this.definition, joinUrl(ctx.baseUrl, '/models'), {
      headers: headers(ctx),
    })) as { models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> };
    return (json.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => ({
        providerModelId: m.name.replace(/^models\//, ''),
        displayName: m.displayName ?? m.name,
        capabilities: [...this.definition.capabilities],
      }));
  }

  async validateAuth(ctx: AdapterContext): Promise<void> {
    await this.listModels(ctx);
  }

  async chat(ctx: AdapterContext, req: ChatRequest): Promise<ChatResponse> {
    const url = joinUrl(ctx.baseUrl, `/models/${encodeURIComponent(req.model)}:generateContent`);
    const json = (await fetchJson(ctx, this.definition, url, {
      method: 'POST',
      headers: headers(ctx),
      body: JSON.stringify(toGeminiBody(req)),
    })) as GeminiResponse;
    return fromGemini(json, req);
  }

  async *chatStream(ctx: AdapterContext, req: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const url = joinUrl(ctx.baseUrl, `/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const res = await (ctx.fetchFn ?? fetch)(url, {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify(toGeminiBody(req)),
        signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal,
      });
      if (!res.ok || !res.body) {
        throw normalizeHttpError(this.definition, res.status, await res.text().catch(() => ''));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const parsed = JSON.parse(line.slice(5)) as GeminiResponse;
            const converted = fromGemini(parsed, req);
            yield { id: converted.id, model: converted.model, delta: converted.content, finishReason: converted.finishReason, usage: converted.usage };
          } catch { /* ignore partial lines */ }
        }
      }
      reader.releaseLock();
    } finally {
      clearTimeout(timer);
    }
  }
}
