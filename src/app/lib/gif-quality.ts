/**
 * GIF 定格动画质量档位
 * - 画板始终只显示 1 帧（护显卡 / 防 Desmos 崩）
 * - perfect：近单图还原度，尽量保留原 GIF 每一帧
 * - 单图路径仍用 1280 / 3600，互不影响
 */

export const GIF_TIME_SLIDER = 's';
export const GIF_SLIDER_STEP = '0.01';

/** 与单图同级上限（perfect 档） */
export const GIF_PERFECT_MAX_DIM = 1280;
export const GIF_PERFECT_MAX_FILL = 3200;
export const GIF_PERFECT_MAX_CONTOURS = 48;
export const GIF_PERFECT_FOURIER_K = 120;
export const GIF_PERFECT_TARGET_POINTS = 480;

export type GifQualityTier = 'standard' | 'cinema' | 'perfect';
export type GifDrawMode = 'outline' | 'fill' | 'both';

export type GifQualityProfile = {
  tier: GifQualityTier;
  sampleIntervalSec: number;
  targetFps: number;
  maxKeyframes: number;
  maxDim: number;
  aiBatchSize: number;
  aiParallelBatches: number;
  localPrepareConcurrency: number;
  workerCount: number;
  scaleConcurrency: number;
  jpegQuality: number;
  sceneChangeThreshold: number;
  pipelineChunkSize: number;
  maxFillPolygons: number;
  maxContours: number;
  fourierKCap: number;
  targetPointCountCap: number;
  /** 保留细线 / 小色块（定格表情包关键） */
  preserveFineDetails: boolean;
  sharpenAmount: number;
  edgeThresholdFactor: number;
};

export const GIF_QUALITY_PROFILES: Record<GifQualityTier, GifQualityProfile> = {
  standard: {
    tier: 'standard',
    sampleIntervalSec: 0.1,
    targetFps: 10,
    maxKeyframes: 48,
    maxDim: 960,
    aiBatchSize: 8,
    aiParallelBatches: 4,
    localPrepareConcurrency: 6,
    workerCount: 6,
    scaleConcurrency: 6,
    jpegQuality: 0.88,
    sceneChangeThreshold: 6,
    pipelineChunkSize: 16,
    maxFillPolygons: 900,
    maxContours: 30,
    fourierKCap: 84,
    targetPointCountCap: 360,
    preserveFineDetails: false,
    sharpenAmount: 0.55,
    edgeThresholdFactor: 0.88,
  },
  cinema: {
    tier: 'cinema',
    sampleIntervalSec: 0.06,
    targetFps: 12,
    maxKeyframes: 80,
    maxDim: 1152,
    aiBatchSize: 6,
    aiParallelBatches: 3,
    localPrepareConcurrency: 5,
    workerCount: 5,
    scaleConcurrency: 5,
    jpegQuality: 0.92,
    sceneChangeThreshold: 3,
    pipelineChunkSize: 12,
    maxFillPolygons: 1800,
    maxContours: 40,
    fourierKCap: 104,
    targetPointCountCap: 420,
    preserveFineDetails: true,
    sharpenAmount: 0.62,
    edgeThresholdFactor: 0.82,
  },
  /** 定格表情包最高还原：近单图画质，尽量不丢帧 */
  perfect: {
    tier: 'perfect',
    sampleIntervalSec: 0.04,
    targetFps: 16,
    maxKeyframes: 128,
    maxDim: GIF_PERFECT_MAX_DIM,
    aiBatchSize: 4,
    aiParallelBatches: 2,
    localPrepareConcurrency: 4,
    workerCount: 4,
    scaleConcurrency: 4,
    jpegQuality: 0.95,
    sceneChangeThreshold: 2,
    pipelineChunkSize: 8,
    maxFillPolygons: GIF_PERFECT_MAX_FILL,
    maxContours: GIF_PERFECT_MAX_CONTOURS,
    fourierKCap: GIF_PERFECT_FOURIER_K,
    targetPointCountCap: GIF_PERFECT_TARGET_POINTS,
    preserveFineDetails: true,
    sharpenAmount: 0.7,
    edgeThresholdFactor: 0.75,
  },
};

