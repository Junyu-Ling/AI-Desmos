/**
 * 浏览器端 API 调用辅助（DeepSeek / Gemini / 其它 OpenAI 兼容同源代理，避免 CORS）
 */

import { getCompatProxyUrl, OPENAI_COMPAT_PROXY_ENDPOINTS } from './api-compat-allowlist';

export const DEEPSEEK_PROXY_BASE = '/api/deepseek';
export const GEMINI_PROXY_BASE = '/api/gemini';

export const getDeepSeekChatCompletionsUrl = () =>
  `${DEEPSEEK_PROXY_BASE}/v1/chat/completions`;

export const getGeminiChatCompletionsUrl = () =>
  `${GEMINI_PROXY_BASE}/v1beta/openai/chat/completions`;

export const buildBearerHeaders = (apiKey?: string): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey?.trim()) headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  return headers;
};

export const buildGeminiHeaders = buildBearerHeaders;

export const buildProviderRequest = (
  providerId: string,
  endpoint: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } => {
  if (providerId === 'deepseek') {
    return { url: getDeepSeekChatCompletionsUrl(), headers: buildBearerHeaders(apiKey) };
  }
  if (providerId === 'google') {
    return { url: getGeminiChatCompletionsUrl(), headers: buildBearerHeaders(apiKey) };
  }
  // OpenAI / Groq / 国内兼容接口等：走同源代理，避免浏览器 CORS 拦截自定义 Key
  if (providerId in OPENAI_COMPAT_PROXY_ENDPOINTS) {
    return {
      url: getCompatProxyUrl(providerId),
      headers: {
        ...buildBearerHeaders(apiKey),
        'X-Desmos-Provider': providerId,
      },
    };
  }
  return {
    url: endpoint,
    headers: buildBearerHeaders(apiKey),
  };
};

/** 压缩图片后再发给视觉模型，避免超大 base64 导致超时 */
export const compressImageDataUrl = (
  dataUrl: string,
  maxDim = 1280,
  quality = 0.82,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas unavailable'));
        return;
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = dataUrl;
  });

export const mapApiFetchError = (error: unknown, status?: number): Error => {
  if (status === 401 || status === 403) return new Error('Unauthorized');
  if (status === 429) return new Error('API Quota Exceeded');
  if (error instanceof TypeError) return new Error('NetworkError');
  if (error instanceof Error) return error;
  return new Error('Unknown API error');
};

/** @deprecated */
export const mapGeminiFetchError = mapApiFetchError;
