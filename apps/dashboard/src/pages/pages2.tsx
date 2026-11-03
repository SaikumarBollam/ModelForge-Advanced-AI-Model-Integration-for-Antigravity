import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, getAdminKey, setAdminKey, streamChat } from '../api';
import { useUiStore } from '../store';
import { Empty, ErrorBox, HealthBadge, Loading, StageBadge, Stat } from './pages1';

// ---------------------------------------------------------------------------
// Playground
// ---------------------------------------------------------------------------

interface RunMetrics { ttftMs?: number; totalMs: number; tokens?: number; tps?: number; estimated: boolean }

export function PlaygroundPage() {
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.models() });
  const playgroundModel = useUiStore((s) => s.playgroundModel);
  const setPlaygroundModel = useUiStore((s) => s.setPlaygroundModel);
  const [system, setSystem] = useState('You are a helpful assistant.');
  const [prompt, setPrompt] = useState('Explain circuit breakers in two sentences.');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(512);
  const [useStream, setUseStream] = useState(true);
  const [output, setOutput] = useState('');
  const [metrics, setMetrics] = useState<RunMetrics | null>(null);
  const [compareModel, setCompareModel] = useState('');
  const [compareOutput, setCompareOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef(false);

  const enabledModels = (models.data ?? []).filter((m) => m.enabled);
  const selected = playgroundModel || enabledModels[0]?.alias || enabledModels[0]?.id || '';

  async function runOne(model: string, setter: (s: string) => void): Promise<RunMetrics> {
    const started = performance.now();
    let firstAt: number | undefined;
    let text = '';
    let usage: { completion_tokens?: number } | undefined;
    if (useStream) {
      for await (const chunk of streamChat({
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        temperature, max_tokens: maxTokens,
      })) {
        if (abortRef.current) break;
        if (!firstAt && chunk.delta) firstAt = performance.now();
        text += chunk.delta;
        setter(text);
        if (chunk.usage) usage = chunk.usage as { completion_tokens?: number };
      }
    } else {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }],
          temperature, max_tokens: maxTokens,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const json = (await res.json()) as { choices: Array<{ message: { content: string } }>; usage: { completion_tokens: number } };
      text = json.choices[0]?.message.content ?? '';
      usage = json.usage;
      setter(text);
    }
    const totalMs = performance.now() - started;
    const tokens = usage?.completion_tokens;
    return {
      ttftMs: firstAt ? Math.round(firstAt - started) : undefined,
      totalMs: Math.round(totalMs),
      tokens,
      tps: tokens ? Math.round((tokens / (totalMs / 1000)) * 10) / 10 : undefined,
      estimated: !usage,
    };
  }

  async function run() {
    if (!selected) return;
    setRunning(true); setError(null); setOutput(''); setCompareOutput(''); setMetrics(null);
    abortRef.current = false;
    try {
      const m = await runOne(selected, setOutput);
      setMetrics(m);
      if (compareModel) await runOne(compareModel, setCompareOutput);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="card grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="pg-model">Model (alias, id, chain:… or policy:…)</label>
          <input id="pg-model" className="input" list="pg-models" value={selected} onChange={(e) => setPlaygroundModel(e.target.value)} />
          <datalist id="pg-models">
            {enabledModels.map((m) => <option key={m.id} value={m.alias ?? m.id}>{m.displayName} — {m.providerId}</option>)}
          </datalist>
        </div>
        <div>
          <label className="label" htmlFor="pg-compare">Compare with (optional)</label>
          <input id="pg-compare" className="input" list="pg-models" value={compareModel} onChange={(e) => setCompareModel(e.target.value)} placeholder="second model" />
        </div>
        <div>
          <label className="label" htmlFor="pg-temp">Temperature: {temperature}</label>
          <input id="pg-temp" type="range" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="w-full" />
        </div>
        <div>
          <label className="label" htmlFor="pg-max">Max output tokens</label>
          <input id="pg-max" type="number" className="input" value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} />
        </div>
        <div className="md:col-span-2">
          <label className="label" htmlFor="pg-system">System prompt</label>
          <input id="pg-system" className="input" value={system} onChange={(e) => setSystem(e.target.value)} />
        </div>
        <div className="flex items-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useStream} onChange={(e) => setUseStream(e.target.checked)} /> Streaming
          </label>
          <button className="btn-primary" disabled={running || !selected} onClick={() => void run()}>{running ? 'Running…' : 'Run'}</button>
          {running && <button className="btn-ghost" onClick={() => { abortRef.current = true; }}>Stop</button>}
        </div>
      </div>
      <div className="card">
        <label className="label" htmlFor="pg-prompt">Prompt</label>
        <textarea id="pg-prompt" className="input min-h-[90px]" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </div>
      {error && <ErrorBox error={new Error(error)} />}
      {metrics && (
        <div className="flex flex-wrap gap-2 text-xs text-zinc-400" aria-live="polite">
          {metrics.ttftMs !== undefined && <span className="badge-blue">TTFT {metrics.ttftMs} ms</span>}
          <span className="badge-blue">Total {metrics.totalMs} ms</span>
          {metrics.tokens !== undefined && <span className="badge-blue">{metrics.tokens} output tokens ({metrics.estimated ? 'estimated' : 'provider-reported'})</span>}
          {metrics.tps !== undefined && <span className="badge-blue">{metrics.tps} tok/s</span>}
        </div>
      )}
      <div className={`grid gap-4 ${compareModel ? 'lg:grid-cols-2' : ''}`}>
        <div className="card">
          <h3 className="mb-2 font-mono text-xs text-zinc-500">{selected || 'No model selected'}</h3>
          <pre className="whitespace-pre-wrap text-sm">{output || <span className="text-zinc-600">Output will appear here…</span>}</pre>
        </div>
        {compareModel && (
          <div className="card">
            <h3 className="mb-2 font-mono text-xs text-zinc-500">{compareModel}</h3>
            <pre className="whitespace-pre-wrap text-sm">{compareOutput || <span className="text-zinc-600">Comparison output…</span>}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Gateway info
// ---------------------------------------------------------------------------

export function GatewayPage() {
  const antigravity = useQuery({ queryKey: ['antigravity'], queryFn: api.antigravity });
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.models() });
  const enabled = (models.data ?? []).filter((m) => m.enabled);
  return (
    <div className="space-y-4">
      <div className="card space-y-2">
        <h3 className="font-medium">OpenAI-compatible gateway</h3>
        <p className="text-sm text-zinc-400">
          Point any OpenAI-compatible client (including Antigravity clients that accept a custom base URL) at this gateway.
          Model names may be an alias, a full model id, <code className="font-mono text-forge-300">chain:&lt;id&gt;</code> for a fallback chain,
          or <code className="font-mono text-forge-300">policy:&lt;id&gt;</code> for a routing policy.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs">{`curl http://127.0.0.1:8787/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${enabled[0]?.alias ?? 'your-alias'}","messages":[{"role":"user","content":"Hello"}]}'`}</pre>
        <div className="text-xs text-zinc-500">Streaming (SSE), retries, circuit breakers and fallback chains are applied by the routing engine. Set <code className="font-mono">MODELFORGE_GATEWAY_API_KEY</code> to require a Bearer key.</div>
      </div>
      <div className="card space-y-2">
        <h3 className="font-medium">Antigravity integration</h3>
        {antigravity.isLoading ? <Loading /> : antigravity.error ? <ErrorBox error={antigravity.error} /> : (
          <>
            <div className="text-sm">Gateway URL: <code className="font-mono text-forge-300">{antigravity.data?.gatewayUrl}</code></div>
            <div className="text-sm">Supported mechanism: <span className="badge-blue">{antigravity.data?.supportedMechanism}</span></div>
            {antigravity.data?.installs.length ? (
              <ul className="space-y-1 text-sm">
                {antigravity.data.installs.map((i) => (
                  <li key={i.path} className="flex flex-wrap items-center gap-2">
                    <span className="badge-zinc">{i.kind}</span>
                    <code className="font-mono text-xs">{i.path}</code>
                    {i.version && <span className="text-xs text-zinc-500">v{i.version}</span>}
                  </li>
                ))}
              </ul>
            ) : <div className="text-sm text-zinc-500">No Antigravity installation detected in standard locations.</div>}
            <ul className="list-inside list-disc space-y-1 text-xs text-zinc-500">
              {antigravity.data?.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Routing policies & fallback chains
// ---------------------------------------------------------------------------

export function RoutingPage() {
  const queryClient = useQueryClient();
  const policies = useQuery({ queryKey: ['policies'], queryFn: api.policies });
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.models() });
  const [form, setForm] = useState({ name: '', strategy: 'explicit', candidates: '' });
  const create = useMutation({
    mutationFn: () => api.createPolicy({ name: form.name, strategy: form.strategy, candidates: form.candidates.split(',').map((s) => s.trim()).filter(Boolean) }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['policies'] }); setForm({ name: '', strategy: 'explicit', candidates: '' }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deletePolicy(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['policies'] }); },
  });
  return (
    <div className="space-y-4">
      <div className="card">
        <h3 className="mb-3 font-medium">New routing policy</h3>
        <div className="grid gap-3 md:grid-cols-4">
          <div><label className="label" htmlFor="pol-name">Name</label><input id="pol-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Best coding model" /></div>
          <div>
            <label className="label" htmlFor="pol-strategy">Strategy</label>
            <select id="pol-strategy" className="input" value={form.strategy} onChange={(e) => setForm({ ...form, strategy: e.target.value })}>
              <option value="explicit">Explicit order (deterministic)</option>
              <option value="lowest-latency">Lowest latency</option>
              <option value="lowest-cost">Lowest cost</option>
              <option value="round-robin">Round robin</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="pol-candidates">Candidates (comma-separated aliases or ids)</label>
            <input id="pol-candidates" className="input" list="all-models" value={form.candidates} onChange={(e) => setForm({ ...form, candidates: e.target.value })} placeholder="fast-coder, deep-reasoner" />
            <datalist id="all-models">{(models.data ?? []).map((m) => <option key={m.id} value={m.alias ?? m.id} />)}</datalist>
          </div>
        </div>
        <button className="btn-primary mt-3" disabled={create.isPending || !form.name} onClick={() => create.mutate()}>Create policy</button>
        {create.error && <div className="mt-3"><ErrorBox error={create.error} /></div>}
        <p className="mt-2 text-xs text-zinc-500">Use as model name <code className="font-mono">policy:&lt;id&gt;</code> in any client. Routing is deterministic by default; latency/cost strategies use recorded metrics and configured pricing.</p>
      </div>
      {policies.isLoading ? <Loading /> : policies.data?.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {policies.data.map((p) => (
            <div key={p.id} className="card space-y-2">
              <div className="flex items-center justify-between"><span className="font-medium">{p.name}</span><span className="badge-blue">{p.strategy}</span></div>
              <div className="font-mono text-xs text-zinc-500">policy:{p.id}</div>
              <div className="flex flex-wrap gap-1">{p.candidates.map((c) => <span key={c} className="badge-zinc">{c}</span>)}</div>
              <button className="btn-danger" onClick={() => { if (confirm('Delete this policy?')) remove.mutate(p.id); }}>Delete</button>
            </div>
          ))}
        </div>
      ) : <Empty label="No routing policies yet." />}
    </div>
  );
}