export function getGifQualityProfile(tier: GifQualityTier = 'perfect'): GifQualityProfile {
  return GIF_QUALITY_PROFILES[tier];
}

export function isMaxFidelityTier(tier: GifQualityTier): boolean {
  return tier === 'perfect' || tier === 'cinema';
}

/**
 * 按素材微调：perfect 几乎不降质；大文件才略收紧并发/分块（护内存与显卡），不砍画质上限。
 */
export function tuneGifProfileForAsset(
  profile: GifQualityProfile,
  file: File,
  frameCount: number,
  mode: GifDrawMode = 'both',
): GifQualityProfile {
  let tuned: GifQualityProfile = { ...profile };
  const mb = file.size / (1024 * 1024);
  const stickerLike = mb <= 2 && frameCount <= 64;
  const perfect = profile.tier === 'perfect';

  if (mode === 'outline') {
    tuned.maxFillPolygons = 0;
    if (!perfect) {
      tuned.maxContours = Math.min(tuned.maxContours, stickerLike ? 36 : 28);
      tuned.fourierKCap = Math.min(tuned.fourierKCap, stickerLike ? 100 : 80);
      tuned.targetPointCountCap = Math.min(tuned.targetPointCountCap, stickerLike ? 420 : 320);
      tuned.maxDim = Math.min(tuned.maxDim, stickerLike ? 1152 : 960);
    }
  } else if (mode === 'fill') {
    tuned.maxContours = Math.min(tuned.maxContours, perfect ? 16 : 12);
    if (!perfect) tuned.fourierKCap = Math.min(tuned.fourierKCap, 64);
  }

  // perfect：小表情包尽量顶满；仅超大 GIF 略降填色防单帧卡死
  if (perfect) {
    if (stickerLike) {
      tuned.maxFillPolygons = Math.max(tuned.maxFillPolygons, mode === 'outline' ? 0 : 2800);
      tuned.maxContours = Math.max(tuned.maxContours, mode === 'fill' ? tuned.maxContours : 44);
      tuned.maxDim = Math.max(tuned.maxDim, 1280);
    } else if (frameCount > 80 || mb > 6) {
      if (mode !== 'outline') {
        tuned.maxFillPolygons = Math.min(tuned.maxFillPolygons, 2400);
      }
      tuned.pipelineChunkSize = Math.min(tuned.pipelineChunkSize, 6);
      tuned.workerCount = Math.min(tuned.workerCount, 3);
    }
  } else if (!stickerLike && frameCount > 40) {
    if (mode !== 'outline') tuned.maxFillPolygons = Math.min(tuned.maxFillPolygons, 1200);
    tuned.maxDim = Math.min(tuned.maxDim, 1024);
  }

  let chunk = tuned.pipelineChunkSize;
  if (mb > 5 || frameCount > 72) chunk = Math.min(chunk, perfect ? 6 : 10);
  if (mb > 10 || frameCount > 100) chunk = Math.min(chunk, perfect ? 4 : 8);
  if (chunk !== tuned.pipelineChunkSize) tuned = { ...tuned, pipelineChunkSize: chunk };

  return tuned;
}

/** 护显卡：perfect 限制并行，避免多 Worker + Desmos 同时抢 GPU */
export function resolveGifWorkerCount(profile: GifQualityProfile): number {
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  const cores = hw && hw > 0 ? hw : 8;
  const cap = profile.tier === 'perfect' ? 4 : profile.tier === 'cinema' ? 6 : 8;
  return Math.max(2, Math.min(profile.workerCount, cap, Math.max(2, Math.floor(cores / 2))));
}
