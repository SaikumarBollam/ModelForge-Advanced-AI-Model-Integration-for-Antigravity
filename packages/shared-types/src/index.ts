/**
 * @modelforge/shared-types — canonical domain types shared by every package.
 * No runtime dependencies. Provider adapters, gateway, registry and dashboard
 * all speak these types; nothing provider-specific leaks past the adapter layer.
 */

// ---------------------------------------------------------------------------
// Capabilities & protocols
// ---------------------------------------------------------------------------

export type Capability =
  | 'text'
  | 'coding'
  | 'reasoning'
  | 'vision'
  | 'image-generation'
  | 'audio'
  | 'embeddings'
  | 'tool-calling'
  | 'structured-output';

export const ALL_CAPABILITIES: readonly Capability[] = [
  'text', 'coding', 'reasoning', 'vision', 'image-generation',
  'audio', 'embeddings', 'tool-calling', 'structured-output',
] as const;

/** Wire protocol a provider speaks. Adapters translate to/from these. */
export type ApiProtocol =
  | 'openai-compatible'   // /v1/chat/completions, /v1/models (OpenAI, Groq, Ollama, vLLM, ...)
  | 'anthropic-messages'  // /v1/messages
  | 'google-generative'   // generativelanguage.googleapis.com
  | 'ollama-native'       // /api/tags, /api/chat
  | 'custom';

export type AuthMethod =
  | 'bearer'
  | 'api-key-header'      // e.g. x-api-key (Anthropic)
  | 'query-param'
  | 'none'                // local servers
  | 'oauth'               // reserved; requires a documented flow per provider
  | 'custom-headers';

export type ProviderKind = 'hosted' | 'local' | 'custom';

