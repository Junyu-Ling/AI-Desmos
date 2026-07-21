/**
 * GIF → Desmos 时间轴动画（高保真）
 * - 质量档位：标准 1fps / 电影级 2fps
 * - Web Worker 并行生成表达式
 * - 批量 AI 降低 API 成本
 */

import {
  decodeGifWithTimeline,
  scaleGifFrame,
} from './gif-decode';
import {
  generateFourierExpressionsFromContext,
  applyGifExpressionsToCalculator,
} from './image-processing';
import {
  analyzeImageHeuristically,
  applyLocalImageRepair,
  analyzeSmartDrawBatchWithAI,
  mergeSmartDrawTuning,
  type SmartDrawMode,
  type SmartDrawTuningParams,
  type SmartDrawAIContour,
} from './smart-draw-repair';
import {
  getGifQualityProfile,
  GIF_TIME_SLIDER,
  GIF_SLIDER_STEP,
  type GifQualityTier,
} from './gif-quality';
import { createGifWorkerPool } from './gif-worker-pool';
import type { GifFrameWorkerInput } from './gif-frame.worker';

export { GIF_TIME_SLIDER, GIF_SLIDER_STEP };
export type { GifQualityTier };

const yieldToMain = (): Promise<void> =>
  new Promise(resolve => {
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => resolve(), { timeout: 48 });
    } else {
      setTimeout(resolve, 0);
    }
  });

export type GifFrameLimits = {
  maxContours: number;
  maxFillPolygons: number;
  fourierK: number;
  targetPointCount: number;
};

