import type { Capability, ProviderDefinition } from '@modelforge/shared-types';
import type { ProviderAdapter } from '@modelforge/provider-sdk';
import { OpenAiCompatibleAdapter } from './openai-compatible.js';
import { AnthropicAdapter, ANTHROPIC_DEFINITION } from './anthropic.js';
import { GeminiAdapter, GEMINI_DEFINITION } from './gemini.js';
import { OllamaAdapter, OLLAMA_DEFINITION } from './ollama.js';

/**
 * Provider catalog. Every OpenAI-compatible provider is pure data here —
 * adding one never touches gateway code. Native-protocol providers
 * (Anthropic, Gemini, Ollama) have dedicated adapter classes below.
 */

const TEXT: Capability[] = ['text', 'coding'];
const FULL: Capability[] = ['text', 'coding', 'reasoning', 'vision', 'tool-calling', 'structured-output'];

function openAiCompat(def: Omit<ProviderDefinition, 'protocol' | 'auth' | 'supportsDiscovery' | 'supportsStreaming'> & Partial<ProviderDefinition>): ProviderDefinition {
  return {
    protocol: 'openai-compatible',
    auth: 'bearer',
    supportsDiscovery: true,
    supportsStreaming: true,
    ...def,
  } as ProviderDefinition;
}

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  openAiCompat({ id: 'openai', displayName: 'OpenAI', kind: 'hosted', defaultBaseUrl: 'https://api.openai.com/v1', capabilities: [...FULL, 'embeddings', 'image-generation', 'audio'], envVar: 'OPENAI_API_KEY', docsUrl: 'https://platform.openai.com/docs' }),
  openAiCompat({ id: 'openrouter', displayName: 'OpenRouter', kind: 'hosted', defaultBaseUrl: 'https://openrouter.ai/api/v1', capabilities: [...FULL], envVar: 'OPENROUTER_API_KEY', docsUrl: 'https://openrouter.ai/docs' }),
  openAiCompat({ id: 'deepseek', displayName: 'DeepSeek', kind: 'hosted', defaultBaseUrl: 'https://api.deepseek.com/v1', capabilities: ['text', 'coding', 'reasoning', 'tool-calling'], envVar: 'DEEPSEEK_API_KEY' }),
  openAiCompat({ id: 'groq', displayName: 'Groq', kind: 'hosted', defaultBaseUrl: 'https://api.groq.com/openai/v1', capabilities: ['text', 'coding', 'tool-calling', 'audio'], envVar: 'GROQ_API_KEY' }),
  openAiCompat({ id: 'mistral', displayName: 'Mistral AI', kind: 'hosted', defaultBaseUrl: 'https://api.mistral.ai/v1', capabilities: [...FULL, 'embeddings'], envVar: 'MISTRAL_API_KEY' }),
  openAiCompat({ id: 'xai', displayName: 'xAI (Grok)', kind: 'hosted', defaultBaseUrl: 'https://api.x.ai/v1', capabilities: [...FULL], envVar: 'XAI_API_KEY' }),
  openAiCompat({ id: 'together', displayName: 'Together AI', kind: 'hosted', defaultBaseUrl: 'https://api.together.xyz/v1', capabilities: [...FULL, 'embeddings', 'image-generation'], envVar: 'TOGETHER_API_KEY' }),
  openAiCompat({ id: 'fireworks', displayName: 'Fireworks AI', kind: 'hosted', defaultBaseUrl: 'https://api.fireworks.ai/inference/v1', capabilities: [...FULL, 'embeddings'], envVar: 'FIREWORKS_API_KEY' }),
  openAiCompat({ id: 'cerebras', displayName: 'Cerebras', kind: 'hosted', defaultBaseUrl: 'https://api.cerebras.ai/v1', capabilities: ['text', 'coding', 'tool-calling'], envVar: 'CEREBRAS_API_KEY' }),
  openAiCompat({ id: 'sambanova', displayName: 'SambaNova', kind: 'hosted', defaultBaseUrl: 'https://api.sambanova.ai/v1', capabilities: ['text', 'coding', 'tool-calling'], envVar: 'SAMBANOVA_API_KEY' }),
  openAiCompat({ id: 'siliconflow', displayName: 'SiliconFlow', kind: 'hosted', defaultBaseUrl: 'https://api.siliconflow.cn/v1', capabilities: [...FULL, 'embeddings', 'image-generation', 'audio'], envVar: 'SILICONFLOW_API_KEY' }),
  openAiCompat({ id: 'novita', displayName: 'Novita AI', kind: 'hosted', defaultBaseUrl: 'https://api.novita.ai/v3/openai', capabilities: [...FULL, 'image-generation'], envVar: 'NOVITA_API_KEY' }),
  openAiCompat({ id: 'huggingface', displayName: 'Hugging Face Inference Providers', kind: 'hosted', defaultBaseUrl: 'https://router.huggingface.co/v1', capabilities: ['text', 'coding', 'embeddings'], envVar: 'HF_TOKEN', notes: 'Routes to HF Inference Providers router.' }),
  openAiCompat({ id: 'nvidia-nim', displayName: 'NVIDIA NIM', kind: 'hosted', defaultBaseUrl: 'https://integrate.api.nvidia.com/v1', capabilities: [...FULL, 'embeddings'], envVar: 'NVIDIA_API_KEY' }),
  openAiCompat({ id: 'alibaba-model-studio', displayName: 'Alibaba Cloud Model Studio', kind: 'hosted', defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', capabilities: [...FULL, 'embeddings'], envVar: 'DASHSCOPE_API_KEY', notes: 'DashScope OpenAI-compatible mode. Region-specific base URL may differ.' }),
  openAiCompat({ id: 'cloudflare-workers-ai', displayName: 'Cloudflare Workers AI', kind: 'hosted', defaultBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1', capabilities: ['text', 'coding', 'embeddings', 'image-generation', 'audio'], envVar: 'CLOUDFLARE_API_TOKEN', notes: 'Replace {account_id} in the base URL with your Cloudflare account id.' }),
  // Local inference (OpenAI-compatible surfaces)
  openAiCompat({ id: 'lmstudio', displayName: 'LM Studio', kind: 'local', defaultBaseUrl: 'http://127.0.0.1:1234/v1', auth: 'none', capabilities: [...TEXT, 'tool-calling', 'embeddings'] }),
  openAiCompat({ id: 'vllm', displayName: 'vLLM', kind: 'local', defaultBaseUrl: 'http://127.0.0.1:8000/v1', auth: 'none', capabilities: [...TEXT, 'tool-calling', 'embeddings'], notes: 'Self-hosted vLLM OpenAI server. Set an API key on the server and switch auth if required.' }),
  openAiCompat({ id: 'llamacpp', displayName: 'llama.cpp server', kind: 'local', defaultBaseUrl: 'http://127.0.0.1:8080/v1', auth: 'none', capabilities: [...TEXT] }),
  openAiCompat({ id: 'localai', displayName: 'LocalAI', kind: 'local', defaultBaseUrl: 'http://127.0.0.1:8080/v1', auth: 'none', capabilities: [...TEXT, 'embeddings', 'image-generation', 'audio'] }),
  openAiCompat({ id: 'textgen-webui', displayName: 'Text Generation WebUI', kind: 'local', defaultBaseUrl: 'http://127.0.0.1:5000/v1', auth: 'none', capabilities: [...TEXT], notes: 'Requires the OpenAI extension enabled in oobabooga.' }),
  openAiCompat({ id: 'ollama-openai', displayName: 'Ollama (OpenAI-compatible)', kind: 'local', defaultBaseUrl: 'http://127.0.0.1:11434/v1', auth: 'none', capabilities: [...TEXT, 'tool-calling', 'embeddings'] }),
  openAiCompat({ id: 'custom-openai', displayName: 'Custom OpenAI-compatible endpoint', kind: 'custom', defaultBaseUrl: 'http://127.0.0.1:8000/v1', auth: 'bearer', capabilities: [...TEXT], notes: 'Any endpoint speaking the OpenAI chat API.' }),
  ANTHROPIC_DEFINITION,
  GEMINI_DEFINITION,
  OLLAMA_DEFINITION,
];

export function createAdapter(definition: ProviderDefinition): ProviderAdapter {
  switch (definition.protocol) {
    case 'anthropic-messages':
      return new AnthropicAdapter();
    case 'google-generative':
      return new GeminiAdapter();
    case 'ollama-native':
      return new OllamaAdapter();
    case 'openai-compatible':
    case 'custom':
    default:
      return new OpenAiCompatibleAdapter(definition);
  }
}

export class ProviderRegistry {
  private readonly definitions = new Map<string, ProviderDefinition>();
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(definitions: ProviderDefinition[] = PROVIDER_DEFINITIONS) {
    for (const def of definitions) this.register(def);
  }

  register(definition: ProviderDefinition): void {
    this.definitions.set(definition.id, definition);
    this.adapters.set(definition.id, createAdapter(definition));
  }

  getDefinition(id: string): ProviderDefinition | undefined {
    return this.definitions.get(id);
  }

  getAdapter(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  listDefinitions(): ProviderDefinition[] {
    return [...this.definitions.values()];
  }
}
