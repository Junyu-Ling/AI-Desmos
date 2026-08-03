/**
 * GIF 质量档位 — 表情包/贴纸优先：够清晰、能看清动画；单图仍用 1280/3600。
 */

export const GIF_TIME_SLIDER = 's';
export const GIF_SLIDER_STEP = '0.01';

/** GIF 单帧默认（表情包友好） */
export const GIF_SINGLE_FRAME_MAX_DIM = 960;
export const GIF_SINGLE_FRAME_MAX_FILL = 720;
export const GIF_SINGLE_FRAME_MAX_CONTOURS = 28;
export const GIF_SINGLE_FRAME_FOURIER_K = 80;
export const GIF_SINGLE_FRAME_TARGET_POINTS = 360;

export type GifQualityTier = 'standard' | 'cinema';
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
};

export const GIF_QUALITY_PROFILES: Record<GifQualityTier, GifQualityProfile> = {
  standard: {
    tier: 'standard',
    sampleIntervalSec: 0.1,
    targetFps: 10,
    maxKeyframes: 48,
    maxDim: GIF_SINGLE_FRAME_MAX_DIM,
    aiBatchSize: 8,
    aiParallelBatches: 4,
    localPrepareConcurrency: 8,
    workerCount: 8,
    scaleConcurrency: 8,
    jpegQuality: 0.88,
    sceneChangeThreshold: 6,
    pipelineChunkSize: 20,
    maxFillPolygons: GIF_SINGLE_FRAME_MAX_FILL,
    maxContours: GIF_SINGLE_FRAME_MAX_CONTOURS,
    fourierKCap: GIF_SINGLE_FRAME_FOURIER_K,
    targetPointCountCap: GIF_SINGLE_FRAME_TARGET_POINTS,
  },
  cinema: {
    tier: 'cinema',
    sampleIntervalSec: 0.07,
    targetFps: 12,
    maxKeyframes: 72,
    maxDim: 1120,
    aiBatchSize: 8,
    aiParallelBatches: 4,
    localPrepareConcurrency: 8,
    workerCount: 8,
    scaleConcurrency: 8,
    jpegQuality: 0.9,
    sceneChangeThreshold: 4,
    pipelineChunkSize: 16,
    maxFillPolygons: 1100,
    maxContours: 36,
    fourierKCap: 96,
    targetPointCountCap: 420,
  },
};

export function getGifQualityProfile(tier: GifQualityTier = 'standard'): GifQualityProfile {
  return GIF_QUALITY_PROFILES[tier];
}

export function tuneGifProfileForAsset(
  profile: GifQualityProfile,
  file: File,
  frameCount: number,
  mode: GifDrawMode = 'both',
): GifQualityProfile {
  let tuned: GifQualityProfile = { ...profile };
  const mb = file.size / (1024 * 1024);
  const stickerLike = mb <= 1.5 && frameCount <= 28;

  if (mode === 'outline') {
    tuned.maxFillPolygons = 0;
    tuned.maxContours = Math.min(tuned.maxContours, stickerLike ? 32 : 24);
    tuned.fourierKCap = Math.min(tuned.fourierKCap, stickerLike ? 88 : 72);
    tuned.targetPointCountCap = Math.min(tuned.targetPointCountCap, stickerLike ? 400 : 300);
    tuned.maxDim = Math.min(tuned.maxDim, stickerLike ? 960 : 800);
  } else if (mode === 'fill') {
    tuned.maxContours = Math.min(tuned.maxContours, 12);
    tuned.fourierKCap = Math.min(tuned.fourierKCap, 56);
  }

  // 大 GIF 才收紧；小表情包保持高画质
  if (!stickerLike && frameCount > 36) {
    if (mode !== 'outline') tuned.maxFillPolygons = Math.min(tuned.maxFillPolygons, 520);
    tuned.maxDim = Math.min(tuned.maxDim, 880);
  }
  if (!stickerLike && frameCount > 56) {
    if (mode !== 'outline') tuned.maxFillPolygons = Math.min(tuned.maxFillPolygons, 400);
    tuned.maxContours = Math.min(tuned.maxContours, 22);
    tuned.fourierKCap = Math.min(tuned.fourierKCap, 68);
  }

  let chunk = tuned.pipelineChunkSize;
  if (mb > 4 || frameCount > 40) chunk = Math.min(chunk, 14);
  if (mb > 8 || frameCount > 60) chunk = Math.min(chunk, 10);
  if (chunk !== tuned.pipelineChunkSize) tuned = { ...tuned, pipelineChunkSize: chunk };

  return tuned;
}

export function resolveGifWorkerCount(profile: GifQualityProfile): number {
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  const cores = hw && hw > 0 ? hw : 8;
  return Math.max(profile.workerCount, Math.min(12, cores));
}
