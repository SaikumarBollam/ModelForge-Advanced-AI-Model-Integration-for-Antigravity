/**
 * API client for the ModelForge admin + gateway APIs.
 * The admin key, when configured server-side, is stored in sessionStorage
 * only (never localStorage) and attached as a Bearer token.
 */

const ADMIN_KEY_STORAGE = 'modelforge.adminKey';

export function getAdminKey(): string {
  return sessionStorage.getItem(ADMIN_KEY_STORAGE) ?? '';
}
export function setAdminKey(key: string): void {
  if (key) sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
  else sessionStorage.removeItem(ADMIN_KEY_STORAGE);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = getAdminKey();
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try { message = (JSON.parse(text) as { error?: { message?: string } | string }).error as string ?? text; } catch { /* raw */ }
    if (typeof message === 'object') message = (message as { message?: string }).message ?? text;
    throw new Error(message || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface ProviderDefinitionDto {
  id: string; displayName: string; kind: string; protocol: string;
  defaultBaseUrl: string; auth: string; capabilities: string[];
  supportsDiscovery: boolean; supportsStreaming: boolean; envVar?: string; notes?: string;
}
export interface ConnectionDto {
  id: string; providerId: string; label: string; baseUrl: string; enabled: boolean;
  hasCredential: boolean; credentialHint?: string; timeoutMs: number; maxRetries: number;
  createdAt: string; updatedAt: string;
}
export interface ModelDto {
  id: string; connectionId: string; providerId: string; providerModelId: string;
  displayName: string; alias?: string; enabled: boolean; source: string;
  capabilities: string[]; providerCapabilities?: string[]; contextWindow?: number;
  maxOutputTokens?: number; pricing?: { inputPerMillion?: number; outputPerMillion?: number; source: string };
  availability: string; lastSeenAt?: string;
}
export interface DiagnosticReportDto {
  connectionId: string; providerId: string; modelId?: string; durationMs: number;
  generationVerified: boolean;
  stages: Array<{ stage: string; status: string; detail: string; durationMs?: number; httpStatus?: number }>;
}
export interface UsageDto {
  id: string; timestamp: string; providerId: string; modelId: string;
  promptTokens: number; completionTokens: number; estimatedCostUsd?: number;
  latencyMs: number; timeToFirstTokenMs?: number; status: string; errorCode?: string; tokensEstimated: boolean;
}
export interface SummaryDto {
  totalRequests: number; errorRate: number; promptTokens: number; completionTokens: number;
  totalTokens: number; estimatedCostUsd?: number; avgLatencyMs: number;
}

export const api = {
  providers: () => request<ProviderDefinitionDto[]>('/api/providers'),
  connections: () => request<ConnectionDto[]>('/api/connections'),
  createConnection: (body: Record<string, unknown>) => request<ConnectionDto>('/api/connections', { method: 'POST', body: JSON.stringify(body) }),
  updateConnection: (id: string, body: Record<string, unknown>) => request<ConnectionDto>(`/api/connections/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteConnection: (id: string) => request<void>(`/api/connections/${id}`, { method: 'DELETE' }),
  discover: (id: string) => request<{ discovered: number }>(`/api/connections/${id}/discover`, { method: 'POST' }),
  diagnose: (id: string, body: Record<string, unknown>) => request<DiagnosticReportDto>(`/api/connections/${id}/diagnose`, { method: 'POST', body: JSON.stringify(body) }),
  models: (params: Record<string, string> = {}) => request<ModelDto[]>(`/api/models?${new URLSearchParams(params)}`),
  createModel: (body: Record<string, unknown>) => request<ModelDto>('/api/models', { method: 'POST', body: JSON.stringify(body) }),
  updateModel: (id: string, body: Record<string, unknown>) => request<ModelDto>(`/api/models/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteModel: (id: string) => request<void>(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  duplicateModel: (id: string) => request<ModelDto>(`/api/models/${encodeURIComponent(id)}/duplicate`, { method: 'POST' }),
  chains: () => request<Array<{ id: string; name: string; targets: string[]; enabled: boolean }>>('/api/chains'),
  createChain: (body: Record<string, unknown>) => request('/api/chains', { method: 'POST', body: JSON.stringify(body) }),
  deleteChain: (id: string) => request<void>(`/api/chains/${id}`, { method: 'DELETE' }),
  policies: () => request<Array<{ id: string; name: string; strategy: string; candidates: string[]; enabled: boolean }>>('/api/policies'),
  createPolicy: (body: Record<string, unknown>) => request('/api/policies', { method: 'POST', body: JSON.stringify(body) }),
  deletePolicy: (id: string) => request<void>(`/api/policies/${id}`, { method: 'DELETE' }),
  servers: () => request<Array<{ id: string; label: string; kind: string; baseUrl: string; host: string; lastHealth?: string }>>('/api/servers'),
  createServer: (body: Record<string, unknown>) => request('/api/servers', { method: 'POST', body: JSON.stringify(body) }),
  deleteServer: (id: string) => request<void>(`/api/servers/${id}`, { method: 'DELETE' }),
  serverHealth: (id: string) => request(`/api/servers/${id}/health`, { method: 'POST' }),
  usage: (limit = 100) => request<UsageDto[]>(`/api/usage?limit=${limit}`),
  summary: () => request<SummaryDto>('/api/analytics/summary'),
  connectionHealth: () => request<Array<{ connectionId: string; label: string; providerId: string; state: string; circuit: string; latencyMs?: number }>>('/api/health/connections'),
  gpus: () => request<{ gpus: Array<{ index: number; name: string; memoryTotalMb?: number; memoryUsedMb?: number; utilizationPct?: number; driverVersion?: string }>; cudaVersion?: string; detected: boolean }>('/api/gpus'),
  antigravity: () => request<{ installs: Array<{ kind: string; path: string; version?: string }>; gatewayUrl: string; supportedMechanism: string; notes: string[] }>('/api/antigravity/status'),
  exportConfig: () => request<{ includesSecrets: boolean; config: unknown }>('/api/config/export'),
  importConfig: (config: unknown) => request('/api/config/import', { method: 'POST', body: JSON.stringify({ config }) }),
};

/** Stream a chat completion from the gateway, yielding content deltas. */
export async function* streamChat(body: Record<string, unknown>): AsyncGenerator<{ delta: string; usage?: unknown }> {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }>; usage?: unknown; error?: { message: string } };
        if (parsed.error) throw new Error(parsed.error.message);
        yield { delta: parsed.choices?.[0]?.delta?.content ?? '', usage: parsed.usage };
      } catch (err) {
        if (err instanceof Error && err.message !== 'Unexpected end of JSON input') throw err;
      }
    }
  }
}
