import { create } from 'zustand';

export type Page =
  | 'overview' | 'providers' | 'catalog' | 'manager' | 'playground'
  | 'gateway' | 'routing' | 'fallbacks' | 'diagnostics' | 'usage'
  | 'costs' | 'local' | 'gpu' | 'servers' | 'config' | 'security' | 'health';

interface UiState {
  page: Page;
  setPage: (page: Page) => void;
  playgroundModel: string;
  setPlaygroundModel: (model: string) => void;
  diagnosticConnection: string;
  setDiagnosticConnection: (id: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  page: 'overview',
  setPage: (page) => set({ page }),
  playgroundModel: '',
  setPlaygroundModel: (playgroundModel) => set({ playgroundModel }),
  diagnosticConnection: '',
  setDiagnosticConnection: (diagnosticConnection) => set({ diagnosticConnection }),
}));
