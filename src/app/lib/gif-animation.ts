/**
 * GIF → Desmos 时间轴动画
 * - 高单帧精度 + 单帧可见播放（GifPlaybackManager）
 * - 提速：分块流水线重叠缩放、并行 Worker/AI、跳过无用 JPEG
 * - 防卡死：分块释放内存、频繁 yield
 */

import {
  decodeGifWithTimeline,
  scaleGifFrame,
  type DecodedGifKeyframe,
  type DecodedGifTimeline,
} from './gif-decode';
import {
  generateFourierExpressionsFromContext,
  initGifStreamCalculator,
  SINGLE_IMAGE_MAX_DIM,
  SINGLE_IMAGE_MAX_FILL_POLYGONS,
  updateGifStreamDuration,
  yieldQuick,
  yieldToInteractive,
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
  resolveGifWorkerCount,
  tuneGifProfileForAsset,
  type GifQualityTier,
} from './gif-quality';
import { countContinuousFrameResults, createGifWorkerPool } from './gif-worker-pool';
import type { GifFrameWorkerInput } from './gif-frame.worker';
import {
  attachGifWindowedPlayback,
  detachGifPlayback,
  GifWindowedPlaybackManager,
} from './gif-playback';
import { GifFrameArchive } from './gif-frame-archive';
import type { GifQualityProfile } from './gif-quality';

export { GIF_TIME_SLIDER, GIF_SLIDER_STEP };
export type { GifQualityTier };

const EMPTY_KEYFRAME_IMAGE = new ImageData(new Uint8ClampedArray(4), 1, 1);

const releaseScaledFrame = (sf: ScaledKeyframe) => {
  sf.dataUrl = '';
  sf.pixels = new Uint8ClampedArray(0);
};

const releaseTimelineKeyframe = (kf: DecodedGifKeyframe) => {
  kf.imageData = EMPTY_KEYFRAME_IMAGE;
};

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

/** 合并 AI tuning：只补默认值，不压低 AI/启发式给出的上限 */
const mergeGifTuning = (
  aiResult: { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] } | undefined,
  profile: GifQualityProfile,
): { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] } | undefined => {
  const defaults: Partial<SmartDrawTuningParams> = {
    maxContours: profile.maxContours,
    fourierK: profile.fourierKCap,
    targetPointCount: profile.targetPointCountCap,
  };
  if (!aiResult) {
    return { tuning: defaults, contours: [] };
  }
  return {
    tuning: { ...defaults, ...aiResult.tuning },
    contours: aiResult.contours,
  };
};

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

const buildScaledKeyframe = (
  keyframe: { imageData: ImageData; timeStartSec: number; timeEndSec: number },
  fi: number,
  gifW: number,
  gifH: number,
  maxDim: number,
  jpegQuality: number,
  needDataUrl: boolean,
): ScaledKeyframe => {
  const scaled = scaleGifFrame(keyframe.imageData, gifW, gifH, maxDim);
  let dataUrl = '';
  if (needDataUrl) {
    const canvas = document.createElement('canvas');
    canvas.width = scaled.width;
    canvas.height = scaled.height;
    canvas.getContext('2d')!.putImageData(scaled.imageData, 0, 0);
    dataUrl = canvas.toDataURL('image/jpeg', jpegQuality);
  }

  return {
    fi,
    width: scaled.width,
    height: scaled.height,
    pixels: new Uint8ClampedArray(scaled.imageData.data),
    timeStartSec: keyframe.timeStartSec,
    timeEndSec: keyframe.timeEndSec,
    dataUrl,
  };
};

