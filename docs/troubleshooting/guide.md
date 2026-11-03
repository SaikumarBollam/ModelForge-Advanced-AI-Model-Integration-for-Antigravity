# Troubleshooting

## "Generation not tested" after a successful diagnostic run
By design. Generation is only verified when you select a model and enable
the generation test. Model listing success alone never marks a connection
as fully tested.

## Diagnostics: authentication passed, generation failed with 403
Your key is valid but lacks access to that model (common with gated or
preview models). The Diagnostics page reports this as `MODEL_ACCESS_DENIED`
at the generation stage — pick a model your plan includes.

## Connection to Ollama fails from Docker
Inside a container, `127.0.0.1` is the container itself. Use
`http://host.docker.internal:11434` as the base URL, and keep
`MODELFORGE_ALLOW_PRIVATE_UPSTREAMS=true` (default).

## Gateway returns 401
`MODELFORGE_GATEWAY_API_KEY` (for `/v1/*`) or `MODELFORGE_ADMIN_API_KEY`
(for `/api/*` and the dashboard) is set. Send `Authorization: Bearer <key>`.
In the dashboard, paste the admin key under **Security**.

## Costs show as unknown
Costs are computed only from pricing configured on the model (Model Manager).
ModelForge never invents pricing; unknown means "not configured", and token
counts are labeled provider-reported vs estimated everywhere.

## Antigravity does not list ModelForge models
ModelForge does not modify Antigravity. Integration works where a client
accepts a custom OpenAI-compatible base URL — point it at
`http://127.0.0.1:8787/v1` and use a model alias. See
[docs/integrations/antigravity.md](../integrations/antigravity.md).
