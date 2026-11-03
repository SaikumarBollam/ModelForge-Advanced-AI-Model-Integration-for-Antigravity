import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, getAdminKey, setAdminKey, streamChat, type ConnectionDto, type ModelDto } from '../api';
import { useUiStore, type Page } from '../store';

// ---------------------------------------------------------------------------
// Shared UI helpers
// ---------------------------------------------------------------------------

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="card text-sm text-zinc-400" role="status">{label}</div>;
}
export function ErrorBox({ error }: { error: unknown }) {
  return <div className="card border-red-900 bg-red-950/30 text-sm text-red-300" role="alert">{error instanceof Error ? error.message : String(error)}</div>;
}
export function Empty({ label }: { label: string }) {
  return <div className="card text-sm text-zinc-500">{label}</div>;
}
export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="text-xs uppercase tracking-wide text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-1 text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}
export function HealthBadge({ state }: { state: string }) {
  const cls = state === 'healthy' ? 'badge-green' : state === 'degraded' ? 'badge-amber' : state === 'down' ? 'badge-red' : 'badge-zinc';
  return <span className={cls}>{state}</span>;
}
export function StageBadge({ status }: { status: string }) {
  const cls = status === 'passed' ? 'badge-green' : status === 'failed' ? 'badge-red' : status === 'skipped' ? 'badge-zinc' : 'badge-amber';
  return <span className={cls}>{status}</span>;
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export function OverviewPage() {
  const summary = useQuery({ queryKey: ['summary'], queryFn: api.summary, refetchInterval: 10_000 });
  const health = useQuery({ queryKey: ['conn-health'], queryFn: api.connectionHealth, refetchInterval: 10_000 });
  const usage = useQuery({ queryKey: ['usage', 50], queryFn: () => api.usage(50) });
  const setPage = useUiStore((s) => s.setPage);

  const byProvider = useMemo(() => {
    const map = new Map<string, number>();
    for (const u of usage.data ?? []) map.set(u.providerId, (map.get(u.providerId) ?? 0) + 1);
    return [...map.entries()].map(([name, requests]) => ({ name, requests }));
  }, [usage.data]);

  if (summary.isLoading) return <Loading />;
  if (summary.error) return <ErrorBox error={summary.error} />;
  const s = summary.data!;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Requests" value={String(s.totalRequests)} />
        <Stat label="Total tokens" value={s.totalTokens.toLocaleString()} sub={`${s.promptTokens.toLocaleString()} in · ${s.completionTokens.toLocaleString()} out`} />
        <Stat label="Avg latency" value={`${s.avgLatencyMs} ms`} />
        <Stat label="Error rate" value={`${(s.errorRate * 100).toFixed(1)}%`} sub={s.estimatedCostUsd !== undefined ? `Est. cost \$${s.estimatedCostUsd.toFixed(4)}` : 'Cost unknown (no pricing configured)'} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h3 className="mb-3 font-medium">Requests by provider</h3>
          {byProvider.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={byProvider}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="name" stroke="#a1a1aa" fontSize={12} />
                <YAxis stroke="#a1a1aa" fontSize={12} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46' }} />
                <Bar dataKey="requests" fill="#338dff" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : <Empty label="No requests yet. Send one from the Playground." />}
        </div>
        <div className="card">
          <h3 className="mb-3 font-medium">Connection health</h3>
          {health.data?.length ? (
            <ul className="space-y-2">
              {health.data.map((h) => (
                <li key={h.connectionId} className="flex items-center justify-between text-sm">
                  <span>{h.label} <span className="text-zinc-500">({h.providerId})</span></span>
                  <span className="flex items-center gap-2">
                    {h.latencyMs !== undefined && <span className="text-xs text-zinc-500">{h.latencyMs} ms</span>}
                    <HealthBadge state={h.state} />
                  </span>
                </li>
              ))}
            </ul>
          ) : <Empty label="No connections configured yet." />}
          <button className="btn-ghost mt-4" onClick={() => setPage('providers')}>Manage providers</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export function ProvidersPage() {
  const queryClient = useQueryClient();
  const providers = useQuery({ queryKey: ['providers'], queryFn: api.providers });
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  const [form, setForm] = useState({ providerId: 'openai', label: '', baseUrl: '', apiKey: '' });
  const [filter, setFilter] = useState('');
  const setDiagnosticConnection = useUiStore((s) => s.setDiagnosticConnection);
  const setPage = useUiStore((s) => s.setPage);

  const create = useMutation({
    mutationFn: () => api.createConnection({
      providerId: form.providerId,
      label: form.label || providers.data?.find((p) => p.id === form.providerId)?.displayName || form.providerId,
      ...(form.baseUrl ? { baseUrl: form.baseUrl } : {}),
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['connections'] }); setForm({ ...form, label: '', apiKey: '' }); },
  });
  const discover = useMutation({
    mutationFn: (id: string) => api.discover(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['models'] }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['connections'] }); },
  });
  const toggle = useMutation({
    mutationFn: (c: ConnectionDto) => api.updateConnection(c.id, { enabled: !c.enabled }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['connections'] }); },
  });

  if (providers.isLoading || connections.isLoading) return <Loading />;
  if (providers.error) return <ErrorBox error={providers.error} />;
  const filteredProviders = (providers.data ?? []).filter((p) => `${p.displayName} ${p.id}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="card">
        <h3 className="mb-3 font-medium">Add connection</h3>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="label" htmlFor="prov">Provider</label>
            <select id="prov" className="input" value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
              {(providers.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.displayName} ({p.kind})</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="label">Label</label>
            <input id="label" className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Production" />
          </div>
          <div>
            <label className="label" htmlFor="base">Base URL (optional)</label>
            <input id="base" className="input" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder={providers.data?.find((p) => p.id === form.providerId)?.defaultBaseUrl} />
          </div>
          <div>
            <label className="label" htmlFor="key">API key (stored encrypted)</label>
            <input id="key" type="password" autoComplete="off" className="input" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-…" />
          </div>
          <div className="flex items-end">
            <button className="btn-primary w-full" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? 'Adding…' : 'Add connection'}
            </button>
          </div>
        </div>
        {create.error && <div className="mt-3"><ErrorBox error={create.error} /></div>}
        {providers.data?.find((p) => p.id === form.providerId)?.notes && (
          <p className="mt-2 text-xs text-zinc-500">{providers.data.find((p) => p.id === form.providerId)?.notes}</p>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-medium">Connections ({connections.data?.length ?? 0})</h3>
          <input className="input max-w-xs" placeholder="Filter provider catalog…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter providers" />
        </div>
        {connections.data?.length ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {connections.data.map((c) => (
              <div key={c.id} className="card space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium">{c.label}</div>
                    <div className="text-xs text-zinc-500">{c.providerId} · {c.id}</div>
                  </div>
                  <HealthBadge state={c.enabled ? 'healthy' : 'unknown'} />
                </div>
                <div className="break-all font-mono text-xs text-zinc-400">{c.baseUrl}</div>
                <div className="text-xs text-zinc-500">
                  Credential: {c.hasCredential ? <span className="font-mono">{c.credentialHint ?? 'stored'}</span> : <span className="text-amber-400">none configured</span>}
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button className="btn-ghost" disabled={discover.isPending} onClick={() => discover.mutate(c.id)}>Discover models</button>
                  <button className="btn-ghost" onClick={() => { setDiagnosticConnection(c.id); setPage('diagnostics'); }}>Diagnose</button>
                  <button className="btn-ghost" onClick={() => toggle.mutate(c)}>{c.enabled ? 'Disable' : 'Enable'}</button>
                  <button className="btn-danger" onClick={() => { if (confirm(`Delete connection "${c.label}"?`)) remove.mutate(c.id); }}>Delete</button>
                </div>
                {discover.isSuccess && discover.variables === c.id && <div className="text-xs text-emerald-400">Discovered {discover.data?.discovered} model(s)</div>}
                {discover.isError && discover.variables === c.id && <div className="text-xs text-red-400">{String((discover.error as Error).message)}</div>}
              </div>
            ))}
          </div>
        ) : <Empty label="No connections yet. Add one above — try Ollama or LM Studio locally, or any hosted provider." />}
      </div>

      <div className="card">
        <h3 className="mb-3 font-medium">Provider catalog ({filteredProviders.length})</h3>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {filteredProviders.map((p) => (
            <div key={p.id} className="rounded-lg border border-zinc-800 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{p.displayName}</span>
                <span className="badge-zinc">{p.kind}</span>
              </div>
              <div className="mt-1 font-mono text-xs text-zinc-500">{p.protocol}</div>
              <div className="mt-2 flex flex-wrap gap-1">
                {p.capabilities.map((cap) => <span key={cap} className="badge-blue">{cap}</span>)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model Catalog + Manager (shared table)
// ---------------------------------------------------------------------------

function ModelTable({ models, manage }: { models: ModelDto[]; manage?: boolean }) {
  const queryClient = useQueryClient();
  const setPlaygroundModel = useUiStore((s) => s.setPlaygroundModel);
  const setPage = useUiStore((s) => s.setPage);
  const update = useMutation({
    mutationFn: (args: { id: string; body: Record<string, unknown> }) => api.updateModel(args.id, args.body),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['models'] }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteModel(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['models'] }); },
  });
  const duplicate = useMutation({
    mutationFn: (id: string) => api.duplicateModel(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['models'] }); },
  });
  const [aliasDraft, setAliasDraft] = useState<Record<string, string>>({});

  if (!models.length) return <Empty label="No models match. Discover models from a connection or register one manually." />;
  return (
    <div className="card overflow-x-auto p-0">
      <table className="data">
        <thead>
          <tr><th>Model</th><th>Provider</th><th>Capabilities</th><th>Context</th><th>Source</th><th>Status</th>{manage && <th>Alias</th>}<th>Actions</th></tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.id}>
              <td>
                <div className="font-medium">{m.displayName}</div>
                <div className="font-mono text-xs text-zinc-500">{m.providerModelId}</div>
                {m.alias && <div className="font-mono text-xs text-forge-300">alias: {m.alias}</div>}
              </td>
              <td className="text-zinc-400">{m.providerId}</td>
              <td><div className="flex max-w-[220px] flex-wrap gap-1">{m.capabilities.map((c) => <span key={c} className="badge-blue">{c}</span>)}</div></td>
              <td className="text-zinc-400">{m.contextWindow ? m.contextWindow.toLocaleString() : '—'}</td>
              <td><span className="badge-zinc">{m.source}</span></td>
              <td>{m.enabled ? <span className="badge-green">enabled</span> : <span className="badge-zinc">disabled</span>}</td>
              {manage && (
                <td>
                  <div className="flex gap-1">
                    <input className="input w-28" placeholder="alias" value={aliasDraft[m.id] ?? m.alias ?? ''} onChange={(e) => setAliasDraft({ ...aliasDraft, [m.id]: e.target.value })} aria-label={`Alias for ${m.displayName}`} />
                    <button className="btn-ghost" onClick={() => update.mutate({ id: m.id, body: { alias: aliasDraft[m.id] || undefined } })}>Save</button>
                  </div>
                </td>
              )}
              <td>
                <div className="flex flex-wrap gap-1">
                  <button className="btn-ghost" onClick={() => { setPlaygroundModel(m.alias ?? m.id); setPage('playground'); }}>Test</button>
                  {manage && <>
                    <button className="btn-ghost" onClick={() => update.mutate({ id: m.id, body: { enabled: !m.enabled } })}>{m.enabled ? 'Disable' : 'Enable'}</button>
                    <button className="btn-ghost" onClick={() => duplicate.mutate(m.id)}>Duplicate</button>
                    <button className="btn-danger" onClick={() => { if (confirm(`Delete model "${m.displayName}"?`)) remove.mutate(m.id); }}>Delete</button>
                  </>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CatalogPage() {
  const [search, setSearch] = useState('');
  const [capability, setCapability] = useState('');
  const models = useQuery({ queryKey: ['models', search, capability], queryFn: () => api.models({ ...(search ? { search } : {}), ...(capability ? { capability } : {}) }) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <input className="input max-w-sm" placeholder="Search models…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search models" />
        <select className="input max-w-[200px]" value={capability} onChange={(e) => setCapability(e.target.value)} aria-label="Filter by capability">
          <option value="">All capabilities</option>
          {['text', 'coding', 'reasoning', 'vision', 'image-generation', 'audio', 'embeddings', 'tool-calling', 'structured-output'].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {models.isLoading ? <Loading /> : models.error ? <ErrorBox error={models.error} /> : <ModelTable models={models.data ?? []} />}
    </div>
  );
}

export function ManagerPage() {
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.models() });
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ connectionId: '', providerModelId: '', displayName: '', alias: '' });
  const create = useMutation({
    mutationFn: () => api.createModel({
      connectionId: form.connectionId || connections.data?.[0]?.id,
      providerModelId: form.providerModelId,
      ...(form.displayName ? { displayName: form.displayName } : {}),
      ...(form.alias ? { alias: form.alias } : {}),
    }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['models'] }); setForm({ ...form, providerModelId: '', displayName: '', alias: '' }); },
  });
  return (
    <div className="space-y-4">
      <div className="card">
        <h3 className="mb-3 font-medium">Register model manually</h3>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="label" htmlFor="mconn">Connection</label>
            <select id="mconn" className="input" value={form.connectionId} onChange={(e) => setForm({ ...form, connectionId: e.target.value })}>
              <option value="">Select…</option>
              {(connections.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.label} ({c.providerId})</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="mid">Provider model id</label>
            <input id="mid" className="input" value={form.providerModelId} onChange={(e) => setForm({ ...form, providerModelId: e.target.value })} placeholder="my-finetune-v2" />
          </div>
          <div>
            <label className="label" htmlFor="mname">Display name</label>
            <input id="mname" className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="malias">Alias</label>
            <input id="malias" className="input" value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value })} placeholder="fast-coder" />
          </div>
          <div className="flex items-end">
            <button className="btn-primary w-full" disabled={create.isPending || !form.providerModelId} onClick={() => create.mutate()}>Register</button>
          </div>
        </div>
        {create.error && <div className="mt-3"><ErrorBox error={create.error} /></div>}
      </div>
      {models.isLoading ? <Loading /> : models.error ? <ErrorBox error={models.error} /> : <ModelTable models={models.data ?? []} manage />}
    </div>
  );
}
