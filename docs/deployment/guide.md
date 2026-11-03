# Deployment

## Standalone (default)

```bash
npm install
MODELFORGE_MASTER_KEY=$(openssl rand -base64 32) npm run start:gateway
```

State lives in `MODELFORGE_DATA_DIR` (default `./data`): `modelforge.json`
(registry data), `vault.json` (encrypted credentials), `vault.key` (only
when no master key env is set). Back up the data dir **and** the master key
together — one is useless without the other.

## Docker

```bash
cd infrastructure/docker
MODELFORGE_MASTER_KEY=... docker compose up --build -d
# optional: --profile infra (Postgres/Redis), --profile monitoring (Prometheus/Grafana)
```

## Remote exposure checklist

1. Set `MODELFORGE_GATEWAY_API_KEY` and `MODELFORGE_ADMIN_API_KEY` (long random values).
2. Put the gateway behind a TLS-terminating reverse proxy; keep the bind on loopback or a private network.
3. Review `MODELFORGE_ALLOW_PRIVATE_UPSTREAMS` — disable it if users should not reach LAN inference servers.
4. Scrape `/metrics` with Prometheus; logs are JSON lines on stdout.
5. Rotate provider keys from the Providers page; old vault entries are replaced atomically.

## Scaling notes

The standalone gateway is single-process with an in-memory circuit breaker.
For multi-instance deployments, run one gateway per node behind a load
balancer today; Redis-backed shared breaker/rate-limit state is on the
roadmap (Phase 6). Local/remote inference servers scale independently —
register each under Remote Servers and route with policies.
