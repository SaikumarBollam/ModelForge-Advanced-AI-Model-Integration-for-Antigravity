import { describe, expect, it } from 'vitest';
import { candidatePaths, detectAntigravity } from './index.js';

describe('Antigravity detection', () => {
  it('produces OS-appropriate candidate paths without touching the system', () => {
    const win = candidatePaths('C:\\Users\\test', 'win32');
    expect(win.length).toBeGreaterThan(0);
    expect(win.some((c) => c.kind === 'desktop-standalone')).toBe(true);
    expect(win.some((c) => c.kind === 'vscode-ide')).toBe(true);
  });

  it('reports the gateway mechanism and honest notes when nothing is installed', () => {
    const status = detectAntigravity({ gatewayUrl: 'http://127.0.0.1:8787/v1', home: 'C:\\nonexistent-home-xyz', os: 'win32' });
    expect(status.supportedMechanism).toBe('local-gateway-endpoint');
    expect(status.notes.join(' ')).toMatch(/does not patch/i);
  });
});
