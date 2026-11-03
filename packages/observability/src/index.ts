import { randomUUID } from 'node:crypto';
import { redactSecrets } from '@modelforge/security';

/**
 * Structured logging + in-memory metrics.
 *
 * Logs are JSON lines with correlation ids. Prompts and credentials are
 * never logged — callers pass metadata only, and every line is passed
 * through redactSecrets as a defense-in-depth measure. Metrics are exposed
 * in Prometheus text format at GET /metrics.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private readonly minLevel: LogLevel = 'info') {}

  private emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: redactSecrets(msg),
      ...(meta ? JSON.parse(redactSecrets(JSON.stringify(meta))) as Record<string, unknown> : {}),
    });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }

  debug(msg: string, meta?: Record<string, unknown>): void { this.emit('debug', msg, meta); }
  info(msg: string, meta?: Record<string, unknown>): void { this.emit('info', msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>): void { this.emit('warn', msg, meta); }
  error(msg: string, meta?: Record<string, unknown>): void { this.emit('error', msg, meta); }
}

export function newCorrelationId(): string {
  return randomUUID();
}

interface Counter { labels: Record<string, string>; value: number }

export class MetricsRegistry {
  private readonly counters = new Map<string, Counter>();
  private readonly latencySamples = new Map<string, number[]>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = `${name}|${JSON.stringify(labels)}`;
    const existing = this.counters.get(key);
    if (existing) existing.value += by;
    else this.counters.set(key, { labels, value: by });
  }

  observeLatency(name: string, labels: Record<string, string>, ms: number): void {
    const key = `${name}|${JSON.stringify(labels)}`;
    const samples = this.latencySamples.get(key) ?? [];
    samples.push(ms);
    if (samples.length > 500) samples.shift();
    this.latencySamples.set(key, samples);
  }

  averageLatency(name: string, labels: Record<string, string>): number | undefined {
    const samples = this.latencySamples.get(`${name}|${JSON.stringify(labels)}`);
    if (!samples?.length) return undefined;
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }

  toPrometheus(): string {
    const lines: string[] = [];
    for (const [key, counter] of this.counters) {
      const name = key.split('|')[0]!;
      const labels = Object.entries(counter.labels).map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(',');
      lines.push(`${name}{${labels}} ${counter.value}`);
    }
    for (const [key, samples] of this.latencySamples) {
      const name = key.split('|')[0]!;
      const labelsJson = key.slice(name.length + 1);
      const labels = Object.entries(JSON.parse(labelsJson) as Record<string, string>)
        .map(([k, v]) => `${k}="${v}"`).join(',');
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      lines.push(`${name}_average_ms{${labels}} ${avg.toFixed(2)}`);
      lines.push(`${name}_count{${labels}} ${samples.length}`);
    }
    return lines.join('\n') + '\n';
  }
}
