/**
 * GIF → Desmos 时间轴动画
 * - 每帧与单图相同精度（3600 填色 / 1280px / 完整 AI tuning）
 * - 大幅提速：批量并行 AI + 并行本地修复 + Worker 全并行
 * - 终止任务时交付已完成帧
 */

import {
  decodeGifWithTimeline,
  scaleGifFrame,
} from './gif-decode';
import {
  appendGifFrameToCalculator,
  generateFourierExpressionsFromContext,
  initGifStreamCalculator,
  SINGLE_IMAGE_MAX_DIM,
  SINGLE_IMAGE_MAX_FILL_POLYGONS,
  updateGifStreamDuration,
} from './image-processing';
import {
  analyzeSmartDrawBatchWithAI,
  prepareSmartDrawFromAiResult,
  type SmartDrawMode,
  type SmartDrawAIContour,
  type SmartDrawTuningParams,
} from './smart-draw-repair';
import {
  getGifQualityProfile,
  GIF_TIME_SLIDER,
  GIF_SLIDER_STEP,
  type GifQualityTier,
} from './gif-quality';
import { countContinuousFrameResults, createGifWorkerPool } from './gif-worker-pool';
import type { GifFrameWorkerInput } from './gif-frame.worker';

export { GIF_TIME_SLIDER, GIF_SLIDER_STEP };
export type { GifQualityTier };

const yieldToMain = (): Promise<void> =>
  new Promise(resolve => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => resolve(), { timeout: 16 });
    } else {
      setTimeout(resolve, 0);
    }
  });

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

async function runParallel<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldAbort?: () => boolean,
): Promise<void> {
  if (items.length === 0) return;
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      if (shouldAbort?.()) return;
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

export type ProcessGifResult = {
  expressions: any[];
  frameCount: number;
  completedFrames: number;
  totalFrames: number;
  durationSec: number;
  partial: boolean;
  explanation: string;
  /** 已流式写入画板，无需再次 bulk inject */
  streamed?: boolean;
};

/** 按帧序缓冲：Worker 乱序完成时仍顺序注入画板 */
class OrderedFrameStream {
  private nextIndex = 0;
  private buffer = new Map<number, any[]>();
  private chain = Promise.resolve();

  constructor(
    private onFrame: (index: number, expressions: any[]) => Promise<void>,
  ) {}

  push(index: number, expressions: any[]): void {
    this.buffer.set(index, expressions);
    this.chain = this.chain.then(() => this.flushReady());
  }

  private async flushReady(): Promise<void> {
    while (this.buffer.has(this.nextIndex)) {
      const exprs = this.buffer.get(this.nextIndex)!;
      this.buffer.delete(this.nextIndex);
      await this.onFrame(this.nextIndex, exprs);
      this.nextIndex++;
    }
  }

  async drain(): Promise<void> {
    await this.chain;
  }

  get continuousDone(): number {
    return this.nextIndex;
  }
}

export function buildGifTimeSliderExpression(
  durationSec: number,
  sliderVar = GIF_TIME_SLIDER,
): any {
  const max = Math.max(0.1, Math.round(durationSec * 100) / 100);
  return {
    id: 'gif_time_slider',
    latex: `${sliderVar}=0`,
    sliderBounds: {
      min: '0',
      max: String(max),
      step: GIF_SLIDER_STEP,
    },
    hidden: false,
  };
}

type ScaledKeyframe = {
  fi: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  timeStartSec: number;
  timeEndSec: number;
  dataUrl: string;
};

type PreparedFrame = {
  tuning: SmartDrawTuningParams;
  aiContours: SmartDrawAIContour[];
  repairedPixels: Uint8ClampedArray;
};

const buildScaledKeyframe = (
  keyframe: { imageData: ImageData; timeStartSec: number; timeEndSec: number },
  fi: number,
  gifW: number,
  gifH: number,
  maxDim: number,
  jpegQuality: number,
): ScaledKeyframe => {
  const scaled = scaleGifFrame(keyframe.imageData, gifW, gifH, maxDim);
  const canvas = document.createElement('canvas');
  canvas.width = scaled.width;
  canvas.height = scaled.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(scaled.imageData, 0, 0);

  return {
    fi,
    width: scaled.width,
    height: scaled.height,
    pixels: new Uint8ClampedArray(scaled.imageData.data),
    timeStartSec: keyframe.timeStartSec,
    timeEndSec: keyframe.timeEndSec,
    dataUrl: canvas.toDataURL('image/jpeg', jpegQuality),
  };
};

const prepareFrameLocal = (
  sf: ScaledKeyframe,
  mode: SmartDrawMode,
  aiResult?: { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] },
): PreparedFrame => {
  const canvas = document.createElement('canvas');
  canvas.width = sf.width;
  canvas.height = sf.height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(sf.pixels, sf.width, sf.height), 0, 0);

  const { tuning, aiContours } = prepareSmartDrawFromAiResult(
    ctx, sf.width, sf.height, mode, aiResult ?? null,
  );

  return {
    tuning,
    aiContours,
    repairedPixels: new Uint8ClampedArray(ctx.getImageData(0, 0, sf.width, sf.height).data),
  };
};

