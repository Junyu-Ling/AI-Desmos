/**
 * GIF 质量档位 — 优先速度：按需换帧 + 少量公式，单图仍用 1280/3600。
 */

export const GIF_TIME_SLIDER = 's';
export const GIF_SLIDER_STEP = '0.01';

/** GIF 专用（比单图更紧） */
export const GIF_SINGLE_FRAME_MAX_DIM = 640;
export const GIF_SINGLE_FRAME_MAX_FILL = 220;
export const GIF_SINGLE_FRAME_MAX_CONTOURS = 18;
export const GIF_SINGLE_FRAME_FOURIER_K = 58;
export const GIF_SINGLE_FRAME_TARGET_POINTS = 260;

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
    sampleIntervalSec: 0.15,
    targetFps: 7,
    maxKeyframes: 40,
    maxDim: GIF_SINGLE_FRAME_MAX_DIM,
    aiBatchSize: 8,
    aiParallelBatches: 4,
    localPrepareConcurrency: 8,
    workerCount: 8,
    scaleConcurrency: 8,
    jpegQuality: 0.82,
    sceneChangeThreshold: 7,
    pipelineChunkSize: 24,
    maxFillPolygons: GIF_SINGLE_FRAME_MAX_FILL,
    maxContours: GIF_SINGLE_FRAME_MAX_CONTOURS,
    fourierKCap: GIF_SINGLE_FRAME_FOURIER_K,
    targetPointCountCap: GIF_SINGLE_FRAME_TARGET_POINTS,
  },
  cinema: {
    tier: 'cinema',
    sampleIntervalSec: 0.08,
    targetFps: 12,
    maxKeyframes: 64,
    maxDim: 768,
    aiBatchSize: 8,
    aiParallelBatches: 4,
    localPrepareConcurrency: 8,
    workerCount: 8,
    scaleConcurrency: 8,
    jpegQuality: 0.85,
    sceneChangeThreshold: 5,
    pipelineChunkSize: 20,
    maxFillPolygons: 360,
    maxContours: 22,
    fourierKCap: 68,
    targetPointCountCap: 300,
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

  if (mode === 'outline') {
    tuned.maxFillPolygons = 0;
    tuned.maxContours = Math.min(tuned.maxContours, 16);
    tuned.fourierKCap = Math.min(tuned.fourierKCap, 52);
    tuned.targetPointCountCap = Math.min(tuned.targetPointCountCap, 220);
    tuned.maxDim = Math.min(tuned.maxDim, 560);
  } else if (mode === 'fill') {
    tuned.maxContours = Math.min(tuned.maxContours, 8);
    tuned.fourierKCap = Math.min(tuned.fourierKCap, 40);
  }

  if (frameCount > 28) {
    if (mode !== 'outline') tuned.maxFillPolygons = Math.min(tuned.maxFillPolygons, 180);
    tuned.maxDim = Math.min(tuned.maxDim, 576);
  }
  if (frameCount > 48) {
    if (mode !== 'outline') tuned.maxFillPolygons = Math.min(tuned.maxFillPolygons, 140);
    tuned.maxContours = Math.min(tuned.maxContours, 14);
    tuned.fourierKCap = Math.min(tuned.fourierKCap, 48);
  }

  const mb = file.size / (1024 * 1024);
  let chunk = tuned.pipelineChunkSize;
  if (mb > 3 || frameCount > 36) chunk = Math.min(chunk, 16);
  if (mb > 6 || frameCount > 56) chunk = Math.min(chunk, 12);
  if (chunk !== tuned.pipelineChunkSize) tuned = { ...tuned, pipelineChunkSize: chunk };

  return tuned;
}

export function resolveGifWorkerCount(profile: GifQualityProfile): number {
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  const cores = hw && hw > 0 ? hw : 8;
  return Math.max(profile.workerCount, Math.min(12, cores));
}
