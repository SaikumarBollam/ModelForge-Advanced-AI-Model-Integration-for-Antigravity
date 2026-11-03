import type {
  ChatRequest, ChatResponse, ChatStreamChunk, ModelRecord, ProviderDefinition,
} from '@modelforge/shared-types';
import { ProviderError } from '@modelforge/shared-types';

/**
 * Provider SDK — the contract every adapter implements.
 *
 * Adapters receive a fully-resolved `AdapterContext` (base URL + credential
 * already decrypted by the caller). They never touch the vault, the database,
 * or gateway routing. Adding a provider = implementing this interface and
 * registering a definition; the gateway core does not change.
 */

export interface AdapterContext {
  connectionId: string;
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

export interface DiscoveredModel {
  providerModelId: string;
  displayName: string;
  capabilities?: ModelRecord['capabilities'];
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface ProviderAdapter {
  readonly definition: ProviderDefinition;
  listModels(ctx: AdapterContext): Promise<DiscoveredModel[]>;
  chat(ctx: AdapterContext, req: ChatRequest): Promise<ChatResponse>;
  chatStream(ctx: AdapterContext, req: ChatRequest): AsyncIterable<ChatStreamChunk>;
  /** Cheap authenticated probe used by diagnostics (defaults to listModels in helpers). */
  validateAuth?(ctx: AdapterContext): Promise<void>;
}

type FetchFn = typeof fetch;

export function resolveFetch(ctx: AdapterContext): FetchFn {
  return ctx.fetchFn ?? fetch;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Build auth headers for the common auth methods. */
export function authHeaders(def: ProviderDefinition, apiKey?: string): Record<string, string> {
  if (!apiKey || def.auth === 'none') return {};
  switch (def.auth) {
    case 'bearer':
      return { authorization: `Bearer ${apiKey}` };
    case 'api-key-header':
      return { [def.authHeaderName ?? 'x-api-key']: apiKey };
    case 'custom-headers':
      return { [def.authHeaderName ?? 'authorization']: apiKey };
    default:
      return {};
  }
}

/** Map an HTTP status + provider message to a normalized ProviderError. */
export function normalizeHttpError(
  def: ProviderDefinition,
  status: number,
  bodyText: string,
): ProviderError {
  let message = bodyText.slice(0, 500);
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') message = parsed.error;
    else if (parsed.error?.message) message = parsed.error.message;
    else if (parsed.message) message = parsed.message;
  } catch { /* keep raw text */ }

  const lower = message.toLowerCase();
  const base = { status, providerId: def.id };
  if (status === 401 || status === 403) {
    return new ProviderError(message || 'Authentication failed', {
      ...base,
      code: status === 403 && /model|access|permission/.test(lower) ? 'MODEL_ACCESS_DENIED' : 'AUTH_FAILED',
    });
  }
  if (status === 404) return new ProviderError(message || 'Model not found', { ...base, code: 'MODEL_NOT_FOUND' });
  if (status === 429) {
    return new ProviderError(message || 'Rate limited', {
      ...base,
      code: /quota|insufficient|billing/.test(lower) ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED',
      retryable: true,
    });
  }
  if (status === 408 || status === 504) {
    return new ProviderError(message || 'Upstream timeout', { ...base, code: 'TIMEOUT', retryable: true });
  }
  if (status >= 500) {
    return new ProviderError(message || `Upstream error (HTTP ${status})`, { ...base, code: 'UPSTREAM_ERROR', retryable: true });
  }
  if (status >= 400) {
    return new ProviderError(message || `Invalid request (HTTP ${status})`, { ...base, code: 'INVALID_REQUEST' });
  }
  return new ProviderError(message || `Unexpected HTTP ${status}`, { ...base, code: 'UNKNOWN' });
}

/** fetch() with timeout + normalized network errors. Never logs credentials. */
export async function fetchJson(
  ctx: AdapterContext,
  def: ProviderDefinition,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
  try {
    const res = await resolveFetch(ctx)(url, { ...init, signal });
    const text = await res.text();
    if (!res.ok) throw normalizeHttpError(def, res.status, text);
    return text ? (JSON.parse(text) as unknown) : {};
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ProviderError(`Request timed out after ${ctx.timeoutMs}ms`, {
        code: 'TIMEOUT', providerId: def.id, retryable: true,
      });
    }
    throw new ProviderError(err instanceof Error ? err.message : 'Network error', {
      code: 'NETWORK_ERROR', providerId: def.id, retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Rough local token estimate (≈4 chars/token). Always flagged estimated. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
