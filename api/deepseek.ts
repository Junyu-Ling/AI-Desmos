/**
 * DeepSeek API 服务端代理（Vercel Serverless）
 * Vite 项目不支持 `[...path]` catch-all，由 vercel.json rewrite 把
 * `/api/deepseek/*` 转到这个扁平函数。
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
    prefix: '/api/deepseek',
    targetOrigin: 'https://api.deepseek.com',
    envKeys: ['DEEPSEEK_API_KEY'],
    fallbackPath: 'v1/chat/completions',
  });
}
