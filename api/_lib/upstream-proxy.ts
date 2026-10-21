/**
 * Shared Vercel serverless reverse-proxy for DeepSeek / Gemini.
 * Catch-all `[...path].ts` files are Next.js-only and 404 on Vite at the edge.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export type UpstreamProxyOptions = {
  prefix: string;
  targetOrigin: string;
  envKeys: string[];
  extraKeyHeaders?: string[];
  fallbackPath?: string;
};

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

export function extractBearerKey(authHeader: string | string[] | undefined): string {
  const raw = headerValue(authHeader);
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

function stripPrefix(pathname: string, prefix: string): string {
  const path = pathname.split('?')[0];
  if (path === prefix || path === `${prefix}/`) return '';
  if (path.startsWith(`${prefix}/`)) {
    return path.slice(prefix.length + 1).replace(/^\/+/, '');
  }
  return '';
}

export function extractUpstreamPath(req: VercelRequest, prefix: string): string {
  const candidates = [
    req.url,
    headerValue(req.headers['x-forwarded-uri']),
    headerValue(req.headers['x-invoke-path']),
    headerValue(req.headers['x-matched-path']),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const stripped = stripPrefix(candidate, prefix);
    if (stripped && stripped !== '[...path]') return stripped;
  }

  const q = req.query.path;
  if (Array.isArray(q) && q.length) {
    const joined = q.filter((s) => typeof s === 'string' && s && s !== '[...path]').join('/');
    if (joined) return joined.replace(/^\/+/, '');
  }
  if (typeof q === 'string' && q.trim() && q !== '[...path]') {
    return q.replace(/^\/+/, '');
  }
  return '';
}

function getForwardQuery(req: VercelRequest): string {
  const raw = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
  if (!raw) return '';
  const params = new URLSearchParams(raw);
  params.delete('path');
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

function readBody(req: VercelRequest): string | undefined {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return undefined;
  }
  if (typeof req.body === 'string') return req.body;
  if (req.body == null) return undefined;
  return JSON.stringify(req.body);
}

export async function proxyUpstream(
  req: VercelRequest,
  res: VercelResponse,
  options: UpstreamProxyOptions,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const pathStr = extractUpstreamPath(req, options.prefix) || options.fallbackPath || '';
  if (!pathStr) {
    res.status(400).json({ error: `Missing API path for ${options.prefix}` });
    return;
  }

  let apiKey = extractBearerKey(req.headers.authorization);
  if (!apiKey && options.extraKeyHeaders) {
    for (const headerName of options.extraKeyHeaders) {
      apiKey = headerValue(req.headers[headerName]).trim();
      if (apiKey) break;
    }
  }
  if (!apiKey) {
    for (const envKey of options.envKeys) {
      apiKey = process.env[envKey] || '';
      if (apiKey) break;
    }
  }

  if (!apiKey) {
    res.status(500).json({
      error: `${options.envKeys[0]} not configured. Set it in Vercel Environment Variables.`,
    });
    return;
  }

  const targetUrl = `${options.targetOrigin.replace(/\/$/, '')}/${pathStr}${getForwardQuery(req)}`;
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
}
