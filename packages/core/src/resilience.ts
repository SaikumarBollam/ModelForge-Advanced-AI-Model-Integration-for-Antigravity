import { ProviderError, type ModelRecord } from '@modelforge/shared-types';

/**
 * Circuit breaker + retry policy used by the routing engine.
 * States: closed (normal) -> open (failing fast) -> half-open (one probe).
 */

export interface CircuitState {
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  openedAt?: number;
  lastLatencyMs?: number;
}

export class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitState>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  get(key: string): CircuitState {
    let circuit = this.circuits.get(key);
    if (!circuit) {
      circuit = { state: 'closed', failures: 0 };
      this.circuits.set(key, circuit);
    }
    if (circuit.state === 'open' && circuit.openedAt && Date.now() - circuit.openedAt >= this.cooldownMs) {
      circuit.state = 'half-open';
    }
    return circuit;
  }

  isAvailable(key: string): boolean {
    return this.get(key).state !== 'open';
  }

  recordSuccess(key: string, latencyMs: number): void {
    const circuit = this.get(key);
    circuit.state = 'closed';
    circuit.failures = 0;
    circuit.lastLatencyMs = latencyMs;
  }

  recordFailure(key: string): void {
    const circuit = this.get(key);
    circuit.failures += 1;
    if (circuit.state === 'half-open' || circuit.failures >= this.failureThreshold) {
      circuit.state = 'open';
      circuit.openedAt = Date.now();
    }
  }

  snapshot(): Record<string, CircuitState> {
    return Object.fromEntries([...this.circuits.entries()].map(([k, v]) => [k, { ...v }]));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter; only for errors flagged retryable. */
export async function withRetries<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; baseDelayMs?: number; signal?: AbortSignal },
): Promise<T> {
  const base = opts.baseDelayMs ?? 250;
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof ProviderError ? err.retryable : false;
      if (!retryable || attempt === opts.maxRetries) throw err;
      const delay = base * 2 ** attempt + Math.random() * 100;
      await sleep(delay);
      if (opts.signal?.aborted) throw err;
    }
  }
  throw lastError;
}

/** Estimated USD cost for a call. Returns undefined when pricing is unknown. */
export function estimateCostUsd(
  model: ModelRecord,
  promptTokens: number,
  completionTokens: number,
): number | undefined {
  const pricing = model.pricing;
  if (!pricing || (pricing.inputPerMillion === undefined && pricing.outputPerMillion === undefined)) {
    return undefined;
  }
  const input = ((pricing.inputPerMillion ?? 0) * promptTokens) / 1_000_000;
  const output = ((pricing.outputPerMillion ?? 0) * completionTokens) / 1_000_000;
  return Math.round((input + output) * 1e6) / 1e6;
}
