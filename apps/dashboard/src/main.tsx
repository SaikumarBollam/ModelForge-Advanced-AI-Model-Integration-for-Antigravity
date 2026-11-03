import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CatalogPage, ManagerPage, OverviewPage, ProvidersPage,
} from './pages/pages1';
import {
  CostsPage, DiagnosticsPage, FallbacksPage, GatewayPage, PlaygroundPage, RoutingPage, UsagePage,
} from './pages/pages2';
import { ConfigPage, GpuPage, HealthPage, SecurityPage, ServersPage } from './pages/pages3';
import { useUiStore, type Page } from './store';
import './index.css';

const NAV: Array<{ group: string; items: Array<{ id: Page; label: string }> }> = [
  { group: 'General', items: [{ id: 'overview', label: 'Overview' }] },
  {
    group: 'Models',
    items: [
      { id: 'providers', label: 'Providers' },
      { id: 'catalog', label: 'Model Catalog' },
      { id: 'manager', label: 'Model Manager' },
      { id: 'playground', label: 'Model Playground' },
    ],
  },
  {
    group: 'Gateway',
    items: [
      { id: 'gateway', label: 'Gateway & Antigravity' },
      { id: 'routing', label: 'Routing Policies' },
      { id: 'fallbacks', label: 'Fallback Chains' },
      { id: 'diagnostics', label: 'Diagnostics' },
    ],
  },
  {
    group: 'Analytics',
    items: [
      { id: 'usage', label: 'Usage Analytics' },
      { id: 'costs', label: 'Cost Analytics' },
    ],
  },
  {
    group: 'Infrastructure',
    items: [
      { id: 'local', label: 'Local Inference' },
      { id: 'gpu', label: 'GPU Infrastructure' },
      { id: 'servers', label: 'Remote Servers' },
    ],
  },
  {
    group: 'System',
    items: [
      { id: 'config', label: 'Configuration' },
      { id: 'security', label: 'Security' },
      { id: 'health', label: 'System Health' },
    ],
  },
];

const TITLES: Record<Page, string> = {
  overview: 'Overview', providers: 'Providers', catalog: 'Model Catalog', manager: 'Model Manager',
  playground: 'Model Playground', gateway: 'Gateway & Antigravity', routing: 'Routing Policies',
  fallbacks: 'Fallback Chains', diagnostics: 'Diagnostics', usage: 'Usage Analytics',
  costs: 'Cost Analytics', local: 'Local Inference', gpu: 'GPU Infrastructure',
  servers: 'Remote Servers', config: 'Configuration', security: 'Security', health: 'System Health',
};

function PageContent({ page }: { page: Page }) {
  switch (page) {
    case 'overview': return <OverviewPage />;
    case 'providers': return <ProvidersPage />;
    case 'catalog': return <CatalogPage />;
    case 'manager': return <ManagerPage />;
    case 'playground': return <PlaygroundPage />;
    case 'gateway': return <GatewayPage />;
    case 'routing': return <RoutingPage />;
    case 'fallbacks': return <FallbacksPage />;
    case 'diagnostics': return <DiagnosticsPage />;
    case 'usage': return <UsagePage />;
    case 'costs': return <CostsPage />;
    case 'local': return <ServersPage title="Local Inference" localOnly />;
    case 'gpu': return <GpuPage />;
    case 'servers': return <ServersPage title="Remote Servers" />;
    case 'config': return <ConfigPage />;
    case 'security': return <SecurityPage />;
    case 'health': return <HealthPage />;
  }
}

function App() {
  const page = useUiStore((s) => s.page);
  const setPage = useUiStore((s) => s.setPage);
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 overflow-y-auto border-r border-zinc-800 bg-zinc-950 p-4 md:block" aria-label="Primary">
        <div className="mb-1 text-lg font-bold tracking-tight">
          <span className="text-forge-400">Model</span>Forge
        </div>
        <div className="mb-5 text-xs text-zinc-500">Universal AI provider platform</div>
        <nav className="space-y-4">
          {NAV.map((group) => (
            <div key={group.group}>
              <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{group.group}</div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setPage(item.id)}
                  aria-current={page === item.id ? 'page' : undefined}
                  className={`block w-full rounded-lg px-2 py-1.5 text-left text-sm transition ${page === item.id ? 'bg-forge-950 text-forge-200' : 'text-zinc-300 hover:bg-zinc-900'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">{TITLES[page]}</h1>
          <select
            className="input max-w-[220px] md:hidden"
            value={page}
            onChange={(e) => setPage(e.target.value as Page)}
            aria-label="Navigate"
          >
            {NAV.flatMap((g) => g.items).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </header>
        <PageContent page={page} />
        <footer className="mt-8 text-xs text-zinc-600">
          ModelForge 0.1.0 · OpenAI-compatible gateway at <code className="font-mono">/v1</code> · Credentials encrypted at rest · No prompts logged
        </footer>
      </main>
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
