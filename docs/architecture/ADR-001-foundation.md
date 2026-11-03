# ADR-001: ModelForge foundation decisions

- Status: Accepted
- Date: 2026-11-03

## Context

ModelForge is a universal AI provider management platform: provider connections,
model registry, an OpenAI-compatible gateway with routing/fallbacks, multi-stage
diagnostics, a management dashboard, local/remote inference management, and an
Antigravity integration. It is inspired by the publicly documented functionality
of `antigravity-add-model` (registering custom models for Antigravity) but is an
independent, substantially larger design. No code was copied from that project.

## Decisions

### D1. npm workspaces monorepo, TypeScript source imports
Packages live under `packages/`, apps under `apps/`, integrations under
`integrations/`. Workspace packages export their TypeScript sources
(`"main": "src/index.ts"`) and run via `tsx`, so there is no build-order
choreography in development; `tsc --noEmit` provides whole-repo typechecking.
pnpm was unavailable in the reference environment; npm workspaces are the
lowest-common-denominator and work everywhere Node 20+ runs.

### D2. Provider abstraction with protocol families
One `ProviderAdapter` interface (`listModels`, `chat`, `chatStream`,
optional `validateAuth`). Providers are grouped by wire protocol:
- `openai-compatible` — a single data-driven adapter covers 20+ providers;
  per-provider differences are `ProviderDefinition` records, not code.
- `anthropic-messages`, `google-generative`, `ollama-native` — dedicated
  adapters translating to/from the normalized chat shape.
Adding a provider never modifies the gateway core (Open/Closed principle).

### D3. Honest diagnostics
Connection health is a 9-stage report (config → DNS → auth → listing →
model access → generation → streaming → tools → timeout/retry). Stages are
reported independently; `generationVerified` requires a real generation.
Model listing success is never presented as a full test.

### D4. Credential security
AES-256-GCM vault (scrypt-derived key from `MODELFORGE_MASTER_KEY` or a
0600 key file). The store keeps only `hasCredential` + masked hints.
Exports never contain secrets. Logs redact credential-shaped strings and
never include prompts. Upstream URLs pass an SSRF guard.

### D5. Deterministic routing by default
Resolution: exact id → alias → `chain:<id>` → `policy:<id>` → bare model id.
Retries only for errors normalized as retryable; circuit breakers per
connection; fallback advances on retryable failures. Latency/cost strategies
use recorded metrics and configured pricing only — no opaque AI routing.

### D6. Standalone-first persistence
`JsonStore` (atomic tmp+rename writes) behind a small interface so a
Drizzle/PostgreSQL or SQLite implementation can replace it without touching
domain services. PostgreSQL/Redis ship as optional Compose profiles.

### D7. Antigravity integration ethics
Detection is read-only. ModelForge never patches Antigravity binaries or
calls private APIs. The supported mechanism is the local OpenAI-compatible
gateway endpoint. Any future documented registration mechanism must land as
a versioned adapter in `integrations/antigravity` with stated risks.

## Consequences

- Fast, dependency-light standalone deployment; Docker for production.
- Provider contract tests run against fake transports by default; live tests
  are gated on real credentials and never claim success without them.