export interface ProviderDefinition {
  id: string;
  displayName: string;
  kind: ProviderKind;
  protocol: ApiProtocol;
  defaultBaseUrl: string;
  auth: AuthMethod;
  /** Header name when auth === 'api-key-header' | 'custom-headers'. */
  authHeaderName?: string;
  docsUrl?: string;
  /** Capabilities the provider family generally supports (per-model flags refine this). */
  capabilities: Capability[];
  supportsDiscovery: boolean;
  supportsStreaming: boolean;
  /** Env var consulted when a connection has no stored credential. */
  envVar?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Connections (a configured instance of a provider)
// ---------------------------------------------------------------------------

export interface ProviderConnection {
  id: string;
  providerId: string;
  label: string;
  baseUrl: string;
  enabled: boolean;
  /** Never serialized to clients. Presence indicates a credential is stored. */
  hasCredential: boolean;
  /** Masked hint e.g. "sk-…abcd". Safe to display. */
  credentialHint?: string;
  timeoutMs: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConnectionInput {
  providerId: string;
  label: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export type ModelSource = 'discovered' | 'manual' | 'imported';

export interface Pricing {
  /** USD per 1M input tokens. */
  inputPerMillion?: number;
  outputPerMillion?: number;
  currency: 'USD';
  /** Where the numbers came from — never present estimates as provider-reported. */
  source: 'provider' | 'configured' | 'estimated';
}

export interface ModelRecord {
  id: string;               // `${connectionId}:${providerModelId}`
  connectionId: string;
  providerId: string;
  providerModelId: string;  // id as the provider knows it
  displayName: string;
  alias?: string;           // gateway-facing name; unique when set
  enabled: boolean;
  source: ModelSource;
  capabilities: Capability[];
  /** Capabilities reported by the provider vs. locally overridden — kept distinct. */
  providerCapabilities?: Capability[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: Pricing;
  version?: string;
  availability: 'unknown' | 'available' | 'unavailable';
  lastSeenAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterModelInput {
  connectionId: string;
  providerModelId: string;
  displayName?: string;
  alias?: string;
  capabilities?: Capability[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: Pricing;
}

// ---------------------------------------------------------------------------
// Chat (normalized, OpenAI-shaped at the gateway boundary)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required';
  reasoning_effort?: 'low' | 'medium' | 'high';
  /** Idempotency key forwarded to providers that support it. */
  idempotencyKey?: string;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** True when token counts were estimated locally rather than provider-reported. */
  estimated: boolean;
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage: Usage;
  /** Raw provider metadata worth surfacing (request id, model version, ...). */
  providerMeta?: Record<string, unknown>;
}

export interface ChatStreamChunk {
  id: string;
  model: string;
  delta: string;
  toolCallDelta?: Partial<ToolCall>;
  finishReason?: string;
  usage?: Usage;
}

// ---------------------------------------------------------------------------
// Errors — normalized across all providers
// ---------------------------------------------------------------------------

export type ProviderErrorCode =
  | 'AUTH_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'MODEL_ACCESS_DENIED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_ERROR'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED_PROTOCOL'
  | 'CIRCUIT_OPEN'
  | 'CONFIGURATION_ERROR'
  | 'UNKNOWN';

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status?: number;
  readonly providerId?: string;
  readonly retryable: boolean;
  constructor(message: string, opts: { code: ProviderErrorCode; status?: number; providerId?: string; retryable?: boolean }) {
    super(message);
    this.name = 'ProviderError';
    this.code = opts.code;
    this.status = opts.status;
    this.providerId = opts.providerId;
    this.retryable = opts.retryable ?? false;
  }
}

// ---------------------------------------------------------------------------
// Diagnostics — multi-stage, independently reported (never collapsed)
// ---------------------------------------------------------------------------

export type DiagnosticStageId =
  | 'config-validation'
  | 'connectivity'
  | 'authentication'
  | 'model-listing'
  | 'model-access'
  | 'generation'
  | 'streaming'
  | 'tool-calling'
  | 'timeout-retry';

export type StageStatus = 'passed' | 'failed' | 'skipped' | 'not-tested';

export interface DiagnosticStage {
  stage: DiagnosticStageId;
  status: StageStatus;
  detail: string;
  durationMs?: number;
  httpStatus?: number;
}

export interface DiagnosticReport {
  connectionId: string;
  providerId: string;
  modelId?: string;
  startedAt: string;
  durationMs: number;
  stages: DiagnosticStage[];
  /** True only when generation (and streaming, if requested) actually passed. */
  generationVerified: boolean;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export interface FallbackChain {
  id: string;
  name: string;
  /** Ordered model ids or aliases; first healthy target wins. */
  targets: string[];
  enabled: boolean;
}

export type RoutingStrategy = 'explicit' | 'lowest-latency' | 'lowest-cost' | 'round-robin';

export interface RoutingPolicy {
  id: string;
  name: string;
  strategy: RoutingStrategy;
  capability?: Capability;
  taskCategory?: string;
  /** Candidate model ids/aliases in preference order. */
  candidates: string[];
  fallbackChainId?: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Usage / observability
// ---------------------------------------------------------------------------

export interface UsageRecord {
  id: string;
  timestamp: string;
  correlationId: string;
  connectionId: string;
  providerId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd?: number;
  costSource?: 'provider' | 'configured' | 'estimated';
  latencyMs: number;
  timeToFirstTokenMs?: number;
  status: 'success' | 'error';
  errorCode?: ProviderErrorCode;
  tokensEstimated: boolean;
}

export interface HealthStatus {
  connectionId: string;
  providerId: string;
  label: string;
  state: 'healthy' | 'degraded' | 'down' | 'unknown';
  latencyMs?: number;
  checkedAt: string;
  circuit: 'closed' | 'open' | 'half-open';
  detail?: string;
}

// ---------------------------------------------------------------------------
// Local GPU / remote inference servers
// ---------------------------------------------------------------------------

export interface GpuInfo {
  index: number;
  name: string;
  memoryTotalMb?: number;
  memoryUsedMb?: number;
  utilizationPct?: number;
  driverVersion?: string;
  cudaVersion?: string;
}

export interface InferenceServer {
  id: string;
  label: string;
  kind: 'ollama' | 'lmstudio' | 'vllm' | 'llamacpp' | 'localai' | 'textgen-webui' | 'custom';
  baseUrl: string;
  host: string;
  enabled: boolean;
  connectionId?: string;
  lastHealth?: 'healthy' | 'down' | 'unknown';
  gpus?: GpuInfo[];
}

// ---------------------------------------------------------------------------
// Antigravity integration
// ---------------------------------------------------------------------------

export type AntigravityInstallKind = 'desktop-standalone' | 'vscode-ide' | 'unknown';

export interface AntigravityInstall {
  kind: AntigravityInstallKind;
  path: string;
  version?: string;
  detectedAt: string;
}

export interface AntigravityIntegrationStatus {
  installs: AntigravityInstall[];
  gatewayUrl: string;
  /** Only ever true for mechanisms that are documented/supported. */
  supportedMechanism: 'local-gateway-endpoint' | 'none-detected';
  notes: string[];
}
