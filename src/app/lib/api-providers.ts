/**
 * API 服务商注册表 + Key 自动识别
 * 大多数厂家使用 OpenAI 兼容接口，Claude / Gemini 使用独立协议。
 */

export type ApiProviderId =
  | 'claude'
  | 'google'
  | 'groq'
  | 'openrouter'
  | 'xai'
  | 'perplexity'
  | 'fireworks'
  | 'openai'
  | 'deepseek'
  | 'moonshot'
  | 'qwen'
  | 'zhipu'
  | 'siliconflow'
  | 'mistral'
  | 'together'
  | 'deepinfra'
  | 'cohere'
  | 'novita'
  | 'minimax'
  | 'baichuan'
  | 'yi'
  | 'stepfun'
  | 'lingyi';

export type ApiFormat = 'openai' | 'anthropic' | 'google' | 'cohere';

export interface ProviderConfig {
  id: ApiProviderId;
  name: string;
  nameEn: string;
  endpoint: string;
  defaultModel: string;
  models: string[];
  /** 越靠前优先级越高 */
  keyPatterns: RegExp[];
  format: ApiFormat;
  docsUrl: string;
}

const OPENAI_COMPAT = (base: string): string => base;

export const API_PROVIDERS: ProviderConfig[] = [
  {
    id: 'claude',
    name: 'Anthropic Claude',
    nameEn: 'Anthropic Claude',
    endpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: 'claude-3-5-sonnet-20241022',
    models: ['claude-opus-4-5', 'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307'],
    keyPatterns: [/^sk-ant-/i],
    format: 'anthropic',
    docsUrl: 'https://console.anthropic.com',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    nameEn: 'Google Gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    defaultModel: 'gemini-flash-latest',
    models: ['gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    keyPatterns: [/^AIza/i, /^AQ\./i],
    format: 'google',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'groq',
    name: 'Groq',
    nameEn: 'Groq',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    keyPatterns: [/^gsk_/i],
    format: 'openai',
    docsUrl: 'https://console.groq.com',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    nameEn: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    defaultModel: 'openai/gpt-4o-mini',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001'],
    keyPatterns: [/^sk-or-/i],
    format: 'openai',
    docsUrl: 'https://openrouter.ai',
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    nameEn: 'xAI Grok',
    endpoint: 'https://api.x.ai/v1/chat/completions',
    defaultModel: 'grok-2-latest',
    models: ['grok-2-latest', 'grok-beta'],
    keyPatterns: [/^xai-/i],
    format: 'openai',
    docsUrl: 'https://console.x.ai',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    nameEn: 'Perplexity',
    endpoint: 'https://api.perplexity.ai/chat/completions',
    defaultModel: 'sonar',
    models: ['sonar', 'sonar-pro'],
    keyPatterns: [/^pplx-/i],
    format: 'openai',
    docsUrl: 'https://www.perplexity.ai/settings/api',
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    nameEn: 'Fireworks AI',
    endpoint: 'https://api.fireworks.ai/inference/v1/chat/completions',
    defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct',
    models: ['accounts/fireworks/models/llama-v3p1-70b-instruct', 'accounts/fireworks/models/qwen2p5-72b-instruct'],
    keyPatterns: [/^fw_/i],
    format: 'openai',
    docsUrl: 'https://fireworks.ai',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    nameEn: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o3-mini'],
    keyPatterns: [/^sk-proj-/i, /^sk-svcacct-/i, /^sk-live-/i, /T3BlbkFJ/],
    format: 'openai',
    docsUrl: 'https://platform.openai.com',
  },
  {
    id: 'cohere',
    name: 'Cohere',
    nameEn: 'Cohere',
    endpoint: 'https://api.cohere.com/compatibility/v1/chat/completions',
    defaultModel: 'command-r-plus-08-2024',
    models: ['command-r-plus-08-2024', 'command-r-08-2024'],
    keyPatterns: [/^co_/i],
    format: 'cohere',
    docsUrl: 'https://dashboard.cohere.com',
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    nameEn: 'Mistral AI',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    defaultModel: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-large-latest', 'codestral-latest'],
    keyPatterns: [/^mist-/i, /^mis-/i],
    format: 'openai',
    docsUrl: 'https://console.mistral.ai',
  },
  {
    id: 'together',
    name: 'Together AI',
    nameEn: 'Together AI',
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    keyPatterns: [/^tgp_/i],
    format: 'openai',
    docsUrl: 'https://api.together.xyz',
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    nameEn: 'DeepInfra',
    endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'],
    keyPatterns: [/^di_/i],
    format: 'openai',
    docsUrl: 'https://deepinfra.com',
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    nameEn: 'Moonshot / Kimi',
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyPatterns: [/^sk-moon/i, /^sk-kimi/i],
    format: 'openai',
    docsUrl: 'https://platform.moonshot.cn',
  },
  {
    id: 'qwen',
    name: '通义千问 / DashScope',
    nameEn: 'Qwen / DashScope',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    keyPatterns: [/^sk-qwen/i],
    format: 'openai',
    docsUrl: 'https://dashscope.console.aliyun.com',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    nameEn: 'Zhipu GLM',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'],
    keyPatterns: [/^sk-[a-z0-9]{8,}\.[a-zA-Z0-9]{6,}$/i],
    format: 'openai',
    docsUrl: 'https://open.bigmodel.cn',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    nameEn: 'SiliconFlow',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'Pro/deepseek-ai/DeepSeek-R1'],
    keyPatterns: [/^sk-sf/i, /^sf-/i],
    format: 'openai',
    docsUrl: 'https://siliconflow.cn',
  },
  {
    id: 'novita',
    name: 'Novita AI',
    nameEn: 'Novita AI',
    endpoint: 'https://api.novita.ai/v3/openai/chat/completions',
    defaultModel: 'deepseek/deepseek-r1',
    models: ['deepseek/deepseek-r1', 'meta-llama/llama-3.3-70b-instruct'],
    keyPatterns: [/^sk_nov/i],
    format: 'openai',
    docsUrl: 'https://novita.ai',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    nameEn: 'MiniMax',
    endpoint: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
    defaultModel: 'MiniMax-Text-01',
    models: ['MiniMax-Text-01', 'abab6.5s-chat'],
    keyPatterns: [/^sk-mm/i],
    format: 'openai',
    docsUrl: 'https://platform.minimaxi.com',
  },
  {
    id: 'baichuan',
    name: '百川',
    nameEn: 'Baichuan',
    endpoint: 'https://api.baichuan-ai.com/v1/chat/completions',
    defaultModel: 'Baichuan4',
    models: ['Baichuan4', 'Baichuan3-Turbo'],
    keyPatterns: [/^sk-bc/i],
    format: 'openai',
    docsUrl: 'https://platform.baichuan-ai.com',
  },
  {
    id: 'yi',
    name: '零一万物 Yi',
    nameEn: '01.AI Yi',
    endpoint: 'https://api.lingyiwanwu.com/v1/chat/completions',
    defaultModel: 'yi-lightning',
    models: ['yi-lightning', 'yi-large'],
    keyPatterns: [/^sk-yi/i],
    format: 'openai',
    docsUrl: 'https://platform.lingyiwanwu.com',
  },
  {
    id: 'stepfun',
    name: '阶跃星辰',
    nameEn: 'StepFun',
    endpoint: 'https://api.stepfun.com/v1/chat/completions',
    defaultModel: 'step-2-16k',
    models: ['step-2-16k', 'step-1-8k'],
    keyPatterns: [/^sk-step/i],
    format: 'openai',
    docsUrl: 'https://platform.stepfun.com',
  },
  {
    id: 'lingyi',
    name: 'Lingyi Wanwu',
    nameEn: 'Lingyi Wanwu',
    endpoint: 'https://api.lingyiwanwu.com/v1/chat/completions',
    defaultModel: 'yi-lightning',
    models: ['yi-lightning'],
    keyPatterns: [/^sk-ly/i],
    format: 'openai',
    docsUrl: 'https://platform.lingyiwanwu.com',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    nameEn: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    keyPatterns: [/^sk-[a-f0-9]{32}$/i, /^sk-/i],
    format: 'openai',
    docsUrl: 'https://platform.deepseek.com',
  },
];

