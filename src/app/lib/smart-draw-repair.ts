/**
 * Smart Drawing 图像修复与 AI 视觉分析
 * - 本地：对比度拉伸、锐化、反色
 * - AI：优化拟合参数 + 精确追踪主轮廓（补充 Sobel 边缘检测）
 */

import { getProviderById } from './api-providers';
import { getApiConfig, getEffectiveApiKey, resolveVisionModel } from './deepseek';
import { buildProviderRequest, compressImageDataUrl } from './gemini-api';

export type SmartDrawMode = 'outline' | 'fill' | 'both';

/** 仅轮廓模式：黑白统一线稿 / 沿边缘采样原图颜色 */
export type OutlineStyle = 'mono' | 'color';

export type SmartDrawTuningParams = {
  contrastBoost: number;
  sharpenAmount: number;
  edgeThresholdFactor: number;
  strengthThresholdRatio: number;
  maxContours: number;
  fourierK: number;
  targetPointCount: number;
  preserveFineDetails: boolean;
  invertColors: boolean;
  blurPasses: number;
};

export type SmartDrawAIContour = {
  closed: boolean;
  points: { x: number; y: number }[];
};

export type SmartDrawPrepareResult = {
  tuning: SmartDrawTuningParams;
  aiContours: SmartDrawAIContour[];
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
  let edgeSpread = 0;
  const step = Math.max(4, Math.floor((width * height) / 8000));

  for (let i = 0; i < width * height; i += step) {
    const off = i * 4;
    const lum = 0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2];
    sum += lum;
    if (lum < 60) dark += 1;
    if (i + step * 4 < data.length) {
      const lum2 = 0.299 * data[off + step * 4] + 0.587 * data[off + step * 4 + 1]
        + 0.114 * data[off + step * 4 + 2];
      edgeSpread += Math.abs(lum - lum2);
    }
  }

  const count = Math.ceil((width * height) / step);
  const avgLum = sum / count;
  const darkRatio = dark / count;
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

const PROXY_PROVIDERS = new Set(['deepseek', 'google']);

const SMART_DRAW_AI_PROMPT = `You analyze images for Smart Drawing: edge detection + Fourier parametric curves on Desmos.
Return ONLY valid JSON (no markdown). Mode: {MODE}.

{
  "contrastBoost": number (1.0-2.5),
  "sharpenAmount": number (0-1.5),
  "edgeThresholdFactor": number (0.4-1.6, lower = keep weak edges),
  "strengthThresholdRatio": number (0.1-0.5, lower = keep more contours),
  "maxContours": integer (25-90),
  "fourierK": integer (40-160, higher = sharper curves),
  "targetPointCount": integer (250-800),
  "preserveFineDetails": boolean,
  "invertColors": boolean (true if dark background / light lines),
  "blurPasses": integer (0-2),
  "contours": [
    {
      "closed": boolean,
      "points": [[x,y], ...] 
    }
  ]
}

For "contours" (skip or [] if mode is fill-only):
- Trace MAIN visible outlines only (outer shape, key internal lines, hair/fine features if important).
- Use normalized coords 0-1000: x=0 left, x=1000 right, y=0 top, y=1000 bottom.
- 12-60 points per contour, evenly spaced along the path.
- Max 20 contours. Prioritize accuracy over quantity.
- closed=true for loops; false for open strokes.`;

const SMART_DRAW_BATCH_AI_PROMPT = `You analyze {N} STOP-MOTION animation frames (indices 0..{N-1}) for Smart Drawing on Desmos.
Return ONLY valid JSON (no markdown). Mode: {MODE}.

CRITICAL — STOP-MOTION RULE:
Each frame is an independent still photograph. Motion is an ILLUSION created by small differences between consecutive frames.
- Analyze EVERY frame on its own; do NOT interpolate, smooth, or average across frames.
- Preserve ALL visible details IN THAT FRAME: outlines, fills, facial features, limbs, props, shadows, text.
- When a body part moves slightly between frames, trace its EXACT position in each frame separately.
- Use high fourierK (90-160) and targetPointCount (400-800) when the frame has fine detail.
- Set preserveFineDetails=true unless the frame is extremely simple.

{
  "frames": [
    {
      "index": 0,
      "contrastBoost": number (1.0-2.5),
      "sharpenAmount": number (0-1.5),
      "edgeThresholdFactor": number (0.4-1.6),
      "strengthThresholdRatio": number (0.1-0.5),
      "maxContours": integer (25-90),
      "fourierK": integer (40-160),
      "targetPointCount": integer (250-800),
      "preserveFineDetails": boolean,
      "invertColors": boolean,
      "blurPasses": integer (0-2),
      "contours": [{ "closed": boolean, "points": [[x,y], ...] }]
    }
  ]
}

Each frame image is labeled "Frame index K" before the image. Match results to that index.
For "contours" (skip or [] if mode is fill-only): normalized coords 0-1000, 20-60 points per contour, up to 40 contours per frame.
Prioritize per-frame accuracy over speed; missing micro-details kills the animation illusion.`;

