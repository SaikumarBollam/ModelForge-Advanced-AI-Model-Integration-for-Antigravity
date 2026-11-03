# Contributing to ModelForge

## Setup

```bash
npm install
npm run typecheck
npm test
npm run dev:gateway      # http://127.0.0.1:8787
npm run dev:dashboard    # http://127.0.0.1:5173/ui/ (proxies to gateway)
```

## Principles

- **No fake integrations.** If a capability needs real credentials or a live
  service, say so; use clearly labeled fixtures in tests.
- **Providers are data.** New OpenAI-compatible providers are catalog entries.
  New protocols implement `ProviderAdapter` in `packages/provider-adapters`.
- **Honest diagnostics.** Never collapse multi-stage checks into a single
  "connected" claim.
- **Security first.** No plaintext secrets anywhere: vault only, masked hints
  in APIs, redaction in logs, SSRF checks on new upstream URLs.
- **Tests required.** Adapter changes need contract tests with fake
  transports; gateway changes need `app.inject` tests.

## Pull requests

Run `npm run typecheck && npm test && npm run build:dashboard` before
opening a PR, and complete the checklist in the PR template.

## Code of conduct

Be kind, be technical, assume good faith. Harassment of any kind is not
tolerated in project spaces.