const scaleChunkParallel = async (
  timeline: DecodedGifTimeline,
  chunkStart: number,
  chunkEnd: number,
  maxDim: number,
  jpegQuality: number,
  needDataUrl: boolean,
  concurrency: number,
  signal?: AbortSignal,
): Promise<ScaledKeyframe[]> => {
  const frameIndices = Array.from(
    { length: chunkEnd - chunkStart },
    (_, i) => chunkStart + i,
  );
  const scaledChunk: ScaledKeyframe[] = new Array(frameIndices.length);

  await runParallel(
    frameIndices,
    concurrency,
    async (fi, localIdx) => {
      if (signal?.aborted) return;
      scaledChunk[localIdx] = buildScaledKeyframe(
        timeline.keyframes[fi],
        fi,
        timeline.width,
        timeline.height,
        maxDim,
        jpegQuality,
        needDataUrl,
      );
      if (localIdx % 4 === 3) await yieldQuick();
    },
    () => Boolean(signal?.aborted),
  );

  return scaledChunk;
};

/** 多批 AI 并行请求 */
const fetchBatchAiParallel = async (
  scaledFrames: ScaledKeyframe[],
  mode: SmartDrawMode,
  profile: GifQualityProfile,
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
  profile: GifQualityProfile,
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
      : `GIF ${tierLabel}（${completed} 帧，${durationLabel}s，${fpsLabel}）。每帧与单图相同精度（3600 填色 / 1280px）；滑块 s 控制播放。`,
  };
};

