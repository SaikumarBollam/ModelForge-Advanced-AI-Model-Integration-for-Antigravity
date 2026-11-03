import type {
  ChatRequest, ChatResponse, ChatStreamChunk, ProviderDefinition,
} from '@modelforge/shared-types';
import {
  authHeaders, estimateTokens, fetchJson, joinUrl, normalizeHttpError,
  type AdapterContext, type DiscoveredModel, type ProviderAdapter,
} from '@modelforge/provider-sdk';

/**
 * Anthropic Messages API adapter (/v1/messages).
 * Translates the normalized chat shape to/from Anthropic's format:
 * system prompt is hoisted, tool_use/tool_result blocks are mapped.
 */

export const ANTHROPIC_DEFINITION: ProviderDefinition = {
  id: 'anthropic',
  displayName: 'Anthropic',
  kind: 'hosted',
  protocol: 'anthropic-messages',
  defaultBaseUrl: 'https://api.anthropic.com/v1',
  auth: 'api-key-header',
  authHeaderName: 'x-api-key',
  docsUrl: 'https://docs.anthropic.com/en/api/messages',
  capabilities: ['text', 'coding', 'reasoning', 'vision', 'tool-calling', 'structured-output'],
  supportsDiscovery: true,
  supportsStreaming: true,
  envVar: 'ANTHROPIC_API_KEY',
};

interface AnthropicResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function headers(ctx: AdapterContext): Record<string, string> {
  return {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...authHeaders(ANTHROPIC_DEFINITION, ctx.apiKey),
  };
}

function toAnthropicBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const system = req.messages.filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
  const messages = req.messages.filter((m) => m.role !== 'system').map((m) => {
    if (m.role === 'tool') {
      return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : '' }] };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant',
        content: [
          ...(typeof m.content === 'string' && m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.tool_calls.map((t) => {
            let input: unknown = {};
            try { input = JSON.parse(t.function.arguments || '{}'); } catch { /* keep {} */ }
            return { type: 'tool_use', id: t.id, name: t.function.name, input };
          }),
        ],
      };
    }
    return { role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map((p) => p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'url', url: p.image_url.url } }) };
  });
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens ?? 1024,
    stream,
  };
  if (system) body.system = system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: 'object' } }));
  }
  return body;
}

function fromAnthropic(json: AnthropicResponse, req: ChatRequest): ChatResponse {
  const text = json.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  const toolCalls = json.content.filter((c) => c.type === 'tool_use').map((c) => ({
    id: c.id ?? '',
    type: 'function' as const,
    function: { name: c.name ?? '', arguments: JSON.stringify(c.input ?? {}) },
  }));
  const usage = json.usage
    ? {
        promptTokens: json.usage.input_tokens,
        completionTokens: json.usage.output_tokens,
        totalTokens: (json.usage.input_tokens ?? 0) + (json.usage.output_tokens ?? 0),
        estimated: false,
      }
    : { promptTokens: estimateTokens(JSON.stringify(req.messages)), completionTokens: estimateTokens(text), estimated: true };
  return {
    id: json.id,
    model: json.model,
    content: text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    finishReason: json.stop_reason,
    usage,
    providerMeta: { stopReason: json.stop_reason },
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly definition = ANTHROPIC_DEFINITION;

  async listModels(ctx: AdapterContext): Promise<DiscoveredModel[]> {
    const json = (await fetchJson(ctx, this.definition, joinUrl(ctx.baseUrl, '/models'), {
      headers: headers(ctx),
    })) as { data?: Array<{ id: string; display_name?: string }> };
    return (json.data ?? []).map((m) => ({
      providerModelId: m.id,
      displayName: m.display_name ?? m.id,
      capabilities: [...this.definition.capabilities],
    }));
  }

  async validateAuth(ctx: AdapterContext): Promise<void> {
    await this.listModels(ctx);
  }

  async chat(ctx: AdapterContext, req: ChatRequest): Promise<ChatResponse> {
    const json = (await fetchJson(ctx, this.definition, joinUrl(ctx.baseUrl, '/messages'), {
      method: 'POST',
      headers: headers(ctx),
      body: JSON.stringify(toAnthropicBody(req, false)),
    })) as AnthropicResponse;
    return fromAnthropic(json, req);
  }

  async *chatStream(ctx: AdapterContext, req: ChatRequest): AsyncIterable<ChatStreamChunk> {
    // Streaming: request with stream=true and parse Anthropic SSE events.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const res = await (ctx.fetchFn ?? fetch)(joinUrl(ctx.baseUrl, '/messages'), {
        method: 'POST',
        headers: headers(ctx),
        body: JSON.stringify(toAnthropicBody(req, true)),
        signal: ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal,
      });
      if (!res.ok || !res.body) {
        throw normalizeHttpError(this.definition, res.status, await res.text().catch(() => ''));
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let messageId = '';
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
            const evt = JSON.parse(line.slice(5)) as {
              type: string;
              message?: { id: string };
              delta?: { type?: string; text?: string; stop_reason?: string };
              usage?: { output_tokens?: number };
            };
            if (evt.type === 'message_start' && evt.message) messageId = evt.message.id;
            if (evt.type === 'content_block_delta' && evt.delta?.text) {
              yield { id: messageId, model: req.model, delta: evt.delta.text };
            }
            if (evt.type === 'message_delta') {
              yield {
                id: messageId, model: req.model, delta: '',
                finishReason: evt.delta?.stop_reason,
                usage: evt.usage ? { completionTokens: evt.usage.output_tokens, estimated: false } : undefined,
              };
            }
          } catch { /* ignore keep-alives */ }
        }
      }
      reader.releaseLock();
    } finally {
      clearTimeout(timer);
    }
  }
}
