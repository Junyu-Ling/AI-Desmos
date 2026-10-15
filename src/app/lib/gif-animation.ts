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
  measureOutlineCalibration,
  mergeOutlineCalibrations,
  retimeGifFrameExpressions,
  updateGifStreamDuration,
  yieldQuick,
  yieldToInteractive,
  type OutlineCalibration,
} from './image-processing';
import {
  analyzeSmartDrawBatchWithAI,
  applyLocalImageRepair,
  analyzeImageHeuristically,
  mergeSmartDrawTuning,
  prepareSmartDrawFromAiResult,
  type SmartDrawMode,
  type SmartDrawAIContour,
  type SmartDrawTuningParams,
} from './smart-draw-repair';
import {
  getGifQualityProfile,
  GIF_TIME_SLIDER,
  GIF_SLIDER_STEP,
  formatGifSliderStep,
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
import { stabilizeGifOutlineArchive } from './gif-outline-stabilize';
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

/** 合并 AI / 档位 tuning：高保真档强制保留细节，预处理参数全动画锁死 */
const mergeGifTuning = (
  aiResult: { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] } | undefined,
  profile: GifQualityProfile,
  calibration?: OutlineCalibration | null,
): { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] } | undefined => {
  const defaults: Partial<SmartDrawTuningParams> = {
    maxContours: profile.maxContours,
    fourierK: profile.fourierKCap,
    targetPointCount: profile.targetPointCountCap,
    preserveFineDetails: profile.preserveFineDetails,
    sharpenAmount: profile.sharpenAmount,
    edgeThresholdFactor: profile.edgeThresholdFactor,
    // 门槛是相对本帧最强边缘算的，卡太高会让同一个部位（手、耳朵）
    // 在动作模糊的帧掉出去、清晰的帧留下来，逐帧看就是忽有忽无
    strengthThresholdRatio: profile.preserveFineDetails ? 0.10 : 0.18,
    invertColors: calibration?.invertColors ?? false,
    contrastBoost: calibration?.contrastBoost ?? 1.35,
    blurPasses: calibration?.blurPasses ?? 1,
  };
  if (!aiResult) {
    return { tuning: defaults, contours: [] };
  }
  return {
    tuning: {
      ...defaults,
      ...aiResult.tuning,
      // 这些必须全动画一致：AI / 启发式是逐帧分析的，让它们改这里
      // 就等于每帧换一套预处理和判噪声标准，同一个部位会闪掉
      edgeThresholdFactor: defaults.edgeThresholdFactor,
      strengthThresholdRatio: defaults.strengthThresholdRatio,
      sharpenAmount: defaults.sharpenAmount,
      invertColors: defaults.invertColors,
      contrastBoost: defaults.contrastBoost,
      blurPasses: defaults.blurPasses,
      // 档位上限优先：不允许 AI 把保真参数压低
      maxContours: Math.max(defaults.maxContours ?? 0, aiResult.tuning.maxContours ?? 0),
      fourierK: Math.max(defaults.fourierK ?? 0, aiResult.tuning.fourierK ?? 0),
      targetPointCount: Math.max(defaults.targetPointCount ?? 0, aiResult.tuning.targetPointCount ?? 0),
      preserveFineDetails: Boolean(defaults.preserveFineDetails || aiResult.tuning.preserveFineDetails),
    },
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
  sliderStep = GIF_SLIDER_STEP,
): any {
  const max = Math.max(0.001, Math.round(durationSec * 10000) / 10000);
  return {
    id: 'gif_time_slider',
    latex: `${sliderVar}=0`,
    sliderBounds: {
      min: '0',
      max: String(max),
      step: sliderStep,
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

/** 标定采样帧数：3 帧足够锁门槛，两遍 6 帧会无谓拖长开头 */
const CALIBRATION_SAMPLE_COUNT = 3;

/**
 * 标定全动画共用的轮廓阈值和预处理参数。
 *
 * 边缘检测的两个门槛、以及反色/对比度/模糊，原本每帧各算一次，于是同一个部位
 * 存活与否取决于它当帧的邻居有多强、或者当帧要不要反色：主体动作大的帧门槛被
 * 抬高，手、耳朵这类弱边缘整批掉出去，播起来忽有忽无。
 * 先在若干帧上投票锁死预处理，再在修复后的画面上量边缘门槛，之后每帧都用同一套。
 */
const calibrateOutlineThresholds = async (
  timeline: DecodedGifTimeline,
  maxDim: number,
  profile: GifQualityProfile,
  mode: SmartDrawMode,
  signal?: AbortSignal,
): Promise<OutlineCalibration | null> => {
  const count = timeline.keyframes.length;
  if (count === 0) return null;

  const canvas = document.createElement('canvas');
  const step = Math.max(1, Math.floor(count / CALIBRATION_SAMPLE_COUNT));
  const sampleIndexes: number[] = [];
  for (let fi = 0; fi < count; fi += step) sampleIndexes.push(fi);

  const firstKeyframe = timeline.keyframes[sampleIndexes[0]];
  if (!firstKeyframe) return null;
  const firstScaled = scaleGifFrame(firstKeyframe.imageData, timeline.width, timeline.height, maxDim);
  canvas.width = firstScaled.width;
  canvas.height = firstScaled.height;
  const firstCtx = canvas.getContext('2d');
  if (!firstCtx) return null;
  firstCtx.putImageData(firstScaled.imageData, 0, 0);
  const firstHeuristic = analyzeImageHeuristically(firstCtx, firstScaled.width, firstScaled.height, mode);
  const invertColors = firstHeuristic.invertColors;
  const contrastBoost = firstHeuristic.contrastBoost;
  const blurPasses = firstHeuristic.blurPasses;

  const lockedTuning = mergeSmartDrawTuning({
    ...mergeGifTuning(undefined, profile)?.tuning,
    invertColors,
    contrastBoost,
    blurPasses,
    sharpenAmount: profile.sharpenAmount,
    edgeThresholdFactor: profile.edgeThresholdFactor,
  });

  const samples: OutlineCalibration[] = [];
  for (const fi of sampleIndexes) {
    if (signal?.aborted) break;
    const keyframe = timeline.keyframes[fi];
    if (!keyframe) continue;
    const scaled = fi === sampleIndexes[0]
      ? firstScaled
      : scaleGifFrame(keyframe.imageData, timeline.width, timeline.height, maxDim);
    canvas.width = scaled.width;
    canvas.height = scaled.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    ctx.putImageData(scaled.imageData, 0, 0);
    applyLocalImageRepair(ctx, scaled.width, scaled.height, lockedTuning);
    try {
      const measured = measureOutlineCalibration(ctx, scaled.width, scaled.height, lockedTuning);
      samples.push({ ...measured, invertColors, contrastBoost, blurPasses });
    } catch {
      // 单帧量不出来不影响整体，继续
    }
    await yieldQuick();
  }

  return mergeOutlineCalibrations(samples);
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
  if (!enableAi || mode !== 'both') return aiMap;

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
  timeline: {
    durationSec: number;
    keyframes: unknown[];
    frameIntervalSec: number;
    sliderMaxSec: number;
  },
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

  // 滑块上界取末帧刻度，拖到最右仍停在末帧（而不是越过末帧变空白）
  const sliderStep = formatGifSliderStep(timeline.frameIntervalSec);
  const sliderMax = partial && completed < totalFrames
    ? scaledFrames[completed - 1].timeStartSec
    : timeline.sliderMaxSec;

  const tierLabel = profile.tier === 'perfect'
    ? '完美定格'
    : profile.tier === 'cinema'
      ? '电影级'
      : '标准';
  const fpsLabel = `${profile.targetFps}fps`;
  const durationLabel = durationSec.toFixed(1);

  return {
    expressions: streamed ? [] : [
      buildGifTimeSliderExpression(sliderMax, GIF_TIME_SLIDER, sliderStep),
      ...frameExpressions.slice(0, completed).flat().filter(Boolean),
    ],
    frameCount: completed,
    completedFrames: completed,
    totalFrames,
    durationSec,
    partial,
    streamed,
    explanation: partial
      ? `GIF ${tierLabel}部分完成（${completed}/${totalFrames} 帧，${durationLabel}s）。拖动滑块 s 播放已完成部分。`
      : `GIF ${tierLabel}（${completed} 帧，${durationLabel}s，${fpsLabel}）。全帧已写入折叠文件夹 · 滑块 s 只显示当前帧。`,
  };
};

export type ProcessGifOptions = {
  mode?: SmartDrawMode;
  outlineStyle?: import('./smart-draw-repair').OutlineStyle;
  apiKey?: string;
  enableAiRepair?: boolean;
  quality?: GifQualityTier;
  signal?: AbortSignal;
  calculator?: any;
  streamToCalculator?: boolean;
  onProgress?: (
    current: number,
    total: number,
    phase: 'decode' | 'frame' | 'ai' | 'worker' | 'archive' | 'inject',
  ) => void;
};

export async function processGifToDesmosAnimation(
  file: File,
  options: ProcessGifOptions = {},
): Promise<ProcessGifResult> {
  const mode = options.mode ?? 'both';
  const outlineStyle = mode === 'both'
    ? 'mono'
    : (options.outlineStyle ?? 'color');
  const enableAi = options.enableAiRepair === true && mode === 'both';
  const baseProfile = getGifQualityProfile(options.quality ?? 'perfect');
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

  const profile = tuneGifProfileForAsset(baseProfile, file, frameCount, mode);
  const maxDim = profile.maxDim;
  const chunkSize = profile.pipelineChunkSize;
  const needDataUrl = enableAi && mode === 'both';
  const workerCount = resolveGifWorkerCount(profile);

  // 一格一帧：步长取实际帧间隔，滑块上界取末帧刻度
  const sliderStep = formatGifSliderStep(timeline.frameIntervalSec);

  // 全动画共用一组轮廓门槛，同一个细节不会在部分帧被判成噪声
  const calibration = mode === 'fill'
    ? null
    : await calibrateOutlineThresholds(
      timeline,
      maxDim,
      profile,
      mode,
      options.signal,
    );

  let streamInitialized = false;
  if (useStreaming) {
    initGifStreamCalculator(
      options.calculator,
      timeline.sliderMaxSec,
      GIF_TIME_SLIDER,
      sliderStep,
    );
    streamInitialized = true;
  }

  let generationPlaybackReady = false;

  const ensureGenerationPlayback = () => {
    if (!playbackManager || !options.calculator || generationPlaybackReady) return;
    playbackManager.attachForGeneration(options.calculator, GIF_TIME_SLIDER, sliderStep);
    generationPlaybackReady = true;
  };

  const buildWorkerInput = (
    sf: ScaledKeyframe,
    aiResult?: { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] },
  ): GifFrameWorkerInput => {
    const capped = mergeGifTuning(aiResult, profile, calibration);
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
      useAiPrepare: mode === 'both' && enableAi,
      maxFillPolygons: profile.maxFillPolygons,
      outlineStyle,
      skipFrameRestriction: false,
      fillDetailMode: 'merged',
      compactFourier: true,
      sharedEdgeStrength: calibration?.edgeStrength,
      sharedContourStrength: calibration?.contourStrength,
    };
  };

  const generateFrameOnMainThread = (
    sf: ScaledKeyframe,
    aiResult?: { tuning: Partial<SmartDrawTuningParams>; contours: SmartDrawAIContour[] },
  ): any[] => {
    const capped = mergeGifTuning(aiResult, profile, calibration);
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
    const baseOptions = {
      mode,
      tuning: prepared.tuning,
      aiContours: prepared.aiContours,
      fillImageData,
      outlineStyle,
      maxFillPolygons: profile.maxFillPolygons,
      varNamespace: frameSlot,
      frameSlot,
      frameSliderVar: GIF_TIME_SLIDER,
      gifTimeBasedSlider: true as const,
      gifTimeStart: sf.timeStartSec,
      gifTimeEnd: sf.timeEndSec,
      gifIsLastFrame: sf.fi === frameCount - 1,
      idPrefix: `gif_f${frameSlot}_`,
      skipFrameRestriction: false,
      compactFourier: true,
      sharedEdgeStrength: calibration?.edgeStrength,
      sharedContourStrength: calibration?.contourStrength,
    };
    try {
      return generateFourierExpressionsFromContext(ctx, sf.width, sf.height, {
        ...baseOptions,
        fillDetailMode: 'merged' as const,
      }).expressions;
    } catch {
      return generateFourierExpressionsFromContext(ctx, sf.width, sf.height, {
        ...baseOptions,
        fillDetailMode: 'cell' as const,
        compactFourier: false,
      }).expressions;
    }
  };

  /** 最近一帧成功的表达式，用于补空帧（宁可定格，也不要闪白） */
  let lastGoodFrame: { slot: number; expressions: any[] } | null = null;
  /** 开头就失败的帧：还没有可复用的帧，等结束后用首个成功帧回填 */
  const framesAwaitingBackfill: number[] = [];

  const commitFrame = (fi: number, expressions: any[]) => {
    if (!frameArchive) return;
    const kf = timeline.keyframes[fi];
    if (!kf) return;
    frameArchive.add(fi, kf.timeStartSec, kf.timeEndSec, expressions);
    ensureGenerationPlayback();
    playbackManager?.onFrameArchived(fi);
  };

  const archiveFrame = (fi: number, expressions: any[]) => {
    if (!frameArchive) return;
    const kf = timeline.keyframes[fi];
    if (!kf) return;

    if (expressions.length > 0) {
      lastGoodFrame = { slot: fi + 1, expressions };
      commitFrame(fi, expressions);
      return;
    }

    // 这一帧没识别出任何东西：沿用上一帧，避免时间轴上出现空白格
    if (!lastGoodFrame) {
      framesAwaitingBackfill.push(fi);
      return;
    }
    commitFrame(fi, retimeGifFrameExpressions(lastGoodFrame.expressions, {
      fromSlot: lastGoodFrame.slot,
      toSlot: fi + 1,
      timeStart: kf.timeStartSec,
      timeEnd: kf.timeEndSec,
      sliderVar: GIF_TIME_SLIDER,
      isLastFrame: fi === frameCount - 1,
    }));
  };

  const frameStream = useStreaming
    ? new OrderedFrameStream(async (fi, exprs) => {
      archiveFrame(fi, exprs);
      options.onProgress?.(fi + 1, frameCount, 'archive');
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
            workerResults[localIdx] = expressions;
            if (frameStream) {
              frameStream.push(globalIndex, expressions);
            } else if (expressions.length > 0) {
              frameExpressions[globalIndex] = expressions;
            }
            workerDone = Math.max(workerDone, globalIndex + 1);
            options.onProgress?.(workerDone, frameCount, 'worker');
            await yieldQuick();
          } catch (err) {
            if (frameStream) frameStream.push(globalIndex, []);
            if (!isAbortError(err)) {
              console.warn(`[GIF] main-thread fallback failed for frame ${globalIndex}`, err);
            }
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
            try {
              const expressions = generateFrameOnMainThread(sf, aiMap.get(sf.fi));
              if (frameStream) {
                frameStream.push(globalIndex, expressions);
              } else {
                frameExpressions[globalIndex] = expressions;
              }
              workerDone = Math.max(workerDone, globalIndex + 1);
              options.onProgress?.(workerDone, frameCount, 'worker');
            } catch (err) {
              if (frameStream) frameStream.push(globalIndex, []);
              if (!isAbortError(err)) {
                console.warn(`[GIF] main-thread generate failed for frame ${globalIndex}`, err);
              }
            }
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

  // 开头几帧就失败时当时还没有可复用的帧，这里用首个成功帧回填，时间轴不留空格
  if (frameArchive && framesAwaitingBackfill.length > 0) {
    const firstGood = frameArchive.getOrderedFrames()[0];
    if (firstGood) {
      for (const fi of framesAwaitingBackfill) {
        const kf = timeline.keyframes[fi];
        if (!kf || frameArchive.has(fi)) continue;
        frameArchive.add(fi, kf.timeStartSec, kf.timeEndSec, retimeGifFrameExpressions(
          firstGood.expressions,
          {
            fromSlot: firstGood.index + 1,
            toSlot: fi + 1,
            timeStart: kf.timeStartSec,
            timeEnd: kf.timeEndSec,
            sliderVar: GIF_TIME_SLIDER,
            isLastFrame: fi === frameCount - 1,
          },
        ));
      }
    }
  }

  // 短间隙里消失的轮廓补回来（必须在合并扁平列表之前）
  if (frameArchive && frameArchive.size > 0 && mode !== 'fill') {
    stabilizeGifOutlineArchive(frameArchive);
  }

  if (frameArchive && frameArchive.size > 0) {
    exprCompleted = Math.max(exprCompleted, frameArchive.size);
  }
  if (exprCompleted === 0 && workerDone > 0) {
    exprCompleted = workerDone;
  }
  if (exprCompleted === 0 || (frameArchive && frameArchive.size === 0 && !options.signal?.aborted)) {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    throw new Error('GIF frame generation produced no output');
  }

  const partial = Boolean(options.signal?.aborted) || exprCompleted < frameCount;

  if (useStreaming && streamInitialized) {
    const finalMax = partial && exprCompleted > 0
      ? timeline.keyframes[Math.min(exprCompleted - 1, frameCount - 1)].timeStartSec
      : timeline.sliderMaxSec;
    updateGifStreamDuration(
      options.calculator,
      finalMax,
      GIF_TIME_SLIDER,
      sliderStep,
      0,
    );
  }

  if (useStreaming && streamInitialized && playbackManager && options.calculator) {
    await attachGifWindowedPlayback(
      options.calculator,
      playbackManager,
      GIF_TIME_SLIDER,
      0,
      true,
      {
        onInjectProgress: (done, total) => {
          options.onProgress?.(done, total, 'inject');
        },
      },
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