/** 多批 AI 并行请求（8 帧/批 × 3 批同时进行） */
const fetchBatchAiParallel = async (
  scaledFrames: ScaledKeyframe[],
  mode: SmartDrawMode,
  profile: ReturnType<typeof getGifQualityProfile>,
  enableAi: boolean,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
  onProgress: (done: number, total: number) => void,
): Promise<Map<number, { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] }>> => {
  const aiMap = new Map<number, { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] }>();
  if (!enableAi || mode === 'fill') return aiMap;

  const batches: ScaledKeyframe[][] = [];
  for (let i = 0; i < scaledFrames.length; i += profile.aiBatchSize) {
    batches.push(scaledFrames.slice(i, i + profile.aiBatchSize));
  }

  let aiDone = 0;
  const total = scaledFrames.length;

  await runParallel(
    batches,
    profile.aiParallelBatches,
    async (batch) => {
      if (signal?.aborted) return;
      try {
        const batchResult = await analyzeSmartDrawBatchWithAI(
          batch.map(sf => ({
            frameIndex: sf.fi,
            dataUrl: sf.dataUrl,
            width: sf.width,
            height: sf.height,
          })),
          mode,
          apiKey,
          signal,
        );
        batchResult.forEach((v, k) => aiMap.set(k, v));
        aiDone += batch.length;
        onProgress(Math.min(aiDone, total), total);
        await yieldToMain();
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) return;
        throw err;
      }
    },
    () => Boolean(signal?.aborted),
  );

  return aiMap;
};

const buildGifResult = (
  timeline: { durationSec: number; keyframes: unknown[] },
  scaledFrames: ScaledKeyframe[],
  frameExpressions: any[][],
  completedFrames: number,
  profile: ReturnType<typeof getGifQualityProfile>,
  partial: boolean,
  streamed = false,
): ProcessGifResult => {
  const totalFrames = timeline.keyframes.length;
  const completed = Math.max(0, Math.min(completedFrames, totalFrames));

  if (completed === 0) {
    throw new DOMException('Aborted', 'AbortError');
  }

  if (!streamed) {
    const flatExprs = frameExpressions.slice(0, completed).flat().filter(Boolean);
    if (flatExprs.length === 0) {
      throw new DOMException('Aborted', 'AbortError');
    }
  }

  const durationSec = partial && completed < totalFrames
    ? scaledFrames[completed - 1].timeEndSec
    : timeline.durationSec;

  const tierLabel = profile.tier === 'cinema' ? '电影级' : '标准';
  const fpsLabel = `${profile.targetFps}fps`;
  const durationLabel = durationSec.toFixed(1);

  return {
    expressions: streamed ? [] : [
      buildGifTimeSliderExpression(durationSec),
      ...frameExpressions.slice(0, completed).flat().filter(Boolean),
    ],
    frameCount: completed,
    completedFrames: completed,
    totalFrames,
    durationSec,
    partial,
    streamed,
    explanation: partial
      ? `GIF ${tierLabel}部分完成（${completed}/${totalFrames} 帧，${durationLabel}s）。滑块 s 可播放已完成部分。`
      : `GIF ${tierLabel}（${completed} 帧，${durationLabel}s，${fpsLabel}）。每帧与单图相同精度；滑块 s 控制播放。`,
  };
};

