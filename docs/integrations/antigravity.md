# Antigravity integration

## What ModelForge does

- **Detects** Antigravity installations (desktop standalone and VS Code-based
  IDE installs are tracked separately — their internals differ) and reports
  versions. Detection is read-only.
- **Integrates via the local gateway**: any Antigravity feature or client that
  accepts a custom OpenAI-compatible base URL can point at
  `http://127.0.0.1:8787/v1` and use ModelForge aliases, fallback chains
  (`chain:<id>`) and routing policies (`policy:<id>`) as model names.
- **Preserves native functionality**: ModelForge never touches Antigravity's
  own model configuration.

## What ModelForge deliberately does not do

- It does **not** modify application binaries, patch internal files, intercept
  private APIs, or claim custom-model registration inside Antigravity where
  no documented mechanism exists.
- If Google publishes a documented model-registration mechanism, it will be
  implemented as a versioned adapter in `integrations/antigravity` with its
  compatibility range and risks stated explicitly.

## Setup

1. Start ModelForge: `npm run dev:gateway` (or Docker).
2. Add your providers and models in the dashboard; give models short aliases.
3. In your client, set the OpenAI-compatible base URL to
   `http://127.0.0.1:8787/v1` and use an alias as the model name.
4. If you set `MODELFORGE_GATEWAY_API_KEY`, use that value as the API key;
   otherwise any non-empty string works locally.

## Diagnostics & recovery

- The dashboard's **Gateway & Antigravity** page shows detected installs and
  the exact gateway URL.
- If a model stops responding, the **Diagnostics** page separates DNS, auth,
  listing, and generation failures so you can tell a bad key from a provider
  outage. Fallback chains keep traffic flowing while you fix the connection.
- ModelForge configuration is fully reversible: deleting a connection removes
  its vault entry; exporting config never includes secrets.
