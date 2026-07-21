/**
 * Gemini API 服务端代理（Vercel Serverless）
 * - 密钥保存在服务端环境变量 GEMINI_API_KEY，不暴露给浏览器
 * - OpenAI 兼容端点使用 Authorization: Bearer；客户端可传该头覆盖为用户自配 Key
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

function extractBearerKey(authHeader: string | string[] | undefined): string {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const segments = req.query.path;
  const pathStr = Array.isArray(segments) ? segments.join('/') : String(segments || '');
  if (!pathStr) {
    res.status(400).json({ error: 'Missing Gemini API path' });
    return;
  }

  const apiKey =
    extractBearerKey(req.headers.authorization) ||
    (typeof req.headers['x-goog-api-key'] === 'string' ? req.headers['x-goog-api-key'] : '') ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    '';

  if (!apiKey) {
    res.status(500).json({
      error: 'GEMINI_API_KEY not configured. Set it in Vercel Environment Variables.',
    });
    return;
  }

  const qs = req.url?.includes('?') ? `?${req.url.split('?').slice(1).join('?')}` : '';
  const targetUrl = `https://generativelanguage.googleapis.com/${pathStr}${qs}`;

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers: {
      'Content-Type': (req.headers['content-type'] as string) || 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
  });

  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);

  const text = await upstream.text();
  res.send(text);
}
