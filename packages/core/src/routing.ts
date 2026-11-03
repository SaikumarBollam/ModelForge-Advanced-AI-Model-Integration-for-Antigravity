import type {
  ChatRequest, ChatResponse, ChatStreamChunk, ModelRecord,
} from '@modelforge/shared-types';
import { ProviderError } from '@modelforge/shared-types';
import type { ProviderAdapter, AdapterContext } from '@modelforge/provider-sdk';
import type { JsonStore } from './store.js';
import { CircuitBreaker, estimateCostUsd, withRetries } from './resilience.js';

/**
 * Routing engine.
 *
 * Resolution order (deterministic by default):
 *   1. Exact model id (`connectionId:providerModelId`)
 *   2. Alias
 *   3. Fallback chain name (`chain:<id>`) or routing policy name (`policy:<id>`)
 *   4. Bare provider model id (first enabled match, insertion order)
 *
 * Each candidate target is tried in order; retryable errors and open circuits
 * advance to the next target. Non-retryable client errors (4xx validation)
 * fail fast — falling back would not fix a malformed request.
 */

export interface ResolvedTarget {
  model: ModelRecord;
  adapter: ProviderAdapter;
  ctx: AdapterContext;
}

export interface RouteAttempt {
  modelId: string;
  errorCode?: string;
  latencyMs: number;
}

export interface RouteResult {
  response: ChatResponse;
  target: ResolvedTarget;
  attempts: RouteAttempt[];
  latencyMs: number;
}

export interface RouterDeps {
  store: JsonStore;
  resolveAdapter: (providerId: string) => ProviderAdapter | undefined;
  resolveContext: (model: ModelRecord) => AdapterContext;
  onUsage?: (info: {
    target: ResolvedTarget;
    request: ChatRequest;
    response?: ChatResponse;
    latencyMs: number;
    timeToFirstTokenMs?: number;
    error?: ProviderError;
  }) => void;
}

export class RoutingEngine {
  readonly breaker = new CircuitBreaker();
  private readonly roundRobinCursor = new Map<string, number>();

  constructor(private readonly deps: RouterDeps) {}

  resolveTargets(modelRef: string): ModelRecord[] {
    const { store } = this.deps;

    if (modelRef.startsWith('chain:')) {
      const chain = store.getFallbackChain(modelRef.slice(6));
      if (!chain || !chain.enabled) return [];
      return chain.targets.flatMap((t) => this.resolveTargets(t));
    }
    if (modelRef.startsWith('policy:')) {
      const policy = store.listRoutingPolicies().find((p) => p.id === modelRef.slice(7) && p.enabled);
      if (!policy) return [];
      let candidates = policy.candidates.flatMap((t) => this.resolveTargets(t));
      candidates = candidates.filter((m) =>
        (!policy.capability || m.capabilities.includes(policy.capability)) &&
        this.breaker.isAvailable(m.connectionId));
      if (policy.strategy === 'lowest-cost') {
        candidates.sort((a, b) => (a.pricing?.inputPerMillion ?? Infinity) - (b.pricing?.inputPerMillion ?? Infinity));
      } else if (policy.strategy === 'lowest-latency') {
        candidates.sort((a, b) =>
          (this.breaker.get(a.connectionId).lastLatencyMs ?? Infinity) -
          (this.breaker.get(b.connectionId).lastLatencyMs ?? Infinity));
      } else if (policy.strategy === 'round-robin' && candidates.length > 1) {
        const cursor = (this.roundRobinCursor.get(policy.id) ?? 0) % candidates.length;
        this.roundRobinCursor.set(policy.id, cursor + 1);
        candidates = [...candidates.slice(cursor), ...candidates.slice(0, cursor)];
      }
      if (policy.fallbackChainId) {
        candidates.push(...this.resolveTargets(`chain:${policy.fallbackChainId}`));
      }
      return dedupe(candidates);
    }

    const byId = store.getModel(modelRef);
    if (byId?.enabled) return [byId];
    const byAlias = store.findByAlias(modelRef);
    if (byAlias) return [byAlias];
    return store.listModels().filter((m) => m.enabled && m.providerModelId === modelRef);
  }

