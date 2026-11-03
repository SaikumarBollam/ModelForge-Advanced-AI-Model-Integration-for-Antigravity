import type {
  ChatRequest, ChatResponse, ChatStreamChunk, ProviderDefinition,
} from '@modelforge/shared-types';
import {
  estimateTokens, fetchJson, joinUrl, normalizeHttpError,
  type AdapterContext, type DiscoveredModel, type ProviderAdapter,
} from '@modelforge/provider-sdk';

/**
 * Ollama native adapter (/api/tags, /api/chat).
 * Ollama also exposes an OpenAI-compatible surface; the native API gives
 * richer local metadata, so it is the primary path. No auth by default.
 */

export const OLLAMA_DEFINITION: ProviderDefinition = {
  id: 'ollama',
  displayName: 'Ollama (native)',
  kind: 'local',
  protocol: 'ollama-native',
  defaultBaseUrl: 'http://127.0.0.1:11434',
  auth: 'none',
  docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
  capabilities: ['text', 'coding', 'vision', 'tool-calling', 'embeddings'],
  supportsDiscovery: true,
  supportsStreaming: true,
};

interface OllamaChatResponse {
  model: string;
  message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly definition = OLLAMA_DEFINITION;

  async listModels(ctx: AdapterContext): Promise<DiscoveredModel[]> {
    const json = (await fetchJson(ctx, this.definition, joinUrl(ctx.baseUrl, '/api/tags'), {})) as {
      models?: Array<{ name: string; details?: { parameter_size?: string } }>;
    };
    return (json.models ?? []).map((m) => ({
      providerModelId: m.name,
      displayName: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
      capabilities: [...this.definition.capabilities],
    }));
  }

  async validateAuth(ctx: AdapterContext): Promise<void> {
    await fetchJson(ctx, this.definition, joinUrl(ctx.baseUrl, '/api/version'), {});
  }

  private body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
      })),
      stream,
    };
    const options: Record<string, unknown> = {};
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.max_tokens !== undefined) options.num_predict = req.max_tokens;
    if (Object.keys(options).length) body.options = options;
    if (req.tools?.length) body.tools = req.tools;
    return body;
  }

  async chat(ctx: AdapterContext, req: ChatRequest): Promise<ChatResponse> {
    const json = (await fetchJson(ctx, this.definition, joinUrl(ctx.baseUrl, '/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(this.body(req, false)),
    })) as OllamaChatResponse;
    const content = json.message?.content ?? '';
    const toolCalls = json.message?.tool_calls?.map((t, i) => ({
      id: `call_${i}`,
      type: 'function' as const,
      function: { name: t.function.name, arguments: JSON.stringify(t.function.arguments ?? {}) },
    }));
    return {
      id: `ollama-${Date.now()}`,
      model: json.model,
      content,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      finishReason: json.done ? 'stop' : undefined,
      usage: json.eval_count !== undefined
        ? { promptTokens: json.prompt_eval_count, completionTokens: json.eval_count, totalTokens: (json.prompt_eval_count ?? 0) + json.eval_count, estimated: false }
        : { completionTokens: estimateTokens(content), estimated: true },
    };
  }

  async *chatStream(ctx: AdapterContext, req: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const res = await (ctx.fetchFn ?? fetch)(joinUrl(ctx.baseUrl, '/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.body(req, true)),
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
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as OllamaChatResponse;
            yield {
              id: 'ollama-stream',
              model: parsed.model ?? req.model,
              delta: parsed.message?.content ?? '',
              finishReason: parsed.done ? 'stop' : undefined,
              usage: parsed.done && parsed.eval_count !== undefined
                ? { promptTokens: parsed.prompt_eval_count, completionTokens: parsed.eval_count, estimated: false }
                : undefined,
            };
          } catch { /* ignore partial lines */ }
        }
      }
      reader.releaseLock();
    } finally {
      clearTimeout(timer);
    }
  }
}
