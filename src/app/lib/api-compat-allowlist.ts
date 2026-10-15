/**
 * OpenAI 兼容代理允许的服务商 → 完整 chat/completions URL
 * 与 api/compat.ts 保持同步。
 */
export const OPENAI_COMPAT_PROXY_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  perplexity: 'https://api.perplexity.ai/chat/completions',
  fireworks: 'https://api.fireworks.ai/inference/v1/chat/completions',
  cohere: 'https://api.cohere.com/compatibility/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  together: 'https://api.together.xyz/v1/chat/completions',
  deepinfra: 'https://api.deepinfra.com/v1/openai/chat/completions',
  moonshot: 'https://api.moonshot.cn/v1/chat/completions',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
  novita: 'https://api.novita.ai/v3/openai/chat/completions',
  minimax: 'https://api.minimax.chat/v1/text/chatcompletion_v2',
  baichuan: 'https://api.baichuan-ai.com/v1/chat/completions',
  yi: 'https://api.lingyiwanwu.com/v1/chat/completions',
  stepfun: 'https://api.stepfun.com/v1/chat/completions',
  lingyi: 'https://api.lingyiwanwu.com/v1/chat/completions',
};

export const getCompatProxyUrl = (providerId: string): string =>
  `/api/compat?provider=${encodeURIComponent(providerId)}`;
