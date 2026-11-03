# Roadmap

## Phase 1 — Foundation ✅
Monorepo, shared types, provider SDK, provider registry, encrypted credential vault.

## Phase 2 — Provider Management ✅
Adapters (OpenAI-compatible family, Anthropic, Gemini, Ollama), model discovery,
model catalog, multi-stage connection diagnostics, generation testing.

## Phase 3 — Gateway ✅
OpenAI-compatible API, SSE streaming, routing, fallback chains, retries,
circuit breakers, routing policies, usage recording, Prometheus metrics.

## Phase 4 — Dashboard ✅
Provider/model management, playground (streaming, compare, TTFT, tok/s),
usage & cost analytics, diagnostics UI, GPU/servers, config import/export.

## Phase 5 — Antigravity 🟡 (supported-mechanism scope complete)
Read-only detection (desktop vs IDE), gateway integration guidance.
Pending: a documented Antigravity model-registration mechanism, if/when one
is published — to be implemented as a versioned adapter with stated risks.

## Phase 6 — Infrastructure 🟡
Done: inference-server registry + health checks, nvidia-smi GPU/CUDA
detection, Docker/Compose with optional Postgres/Redis/monitoring profiles.
Next:
- Drizzle ORM store (PostgreSQL) + SQLite option behind the `JsonStore` interface
- Redis-backed distributed circuit breakers / rate limiting for multi-instance gateways
- Per-key gateway rate limits and concurrent-request limits
- Multi-node inference via runtime-native mechanisms (vLLM tensor parallelism,
  Ollama clusters) — orchestration only, never reimplemented inference

## Phase 7 — Production hardening ⬜
- Playwright E2E suite for the dashboard
- Provider contract tests against live sandboxes (credential-gated)
- OpenTelemetry tracing export (OTLP) — metrics/logging hooks already in place
- Load testing, security audit, signed releases, SBOM
- RBAC for multi-user deployments (roles: admin / operator / viewer)
- Embedding + image-generation gateway endpoints (`/v1/embeddings`, `/v1/images`)
