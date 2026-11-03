import type {
  ChatRequest, ChatResponse, ChatStreamChunk, ProviderDefinition, ToolCall, Usage,
} from '@modelforge/shared-types';
import { ProviderError } from '@modelforge/shared-types';
import {
  authHeaders, estimateTokens, fetchJson, joinUrl, normalizeHttpError, resolveFetch,
  type AdapterContext, type DiscoveredModel, type ProviderAdapter,
} from '@modelforge/provider-sdk';

/**
 * Generic OpenAI-compatible adapter.
 *
 * Covers every provider that speaks /v1/models + /v1/chat/completions:
 * OpenAI, Groq, DeepSeek, OpenRouter, Together, Mistral, xAI, Cerebras,
 * Fireworks, SambaNova, SiliconFlow, Novita, NVIDIA NIM, Cloudflare (with a
 * per-account base URL), LM Studio, vLLM, llama.cpp server, LocalAI, Ollama's
 * OpenAI-compat surface, and user-defined custom endpoints.
 *
 * Per-provider differences are data (ProviderDefinition), not code.
 */

interface OpenAiModelList { data?: Array<{ id: string; name?: string }> }
interface OpenAiChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function toUsage(u: OpenAiChatResponse['usage'], req: ChatRequest, content: string): Usage {
  if (u && (u.prompt_tokens !== undefined || u.completion_tokens !== undefined)) {
    return {
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
      estimated: false,
    };
  }
  const prompt = req.messages.reduce((n, m) => n + estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)), 0);
  return { promptTokens: prompt, completionTokens: estimateTokens(content), totalTokens: prompt + estimateTokens(content), estimated: true };
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  constructor(readonly definition: ProviderDefinition) {}

  async listModels(ctx: AdapterContext): Promise<DiscoveredModel[]> {
    const json = (await fetchJson(ctx, this.definition, joinUrl(ctx.baseUrl, '/models'), {
      headers: { ...authHeaders(this.definition, ctx.apiKey) },
    })) as OpenAiModelList;
    return (json.data ?? []).map((m) => ({
      providerModelId: m.id,
      displayName: m.name ?? m.id,
      capabilities: [...this.definition.capabilities],
    }));
  }

  async validateAuth(ctx: AdapterContext): Promise<void> {
    await this.listModels(ctx);
  }

  private body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    if (req.tools?.length) { body.tools = req.tools; body.tool_choice = req.tool_choice ?? 'auto'; }
    if (stream) body.stream_options = { include_usage: true };
    return body;
  }

  async chat(ctx: AdapterContext, req: ChatRequest): Promise<ChatResponse> {
    const json = (await fetchJson(ctx, this.definition, joinUrl(ctx.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(this.definition, ctx.apiKey) },
      body: JSON.stringify(this.body(req, false)),
    })) as OpenAiChatResponse;
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? '';
    return {
      id: json.id ?? `chatcmpl-${Date.now()}`,
      model: json.model ?? req.model,
      content,
      toolCalls: choice?.message?.tool_calls,
      finishReason: choice?.finish_reason,
      usage: toUsage(json.usage, req, content),
    };
  }

  async *chatStream(ctx: AdapterContext, req: ChatRequest): AsyncIterable<ChatStreamChunk> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    let res: Response;
    try {
      res = await resolveFetch(ctx)(joinUrl(ctx.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(this.definition, ctx.apiKey) },
        body: JSON.stringify(this.body(req, true)),
        signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw err instanceof Error && err.name === 'AbortError'
        ? new ProviderError(`Stream timed out after ${ctx.timeoutMs}ms`, { code: 'TIMEOUT', providerId: this.definition.id, retryable: true })
        : new ProviderError(err instanceof Error ? err.message : 'Network error', { code: 'NETWORK_ERROR', providerId: this.definition.id, retryable: true });
    }
    if (!res.ok || !res.body) {
      clearTimeout(timer);
      throw normalizeHttpError(this.definition, res.status, await res.text().catch(() => ''));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload) as {
              id?: string; model?: string;
              choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
              usage?: OpenAiChatResponse['usage'];
            };
            const choice = parsed.choices?.[0];
            const usage = parsed.usage
              ? { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens, totalTokens: parsed.usage.total_tokens, estimated: false }
              : undefined;
            yield {
              id: parsed.id ?? '',
              model: parsed.model ?? req.model,
              delta: choice?.delta?.content ?? '',
              finishReason: choice?.finish_reason ?? undefined,
              usage,
            };
          } catch { /* ignore malformed SSE lines */ }
        }
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }
}
