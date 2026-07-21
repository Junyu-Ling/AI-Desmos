/**
 * Smart Drawing 图像修复与 AI 视觉分析
 * 在傅里叶拟合前增强对比度、锐化边缘，并由视觉模型优化拟合参数。
 */

import { getProviderById } from './api-providers';
import { getApiConfig } from './deepseek';

export type SmartDrawMode = 'outline' | 'fill' | 'both';

export type SmartDrawTuningParams = {
  /** 对比度拉伸强度 1.0–2.5 */
  contrastBoost: number;
  /** 锐化强度 0–1.5 */
  sharpenAmount: number;
  /** 边缘检测阈值倍率 0.5–1.5（越小保留越多弱边缘） */
  edgeThresholdFactor: number;
  /** 轮廓强度过滤比例 0.12–0.45（越小保留越多弱轮廓） */
  strengthThresholdRatio: number;
  /** 最多保留轮廓数 */
  maxContours: number;
  /** 傅里叶频率项数 */
  fourierK: number;
  /** 每条轮廓降采样目标点数 */
  targetPointCount: number;
  /** 保留细线/小轮廓，降低几何过滤强度 */
  preserveFineDetails: boolean;
  /** 深色背景图反色为白底黑线 */
  invertColors: boolean;
  /** 预处理模糊次数 0–2 */
  blurPasses: number;
};

export const DEFAULT_SMART_DRAW_TUNING: SmartDrawTuningParams = {
  contrastBoost: 1.35,
  sharpenAmount: 0.65,
  edgeThresholdFactor: 0.85,
  strengthThresholdRatio: 0.22,
  maxContours: 55,
  fourierK: 110,
  targetPointCount: 480,
  preserveFineDetails: true,
  invertColors: false,
  blurPasses: 1,
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function mergeSmartDrawTuning(
  partial: Partial<SmartDrawTuningParams>,
): SmartDrawTuningParams {
  return {
    contrastBoost: clamp(partial.contrastBoost ?? DEFAULT_SMART_DRAW_TUNING.contrastBoost, 1, 2.5),
    sharpenAmount: clamp(partial.sharpenAmount ?? DEFAULT_SMART_DRAW_TUNING.sharpenAmount, 0, 1.5),
    edgeThresholdFactor: clamp(
      partial.edgeThresholdFactor ?? DEFAULT_SMART_DRAW_TUNING.edgeThresholdFactor,
      0.4,
      1.6,
    ),
    strengthThresholdRatio: clamp(
      partial.strengthThresholdRatio ?? DEFAULT_SMART_DRAW_TUNING.strengthThresholdRatio,
      0.1,
      0.5,
    ),
    maxContours: clamp(Math.round(partial.maxContours ?? DEFAULT_SMART_DRAW_TUNING.maxContours), 25, 90),
    fourierK: clamp(Math.round(partial.fourierK ?? DEFAULT_SMART_DRAW_TUNING.fourierK), 40, 160),
    targetPointCount: clamp(
      Math.round(partial.targetPointCount ?? DEFAULT_SMART_DRAW_TUNING.targetPointCount),
      250,
      800,
    ),
    preserveFineDetails: partial.preserveFineDetails ?? DEFAULT_SMART_DRAW_TUNING.preserveFineDetails,
    invertColors: partial.invertColors ?? DEFAULT_SMART_DRAW_TUNING.invertColors,
    blurPasses: clamp(Math.round(partial.blurPasses ?? DEFAULT_SMART_DRAW_TUNING.blurPasses), 0, 2),
  };
}

/** 基于图像统计的启发式参数（无需 API） */
export function analyzeImageHeuristically(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mode: SmartDrawMode,
): SmartDrawTuningParams {
  const { data } = ctx.getImageData(0, 0, width, height);
  let sum = 0;
  let dark = 0;
  let bright = 0;
  let edgeSpread = 0;
  const samples = Math.min(data.length / 4, width * height);
  const step = Math.max(4, Math.floor((width * height) / 8000));

  for (let i = 0; i < width * height; i += step) {
    const off = i * 4;
    const lum = 0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2];
    sum += lum;
    if (lum < 60) dark += 1;
    if (lum > 200) bright += 1;
    if (i + step * 4 < data.length) {
      const lum2 = 0.299 * data[off + step * 4] + 0.587 * data[off + step * 4 + 1]
        + 0.114 * data[off + step * 4 + 2];
      edgeSpread += Math.abs(lum - lum2);
    }
  }

  const count = Math.ceil((width * height) / step);
  const avgLum = sum / count;
  const darkRatio = dark / count;
  const brightRatio = bright / count;
  const avgEdge = edgeSpread / count;

  const lowContrast = avgEdge < 18;
  const darkBackground = avgLum < 110 && darkRatio > 0.35;
  const complexImage = avgEdge > 35 || darkRatio > 0.15;

  const tuning: Partial<SmartDrawTuningParams> = {
    invertColors: darkBackground,
    contrastBoost: lowContrast ? 1.75 : 1.35,
    sharpenAmount: lowContrast ? 0.85 : 0.6,
    edgeThresholdFactor: complexImage ? 0.72 : 0.9,
    strengthThresholdRatio: complexImage ? 0.18 : 0.24,
    maxContours: complexImage ? 65 : 50,
    fourierK: complexImage ? 125 : 100,
    targetPointCount: complexImage ? 560 : 450,
    preserveFineDetails: true,
    blurPasses: lowContrast ? 0 : 1,
  };

  if (mode === 'outline') {
    tuning.sharpenAmount = (tuning.sharpenAmount ?? 0.6) + 0.15;
    tuning.edgeThresholdFactor = (tuning.edgeThresholdFactor ?? 0.85) * 0.92;
  } else if (mode === 'fill') {
    tuning.fourierK = Math.min(tuning.fourierK ?? 100, 80);
    tuning.maxContours = Math.min(tuning.maxContours ?? 50, 40);
  }

  return mergeSmartDrawTuning(tuning);
}