export type ProcessGifOptions = {
  mode?: SmartDrawMode;
  apiKey?: string;
  enableAiRepair?: boolean;
  quality?: GifQualityTier;
  signal?: AbortSignal;
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
  const baseProfile = getGifQualityProfile(options.quality ?? 'standard');
  const useStreaming = Boolean(
    options.calculator && options.streamToCalculator !== false,
  );
  const playbackManager = useStreaming ? new GifWindowedPlaybackManager(new GifFrameArchive()) : null;
  const frameArchive = playbackManager?.getArchive() ?? null;

  options.onProgress?.(0, 1, 'decode');
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const timeline = await decodeGifWithTimeline(file, {
    minIntervalSec: baseProfile.sampleIntervalSec,
    targetFps: baseProfile.targetFps,
    maxKeyframes: baseProfile.maxKeyframes,
    sceneChangeThreshold: baseProfile.sceneChangeThreshold,
  });

  const frameCount = timeline.keyframes.length;
  if (frameCount === 0) throw new Error('GIF has no frames');

  const profile = tuneGifProfileForAsset(baseProfile, file, frameCount);
  const maxDim = Math.min(profile.maxDim, SINGLE_IMAGE_MAX_DIM);
  const chunkSize = profile.pipelineChunkSize;
  const needDataUrl = enableAi && mode !== 'fill';
  const workerCount = resolveGifWorkerCount(profile);

  let streamInitialized = false;
  if (useStreaming) {
    initGifStreamCalculator(
      options.calculator,
      timeline.durationSec,
      GIF_TIME_SLIDER,
      GIF_SLIDER_STEP,
    );
    streamInitialized = true;
  }

  let generationPlaybackReady = false;

  const ensureGenerationPlayback = () => {
    if (!playbackManager || !options.calculator || generationPlaybackReady) return;
    playbackManager.attachForGeneration(options.calculator, GIF_TIME_SLIDER);
    generationPlaybackReady = true;
  };

  const buildWorkerInput = (
    sf: ScaledKeyframe,
    aiResult?: { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] },
  ): GifFrameWorkerInput => {
    const capped = mergeGifTuning(aiResult, profile);
    return {
      taskId: `f${sf.fi}`,
      pixels: new Uint8ClampedArray(sf.pixels),
      width: sf.width,
      height: sf.height,
      mode,
      tuning: capped?.tuning,
      aiContours: capped?.contours ?? [],
      frameSlot: sf.fi + 1,
      timeStartSec: sf.timeStartSec,
      timeEndSec: sf.timeEndSec,
      gifIsLastFrame: sf.fi === frameCount - 1,
      useAiPrepare: true,
      maxFillPolygons: SINGLE_IMAGE_MAX_FILL_POLYGONS,
    };
  };

  const generateFrameOnMainThread = (
    sf: ScaledKeyframe,
    aiResult?: { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] },
  ): any[] => {
    const capped = mergeGifTuning(aiResult, profile);
    const canvas = document.createElement('canvas');
    canvas.width = sf.width;
    canvas.height = sf.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Frame canvas unavailable');

    ctx.putImageData(new ImageData(new Uint8ClampedArray(sf.pixels), sf.width, sf.height), 0, 0);
    const fillImageData = new ImageData(new Uint8ClampedArray(sf.pixels), sf.width, sf.height);
    const prepared = prepareSmartDrawFromAiResult(
      ctx,
      sf.width,
      sf.height,
      mode,
      capped ?? null,
    );
    const frameSlot = sf.fi + 1;
    const { expressions } = generateFourierExpressionsFromContext(
      ctx,
      sf.width,
      sf.height,
      {
        mode,
        tuning: prepared.tuning,
        aiContours: prepared.aiContours,
        fillImageData,
        maxFillPolygons: SINGLE_IMAGE_MAX_FILL_POLYGONS,
        varNamespace: frameSlot,
        frameSlot,
        frameSliderVar: GIF_TIME_SLIDER,
        gifTimeBasedSlider: true,
        gifTimeStart: sf.timeStartSec,
        gifTimeEnd: sf.timeEndSec,
        gifIsLastFrame: sf.fi === frameCount - 1,
        idPrefix: `gif_f${frameSlot}_`,
      },
    );
    return expressions;
  };

  const archiveFrame = (fi: number, expressions: any[]) => {
    if (!frameArchive || expressions.length === 0) return;
    const kf = timeline.keyframes[fi];
    if (!kf) return;
    frameArchive.add(fi, kf.timeStartSec, kf.timeEndSec, expressions);
    ensureGenerationPlayback();
    playbackManager?.onFrameArchived(fi);
  };

  const frameStream = useStreaming
    ? new OrderedFrameStream(async (fi, exprs) => {
      archiveFrame(fi, exprs);
      options.onProgress?.(fi + 1, frameCount, 'inject');
      if ((fi + 1) % 3 === 0) await yieldQuick();
    })
    : null;

  const pool = createGifWorkerPool(workerCount);
  const frameExpressions: any[][] = useStreaming ? [] : [];
  let exprCompleted = 0;
  let workerDone = 0;

  const scaleRange = (start: number, end: number) =>
    scaleChunkParallel(
      timeline,
      start,
      end,
      maxDim,
      profile.jpegQuality,
      needDataUrl,
      profile.scaleConcurrency,
      options.signal,
    );

  let pendingScale: Promise<ScaledKeyframe[]> | null = scaleRange(
    0,
    Math.min(chunkSize, frameCount),
  );

  try {
    for (let chunkStart = 0; chunkStart < frameCount; chunkStart += chunkSize) {
      if (options.signal?.aborted) break;

      const chunkEnd = Math.min(chunkStart + chunkSize, frameCount);
      const scaledChunk = await pendingScale!;
      pendingScale = chunkEnd < frameCount
        ? scaleRange(chunkEnd, Math.min(chunkEnd + chunkSize, frameCount))
        : null;

      await yieldToInteractive();

      const aiMap = await fetchBatchAiParallel(
        scaledChunk,
        mode,
        profile,
        enableAi,
        options.apiKey,
        options.signal,
        (done) => options.onProgress?.(chunkStart + done, frameCount, 'ai'),
      );

      for (const sf of scaledChunk) {
        sf.dataUrl = '';
      }

      if (pool) {
        const workerInputs = scaledChunk.map(sf =>
          buildWorkerInput(sf, aiMap.get(sf.fi)),
        );

        const workerResults = await pool.runUntilAbort(
          workerInputs,
          options.signal,
          (done) => {
            workerDone = chunkStart + done;
            options.onProgress?.(workerDone, frameCount, 'worker');
          },
          async (index, exprs) => {
            const globalIndex = chunkStart + index;
            if (frameStream) {
              frameStream.push(globalIndex, exprs);
            } else {
              frameExpressions[globalIndex] = exprs;
            }
          },
        );

        for (let localIdx = 0; localIdx < scaledChunk.length; localIdx++) {
          if (options.signal?.aborted) break;
          const exprs = workerResults[localIdx];
          if (exprs && exprs.length > 0) continue;

          const sf = scaledChunk[localIdx];
          const globalIndex = chunkStart + localIdx;
          try {
            const expressions = generateFrameOnMainThread(sf, aiMap.get(sf.fi));
            if (expressions.length === 0) continue;
            workerResults[localIdx] = expressions;
            if (frameStream) {
              frameStream.push(globalIndex, expressions);
            } else {
              frameExpressions[globalIndex] = expressions;
            }
            workerDone = Math.max(workerDone, globalIndex + 1);
            options.onProgress?.(workerDone, frameCount, 'worker');
            await yieldQuick();
          } catch (err) {
            if (!isAbortError(err)) {
              console.warn(`[GIF] main-thread fallback failed for frame ${globalIndex}`, err);
            }
            break;
          }
        }
      } else {
        await runParallel(
          scaledChunk.map((_, i) => i),
          profile.localPrepareConcurrency,
          async (localIdx) => {
            if (options.signal?.aborted) return;
            const sf = scaledChunk[localIdx];
            const globalIndex = chunkStart + localIdx;
            const expressions = generateFrameOnMainThread(sf, aiMap.get(sf.fi));
            if (frameStream) {
              frameStream.push(globalIndex, expressions);
            } else {
              frameExpressions[globalIndex] = expressions;
            }
            workerDone = Math.max(workerDone, globalIndex + 1);
            options.onProgress?.(workerDone, frameCount, 'worker');
            await yieldQuick();
          },
          () => Boolean(options.signal?.aborted),
        );
      }

      for (let fi = chunkStart; fi < chunkEnd; fi++) {
        releaseTimelineKeyframe(timeline.keyframes[fi]);
      }
      for (const sf of scaledChunk) {
        releaseScaledFrame(sf);
      }
      await yieldToInteractive();
    }

    if (frameStream) {
      await frameStream.drain();
      exprCompleted = frameStream.continuousDone;
    } else {
      exprCompleted = countContinuousFrameResults(frameExpressions);
    }
  } finally {
    pool?.terminate();
  }

  if (exprCompleted === 0 && workerDone > 0) {
    exprCompleted = workerDone;
  }
  if (exprCompleted === 0) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    throw new Error('GIF frame generation produced no output');
  }

  const partial = Boolean(options.signal?.aborted) || exprCompleted < frameCount;

  if (useStreaming && streamInitialized) {
    const finalDuration = partial && exprCompleted > 0
      ? timeline.keyframes[Math.min(exprCompleted - 1, frameCount - 1)].timeEndSec
      : timeline.durationSec;
    updateGifStreamDuration(
      options.calculator,
      finalDuration,
      GIF_TIME_SLIDER,
      GIF_SLIDER_STEP,
    );
  }

  if (useStreaming && streamInitialized && playbackManager && options.calculator) {
    attachGifWindowedPlayback(
      options.calculator,
      playbackManager,
      GIF_TIME_SLIDER,
      0,
      true,
    );
  }

  const scaledStub: ScaledKeyframe[] = timeline.keyframes.map((kf, fi) => ({
    fi,
    width: timeline.width,
    height: timeline.height,
    pixels: new Uint8ClampedArray(0),
    timeStartSec: kf.timeStartSec,
    timeEndSec: kf.timeEndSec,
    dataUrl: '',
  }));

  return buildGifResult(
    timeline,
    scaledStub,
    frameExpressions,
    exprCompleted,
    profile,
    partial,
    useStreaming && streamInitialized,
  );
}

export { applyGifExpressionsToCalculator } from './image-processing';
export { detachGifPlayback } from './gif-playback';

/** @deprecated */
export const GIF_FRAME_SLIDER = 'f';