export function computeGifFrameLimits(
  frameCount: number,
  mode: SmartDrawMode,
  totalExprBudget = 4800,
): GifFrameLimits {
  const perFrame = Math.floor(totalExprBudget / Math.max(1, frameCount));
  const contourBudget = mode === 'fill' ? 12 : 20;
  const maxContours = Math.min(contourBudget, Math.max(4, Math.floor(perFrame / 11)));
  const maxFillPolygons = mode === 'outline'
    ? 0
    : Math.min(900, Math.max(60, perFrame - maxContours * 7));

  const dense = frameCount > 80;
  const veryDense = frameCount > 200;
  return {
    maxContours,
    maxFillPolygons,
    fourierK: mode === 'fill'
      ? (veryDense ? 70 : dense ? 80 : 95)
      : (veryDense ? 85 : dense ? 95 : 115),
    targetPointCount: veryDense ? 360 : dense ? 420 : 540,
  };
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

const processFrameOnMainThread = (
  scaled: ScaledKeyframe,
  mode: SmartDrawMode,
  limits: GifFrameLimits,
  tuning: SmartDrawTuningParams | undefined,
  aiContours: SmartDrawAIContour[],
): any[] => {
  const canvas = document.createElement('canvas');
  canvas.width = scaled.width;
  canvas.height = scaled.height;
  const ctx = canvas.getContext('2d')!;
  const imageData = new ImageData(scaled.pixels, scaled.width, scaled.height);
  ctx.putImageData(imageData, 0, 0);
  const fillImageData = new ImageData(new Uint8ClampedArray(scaled.pixels), scaled.width, scaled.height);

  let frameTuning: SmartDrawTuningParams;
  if (tuning) {
    frameTuning = mergeSmartDrawTuning({
      ...tuning,
      maxContours: limits.maxContours,
      fourierK: limits.fourierK,
      targetPointCount: limits.targetPointCount,
      preserveFineDetails: true,
    });
  } else {
    frameTuning = mergeSmartDrawTuning({
      ...analyzeImageHeuristically(ctx, scaled.width, scaled.height, mode),
      maxContours: limits.maxContours,
      fourierK: limits.fourierK,
      targetPointCount: limits.targetPointCount,
      preserveFineDetails: true,
    });
  }

  applyLocalImageRepair(ctx, scaled.width, scaled.height, frameTuning);

  const frameSlot = scaled.fi + 1;
  const { expressions } = generateFourierExpressionsFromContext(
    ctx,
    scaled.width,
    scaled.height,
    {
      mode,
      tuning: frameTuning,
      aiContours,
      fillImageData,
      maxFillPolygons: limits.maxFillPolygons,
      varNamespace: frameSlot,
      frameSlot,
      frameSliderVar: GIF_TIME_SLIDER,
      gifTimeBasedSlider: true,
      gifTimeStart: scaled.timeStartSec,
      gifTimeEnd: scaled.timeEndSec,
      idPrefix: `gif_f${frameSlot}_`,
    },
  );

  return expressions;
};

export type ProcessGifOptions = {
  mode?: SmartDrawMode;
  apiKey?: string;
  enableAiRepair?: boolean;
  quality?: GifQualityTier;
  signal?: AbortSignal;
  onProgress?: (
    current: number,
    total: number,
    phase: 'decode' | 'frame' | 'ai' | 'worker' | 'inject',
  ) => void;
};

export async function processGifToDesmosAnimation(
  file: File,
  options: ProcessGifOptions = {},
): Promise<{
  expressions: any[];
  frameCount: number;
  durationSec: number;
  explanation: string;
}> {
  const mode = options.mode ?? 'both';
  const enableAi = options.enableAiRepair !== false;
  const profile = getGifQualityProfile(options.quality ?? 'standard');

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

  const limits = computeGifFrameLimits(frameCount, mode, profile.totalExprBudget);

  const scaledFrames: ScaledKeyframe[] = timeline.keyframes.map((kf, fi) =>
    buildScaledKeyframe(
      kf,
      fi,
      timeline.width,
      timeline.height,
      profile.maxDim,
      profile.jpegQuality,
    ),
  );

  const aiResults = new Map<number, {
    tuning: Partial<SmartDrawTuningParams>;
    contours: SmartDrawAIContour[];
  }>();

  if (enableAi && mode !== 'fill') {
    for (let i = 0; i < frameCount; i += profile.aiBatchSize) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const slice = scaledFrames.slice(i, i + profile.aiBatchSize);
      options.onProgress?.(Math.min(i + slice.length, frameCount), frameCount, 'ai');
      await yieldToMain();

      const batchResult = await analyzeSmartDrawBatchWithAI(
        slice.map(sf => ({
          frameIndex: sf.fi,
          dataUrl: sf.dataUrl,
          width: sf.width,
          height: sf.height,
        })),
        mode,
        options.apiKey,
      );
      batchResult.forEach((v, k) => aiResults.set(k, v));
    }
  }

  options.onProgress?.(0, frameCount, 'worker');
  await yieldToMain();

  const pool = createGifWorkerPool(profile.workerCount);
  const frameExpressions: any[][] = new Array(frameCount);

  if (pool) {
    const workerInputs: GifFrameWorkerInput[] = scaledFrames.map(sf => {
      const ai = aiResults.get(sf.fi);
      return {
        taskId: `f${sf.fi}`,
        pixels: sf.pixels,
        width: sf.width,
        height: sf.height,
        mode,
        aiTuning: ai?.tuning,
        aiContours: ai?.contours ?? [],
        limits,
        frameSlot: sf.fi + 1,
        timeStartSec: sf.timeStartSec,
        timeEndSec: sf.timeEndSec,
      };
    });

    let done = 0;
    const results = await Promise.all(
      workerInputs.map(async (input, idx) => {
        const exprs = await pool.run(input);
        done += 1;
        options.onProgress?.(done, frameCount, 'worker');
        frameExpressions[idx] = exprs;
        return exprs;
      }),
    );
    void results;
    pool.terminate();
  } else {
    for (let fi = 0; fi < frameCount; fi++) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const sf = scaledFrames[fi];
      const ai = aiResults.get(fi);
      let tuning: SmartDrawTuningParams | undefined;
      if (ai?.tuning) {
        const canvas = document.createElement('canvas');
        canvas.width = sf.width;
        canvas.height = sf.height;
        const ctx = canvas.getContext('2d')!;
        ctx.putImageData(new ImageData(sf.pixels, sf.width, sf.height), 0, 0);
        tuning = mergeSmartDrawTuning({
          ...analyzeImageHeuristically(ctx, sf.width, sf.height, mode),
          ...ai.tuning,
          maxContours: limits.maxContours,
          fourierK: limits.fourierK,
          targetPointCount: limits.targetPointCount,
          preserveFineDetails: true,
        });
      }
      frameExpressions[fi] = processFrameOnMainThread(
        sf, mode, limits, tuning, ai?.contours ?? [],
      );
      options.onProgress?.(fi + 1, frameCount, 'frame');
      await yieldToMain();
    }
  }

  const tierLabel = profile.tier === 'cinema' ? '电影级' : '标准';
  const fpsLabel = profile.targetFps >= 8
    ? `${profile.targetFps}fps`
    : profile.targetFps >= 4
      ? `${profile.targetFps}fps`
      : `${profile.sampleIntervalSec}s/帧`;
  const durationLabel = timeline.durationSec.toFixed(1);

  return {
    expressions: [
      buildGifTimeSliderExpression(timeline.durationSec),
      ...frameExpressions.flat(),
    ],
    frameCount,
    durationSec: timeline.durationSec,
    explanation: `GIF ${tierLabel}动画（${frameCount} 关键帧，${durationLabel}s，${fpsLabel}）。滑块 s（秒）可拖动；点击 s 旁 ▶ 播放。`,
  };
}

export { applyGifExpressionsToCalculator };

/** @deprecated 旧版帧序号滑块 */
export const GIF_FRAME_SLIDER = 'f';
