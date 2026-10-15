/**
 * OpenAI 兼容 API 同源代理（Vercel）
 * 解决浏览器直连 OpenAI / Groq / OpenRouter 等的 CORS 问题。
 * 仅允许转发到已登记服务商的 endpoint，客户端传用户自己的 Bearer Key。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

/** 与 src/app/lib/api-providers.ts 中 openai/cohere 格式 endpoint 保持同步 */
const ALLOWED_ENDPOINTS: Record<string, string> = {
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

function extractBearerKey(authHeader: string | string[] | undefined): string {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function readProviderId(req: VercelRequest): string {
  const q = req.query.provider;
  if (typeof q === 'string' && q.trim()) return q.trim().toLowerCase();
  const header = req.headers['x-desmos-provider'];
  if (typeof header === 'string' && header.trim()) return header.trim().toLowerCase();
  return '';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const providerId = readProviderId(req);
  const targetUrl = ALLOWED_ENDPOINTS[providerId];
  if (!targetUrl) {
    res.status(400).json({
      error: `Unsupported provider for compat proxy: ${providerId || '(missing)'}`,
    });
    return;
  }

  const apiKey = extractBearerKey(req.headers.authorization);
  if (!apiKey) {
    res.status(401).json({ error: 'Missing Authorization Bearer API key' });
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': (req.headers['content-type'] as string) || 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (providerId === 'openrouter') {
    headers['HTTP-Referer'] = 'https://ai-desmos.app';
    headers['X-Title'] = 'AI Desmos';
  }

  const upstream = await fetch(targetUrl, {
    method: req.method || 'POST',
    headers,
    body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
  });

  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);

  // 尽量流式转发，避免自定义 Key 长回复被缓冲到超时
  const body = upstream.body;
  if (body && typeof (body as any).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
      }
      res.end();
      return;
    } catch {
      // fall through to text
    }
  }

  const text = await upstream.text();
  res.send(text);
}
