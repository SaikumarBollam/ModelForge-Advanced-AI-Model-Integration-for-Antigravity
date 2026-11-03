import type { ProviderConnection } from '@modelforge/shared-types';
import type { AdapterContext } from '@modelforge/provider-sdk';
import type { ProviderRegistry } from '@modelforge/provider-adapters';
import type { CredentialVault } from '@modelforge/security';
import { JsonStore, nowIso } from './store.js';
import { RoutingEngine, estimateCostUsd } from './routing.js';
import { DiagnosticsEngine } from './diagnostics.js';
import { randomUUID } from 'node:crypto';

/**
 * ModelForgeService — the application service layer used by the gateway's
 * REST API. Owns connections, discovery, model registry operations, routing
 * and diagnostics. Credentials live only in the vault; the store keeps
 * hasCredential flags + masked hints.
 */

export interface ServiceDeps {
  store: JsonStore;
  vault: CredentialVault;
  registry: ProviderRegistry;
  /** Injectable fetch (tests, custom transports). Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export class ModelForgeService {
  readonly router: RoutingEngine;
  readonly diagnostics: DiagnosticsEngine;

  constructor(private readonly deps: ServiceDeps) {
    this.router = new RoutingEngine({
      store: deps.store,
      resolveAdapter: (id) => deps.registry.getAdapter(id),
      resolveContext: (model) => {
        const conn = deps.store.getConnection(model.connectionId);
        if (!conn) throw new Error(`Connection ${model.connectionId} not found`);
        return this.contextFor(conn);
      },
      onUsage: ({ target, response, latencyMs, timeToFirstTokenMs, error }) => {
        const promptTokens = response?.usage.promptTokens ?? 0;
        const completionTokens = response?.usage.completionTokens ?? 0;
        deps.store.recordUsage({
          id: randomUUID(),
          timestamp: nowIso(),
          correlationId: randomUUID(),
          connectionId: target.model.connectionId,
          providerId: target.model.providerId,
          modelId: target.model.id,
          promptTokens,
          completionTokens,
          estimatedCostUsd: response ? estimateCostUsd(target.model, promptTokens, completionTokens) : undefined,
          costSource: target.model.pricing?.source,
          latencyMs,
          timeToFirstTokenMs,
          status: error ? 'error' : 'success',
          errorCode: error?.code,
          tokensEstimated: response?.usage.estimated ?? false,
        });
      },
    });
    this.diagnostics = new DiagnosticsEngine(
      (id) => deps.registry.getAdapter(id),
      (conn) => this.contextFor(conn),
    );
  }

  contextFor(conn: ProviderConnection): AdapterContext {
    const stored = this.deps.vault.get(conn.id);
    const def = this.deps.registry.getDefinition(conn.providerId);
    const envKey = def?.envVar ? process.env[def.envVar] : undefined;
    const perConnectionEnv = process.env[`MODELFORGE_KEY_${conn.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    return {
      connectionId: conn.id,
      baseUrl: conn.baseUrl,
      apiKey: stored ?? perConnectionEnv ?? envKey,
      timeoutMs: conn.timeoutMs,
      fetchFn: this.deps.fetchFn,
    };
  }

  // -- connections -------------------------------------------------------------
  createConnection(input: {
    providerId: string; label: string; baseUrl?: string; apiKey?: string;
    timeoutMs?: number; maxRetries?: number;
  }): ProviderConnection {
    const def = this.deps.registry.getDefinition(input.providerId);
    if (!def) throw new Error(`Unknown provider "${input.providerId}"`);
    const id = `conn_${randomUUID().slice(0, 8)}`;
    if (input.apiKey) this.deps.vault.set(id, input.apiKey);
    const conn: ProviderConnection = {
      id,
      providerId: input.providerId,
      label: input.label,
      baseUrl: (input.baseUrl ?? def.defaultBaseUrl).replace(/\/+$/, ''),
      enabled: true,
      hasCredential: Boolean(input.apiKey) || Boolean(def.envVar && process.env[def.envVar]),
      credentialHint: input.apiKey ? this.deps.vault.hint(id) : undefined,
      timeoutMs: input.timeoutMs ?? 60_000,
      maxRetries: input.maxRetries ?? 2,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    return this.deps.store.upsertConnection(conn);
  }

  updateConnection(id: string, patch: Partial<ProviderConnection> & { apiKey?: string }): ProviderConnection {
    const existing = this.deps.store.getConnection(id);
    if (!existing) throw new Error(`Connection ${id} not found`);
    if (patch.apiKey) {
      this.deps.vault.set(id, patch.apiKey);
      patch.hasCredential = true;
      patch.credentialHint = this.deps.vault.hint(id);
    }
    const { apiKey: _omit, ...rest } = patch;
    void _omit;
    return this.deps.store.upsertConnection({ ...existing, ...rest, id, updatedAt: nowIso() });
  }

  deleteConnection(id: string): void {
    this.deps.vault.delete(id);
    this.deps.store.deleteConnection(id);
  }

  // -- discovery -----------------------------------------------------------------
  async discoverModels(connectionId: string): Promise<{ discovered: number; models: ReturnType<JsonStore['listModels']> }> {
    const conn = this.deps.store.getConnection(connectionId);
    if (!conn) throw new Error(`Connection ${connectionId} not found`);
    const adapter = this.deps.registry.getAdapter(conn.providerId);
    if (!adapter) throw new Error(`No adapter for provider ${conn.providerId}`);
    const discovered = await adapter.listModels(this.contextFor(conn));
    for (const d of discovered) {
      const id = `${connectionId}:${d.providerModelId}`;
      const existing = this.deps.store.getModel(id);
      this.deps.store.upsertModel({
        id,
        connectionId,
        providerId: conn.providerId,
        providerModelId: d.providerModelId,
        displayName: d.displayName,
        enabled: existing?.enabled ?? true,
        source: existing?.source ?? 'discovered',
        capabilities: existing?.capabilities ?? d.capabilities ?? [],
        providerCapabilities: d.capabilities,
        contextWindow: d.contextWindow ?? existing?.contextWindow,
        maxOutputTokens: d.maxOutputTokens ?? existing?.maxOutputTokens,
        pricing: existing?.pricing,
        alias: existing?.alias,
        availability: 'available',
        lastSeenAt: nowIso(),
        createdAt: existing?.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      });
    }
    return { discovered: discovered.length, models: this.deps.store.listModels().filter((m) => m.connectionId === connectionId) };
  }
}
