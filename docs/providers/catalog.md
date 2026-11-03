# Providers

Every provider is a `ProviderDefinition` (data) plus, where the wire protocol
is not OpenAI-compatible, a dedicated adapter class. Adding an
OpenAI-compatible provider is a one-line catalog entry in
`packages/provider-adapters/src/catalog.ts` — the gateway core never changes.

## Hosted (OpenAI-compatible unless noted)

| Provider | Base URL | Env var | Protocol |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` | openai-compatible |
| Anthropic | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | anthropic-messages (native adapter) |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` | google-generative (native adapter) |
| OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | openai-compatible |
| DeepSeek | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | openai-compatible |
| Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | openai-compatible |
| Mistral AI | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | openai-compatible |
| xAI | `https://api.x.ai/v1` | `XAI_API_KEY` | openai-compatible |
| Together AI | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` | openai-compatible |
| Fireworks AI | `https://api.fireworks.ai/inference/v1` | `FIREWORKS_API_KEY` | openai-compatible |
| Cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` | openai-compatible |
| SambaNova | `https://api.sambanova.ai/v1` | `SAMBANOVA_API_KEY` | openai-compatible |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` | openai-compatible |
| Novita AI | `https://api.novita.ai/v3/openai` | `NOVITA_API_KEY` | openai-compatible |
| Hugging Face Inference Providers | `https://router.huggingface.co/v1` | `HF_TOKEN` | openai-compatible |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` | openai-compatible |
| Alibaba Cloud Model Studio | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` | openai-compatible (DashScope compat mode) |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` | `CLOUDFLARE_API_TOKEN` | openai-compatible (replace `{account_id}`) |

## Local inference

| Runtime | Default endpoint | Notes |
|---|---|---|
| Ollama (native) | `http://127.0.0.1:11434` | `/api/tags`, `/api/chat` |
| Ollama (OpenAI-compat) | `http://127.0.0.1:11434/v1` | Alternative surface |
| LM Studio | `http://127.0.0.1:1234/v1` | Enable the local server in LM Studio |
| vLLM | `http://127.0.0.1:8000/v1` | `vllm serve <model>` |
| llama.cpp | `http://127.0.0.1:8080/v1` | `llama-server` |
| LocalAI | `http://127.0.0.1:8080/v1` | |
| Text Generation WebUI | `http://127.0.0.1:5000/v1` | Requires the OpenAI extension |
| Custom OpenAI-compatible | user-defined | Any endpoint speaking the OpenAI chat API |

## Honesty rules

- Capability lists in the catalog describe the provider family; per-model
  capabilities come from discovery or local overrides, and the registry keeps
  provider-reported values distinct from overrides.
- Adapters never fabricate usage: when a provider does not report tokens,
  usage is estimated locally and flagged `estimated: true`.
- Google Cloud Code account pooling is intentionally not implemented: it has
  no publicly documented third-party integration method. Use Gemini API keys
  or Vertex-style endpoints via the custom OpenAI-compatible provider where
  supported.
