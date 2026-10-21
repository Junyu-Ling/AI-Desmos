/**
 * Gemini API 服务端代理（Vercel Serverless）
 * Vite 项目不支持 `[...path]` catch-all，由 vercel.json rewrite 把
 * `/api/gemini/*` 转到这个扁平函数。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { proxyUpstream } from './_lib/upstream-proxy';

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
  maxDuration: 60,
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await proxyUpstream(req, res, {
    prefix: '/api/gemini',
    targetOrigin: 'https://generativelanguage.googleapis.com',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    extraKeyHeaders: ['x-goog-api-key'],
    fallbackPath: 'v1beta/openai/chat/completions',
  });
}
