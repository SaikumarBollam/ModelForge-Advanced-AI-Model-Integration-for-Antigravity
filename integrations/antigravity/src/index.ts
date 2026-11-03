import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { AntigravityInstall, AntigravityIntegrationStatus } from '@modelforge/shared-types';

/**
 * Antigravity integration — detection & supported-mechanism guidance.
 *
 * Compatibility strategy (deliberately conservative):
 * - We DETECT installations (desktop standalone vs VS Code-based IDE) and
 *   report versions. Detection is read-only.
 * - We do NOT modify application binaries, patch internal files, or call
 *   private APIs. There is no publicly documented Antigravity API for
 *   registering third-party models at the time of writing.
 * - The supported integration path is the local OpenAI-compatible gateway:
 *   any Antigravity feature/client that accepts a custom OpenAI-compatible
 *   base URL can point at ModelForge (`http://127.0.0.1:8787/v1`) and use
 *   aliases, fallback chains and policies as model names.
 * - If a future documented configuration mechanism appears, it belongs in a
 *   versioned adapter here — never as an undocumented binary patch.
 */

interface CandidatePath {
  kind: AntigravityInstall['kind'];
  path: string;
  versionFile?: string;
}

export function candidatePaths(home = homedir(), os = platform()): CandidatePath[] {
  const candidates: CandidatePath[] = [];
  if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    candidates.push(
      { kind: 'desktop-standalone', path: join(localAppData, 'Programs', 'Antigravity'), versionFile: 'resources/app/package.json' },
      { kind: 'desktop-standalone', path: join(localAppData, 'Antigravity'), versionFile: 'resources/app/package.json' },
      { kind: 'vscode-ide', path: join(appData, 'Antigravity', 'User'), versionFile: undefined },
      { kind: 'vscode-ide', path: join(home, '.antigravity') },
    );
  } else if (os === 'darwin') {
    candidates.push(
      { kind: 'desktop-standalone', path: '/Applications/Antigravity.app', versionFile: 'Contents/Resources/app/package.json' },
      { kind: 'vscode-ide', path: join(home, 'Library', 'Application Support', 'Antigravity', 'User') },
      { kind: 'vscode-ide', path: join(home, '.antigravity') },
    );
  } else {
    candidates.push(
      { kind: 'desktop-standalone', path: join(home, '.local', 'share', 'antigravity') },
      { kind: 'vscode-ide', path: join(home, '.config', 'Antigravity', 'User') },
      { kind: 'vscode-ide', path: join(home, '.antigravity') },
    );
  }
  return candidates;
}

function readVersion(candidate: CandidatePath): string | undefined {
  if (!candidate.versionFile) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(candidate.path, candidate.versionFile), 'utf8')) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

export function detectAntigravity(opts: { gatewayUrl: string; home?: string; os?: NodeJS.Platform }): AntigravityIntegrationStatus {
  const installs: AntigravityInstall[] = [];
  for (const candidate of candidatePaths(opts.home, opts.os)) {
    if (existsSync(candidate.path)) {
      installs.push({
        kind: candidate.kind,
        path: candidate.path,
        version: readVersion(candidate),
        detectedAt: new Date().toISOString(),
      });
    }
  }

  const notes: string[] = [];
  if (!installs.length) {
    notes.push('No Antigravity installation detected in standard locations. Detection is read-only and non-invasive.');
  } else {
    notes.push(`Detected ${installs.length} Antigravity location(s). Desktop and IDE installs are tracked separately because their internals differ.`);
  }
  notes.push(
    'Supported integration: point any client that accepts an OpenAI-compatible base URL at the ModelForge gateway. ' +
    'ModelForge does not patch Antigravity binaries or use private APIs; custom-model registration inside Antigravity ' +
    'is only performed where a documented mechanism exists.',
  );

  return {
    installs,
    gatewayUrl: opts.gatewayUrl,
    supportedMechanism: 'local-gateway-endpoint',
    notes,
  };
}

/** Copy-paste configuration snippet for clients that accept OpenAI-compatible endpoints. */
export function gatewayClientSnippet(gatewayUrl: string): Record<string, unknown> {
  return {
    baseURL: gatewayUrl,
    apiKey: 'use MODELFORGE_GATEWAY_API_KEY value, or any non-empty string when unset',
    models: 'GET /v1/models lists enabled aliases; chain:<id> and policy:<id> are valid model names',
  };
}
