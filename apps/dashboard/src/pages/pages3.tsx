import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, getAdminKey, setAdminKey } from '../api';
import { Empty, ErrorBox, HealthBadge, Loading, Stat } from './pages1';

// ---------------------------------------------------------------------------
// Local inference / GPU / remote servers
// ---------------------------------------------------------------------------

const LOCAL_PRESETS = [
  { kind: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { kind: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' },
  { kind: 'vllm', label: 'vLLM', baseUrl: 'http://127.0.0.1:8000/v1' },
  { kind: 'llamacpp', label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080/v1' },
  { kind: 'localai', label: 'LocalAI', baseUrl: 'http://127.0.0.1:8080/v1' },
] as const;

export function ServersPage({ title, localOnly }: { title: string; localOnly?: boolean }) {
  const queryClient = useQueryClient();
  const servers = useQuery({ queryKey: ['servers'], queryFn: api.servers });
  const [form, setForm] = useState({ label: '', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' });
  const create = useMutation({
    mutationFn: () => api.createServer(form),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['servers'] }); setForm({ ...form, label: '' }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteServer(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['servers'] }); },
  });
  const health = useMutation({
    mutationFn: (id: string) => api.serverHealth(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['servers'] }); },
  });

  return (
    <div className="space-y-4">
      <div className="card">
        <h3 className="mb-3 font-medium">Register inference server</h3>
        {localOnly && (
          <div className="mb-3 flex flex-wrap gap-2">
            {LOCAL_PRESETS.map((p) => (
              <button key={p.kind} className="btn-ghost" onClick={() => setForm({ label: p.label, kind: p.kind, baseUrl: p.baseUrl })}>{p.label}</button>
            ))}
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-4">
          <div><label className="label" htmlFor="srv-label">Label</label><input id="srv-label" className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Workstation GPU box" /></div>
          <div>
            <label className="label" htmlFor="srv-kind">Runtime</label>
            <select id="srv-kind" className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {['ollama', 'lmstudio', 'vllm', 'llamacpp', 'localai', 'textgen-webui', 'custom'].map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div className="md:col-span-2"><label className="label" htmlFor="srv-url">Base URL</label><input id="srv-url" className="input" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></div>
        </div>
        <button className="btn-primary mt-3" disabled={create.isPending || !form.label} onClick={() => create.mutate()}>Register server</button>
        {create.error && <div className="mt-3"><ErrorBox error={create.error} /></div>}
        <p className="mt-2 text-xs text-zinc-500">
          Registering tracks the endpoint and its health. To route traffic to it, also add a matching provider connection
          (Providers page) — ModelForge integrates runtimes like vLLM/Ollama rather than reimplementing distributed inference.
        </p>
      </div>
      {servers.isLoading ? <Loading /> : servers.data?.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {servers.data.map((s) => (
            <div key={s.id} className="card space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">{s.label}</span>
                <HealthBadge state={s.lastHealth ?? 'unknown'} />
              </div>
              <div className="text-xs text-zinc-500">{s.kind} · {s.host}</div>
              <div className="break-all font-mono text-xs text-zinc-400">{s.baseUrl}</div>
              <div className="flex gap-2">
                <button className="btn-ghost" disabled={health.isPending} onClick={() => health.mutate(s.id)}>Check health</button>
                <button className="btn-danger" onClick={() => { if (confirm('Remove this server?')) remove.mutate(s.id); }}>Remove</button>
              </div>
              {health.isSuccess && health.variables === s.id && <div className="text-xs text-zinc-400">Checked — see health badge.</div>}
            </div>
          ))}
        </div>
      ) : <Empty label={`No ${title.toLowerCase()} registered yet.`} />}
    </div>
  );
}

export function GpuPage() {
  const gpus = useQuery({ queryKey: ['gpus'], queryFn: api.gpus });
  if (gpus.isLoading) return <Loading label="Detecting GPUs via nvidia-smi…" />;
  if (gpus.error) return <ErrorBox error={gpus.error} />;
  const data = gpus.data!;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Stat label="GPUs detected" value={String(data.gpus.length)} sub={data.detected ? 'via nvidia-smi' : 'nvidia-smi not found or no NVIDIA GPU'} />
        <Stat label="CUDA version" value={data.cudaVersion ?? '—'} />
        <Stat label="Driver" value={data.gpus[0]?.driverVersion ?? '—'} />
      </div>
      {data.gpus.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {data.gpus.map((g) => {
            const usedPct = g.memoryTotalMb ? Math.round(((g.memoryUsedMb ?? 0) / g.memoryTotalMb) * 100) : 0;
            return (
              <div key={g.index} className="card space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">GPU {g.index}: {g.name}</span>
                  <span className="badge-blue">{g.utilizationPct ?? 0}% util</span>
                </div>
                <div className="h-2 overflow-hidden rounded bg-zinc-800" role="progressbar" aria-valuenow={usedPct} aria-valuemin={0} aria-valuemax={100} aria-label="GPU memory usage">
                  <div className="h-full bg-forge-500" style={{ width: `${usedPct}%` }} />
                </div>
                <div className="text-xs text-zinc-500">
                  Memory {g.memoryUsedMb?.toLocaleString()} / {g.memoryTotalMb?.toLocaleString()} MiB ({usedPct}%)
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty label="No NVIDIA GPU detected on the gateway host. Remote GPU machines can be registered under Remote Servers; multi-node inference is delegated to runtimes such as vLLM." />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuration / Security / System health
// ---------------------------------------------------------------------------

export function ConfigPage() {
  const [message, setMessage] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const doExport = async () => {
    const data = await api.exportConfig();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'modelforge-config.json'; a.click();
    URL.revokeObjectURL(url);
    setMessage(`Exported. Includes secrets: ${data.includesSecrets ? 'yes' : 'no (credentials are never exported)'}.`);
  };
  const doImport = async () => {
    try {
      const parsed = JSON.parse(importText) as { config?: unknown };
      await api.importConfig(parsed.config ?? parsed);
      setMessage('Configuration imported. Credentials must be re-entered (exports never contain secrets).');
    } catch (err) {
      setMessage(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <h3 className="font-medium">Export configuration</h3>
        <p className="text-sm text-zinc-400">Exports connections, models, chains, policies and servers. API keys are never included — only credential-presence flags.</p>
        <button className="btn-primary" onClick={() => void doExport()}>Download config JSON</button>
      </div>
      <div className="card space-y-3">
        <h3 className="font-medium">Import configuration</h3>
        <textarea className="input min-h-[140px] font-mono text-xs" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"config": { … }}' aria-label="Configuration JSON to import" />
        <button className="btn-ghost" disabled={!importText} onClick={() => void doImport()}>Import</button>
      </div>
      {message && <div className="card text-sm text-zinc-300" role="status">{message}</div>}
    </div>
  );
}

export function SecurityPage() {
  const [key, setKey] = useState(getAdminKey());
  return (
    <div className="space-y-4">
      <div className="card space-y-3">
        <h3 className="font-medium">Admin API key</h3>
        <p className="text-sm text-zinc-400">
          When <code className="font-mono">MODELFORGE_ADMIN_API_KEY</code> is set on the gateway, the dashboard must present it.
          It is kept in sessionStorage only and cleared when the tab closes.
        </p>
        <div className="flex gap-2">
          <input type="password" className="input max-w-md" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Admin API key" aria-label="Admin API key" autoComplete="off" />
          <button className="btn-primary" onClick={() => setAdminKey(key)}>Save for session</button>
          <button className="btn-ghost" onClick={() => { setKey(''); setAdminKey(''); }}>Clear</button>
        </div>
      </div>
      <div className="card space-y-2 text-sm text-zinc-300">
        <h3 className="font-medium text-zinc-100">Security posture</h3>
        <ul className="list-inside list-disc space-y-1">
          <li>Provider credentials are encrypted at rest (AES-256-GCM) in the vault; the database stores only masked hints.</li>
          <li>Exports never contain secrets. Logs redact credential-shaped strings and never include prompts.</li>
          <li>Upstream URLs pass an SSRF guard; private/loopback targets require <code className="font-mono">MODELFORGE_ALLOW_PRIVATE_UPSTREAMS</code>.</li>
          <li>The gateway binds to loopback by default. Set gateway/admin API keys before exposing it remotely, and terminate TLS at a reverse proxy.</li>
          <li>Request bodies are size-capped and schema-validated (Zod) on every route.</li>
        </ul>
      </div>
    </div>
  );
}

export function HealthPage() {
  const health = useQuery({ queryKey: ['conn-health'], queryFn: api.connectionHealth, refetchInterval: 10_000 });
  const summary = useQuery({ queryKey: ['summary'], queryFn: api.summary, refetchInterval: 10_000 });
  if (health.isLoading) return <Loading />;
  if (health.error) return <ErrorBox error={health.error} />;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Stat label="Gateway" value="ok" sub="GET /health" />
        <Stat label="Avg latency" value={`${summary.data?.avgLatencyMs ?? 0} ms`} />
        <Stat label="Error rate" value={`${((summary.data?.errorRate ?? 0) * 100).toFixed(1)}%`} />
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="data">
          <thead><tr><th>Connection</th><th>Provider</th><th>State</th><th>Circuit breaker</th><th>Last latency</th></tr></thead>
          <tbody>
            {(health.data ?? []).map((h) => (
              <tr key={h.connectionId}>
                <td>{h.label}</td>
                <td className="text-zinc-400">{h.providerId}</td>
                <td><HealthBadge state={h.state} /></td>
                <td><span className={h.circuit === 'open' ? 'badge-red' : h.circuit === 'half-open' ? 'badge-amber' : 'badge-green'}>{h.circuit}</span></td>
                <td className="text-zinc-400">{h.latencyMs !== undefined ? `${h.latencyMs} ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!health.data?.length && <div className="p-4"><Empty label="No connections configured." /></div>}
      </div>
      <p className="text-xs text-zinc-500">Prometheus metrics are exposed at <code className="font-mono">GET /metrics</code> on the gateway. Circuit breakers open after repeated failures and half-open automatically for a probe request.</p>
    </div>
  );
}
