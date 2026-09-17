/**
 * GIF 定格质量：密采样 + 同色合并，用更少公式接近原图。
 * 单图仍用 1280 / 3600，互不影响。
 */

export const GIF_TIME_SLIDER = 's';
/** 兜底步长；正常情况下按实际帧间隔计算（见 formatGifSliderStep） */
export const GIF_SLIDER_STEP = '0.01';

/**
 * 滑块步长 = 一帧时长，拖一格正好换一帧。
 * 固定 0.01 会让一帧横跨多格（拖动无反应）、且各帧格数不等（播放忽快忽慢）。
 */
export function formatGifSliderStep(frameIntervalSec: number): string {
  const step = Math.max(0.001, Math.round(frameIntervalSec * 1000) / 1000);
  return step.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export const GIF_PERFECT_MAX_DIM = 960;
export const GIF_PERFECT_MAX_FILL = 480;
/**
 * 轮廓上限。轮廓改成预采样折线后每条只占 1 行（原先 4 行），
 * 所以这里可以给得很宽——卡得太紧会让「手」这种排名临界的轮廓
 * 在某些帧被砍掉、某些帧留下，看起来就是时有时无。
 */
export const GIF_PERFECT_MAX_CONTOURS = 48;
export const GIF_PERFECT_FOURIER_K = 72;
export const GIF_PERFECT_TARGET_POINTS = 280;

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
  preserveFineDetails: boolean;
  sharpenAmount: number;
  edgeThresholdFactor: number;
};

export const GIF_QUALITY_PROFILES: Record<GifQualityTier, GifQualityProfile> = {
  standard: {
    tier: 'standard',
    sampleIntervalSec: 0.12,
    targetFps: 8,
    maxKeyframes: 36,
    maxDim: 720,
    aiBatchSize: 6,
    aiParallelBatches: 2,
    localPrepareConcurrency: 3,
    workerCount: 2,
    scaleConcurrency: 3,
    jpegQuality: 0.86,
    sceneChangeThreshold: 6,
    pipelineChunkSize: 10,
    maxFillPolygons: 260,
    maxContours: 24,
    fourierKCap: 56,
    targetPointCountCap: 220,
    preserveFineDetails: false,
    sharpenAmount: 0.5,
    edgeThresholdFactor: 0.9,
  },
  cinema: {
    tier: 'cinema',
    sampleIntervalSec: 0.08,
    targetFps: 10,
    maxKeyframes: 56,
    maxDim: 880,
    aiBatchSize: 4,
    aiParallelBatches: 2,
    localPrepareConcurrency: 3,
    workerCount: 2,
    scaleConcurrency: 3,
    jpegQuality: 0.9,
    sceneChangeThreshold: 4,
    pipelineChunkSize: 8,
    maxFillPolygons: 360,
    maxContours: 36,
    fourierKCap: 64,
    targetPointCountCap: 250,
    preserveFineDetails: true,
    sharpenAmount: 0.58,
    edgeThresholdFactor: 0.84,
  },
  perfect: {
    tier: 'perfect',
    sampleIntervalSec: 0.05,
    targetFps: 12,
    maxKeyframes: 72,
    maxDim: GIF_PERFECT_MAX_DIM,
    aiBatchSize: 4,
    aiParallelBatches: 2,
    localPrepareConcurrency: 2,
    workerCount: 2,
    scaleConcurrency: 2,
    jpegQuality: 0.93,
    sceneChangeThreshold: 2,
    pipelineChunkSize: 6,
    maxFillPolygons: GIF_PERFECT_MAX_FILL,
    maxContours: GIF_PERFECT_MAX_CONTOURS,
    fourierKCap: GIF_PERFECT_FOURIER_K,
    targetPointCountCap: GIF_PERFECT_TARGET_POINTS,
    preserveFineDetails: true,
    sharpenAmount: 0.66,
    edgeThresholdFactor: 0.78,
  },
};

export function getGifQualityProfile(tier: GifQualityTier = 'perfect'): GifQualityProfile {
  return GIF_QUALITY_PROFILES[tier];
}

export function isMaxFidelityTier(tier: GifQualityTier): boolean {
  return tier === 'perfect' || tier === 'cinema';
}

export function tuneGifProfileForAsset(
  profile: GifQualityProfile,
  file: File,
  frameCount: number,
  mode: GifDrawMode = 'both',
): GifQualityProfile {
  let tuned: GifQualityProfile = { ...profile };
  const mb = file.size / (1024 * 1024);

  if (mode === 'outline') {
    tuned.maxFillPolygons = 0;
  } else if (mode === 'fill') {
    tuned.maxContours = Math.min(tuned.maxContours, 10);
  }

  if (frameCount > 40 || mb > 3) {
    tuned.pipelineChunkSize = Math.min(tuned.pipelineChunkSize, 5);
    tuned.workerCount = 2;
  }
  if (frameCount > 64 || mb > 6) {
    tuned.maxKeyframes = Math.min(tuned.maxKeyframes, 56);
    tuned.pipelineChunkSize = Math.min(tuned.pipelineChunkSize, 4);
  }

  return tuned;
}

export function resolveGifWorkerCount(profile: GifQualityProfile): number {
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  const cores = hw && hw > 0 ? hw : 4;
  return Math.max(1, Math.min(profile.workerCount, 2, Math.max(1, Math.floor(cores / 2))));
}
