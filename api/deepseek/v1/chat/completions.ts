/**
 * Exact filesystem route for POST /api/deepseek/v1/chat/completions.
 * Vite + Vercel does not route `[...path]` catch-alls, so this static
 * path must exist as a real function (same pattern as api/compat.ts).
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { proxyUpstream } from '../../../_lib/upstream-proxy';

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
  maxDuration: 60,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await proxyUpstream(req, res, {
    prefix: '/api/deepseek',
    targetOrigin: 'https://api.deepseek.com',
    envKeys: ['DEEPSEEK_API_KEY'],
    fallbackPath: 'v1/chat/completions',
  });
}
