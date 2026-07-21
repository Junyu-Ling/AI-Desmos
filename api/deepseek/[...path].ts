/**
 * DeepSeek API 服务端代理（Vercel Serverless）
 * - 密钥保存在服务端环境变量 DEEPSEEK_API_KEY
 * - 客户端可传 Authorization: Bearer 覆盖为用户自配 Key
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
    res.status(400).json({ error: 'Missing DeepSeek API path' });
    return;
  }

  const apiKey =
    extractBearerKey(req.headers.authorization) ||
    process.env.DEEPSEEK_API_KEY ||
    '';

  if (!apiKey) {
    res.status(500).json({
      error: 'DEEPSEEK_API_KEY not configured. Set it in Vercel Environment Variables.',
    });
    return;
  }

  const qs = req.url?.includes('?') ? `?${req.url.split('?').slice(1).join('?')}` : '';
  const targetUrl = `https://api.deepseek.com/${pathStr}${qs}`;

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