type RawAIResponse = Partial<SmartDrawTuningParams> & {
  contours?: Array<{
    closed?: boolean;
    points?: unknown;
  }>;
};

function parseAIResponse(
  text: string,
  width: number,
  height: number,
): { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] } | null {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const raw = JSON.parse(jsonMatch[0]) as RawAIResponse;
    const { contours: rawContours, ...tuningPartial } = raw;
    const contours: SmartDrawAIContour[] = [];

    if (Array.isArray(rawContours)) {
      for (const item of rawContours.slice(0, 25)) {
        if (!Array.isArray(item.points) || item.points.length < 6) continue;

        const points: { x: number; y: number }[] = [];
        for (const pt of item.points) {
          if (!Array.isArray(pt) || pt.length < 2) continue;
          const nx = Number(pt[0]);
          const ny = Number(pt[1]);
          if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;
          points.push({
            x: clamp((nx / 1000) * width, 0, width - 1),
            y: clamp((ny / 1000) * height, 0, height - 1),
          });
        }

        if (points.length >= 6) {
          contours.push({ closed: Boolean(item.closed), points });
        }
      }
    }

    return { tuning: tuningPartial, contours };
  } catch {
    return null;
  }
}

type BatchRawFrame = RawAIResponse & { index?: number };

function parseBatchAIResponse(
  text: string,
  frames: Array<{ frameIndex: number; width: number; height: number }>,
): Map<number, { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] }> {
  const result = new Map<number, { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] }>();
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return result;

  try {
    const raw = JSON.parse(jsonMatch[0]) as { frames?: BatchRawFrame[] };
    const items = Array.isArray(raw.frames) ? raw.frames : [];

    for (const item of items) {
      const idx = Number(item.index);
      const meta = frames.find(f => f.frameIndex === idx) ?? frames[items.indexOf(item)];
      if (!meta) continue;

      const { contours: rawContours, index: _idx, ...tuningPartial } = item;
      const parsed = parseAIResponse(
        JSON.stringify({ ...tuningPartial, contours: rawContours }),
        meta.width,
        meta.height,
      );
      if (parsed) {
        result.set(meta.frameIndex, parsed);
      }
    }
  } catch {
    // ignore
  }

  return result;
}

async function callOpenAiVisionBatch(
  endpoint: string,
  model: string,
  batch: Array<{ dataUrl: string; frameIndex: number; width: number; height: number }>,
  mode: SmartDrawMode,
  headersOverride?: Record<string, string>,
  signal?: AbortSignal,
): Promise<Map<number, { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] }> | null> {
  const n = batch.length;
  const content: Array<{ type: string; text?: string; image_url?: { url: string; detail: string } }> = [
    {
      type: 'text',
      text: SMART_DRAW_BATCH_AI_PROMPT
        .replace('{N}', String(n))
        .replace('{N-1}', String(n - 1))
        .replace('{MODE}', mode),
    },
  ];

  for (const frame of batch) {
    content.push({ type: 'text', text: `Frame index ${frame.frameIndex}:` });
    content.push({ type: 'image_url', image_url: { url: frame.dataUrl, detail: 'high' } });
  }

  const headers = headersOverride ?? { 'Content-Type': 'application/json' };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: Math.min(16384, 2048 + n * 1200),
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) return null;
  const json = await response.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') return null;

  const parsed = parseBatchAIResponse(text, batch.map(f => ({
    frameIndex: f.frameIndex,
    width: f.width,
    height: f.height,
  })));
  return parsed.size > 0 ? parsed : null;
}

