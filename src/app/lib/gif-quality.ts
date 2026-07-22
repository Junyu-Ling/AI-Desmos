/**
 * GIF 动画质量档位：标准 / 电影级（高采样）
 */

/** 秒级时间滑块；勿用 t（与参数曲线参数 t 冲突） */
export const GIF_TIME_SLIDER = 's';
export const GIF_SLIDER_STEP = '0.01';

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
  /** 并行本地修复帧数 */
  localPrepareConcurrency: number;
  /** 并行 Worker 数量 */
  workerCount: number;
  jpegQuality: number;
  sceneChangeThreshold: number;
};

export const GIF_QUALITY_PROFILES: Record<GifQualityTier, GifQualityProfile> = {
  standard: {
    tier: 'standard',
    sampleIntervalSec: 0.125,
    targetFps: 8,
    maxKeyframes: 400,
    maxDim: 1280,
    aiBatchSize: 8,
    aiParallelBatches: 3,
    localPrepareConcurrency: 8,
    workerCount: 8,
    jpegQuality: 0.95,
    sceneChangeThreshold: 7,
  },
  cinema: {
    tier: 'cinema',
    sampleIntervalSec: 0.04,
    targetFps: 24,
    maxKeyframes: 600,
    maxDim: 1280,
    aiBatchSize: 8,
    aiParallelBatches: 3,
    localPrepareConcurrency: 8,
    workerCount: 8,
    jpegQuality: 0.95,
    sceneChangeThreshold: 4,
  },
};

export function getGifQualityProfile(tier: GifQualityTier = 'standard'): GifQualityProfile {
  return GIF_QUALITY_PROFILES[tier];
}