export function FallbacksPage() {
  const queryClient = useQueryClient();
  const chains = useQuery({ queryKey: ['chains'], queryFn: api.chains });
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.models() });
  const [form, setForm] = useState({ name: '', targets: '' });
  const create = useMutation({
    mutationFn: () => api.createChain({ name: form.name, targets: form.targets.split(',').map((s) => s.trim()).filter(Boolean) }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['chains'] }); setForm({ name: '', targets: '' }); },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteChain(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['chains'] }); },
  });
  return (
    <div className="space-y-4">
      <div className="card">
        <h3 className="mb-3 font-medium">New fallback chain</h3>
        <div className="grid gap-3 md:grid-cols-3">
          <div><label className="label" htmlFor="chain-name">Name</label><input id="chain-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Primary → backup" /></div>
          <div className="md:col-span-2">
            <label className="label" htmlFor="chain-targets">Targets in order (comma-separated)</label>
            <input id="chain-targets" className="input" list="all-models" value={form.targets} onChange={(e) => setForm({ ...form, targets: e.target.value })} placeholder="gpt-alias, claude-alias, local-llama" />
            <datalist id="all-models">{(models.data ?? []).map((m) => <option key={m.id} value={m.alias ?? m.id} />)}</datalist>
          </div>
        </div>
        <button className="btn-primary mt-3" disabled={create.isPending || !form.name} onClick={() => create.mutate()}>Create chain</button>
        {create.error && <div className="mt-3"><ErrorBox error={create.error} /></div>}
        <p className="mt-2 text-xs text-zinc-500">Targets are tried in order on retryable failures (5xx, timeouts, rate limits) or open circuit breakers. Use as model name <code className="font-mono">chain:&lt;id&gt;</code>.</p>
      </div>
      {chains.isLoading ? <Loading /> : chains.data?.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {chains.data.map((c) => (
            <div key={c.id} className="card space-y-2">
              <div className="flex items-center justify-between"><span className="font-medium">{c.name}</span><span className="badge-zinc">{c.enabled ? 'enabled' : 'disabled'}</span></div>
              <div className="font-mono text-xs text-zinc-500">chain:{c.id}</div>
              <ol className="list-inside list-decimal space-y-1 text-sm text-zinc-300">
                {c.targets.map((t) => <li key={t} className="font-mono text-xs">{t}</li>)}
              </ol>
              <button className="btn-danger" onClick={() => { if (confirm('Delete this chain?')) remove.mutate(c.id); }}>Delete</button>
            </div>
          ))}
        </div>
      ) : <Empty label="No fallback chains yet." />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export function DiagnosticsPage() {
  const connections = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.models() });
  const diagnosticConnection = useUiStore((s) => s.diagnosticConnection);
  const setDiagnosticConnection = useUiStore((s) => s.setDiagnosticConnection);
  const [modelId, setModelId] = useState('');
  const [opts, setOpts] = useState({ testGeneration: true, testStreaming: true, testTools: false });
  const run = useMutation({ mutationFn: () => api.diagnose(diagnosticConnection, { ...(modelId ? { modelId } : {}), ...opts }) });
  const connModels = (models.data ?? []).filter((m) => m.connectionId === diagnosticConnection);
  const report = run.data;

  return (
    <div className="space-y-4">
      <div className="card grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="diag-conn">Connection</label>
          <select id="diag-conn" className="input" value={diagnosticConnection} onChange={(e) => { setDiagnosticConnection(e.target.value); setModelId(''); }}>
            <option value="">Select…</option>
            {(connections.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.label} ({c.providerId})</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="diag-model">Model (for generation tests)</label>
          <select id="diag-model" className="input" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            <option value="">None</option>
            {connModels.map((m) => <option key={m.id} value={m.providerModelId}>{m.displayName}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={opts.testGeneration} onChange={(e) => setOpts({ ...opts, testGeneration: e.target.checked })} /> Generation test</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={opts.testStreaming} onChange={(e) => setOpts({ ...opts, testStreaming: e.target.checked })} /> Streaming test</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={opts.testTools} onChange={(e) => setOpts({ ...opts, testTools: e.target.checked })} /> Tool-calling test</label>
        </div>
        <div className="flex items-end">
          <button className="btn-primary w-full" disabled={!diagnosticConnection || run.isPending} onClick={() => run.mutate()}>{run.isPending ? 'Running…' : 'Run diagnostics'}</button>
        </div>
      </div>
      <p className="text-xs text-zinc-500">Each stage is reported independently. A connection is only marked generation-verified when a real generation (and streaming, if requested) succeeds — model listing alone never counts as a full test.</p>
      {run.error && <ErrorBox error={run.error} />}
      {report && (
        <div className="card space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Report</span>
            {report.generationVerified ? <span className="badge-green">generation verified</span> : <span className="badge-amber">generation not verified</span>}
            <span className="text-xs text-zinc-500">{report.durationMs} ms total</span>
          </div>
          <table className="data">
            <thead><tr><th>Stage</th><th>Status</th><th>Detail</th><th>Duration</th></tr></thead>
            <tbody>
              {report.stages.map((s) => (
                <tr key={s.stage}>
                  <td className="font-mono text-xs">{s.stage}</td>
                  <td><StageBadge status={s.status} /></td>
                  <td className="text-zinc-300">{s.detail}{s.httpStatus ? ` (HTTP ${s.httpStatus})` : ''}</td>
                  <td className="text-zinc-500">{s.durationMs !== undefined ? `${s.durationMs} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage & costs
// ---------------------------------------------------------------------------

export function UsagePage() {
  const usage = useQuery({ queryKey: ['usage', 200], queryFn: () => api.usage(200), refetchInterval: 15_000 });
  const chartData = useMemo(() => [...(usage.data ?? [])].reverse().map((u, i) => ({
    i, tokens: u.promptTokens + u.completionTokens, latency: u.latencyMs,
  })), [usage.data]);
  if (usage.isLoading) return <Loading />;
  if (usage.error) return <ErrorBox error={usage.error} />;
  return (
    <div className="space-y-4">
      <div className="card">
        <h3 className="mb-3 font-medium">Token volume & latency (recent requests)</h3>
        {chartData.length ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="i" stroke="#a1a1aa" fontSize={12} />
              <YAxis stroke="#a1a1aa" fontSize={12} />
              <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46' }} />
              <Area type="monotone" dataKey="tokens" stroke="#338dff" fill="#1b6ef5" fillOpacity={0.25} />
            </AreaChart>
          </ResponsiveContainer>
        ) : <Empty label="No usage recorded yet." />}
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="data">
          <thead><tr><th>Time</th><th>Provider</th><th>Model</th><th>Tokens (in/out)</th><th>Latency</th><th>TTFT</th><th>Status</th></tr></thead>
          <tbody>
            {(usage.data ?? []).map((u) => (
              <tr key={u.id}>
                <td className="whitespace-nowrap text-xs text-zinc-400">{new Date(u.timestamp).toLocaleString()}</td>
                <td>{u.providerId}</td>
                <td className="font-mono text-xs">{u.modelId}</td>
                <td>{u.promptTokens}/{u.completionTokens}{u.tokensEstimated ? ' (est.)' : ''}</td>
                <td>{u.latencyMs} ms</td>
                <td>{u.timeToFirstTokenMs !== undefined ? `${u.timeToFirstTokenMs} ms` : '—'}</td>
                <td>{u.status === 'success' ? <span className="badge-green">success</span> : <span className="badge-red">{u.errorCode ?? 'error'}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!usage.data?.length && <div className="p-4"><Empty label="No requests yet." /></div>}
      </div>
    </div>
  );
}

export function CostsPage() {
  const summary = useQuery({ queryKey: ['summary'], queryFn: api.summary });
  const usage = useQuery({ queryKey: ['usage', 500], queryFn: () => api.usage(500) });
  const byModel = useMemo(() => {
    const map = new Map<string, { model: string; cost: number; tokens: number }>();
    for (const u of usage.data ?? []) {
      const entry = map.get(u.modelId) ?? { model: u.modelId, cost: 0, tokens: 0 };
      entry.cost += u.estimatedCostUsd ?? 0;
      entry.tokens += u.promptTokens + u.completionTokens;
      map.set(u.modelId, entry);
    }
    return [...map.values()].sort((a, b) => b.cost - a.cost);
  }, [usage.data]);
  if (summary.isLoading) return <Loading />;
  if (summary.error) return <ErrorBox error={summary.error} />;
  const s = summary.data!;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Stat label="Estimated cost" value={s.estimatedCostUsd !== undefined ? `\$${s.estimatedCostUsd.toFixed(4)}` : 'Unknown'} sub="Only computed when pricing is configured on a model" />
        <Stat label="Total tokens" value={s.totalTokens.toLocaleString()} />
        <Stat label="Requests" value={String(s.totalRequests)} />
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="data">
          <thead><tr><th>Model</th><th>Tokens</th><th>Estimated cost (USD)</th></tr></thead>
          <tbody>
            {byModel.map((r) => (
              <tr key={r.model}><td className="font-mono text-xs">{r.model}</td><td>{r.tokens.toLocaleString()}</td><td>{r.cost ? `\$${r.cost.toFixed(4)}` : '—'}</td></tr>
            ))}
          </tbody>
        </table>
        {!byModel.length && <div className="p-4"><Empty label="No usage yet. Costs appear once models with pricing metadata serve requests." /></div>}
      </div>
      <p className="text-xs text-zinc-500">Costs are estimates from configured per-model pricing — clearly labeled, never presented as provider-billed amounts.</p>
    </div>
  );
}