const VISION_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  google: 'gemini-2.0-flash',
  claude: 'claude-3-5-sonnet-20241022',
  openrouter: 'openai/gpt-4o-mini',
  xai: 'grok-2-vision-latest',
};

const VISION_PROMPT = `You analyze images for conversion into parametric curves (edge detection + Fourier series).
Return ONLY valid JSON (no markdown) with these fields:
{
  "contrastBoost": number (1.0-2.5),
  "sharpenAmount": number (0-1.5),
  "edgeThresholdFactor": number (0.4-1.6, lower keeps more weak edges),
  "strengthThresholdRatio": number (0.1-0.5, lower keeps more contours),
  "maxContours": integer (25-90),
  "fourierK": integer (40-160, higher = more detail),
  "targetPointCount": integer (250-800),
  "preserveFineDetails": boolean,
  "invertColors": boolean (true if dark background / light lines),
  "blurPasses": integer (0-2)
}
Goal: preserve fine lines, hair, small features; reduce noise blobs. Mode: {MODE}.`;

function parseVisionJson(text: string): Partial<SmartDrawTuningParams> | null {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as Partial<SmartDrawTuningParams>;
  } catch {
    return null;
  }
}

async function callOpenAiVision(
  endpoint: string,
  apiKey: string,
  model: string,
  dataUrl: string,
  mode: SmartDrawMode,
): Promise<Partial<SmartDrawTuningParams> | null> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT.replace('{MODE}', mode) },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      }],
    }),
  });

  if (!response.ok) return null;
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  return parseVisionJson(content);
}

async function callClaudeVision(
  apiKey: string,
  model: string,
  dataUrl: string,
  mode: SmartDrawMode,
): Promise<Partial<SmartDrawTuningParams> | null> {
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const mediaType = dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          { type: 'text', text: VISION_PROMPT.replace('{MODE}', mode) },
        ],
      }],
    }),
  });

  if (!response.ok) return null;
  const json = await response.json();
  const block = json?.content?.find((b: { type: string }) => b.type === 'text');
  if (!block?.text) return null;
  return parseVisionJson(block.text);
}

