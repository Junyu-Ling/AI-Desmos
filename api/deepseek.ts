/**
 * DeepSeek API 服务端代理（Vercel Serverless）
 * Vite 不支持 `[...path]` catch-all；本文件是扁平入口，
 * `/api/deepseek/*` 由 vercel.json rewrite 转到这里。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

function extractBearerKey(authHeader: string | string[] | undefined): string {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function stripPrefix(pathname: string, prefix: string): string {
  const path = pathname.split('?')[0];
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length + 1).replace(/^\/+/, '');
  return '';
}

function extractUpstreamPath(req: VercelRequest): string {
  const prefix = '/api/deepseek';
  for (const candidate of [req.url, headerValue(req.headers['x-forwarded-uri'])]) {
    if (!candidate) continue;
    const stripped = stripPrefix(candidate, prefix);
    if (stripped) return stripped;
  }
  const q = req.query.path;
  if (Array.isArray(q) && q.length) return q.filter(Boolean).join('/');
  if (typeof q === 'string' && q.trim()) return q.replace(/^\/+/, '');
  return 'v1/chat/completions';
}

function readBody(req: VercelRequest): string | undefined {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return undefined;
  if (typeof req.body === 'string') return req.body;
  if (req.body == null) return undefined;
  return JSON.stringify(req.body);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  try {
    const pathStr = extractUpstreamPath(req);
    const apiKey = extractBearerKey(req.headers.authorization) || process.env.DEEPSEEK_API_KEY || '';
    if (!apiKey) {
      res.status(500).json({
        error: 'DEEPSEEK_API_KEY not configured. Set it in Vercel Environment Variables.',
      });
      return;
    }

    const qs = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const params = new URLSearchParams(qs);
    params.delete('path');
    const query = params.toString();
    const targetUrl = `https://api.deepseek.com/${pathStr}${query ? `?${query}` : ''}`;

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': (req.headers['content-type'] as string) || 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: readBody(req),
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);

    const body = upstream.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
        res.end();
        return;
      } catch {
        /* fall through */
      }
    }

    res.send(await upstream.text());
  } catch (err) {
    console.error('[api/deepseek]', err);
    if (!res.headersSent) {
      res.status(502).json({ error: 'DeepSeek proxy failed' });
    } else {
      res.end();
    }
  }
}