  private toTarget(model: ModelRecord): ResolvedTarget | undefined {
    const adapter = this.deps.resolveAdapter(model.providerId);
    if (!adapter) return undefined;
    return { model, adapter, ctx: this.deps.resolveContext(model) };
  }

  async chat(modelRef: string, req: ChatRequest): Promise<RouteResult> {
    const models = this.resolveTargets(modelRef);
    if (!models.length) {
      throw new ProviderError(`No enabled model matches "${modelRef}"`, { code: 'MODEL_NOT_FOUND' });
    }
    const attempts: RouteAttempt[] = [];
    const started = Date.now();
    let lastError: ProviderError | undefined;

    for (const model of models) {
      const target = this.toTarget(model);
      if (!target) continue;
      if (!this.breaker.isAvailable(model.connectionId)) {
        attempts.push({ modelId: model.id, errorCode: 'CIRCUIT_OPEN', latencyMs: 0 });
        continue;
      }
      const attemptStart = Date.now();
      try {
        const response = await withRetries(
          () => target.adapter.chat(target.ctx, { ...req, model: model.providerModelId }),
          { maxRetries: connectionRetries(this.deps, model) },
        );
        const latencyMs = Date.now() - attemptStart;
        this.breaker.recordSuccess(model.connectionId, latencyMs);
        attempts.push({ modelId: model.id, latencyMs });
        this.deps.onUsage?.({ target, request: req, response, latencyMs });
        return { response, target, attempts, latencyMs: Date.now() - started };
      } catch (err) {
        const providerError = asProviderError(err);
        const latencyMs = Date.now() - attemptStart;
        this.breaker.recordFailure(model.connectionId);
        attempts.push({ modelId: model.id, errorCode: providerError.code, latencyMs });
        this.deps.onUsage?.({ target, request: req, latencyMs, error: providerError });
        lastError = providerError;
        if (!providerError.retryable && providerError.code !== 'MODEL_NOT_FOUND' && providerError.code !== 'MODEL_ACCESS_DENIED') {
          throw providerError;
        }
      }
    }
    throw lastError ?? new ProviderError(`All targets for "${modelRef}" are unavailable`, { code: 'UPSTREAM_ERROR', retryable: true });
  }

  async *chatStream(modelRef: string, req: ChatRequest): AsyncIterable<ChatStreamChunk> & { target?: ResolvedTarget } {
    const models = this.resolveTargets(modelRef);
    if (!models.length) {
      throw new ProviderError(`No enabled model matches "${modelRef}"`, { code: 'MODEL_NOT_FOUND' });
    }
    let lastError: ProviderError | undefined;
    for (const model of models) {
      const target = this.toTarget(model);
      if (!target || !this.breaker.isAvailable(model.connectionId)) continue;
      const started = Date.now();
      let firstTokenAt: number | undefined;
      let emitted = false;
      try {
        for await (const chunk of target.adapter.chatStream(target.ctx, { ...req, model: model.providerModelId })) {
          if (!emitted) { emitted = true; firstTokenAt = Date.now(); }
          yield chunk;
        }
        const latencyMs = Date.now() - started;
        this.breaker.recordSuccess(model.connectionId, latencyMs);
        this.deps.onUsage?.({
          target, request: req, latencyMs,
          timeToFirstTokenMs: firstTokenAt ? firstTokenAt - started : undefined,
        });
        return;
      } catch (err) {
        // If tokens already reached the client we cannot transparently switch
        // providers mid-stream; surface the error instead.
        if (emitted) throw err;
        lastError = asProviderError(err);
        this.breaker.recordFailure(model.connectionId);
      }
    }
    throw lastError ?? new ProviderError(`All streaming targets for "${modelRef}" are unavailable`, { code: 'UPSTREAM_ERROR', retryable: true });
  }
}

function dedupe(models: ModelRecord[]): ModelRecord[] {
  const seen = new Set<string>();
  return models.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

function connectionRetries(deps: RouterDeps, model: ModelRecord): number {
  const conn = deps.store.getConnection(model.connectionId);
  return conn?.maxRetries ?? 2;
}

export function asProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  return new ProviderError(err instanceof Error ? err.message : 'Unknown error', { code: 'UNKNOWN' });
}

export { estimateCostUsd };
