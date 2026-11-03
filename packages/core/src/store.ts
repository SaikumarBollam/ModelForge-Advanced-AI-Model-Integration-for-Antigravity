import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  FallbackChain, InferenceServer, ModelRecord, ProviderConnection, RoutingPolicy, UsageRecord,
} from '@modelforge/shared-types';

/**
 * JSON-file persistence for standalone deployments.
 *
 * The store is deliberately behind a small synchronous interface so a
 * Drizzle/PostgreSQL (or SQLite) implementation can replace it without
 * touching domain services. Writes are atomic (tmp + rename). Secrets are
 * never stored here — only vault references (hasCredential flags).
 */

export interface StoreData {
  version: number;
  connections: ProviderConnection[];
  models: ModelRecord[];
  fallbackChains: FallbackChain[];
  routingPolicies: RoutingPolicy[];
  servers: InferenceServer[];
  usage: UsageRecord[];
}

const EMPTY: StoreData = {
  version: 1, connections: [], models: [], fallbackChains: [], routingPolicies: [], servers: [], usage: [],
};

const MAX_USAGE_RECORDS = 5000;

export class JsonStore {
  private data: StoreData;
  private readonly filePath: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'modelforge.json');
    if (existsSync(this.filePath)) {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as StoreData;
      this.data = { ...EMPTY, ...parsed };
    } else {
      this.data = structuredClone(EMPTY);
      this.persist();
    }
  }

  private persist(): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  // -- connections -----------------------------------------------------------
  listConnections(): ProviderConnection[] { return [...this.data.connections]; }
  getConnection(id: string): ProviderConnection | undefined {
    return this.data.connections.find((c) => c.id === id);
  }
  upsertConnection(conn: ProviderConnection): ProviderConnection {
    const idx = this.data.connections.findIndex((c) => c.id === conn.id);
    if (idx >= 0) this.data.connections[idx] = conn; else this.data.connections.push(conn);
    this.persist();
    return conn;
  }
  deleteConnection(id: string): void {
    this.data.connections = this.data.connections.filter((c) => c.id !== id);
    this.data.models = this.data.models.filter((m) => m.connectionId !== id);
    this.persist();
  }

  // -- models ----------------------------------------------------------------
  listModels(): ModelRecord[] { return [...this.data.models]; }
  getModel(id: string): ModelRecord | undefined { return this.data.models.find((m) => m.id === id); }
  findByAlias(alias: string): ModelRecord | undefined {
    return this.data.models.find((m) => m.alias === alias && m.enabled);
  }
  findByProviderModelId(connectionId: string, providerModelId: string): ModelRecord | undefined {
    return this.data.models.find((m) => m.connectionId === connectionId && m.providerModelId === providerModelId);
  }
  upsertModel(model: ModelRecord): ModelRecord {
    const idx = this.data.models.findIndex((m) => m.id === model.id);
    if (idx >= 0) this.data.models[idx] = model; else this.data.models.push(model);
    this.persist();
    return model;
  }
  deleteModel(id: string): void {
    this.data.models = this.data.models.filter((m) => m.id !== id);
    this.persist();
  }

  // -- routing ----------------------------------------------------------------
  listFallbackChains(): FallbackChain[] { return [...this.data.fallbackChains]; }
  getFallbackChain(id: string): FallbackChain | undefined { return this.data.fallbackChains.find((c) => c.id === id); }
  upsertFallbackChain(chain: FallbackChain): FallbackChain {
    const idx = this.data.fallbackChains.findIndex((c) => c.id === chain.id);
    if (idx >= 0) this.data.fallbackChains[idx] = chain; else this.data.fallbackChains.push(chain);
    this.persist();
    return chain;
  }
  deleteFallbackChain(id: string): void {
    this.data.fallbackChains = this.data.fallbackChains.filter((c) => c.id !== id);
    this.persist();
  }
  listRoutingPolicies(): RoutingPolicy[] { return [...this.data.routingPolicies]; }
  upsertRoutingPolicy(policy: RoutingPolicy): RoutingPolicy {
    const idx = this.data.routingPolicies.findIndex((p) => p.id === policy.id);
    if (idx >= 0) this.data.routingPolicies[idx] = policy; else this.data.routingPolicies.push(policy);
    this.persist();
    return policy;
  }
  deleteRoutingPolicy(id: string): void {
    this.data.routingPolicies = this.data.routingPolicies.filter((p) => p.id !== id);
    this.persist();
  }

  // -- servers ------------------------------------------------------------------
  listServers(): InferenceServer[] { return [...this.data.servers]; }
  upsertServer(server: InferenceServer): InferenceServer {
    const idx = this.data.servers.findIndex((s) => s.id === server.id);
    if (idx >= 0) this.data.servers[idx] = server; else this.data.servers.push(server);
    this.persist();
    return server;
  }
  deleteServer(id: string): void {
    this.data.servers = this.data.servers.filter((s) => s.id !== id);
    this.persist();
  }

  // -- usage ---------------------------------------------------------------------
  recordUsage(record: UsageRecord): void {
    this.data.usage.push(record);
    if (this.data.usage.length > MAX_USAGE_RECORDS) {
      this.data.usage = this.data.usage.slice(-MAX_USAGE_RECORDS);
    }
    this.persist();
  }
  listUsage(limit = 200): UsageRecord[] {
    return [...this.data.usage].reverse().slice(0, limit);
  }

  exportConfig(): Omit<StoreData, 'usage'> {
    const { usage: _usage, ...rest } = this.data;
    return structuredClone(rest);
  }
  importConfig(config: Partial<StoreData>): void {
    // Secrets are never part of exports; hasCredential flags are preserved but
    // credentials themselves must be re-entered or restored from the vault.
    this.data = {
      ...structuredClone(EMPTY),
      ...config,
      usage: this.data.usage,
    };
    this.persist();
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