async function callClaudeVisionBatch(
  apiKey: string,
  model: string,
  batch: Array<{ dataUrl: string; frameIndex: number }>,
  mode: SmartDrawMode,
  frameMeta: Array<{ frameIndex: number; width: number; height: number }>,
  signal?: AbortSignal,
): Promise<Map<number, { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] }> | null> {
  const n = batch.length;
  const content: Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> = [
    {
      type: 'text',
      text: SMART_DRAW_BATCH_AI_PROMPT
        .replace('{N}', String(n))
        .replace('{N-1}', String(n - 1))
        .replace('{MODE}', mode),
    },
  ];

  for (const frame of batch) {
    const base64 = frame.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const mediaType = frame.dataUrl.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
    content.push({ type: 'text', text: `Frame index ${frame.frameIndex}:` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 },
    });
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(16384, 2048 + n * 1200),
      messages: [{ role: 'user', content }],
    }),
  });

  if (!response.ok) return null;
  const json = await response.json();
  const block = json?.content?.find((b: { type: string }) => b.type === 'text');
  if (!block?.text) return null;

  const parsed = parseBatchAIResponse(block.text, frameMeta);
  return parsed.size > 0 ? parsed : null;
}

export type SmartDrawBatchFrameInput = {
  frameIndex: number;
  dataUrl: string;
  width: number;
  height: number;
};

/** 批量 AI：一次请求分析多帧，降低成本；失败时回退逐帧 */
export async function analyzeSmartDrawBatchWithAI(
  frames: SmartDrawBatchFrameInput[],
  mode: SmartDrawMode,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<Map<number, { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] }>> {
  const result = new Map<number, { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] }>();
  if (frames.length === 0 || mode === 'fill') return result;
  if (signal?.aborted) return result;

  const cfg = getApiConfig();
  const key = getEffectiveApiKey(apiKey);
  const provider = getProviderById(cfg.provider);
  if (!provider) return result;
  if (!PROXY_PROVIDERS.has(provider.id) && !key) return result;

  try {
    const compressed = await Promise.all(
      frames.map(f => compressImageDataUrl(f.dataUrl, 768, 0.85)),
    );
    const batch = frames.map((f, i) => ({
      ...f,
      dataUrl: compressed[i],
    }));

    let batchResult: Map<number, { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] }> | null = null;

    if (provider.format === 'anthropic') {
      if (key) {
        batchResult = await callClaudeVisionBatch(
          key,
          resolveVisionModel(provider.id, cfg.model),
          batch,
          mode,
          frames.map(f => ({ frameIndex: f.frameIndex, width: f.width, height: f.height })),
          signal,
        );
      }
    } else {
      const { url, headers } = buildProviderRequest(provider.id, provider.endpoint, key);
      const model = resolveVisionModel(provider.id, cfg.model);
      batchResult = await callOpenAiVisionBatch(url, model, batch, mode, headers, signal);
    }

    if (batchResult && batchResult.size > 0) {
      batchResult.forEach((v, k) => result.set(k, v));
    }
  } catch {
    // fall through to per-frame fallback
  }

  const missing = frames.filter(f => !result.has(f.frameIndex));
  if (missing.length === 0) return result;

  await runParallel(missing, 4, async (frame) => {
    if (signal?.aborted) return;
    try {
      const single = await analyzeSmartDrawWithAI(
        frame.dataUrl, mode, frame.width, frame.height, apiKey,
      );
      if (single) result.set(frame.frameIndex, single);
    } catch {
      // skip frame
    }
  });

  return result;
}

async function runParallel<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** 合并 AI 结果到启发式 tuning（与 prepareSmartDrawImage 相同逻辑） */
export function mergeAiIntoSmartDrawTuning(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mode: SmartDrawMode,
  aiResult?: { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] } | null,
): SmartDrawPrepareResult {
  let tuning = analyzeImageHeuristically(ctx, width, height, mode);
  let aiContours: SmartDrawAIContour[] = [];

  if (aiResult) {
    tuning = mergeSmartDrawTuning({ ...tuning, ...aiResult.tuning });
    aiContours = aiResult.contours;
    if (aiContours.length > 0) {
      tuning = mergeSmartDrawTuning({
        ...tuning,
        preserveFineDetails: true,
        fourierK: Math.max(tuning.fourierK, 115),
        targetPointCount: Math.max(tuning.targetPointCount, 500),
      });
    }
  }

  return { tuning, aiContours };
}

