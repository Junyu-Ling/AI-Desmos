/**
 * GIF 动画质量档位：标准 / 电影级（高采样）
 *
 * 设计原则（定格动画）：
 * GIF 本质是「逐帧定格照片」——动画感来自相邻帧之间的细微差异。
 * 每一帧都必须按单图最高精度独立绘制（轮廓、填色、傅里叶项），
 * 绝不能跨帧简化或合并；帧内细节越多，播放时才越像真的在动。
 */

/** 秒级时间滑块；勿用 t（与参数曲线参数 t 冲突） */
export const GIF_TIME_SLIDER = 's';
export const GIF_SLIDER_STEP = '0.01';

/** 与单图一致的单帧精度基准（勿下调） */
export const GIF_SINGLE_FRAME_MAX_DIM = 1280;
export const GIF_SINGLE_FRAME_MAX_FILL = 3600;
export const GIF_SINGLE_FRAME_MAX_CONTOURS = 55;
export const GIF_SINGLE_FRAME_FOURIER_K = 110;
export const GIF_SINGLE_FRAME_TARGET_POINTS = 480;

export type GifQualityTier = 'standard' | 'cinema';

export type GifQualityProfile = {
  tier: GifQualityTier;
  /** 时间轴采样间隔（秒） */
  sampleIntervalSec: number;
  /** 目标帧率（与 sampleIntervalSec 配合，取更多帧） */
  targetFps: number;
  maxKeyframes: number;
  maxDim: number;
  /** 批量 AI 每批帧数 */
  aiBatchSize: number;
  /** 同时进行的 AI 批次数 */
  aiParallelBatches: number;
  /** 并行本地修复帧数（Worker 内执行） */
  localPrepareConcurrency: number;
  /** 并行 Worker 数量（基准；实际会参考 CPU 核数） */
  workerCount: number;
  /** 主线程并行缩放帧数 */
  scaleConcurrency: number;
  jpegQuality: number;
  sceneChangeThreshold: number;
  /** 分块流水线：同时在内存中的关键帧上限 */
  pipelineChunkSize: number;
  /** GIF 每帧填色块上限 */
  maxFillPolygons: number;
  /** GIF 每帧轮廓条数上限 */
  maxContours: number;
  /** GIF 傅里叶项数上限 */
  fourierKCap: number;
  /** GIF 轮廓采样点上限 */
  targetPointCountCap: number;
};

export const GIF_QUALITY_PROFILES: Record<GifQualityTier, GifQualityProfile> = {
  standard: {
    tier: 'standard',
    sampleIntervalSec: 0.125,
    targetFps: 8,
    maxKeyframes: 150,
    maxDim: GIF_SINGLE_FRAME_MAX_DIM,
    aiBatchSize: 8,
    aiParallelBatches: 8,
    localPrepareConcurrency: 6,
    workerCount: 8,
    scaleConcurrency: 8,
    jpegQuality: 0.95,
    sceneChangeThreshold: 5,
    pipelineChunkSize: 16,
    maxFillPolygons: GIF_SINGLE_FRAME_MAX_FILL,
    maxContours: GIF_SINGLE_FRAME_MAX_CONTOURS,
    fourierKCap: GIF_SINGLE_FRAME_FOURIER_K,
    targetPointCountCap: GIF_SINGLE_FRAME_TARGET_POINTS,
  },
  cinema: {
    tier: 'cinema',
    sampleIntervalSec: 0.04,
    targetFps: 24,
    maxKeyframes: 220,
    maxDim: GIF_SINGLE_FRAME_MAX_DIM,
    aiBatchSize: 8,
    aiParallelBatches: 8,
    localPrepareConcurrency: 6,
    workerCount: 8,
    scaleConcurrency: 8,
    jpegQuality: 0.95,
    sceneChangeThreshold: 3,
    pipelineChunkSize: 12,
    maxFillPolygons: GIF_SINGLE_FRAME_MAX_FILL,
    maxContours: GIF_SINGLE_FRAME_MAX_CONTOURS,
    fourierKCap: GIF_SINGLE_FRAME_FOURIER_K,
    targetPointCountCap: GIF_SINGLE_FRAME_TARGET_POINTS,
  },
};

export function getGifQualityProfile(tier: GifQualityTier = 'standard'): GifQualityProfile {
  return GIF_QUALITY_PROFILES[tier];
}

/** 按 GIF 体积/帧数只收紧分块大小（保画质、降峰值内存） */
export function tuneGifProfileForAsset(
  profile: GifQualityProfile,
  file: File,
  frameCount: number,
): GifQualityProfile {
  const mb = file.size / (1024 * 1024);
  let chunk = profile.pipelineChunkSize;
  if (mb > 5 || frameCount > 130) chunk = Math.min(chunk, 12);
  if (mb > 10 || frameCount > 180) chunk = Math.min(chunk, 8);
  if (chunk === profile.pipelineChunkSize) return profile;
  return { ...profile, pipelineChunkSize: chunk };
}

/** Worker 数：在档位基准与 CPU 核数间取优 */
export function resolveGifWorkerCount(profile: GifQualityProfile): number {
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 0;
  const cores = hw && hw > 0 ? hw : 8;
  return Math.max(profile.workerCount, Math.min(12, cores));
}
