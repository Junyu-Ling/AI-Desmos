/**
 * Exact filesystem route for POST /api/deepseek/v1/chat/completions.
 * Must be self-contained: Vite/Vercel functions do not bundle `/api/_lib` imports.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

function extractBearerKey(authHeader: string | string[] | undefined): string {
  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
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
    const apiKey = extractBearerKey(req.headers.authorization) || process.env.DEEPSEEK_API_KEY || '';
    if (!apiKey) {
      res.status(500).json({
        error: 'DEEPSEEK_API_KEY not configured. Set it in Vercel Environment Variables.',
      });
      return;
    }

    const upstream = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: req.method || 'POST',
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
    console.error('[api/deepseek/v1/chat/completions]', err);
    if (!res.headersSent) {
      res.status(502).json({ error: 'DeepSeek proxy failed' });
    } else {
      res.end();
    }
  }
}