/** 已有 AI 结果时本地修复（无 API，与单图 prepareSmartDrawImage 同精度） */
export function prepareSmartDrawFromAiResult(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mode: SmartDrawMode,
  aiResult?: { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] } | null,
): SmartDrawPrepareResult {
  const { tuning, aiContours } = mergeAiIntoSmartDrawTuning(ctx, width, height, mode, aiResult);
  applyLocalImageRepair(ctx, width, height, tuning);
  return { tuning, aiContours };
}

async function callOpenAiVision(
  endpoint: string,
  model: string,
  dataUrl: string,
  mode: SmartDrawMode,
  width: number,
  height: number,
  headersOverride?: Record<string, string>,
): Promise<{ tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] } | null> {
  const headers = headersOverride ?? { 'Content-Type': 'application/json' };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: SMART_DRAW_AI_PROMPT.replace('{MODE}', mode) },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
        ],
      }],
    }),
  });

  if (!response.ok) return null;
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;

  return parseAIResponse(content, width, height);
}

async function callClaudeVision(
  apiKey: string,
  model: string,
  dataUrl: string,
  mode: SmartDrawMode,
  width: number,
  height: number,
): Promise<{ tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] } | null> {
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
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          { type: 'text', text: SMART_DRAW_AI_PROMPT.replace('{MODE}', mode) },
        ],
      }],
    }),
  });

  if (!response.ok) return null;
  const json = await response.json();
  const block = json?.content?.find((b: { type: string }) => b.type === 'text');
  if (!block?.text) return null;
  return parseAIResponse(block.text, width, height);
}

/** 调用视觉模型：优化参数 + 追踪主轮廓；失败时返回 null */
export async function analyzeSmartDrawWithAI(
  dataUrl: string,
  mode: SmartDrawMode,
  width: number,
  height: number,
  apiKey?: string,
): Promise<{ tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] } | null> {
  if (mode === 'fill') return null;

  const cfg = getApiConfig();
  const key = getEffectiveApiKey(apiKey);
  const provider = getProviderById(cfg.provider);
  if (!provider) return null;

  if (!PROXY_PROVIDERS.has(provider.id) && !key) return null;

  try {
    const compressed = await compressImageDataUrl(dataUrl, 768, 0.85);

    if (provider.format === 'anthropic') {
      if (!key) return null;
      return await callClaudeVision(
        key,
        resolveVisionModel(provider.id, cfg.model),
        compressed,
        mode,
        width,
        height,
      );
    }

    const { url, headers } = buildProviderRequest(provider.id, provider.endpoint, key);
    const model = resolveVisionModel(provider.id, cfg.model);

    const result = await callOpenAiVision(url, model, compressed, mode, width, height, headers);
    if (!result) return null;
    return result;
  } catch {
    return null;
  }
}

/** @deprecated 使用 analyzeSmartDrawWithAI */
export async function analyzeImageWithAI(
  dataUrl: string,
  mode: SmartDrawMode,
  apiKey?: string,
): Promise<Partial<SmartDrawTuningParams> | null> {
  const result = await analyzeSmartDrawWithAI(dataUrl, mode, 1024, 1024, apiKey);
  return result?.tuning ?? null;
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
): Promise<SmartDrawPrepareResult> {
  let tuning = analyzeImageHeuristically(ctx, width, height, mode);
  let aiContours: SmartDrawAIContour[] = [];

  // 仅轮廓/仅填色：本地 Sobel + 对比度即可，无需视觉 API（减负服务器）
  const needsAi = options.enableAiRepair !== false && mode === 'both';

  if (needsAi) {
    options.onProgress?.('ai_analyze');
    const aiResult = await analyzeSmartDrawWithAI(dataUrl, mode, width, height, options.apiKey);
    if (aiResult) {
      const merged = mergeAiIntoSmartDrawTuning(ctx, width, height, mode, aiResult);
      tuning = merged.tuning;
      aiContours = merged.aiContours;
    }
  }

  options.onProgress?.('local_repair');
  applyLocalImageRepair(ctx, width, height, tuning);
  return { tuning, aiContours };
}
