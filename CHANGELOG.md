# Changelog

All notable changes to ModelForge are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0] — 2026-11-03

### Added
- Monorepo foundation: shared types, security (AES-256-GCM vault, SSRF guard),
  provider SDK, observability, config packages.
- Provider adapters: OpenAI-compatible (20+ providers as data), Anthropic
  Messages, Google Gemini, Ollama native.
- Model registry with discovery, aliases, manual registration, duplication,
  enable/disable, import/export (secrets never exported).
- Multi-stage diagnostics (9 independently reported stages).
- OpenAI-compatible gateway with routing engine: aliases, fallback chains,
  routing policies (explicit/latency/cost/round-robin), retries, circuit
  breakers, SSE streaming, usage/cost recording, Prometheus metrics.
- Dashboard: Overview, Providers, Model Catalog, Model Manager, Playground
  (streaming, compare, TTFT/tok-s), Gateway & Antigravity, Routing Policies,
  Fallback Chains, Diagnostics, Usage, Costs, Local Inference, GPU
  (nvidia-smi), Remote Servers, Configuration, Security, System Health.
- Antigravity read-only detection + local-gateway integration guidance.
- Docker + Compose (optional Postgres/Redis/Prometheus/Grafana profiles),
  GitHub Actions CI, 20 automated tests.