/** 兼容旧代码的类型别名 */
export type ApiProvider = ApiProviderId;

export const DEFAULT_MODELS: Record<string, string> = Object.fromEntries(
  API_PROVIDERS.map(p => [p.id, p.defaultModel])
);

export const CLAUDE_MODELS = API_PROVIDERS.find(p => p.id === 'claude')!.models;

export const API_ENDPOINTS: Record<string, string> = Object.fromEntries(
  API_PROVIDERS.map(p => [p.id, p.endpoint])
);

export function getProviderById(id: string): ProviderConfig | undefined {
  return API_PROVIDERS.find(p => p.id === id);
}

export function detectProviderFromKey(apiKey: string): ProviderConfig | null {
  const key = apiKey.trim();
  if (!key) return null;

  for (const provider of API_PROVIDERS) {
    if (provider.id === 'deepseek') continue;
    for (const pattern of provider.keyPatterns) {
      if (pattern.test(key)) return provider;
    }
  }

  // DeepSeek 经典 Key：sk- + 32 位十六进制
  if (/^sk-[a-f0-9]{32}$/i.test(key)) {
    return getProviderById('deepseek') ?? null;
  }

  // 其它 sk- 过短或格式不明：不强制判定，交给已保存的 provider / UI 状态
  return null;
}

export function getProviderDisplayName(provider: ProviderConfig, lang: string): string {
  return lang === 'zh' ? provider.name : provider.nameEn;
}