/** 调用视觉模型分析图片，失败时返回 null */
export async function analyzeImageWithAI(
  dataUrl: string,
  mode: SmartDrawMode,
  apiKey?: string,
): Promise<Partial<SmartDrawTuningParams> | null> {
  const cfg = getApiConfig();
  const key = (apiKey || cfg.key || '').trim();
  if (!key) return null;

  const provider = getProviderById(cfg.provider);
  if (!provider) return null;

  const visionModel = VISION_MODELS[provider.id];
  if (!visionModel && provider.format !== 'anthropic') return null;

  try {
    if (provider.format === 'anthropic') {
      return await callClaudeVision(key, visionModel || provider.defaultModel, dataUrl, mode);
    }
    return await callOpenAiVision(provider.endpoint, key, visionModel || provider.defaultModel, dataUrl, mode);
  } catch {
    return null;
  }
}

/** 在 Canvas 上应用对比度拉伸、锐化、可选反色 */
export function applyLocalImageRepair(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  tuning: SmartDrawTuningParams,
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;

  let minLum = 255;
  let maxLum = 0;
  const lumArr = new Float32Array(width * height);

  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    let r = data[off];
    let g = data[off + 1];
    let b = data[off + 2];

    if (tuning.invertColors) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }

    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    lumArr[i] = lum;
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
  }

  const range = Math.max(1, maxLum - minLum);
  const boost = tuning.contrastBoost;

  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    let r = data[off];
    let g = data[off + 1];
    let b = data[off + 2];

    if (tuning.invertColors) {
      r = 255 - r;
      g = 255 - g;
      b = 255 - b;
    }

    const norm = ((lumArr[i] - minLum) / range - 0.5) * boost + 0.5;
    const factor = clamp(norm / Math.max(0.01, lumArr[i] / 255), 0.3, 3);

    data[off] = clamp(Math.round(r * factor), 0, 255);
    data[off + 1] = clamp(Math.round(g * factor), 0, 255);
    data[off + 2] = clamp(Math.round(b * factor), 0, 255);
  }

  ctx.putImageData(imageData, 0, 0);

  if (tuning.sharpenAmount > 0.05) {
    applyUnsharpMask(ctx, width, height, tuning.sharpenAmount);
  }
}

function applyUnsharpMask(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  amount: number,
): void {
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const copy = new Uint8ClampedArray(data);

  const kernel = [
    0, -amount, 0,
    -amount, 1 + 4 * amount, -amount,
    0, -amount, 0,
  ];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let ki = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const idx = ((y + ky) * width + (x + kx)) * 4 + c;
            sum += copy[idx] * kernel[ki++];
          }
        }
        data[(y * width + x) * 4 + c] = clamp(Math.round(sum), 0, 255);
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

export type SmartDrawRepairPhase = 'ai_analyze' | 'local_repair' | 'fit';

export async function prepareSmartDrawImage(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dataUrl: string,
  mode: SmartDrawMode,
  options: {
    apiKey?: string;
    enableAiRepair?: boolean;
    onProgress?: (phase: SmartDrawRepairPhase) => void;
  } = {},
): Promise<SmartDrawTuningParams> {
  let tuning = analyzeImageHeuristically(ctx, width, height, mode);

  if (options.enableAiRepair !== false) {
    options.onProgress?.('ai_analyze');
    const aiPartial = await analyzeImageWithAI(dataUrl, mode, options.apiKey);
    if (aiPartial) {
      tuning = mergeSmartDrawTuning({ ...tuning, ...aiPartial });
    }
  }

  options.onProgress?.('local_repair');
  applyLocalImageRepair(ctx, width, height, tuning);
  return tuning;
}
