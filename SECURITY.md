# Security policy

## Reporting a vulnerability

Please open a private security advisory on GitHub, or email the maintainers.
Do not file public issues for vulnerabilities. We aim to acknowledge reports
within 72 hours.

## Security model

- **Credentials**: provider API keys are encrypted at rest with AES-256-GCM
  (key derived via scrypt from `MODELFORGE_MASTER_KEY`, or a generated 0600
  key file). The JSON store contains only `hasCredential` flags and masked
  hints like `sk-…abcd`. Keys are never logged, never returned by the API,
  and never included in exports.
- **Network**: the gateway binds to `127.0.0.1` by default. Set
  `MODELFORGE_GATEWAY_API_KEY` and `MODELFORGE_ADMIN_API_KEY` before any
  remote exposure, and terminate TLS at a reverse proxy.
- **SSRF**: connection and server base URLs are validated; private/loopback
  upstreams require `MODELFORGE_ALLOW_PRIVATE_UPSTREAMS=true` (needed for
  legitimate local inference). Credentials embedded in URLs are rejected.
- **Input**: all request bodies are size-capped (2 MiB) and Zod-validated.
- **Logging**: structured JSON logs carry correlation ids and metadata only.
  Prompts are never logged; every line passes through a secret redactor.
- **Antigravity**: integration is read-only detection plus the documented
  local-gateway pattern. No binary patching, no private API interception.

## Supported versions

Only the latest `main` is supported during the 0.x series.