export type ProcessGifOptions = {
  mode?: SmartDrawMode;
  apiKey?: string;
  enableAiRepair?: boolean;
  quality?: GifQualityTier;
  signal?: AbortSignal;
  /** 提供则 Worker 完成一帧立刻流式写入（默认 true） */
  calculator?: any;
  streamToCalculator?: boolean;
  onProgress?: (
    current: number,
    total: number,
    phase: 'decode' | 'frame' | 'ai' | 'worker' | 'inject',
  ) => void;
};

export async function processGifToDesmosAnimation(
  file: File,
  options: ProcessGifOptions = {},
): Promise<ProcessGifResult> {
  const mode = options.mode ?? 'both';
  const enableAi = options.enableAiRepair !== false;
  const profile = getGifQualityProfile(options.quality ?? 'standard');
  const maxDim = Math.max(profile.maxDim, SINGLE_IMAGE_MAX_DIM);

  options.onProgress?.(0, 1, 'decode');
  await yieldToMain();
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const timeline = await decodeGifWithTimeline(file, {
    minIntervalSec: profile.sampleIntervalSec,
    targetFps: profile.targetFps,
    maxKeyframes: profile.maxKeyframes,
    sceneChangeThreshold: profile.sceneChangeThreshold,
  });

  const frameCount = timeline.keyframes.length;
  if (frameCount === 0) throw new Error('GIF has no frames');

  const scaledFrames: ScaledKeyframe[] = [];
  for (let fi = 0; fi < timeline.keyframes.length; fi++) {
    scaledFrames.push(buildScaledKeyframe(
      timeline.keyframes[fi],
      fi,
      timeline.width,
      timeline.height,
      maxDim,
      profile.jpegQuality,
    ));
    if (fi > 0 && fi % 16 === 0) {
      await yieldToMain();
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
  }

  const aiMap = await fetchBatchAiParallel(
    scaledFrames,
    mode,
    profile,
    enableAi,
    options.apiKey,
    options.signal,
    (done, total) => options.onProgress?.(done, total, 'ai'),
  );

  // AI 完成后释放 JPEG dataUrl，降低峰值内存
  for (const sf of scaledFrames) {
    sf.dataUrl = '';
  }

  const preparedFrames: PreparedFrame[] = new Array(frameCount);

  await runParallel(
    scaledFrames.map((_, i) => i),
    profile.localPrepareConcurrency,
    async (fi) => {
      if (options.signal?.aborted) return;
      preparedFrames[fi] = prepareFrameLocal(
        scaledFrames[fi],
        mode,
        aiMap.get(scaledFrames[fi].fi),
      );
    },
    () => Boolean(options.signal?.aborted),
  );

  // 终止时至少保证第 0 帧可交付（本地修复不依赖 AI）
  if (!preparedFrames[0] && scaledFrames.length > 0) {
    preparedFrames[0] = prepareFrameLocal(
      scaledFrames[0],
      mode,
      aiMap.get(scaledFrames[0].fi),
    );
  }

  let prepareDone = 0;
  for (let i = 0; i < frameCount; i++) {
    if (!preparedFrames[i]) break;
    prepareDone = i + 1;
  }

  if (prepareDone === 0) {
    throw new DOMException('Aborted', 'AbortError');
  }

  options.onProgress?.(0, prepareDone, 'worker');
  await yieldToMain();

  const useStreaming = Boolean(
    options.calculator && options.streamToCalculator !== false,
  );
  let streamInitialized = false;
  let framesInjected = 0;

  const frameStream = useStreaming
    ? new OrderedFrameStream(async (fi, exprs) => {
      if (!streamInitialized) {
        initGifStreamCalculator(
          options.calculator,
          timeline.durationSec,
          GIF_TIME_SLIDER,
          GIF_SLIDER_STEP,
        );
        streamInitialized = true;
      }
      await appendGifFrameToCalculator(options.calculator, exprs);
      framesInjected++;
      preparedFrames[fi] = undefined as unknown as PreparedFrame;
      scaledFrames[fi].pixels = new Uint8ClampedArray(0);
      options.onProgress?.(framesInjected, prepareDone, 'inject');
    })
    : null;

  const pool = createGifWorkerPool(profile.workerCount);
  const frameExpressions: any[][] = useStreaming ? [] : new Array(prepareDone);
  let exprCompleted = 0;

  const releaseFrameMemory = (fi: number) => {
    preparedFrames[fi] = undefined as unknown as PreparedFrame;
    if (scaledFrames[fi]) scaledFrames[fi].pixels = new Uint8ClampedArray(0);
  };

  if (pool) {
    const workerInputs: GifFrameWorkerInput[] = [];
    for (let fi = 0; fi < prepareDone; fi++) {
      if (!preparedFrames[fi]) break;
      const sf = scaledFrames[fi];
      workerInputs.push({
        taskId: `f${sf.fi}`,
        pixels: preparedFrames[fi].repairedPixels,
        fillPixels: sf.pixels,
        width: sf.width,
        height: sf.height,
        mode,
        tuning: preparedFrames[fi].tuning,
        aiContours: preparedFrames[fi].aiContours,
        frameSlot: sf.fi + 1,
        timeStartSec: sf.timeStartSec,
        timeEndSec: sf.timeEndSec,
        alreadyRepaired: true,
      });
    }

    try {
      const results = await pool.runUntilAbort(
        workerInputs,
        options.signal,
        (done, total) => options.onProgress?.(done, total, 'worker'),
        async (index, exprs) => {
          if (frameStream) {
            frameStream.push(index, exprs);
          } else {
            frameExpressions[index] = exprs;
          }
        },
      );
      if (frameStream) {
        await frameStream.drain();
        exprCompleted = frameStream.continuousDone;
      } else {
        exprCompleted = countContinuousFrameResults(results);
        for (let i = 0; i < exprCompleted; i++) {
          frameExpressions[i] = results[i];
        }
      }
    } finally {
      pool.terminate();
    }
  } else {
    await runParallel(
      Array.from({ length: prepareDone }, (_, i) => i),
      profile.localPrepareConcurrency,
      async (fi) => {
        if (options.signal?.aborted) return;
        const sf = scaledFrames[fi];
        const canvas = document.createElement('canvas');
        canvas.width = sf.width;
        canvas.height = sf.height;
        const ctx = canvas.getContext('2d')!;
        ctx.putImageData(new ImageData(preparedFrames[fi].repairedPixels, sf.width, sf.height), 0, 0);
        const fillImageData = new ImageData(new Uint8ClampedArray(sf.pixels), sf.width, sf.height);
        const frameSlot = sf.fi + 1;
        const { expressions } = generateFourierExpressionsFromContext(
          ctx, sf.width, sf.height,
          {
            mode,
            tuning: preparedFrames[fi].tuning,
            aiContours: preparedFrames[fi].aiContours,
            fillImageData,
            maxFillPolygons: SINGLE_IMAGE_MAX_FILL_POLYGONS,
            varNamespace: frameSlot,
            frameSlot,
            frameSliderVar: GIF_TIME_SLIDER,
            gifTimeBasedSlider: true,
            gifTimeStart: sf.timeStartSec,
            gifTimeEnd: sf.timeEndSec,
            idPrefix: `gif_f${frameSlot}_`,
          },
        );
        if (frameStream) {
          frameStream.push(fi, expressions);
        } else {
          frameExpressions[fi] = expressions;
        }
        if (!frameStream) {
          exprCompleted = countContinuousFrameResults(frameExpressions);
        }
        options.onProgress?.(
          frameStream ? fi + 1 : exprCompleted,
          prepareDone,
          frameStream ? 'inject' : 'frame',
        );
        releaseFrameMemory(fi);
      },
      () => Boolean(options.signal?.aborted),
    );
    if (frameStream) {
      await frameStream.drain();
      exprCompleted = frameStream.continuousDone;
    } else {
      exprCompleted = countContinuousFrameResults(frameExpressions);
    }
  }

  const partial = Boolean(options.signal?.aborted) || exprCompleted < frameCount;

  if (useStreaming && streamInitialized) {
    const finalDuration = partial && exprCompleted > 0
      ? scaledFrames[exprCompleted - 1].timeEndSec
      : timeline.durationSec;
    updateGifStreamDuration(
      options.calculator,
      finalDuration,
      GIF_TIME_SLIDER,
      GIF_SLIDER_STEP,
    );
  }

  return buildGifResult(
    timeline,
    scaledFrames,
    frameExpressions,
    exprCompleted,
    profile,
    partial,
    useStreaming && streamInitialized,
  );
}

export { applyGifExpressionsToCalculator } from './image-processing';

/** @deprecated */
export const GIF_FRAME_SLIDER = 'f';
