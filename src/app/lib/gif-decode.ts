/**
 * GIF 解码：逐帧合成完整画布图像（支持 disposal）
 * 高保真模式：按时间轴采样（约每秒一帧）+ 场景变化检测
 */
import { parseGIF, decompressFrames } from 'gifuct-js';
import { yieldToInteractive } from './image-processing';

export type DecodedGifFrame = {
  imageData: ImageData;
  delayMs: number;
  index: number;
};

export type DecodedGifKeyframe = DecodedGifFrame & {
  /** 该关键帧在 GIF 时间轴上的起始秒数 */
  timeStartSec: number;
  /** 下一关键帧起始秒数（或 GIF 总时长） */
  timeEndSec: number;
};

export type DecodedGif = {
  width: number;
  height: number;
  frames: DecodedGifFrame[];
};

export type DecodedGifTimeline = {
  width: number;
  height: number;
  durationSec: number;
  keyframes: DecodedGifKeyframe[];
  /** 每帧固定时长（秒）；滑块步长取这个值，一格正好一帧 */
  frameIntervalSec: number;
  /** 滑块最大值 = 末帧刻度，保证拖到最右仍停在末帧 */
  sliderMaxSec: number;
};

export type TimelineSampleOptions = {
  /** 最小采样间隔（秒） */
  minIntervalSec?: number;
  /** 目标帧率（尽量达到，受 maxKeyframes 限制） */
  targetFps?: number;
  /** 关键帧数量上限 */
  maxKeyframes?: number;
  /** 场景变化阈值（0–255 均值差），越低越敏感 */
  sceneChangeThreshold?: number;
};

const copyImageData = (src: ImageData): ImageData =>
  new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);

/** 时间一律对齐到 0.001 秒，避免浮点误差让帧区间错位 */
const roundTimeSec = (sec: number): number => Math.round(sec * 1000) / 1000;

/**
 * 均匀化时间轴：原始 GIF 时间戳间隔不等，且不是滑块步长的整数倍，
 * 会导致拖动时大量刻度停在同一帧、各帧停留时长忽长忽短。
 * 这里重排成等距刻度，滑块步长取 frameIntervalSec，做到「一格一帧」。
 */
const applyUniformTimeline = (
  keyframes: DecodedGifKeyframe[],
  durationSec: number,
): { frameIntervalSec: number; durationSec: number; sliderMaxSec: number } => {
  const count = keyframes.length;
  if (count === 0) {
    return { frameIntervalSec: 0.05, durationSec, sliderMaxSec: 0 };
  }

  const interval = Math.max(0.02, roundTimeSec(durationSec / count));
  keyframes.forEach((kf, i) => {
    kf.timeStartSec = roundTimeSec(i * interval);
    kf.timeEndSec = roundTimeSec((i + 1) * interval);
  });

  return {
    frameIntervalSec: interval,
    durationSec: roundTimeSec(count * interval),
    sliderMaxSec: roundTimeSec((count - 1) * interval),
  };
};

const blitPatch = (
  target: ImageData,
  patch: Uint8ClampedArray,
  dims: { width: number; height: number; top: number; left: number },
  gifWidth: number,
): void => {
  for (let y = 0; y < dims.height; y++) {
    for (let x = 0; x < dims.width; x++) {
      const patchIdx = (y * dims.width + x) * 4;
      const alpha = patch[patchIdx + 3];
      if (alpha === 0) continue;
      const imgIdx = ((dims.top + y) * gifWidth + (dims.left + x)) * 4;
      target.data[imgIdx] = patch[patchIdx];
      target.data[imgIdx + 1] = patch[patchIdx + 1];
      target.data[imgIdx + 2] = patch[patchIdx + 2];
      target.data[imgIdx + 3] = 255;
    }
  }
};

const clearRect = (
  target: ImageData,
  dims: { width: number; height: number; top: number; left: number },
  gifWidth: number,
  bg: [number, number, number],
): void => {
  for (let y = 0; y < dims.height; y++) {
    for (let x = 0; x < dims.width; x++) {
      const imgIdx = ((dims.top + y) * gifWidth + (dims.left + x)) * 4;
      target.data[imgIdx] = bg[0];
      target.data[imgIdx + 1] = bg[1];
      target.data[imgIdx + 2] = bg[2];
      target.data[imgIdx + 3] = 255;
    }
  }
};

/** 32×32 灰度缩略图，用于场景变化检测 */
const computeThumb32 = (imageData: ImageData, width: number, height: number): Uint8Array => {
  const size = 32;
  const thumb = new Uint8Array(size * size);
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const sx = Math.min(width - 1, Math.floor((tx / size) * width));
      const sy = Math.min(height - 1, Math.floor((ty / size) * height));
      const idx = (sy * width + sx) * 4;
      thumb[ty * size + tx] = Math.round(
        (imageData.data[idx] + imageData.data[idx + 1] + imageData.data[idx + 2]) / 3,
      );
    }
  }
  return thumb;
};

const thumbDiff = (a: Uint8Array, b: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
};

const decodeYield = (): Promise<void> => yieldToInteractive();

/** 在单调递增的时间轴上找最近帧（O(log n)） */
const findNearestFrameIndex = (frameTimesSec: number[], sec: number): number => {
  const total = frameTimesSec.length;
  if (total === 0) return 0;
  if (total === 1) return 0;

  let lo = 0;
  let hi = total - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (frameTimesSec[mid] < sec) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(frameTimesSec[lo - 1] - sec) <= Math.abs(frameTimesSec[lo] - sec)) {
    return lo - 1;
  }
  return lo;
};

/** 均匀采样帧索引，保留首尾 */
export function sampleFrameIndices(total: number, maxFrames: number): number[] {
  if (total <= maxFrames) {
    return Array.from({ length: total }, (_, i) => i);
  }
  const picked = new Set<number>();
  for (let i = 0; i < maxFrames; i++) {
    picked.add(Math.round((i * (total - 1)) / (maxFrames - 1)));
  }
  return [...picked].sort((a, b) => a - b);
}

/**
 * 按时间轴选取关键帧：
 * - 至少每 minIntervalSec 秒一帧
 * - 场景突变处额外加入
 * - 保留首尾帧
 */
export function pickTimelineKeyframeIndices(
  frameTimesSec: number[],
  frameThumbs: Uint8Array[],
  durationSec: number,
  options: TimelineSampleOptions = {},
): number[] {
  const minInterval = options.minIntervalSec ?? 0.25;
  const targetFps = options.targetFps ?? Math.max(1, 1 / minInterval);
  const maxKf = options.maxKeyframes ?? 400;
  const threshold = options.sceneChangeThreshold ?? 8;
  const total = frameTimesSec.length;

  if (total === 0) return [];
  if (total === 1) return [0];
  // 原帧不多时全部保留，最流畅
  if (total <= maxKf) {
    return Array.from({ length: total }, (_, i) => i);
  }

  const targetCount = Math.min(
    maxKf,
    Math.max(
      3,
      Math.ceil(durationSec * targetFps),
      Math.ceil(durationSec / minInterval),
    ),
  );

  const picked = new Set<number>();
  picked.add(0);
  picked.add(total - 1);

  // 按目标帧率均匀取时间点
  for (let k = 1; k < targetCount - 1; k++) {
    const sec = (k / (targetCount - 1)) * durationSec;
    picked.add(findNearestFrameIndex(frameTimesSec, sec));
  }

  // 固定间隔边界补帧
  for (let sec = minInterval; sec < durationSec; sec += minInterval) {
    picked.add(findNearestFrameIndex(frameTimesSec, sec));
  }

  // 场景变化：相邻原帧差异超过阈值
  for (let i = 1; i < total; i++) {
    if (frameThumbs[i] && frameThumbs[i - 1]) {
      const diff = thumbDiff(frameThumbs[i], frameThumbs[i - 1]);
      if (diff >= threshold) {
        picked.add(i);
      }
    }
  }

  // 仍不足目标帧数：均匀补帧
  if (picked.size < targetCount) {
    sampleFrameIndices(total, Math.min(maxKf, targetCount)).forEach(i => picked.add(i));
  }

  return [...picked].sort((a, b) => a - b).slice(0, maxKf);
}

/** 高保真 GIF 分辨率（尽量保留细节） */
export function computeHighFidelityGifSettings(
  fileSizeBytes: number,
  width: number,
  height: number,
): { maxDim: number } {
  const pixels = width > 0 && height > 0 ? width * height : 0;
  let maxDim = 1280;

  if (fileSizeBytes > 12_000_000 || pixels > 1_500_000) {
    maxDim = 1024;
  } else if (fileSizeBytes > 8_000_000 || pixels > 1_000_000) {
    maxDim = 1152;
  }

  return { maxDim };
}

/** @deprecated 旧版自适应（低帧数），保留兼容 */
export function computeAdaptiveGifSettings(
  fileSizeBytes: number,
  width: number,
  height: number,
): { maxFrames: number; maxDim: number } {
  const pixels = width > 0 && height > 0 ? width * height : 0;
  let maxFrames = 18;
  let maxDim = 1024;

  if (fileSizeBytes > 4_000_000 || pixels > 800_000) {
    maxFrames = 10;
    maxDim = 720;
  } else if (fileSizeBytes > 2_000_000 || pixels > 400_000) {
    maxFrames = 14;
    maxDim = 880;
  } else if (fileSizeBytes > 800_000 || pixels > 200_000) {
    maxFrames = 16;
    maxDim = 960;
  }

  return { maxFrames, maxDim };
}

/** 解码 GIF 并沿时间轴采样关键帧（高保真管线） */
export async function decodeGifWithTimeline(
  file: File,
  options: TimelineSampleOptions = {},
): Promise<DecodedGifTimeline> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));

  const buffer = new Uint8Array(await file.arrayBuffer());
  const gif = parseGIF(buffer);
  const rawFrames = decompressFrames(gif, true);
  const width = gif.lsd.width;
  const height = gif.lsd.height;

  const bgIndex = gif.lsd.backgroundColorIndex ?? 0;
  const bgColor = gif.gct?.[bgIndex] ?? [255, 255, 255];
  const bg: [number, number, number] = [bgColor[0], bgColor[1], bgColor[2]];

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('GIF canvas unavailable');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  let composite = ctx.getImageData(0, 0, width, height);
  let previous: ImageData | null = null;

  const frameTimesSec: number[] = [];
  const frameThumbs: Uint8Array[] = [];
  let cumulativeMs = 0;

  for (let index = 0; index < rawFrames.length; index++) {
    const frame = rawFrames[index];
    blitPatch(composite, frame.patch, frame.dims, width);
    const delayMs = Math.max(20, (frame.delay || 8) * 10);
    frameTimesSec.push(cumulativeMs / 1000);
    frameThumbs.push(computeThumb32(composite, width, height));
    cumulativeMs += delayMs;

    if (frame.disposalType === 2) {
      clearRect(composite, frame.dims, width, bg);
    } else if (frame.disposalType === 3 && previous) {
      composite = copyImageData(previous);
    }

    if (frame.disposalType !== 3) {
      previous = copyImageData(composite);
    }

    if (index > 0 && index % 32 === 0) {
      await decodeYield();
    }
  }

  const durationSec = cumulativeMs / 1000;
  const pickedIndices = pickTimelineKeyframeIndices(
    frameTimesSec,
    frameThumbs,
    durationSec,
    options,
  );

  // 第二遍：只保留关键帧的完整图像
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  composite = ctx.getImageData(0, 0, width, height);
  previous = null;
  cumulativeMs = 0;

  const pickedSet = new Set(pickedIndices);
  const keyframes: DecodedGifKeyframe[] = [];

  for (let index = 0; index < rawFrames.length; index++) {
    const frame = rawFrames[index];
    blitPatch(composite, frame.patch, frame.dims, width);
    const delayMs = Math.max(20, (frame.delay || 8) * 10);

    if (pickedSet.has(index)) {
      const timeStartSec = frameTimesSec[index];
      const slot = keyframes.length;
      const nextRawIdx = pickedIndices[slot + 1];
      const timeEndSec = nextRawIdx != null
        ? frameTimesSec[nextRawIdx]
        : durationSec;

      keyframes.push({
        imageData: copyImageData(composite),
        delayMs,
        index,
        timeStartSec,
        timeEndSec: Math.max(timeStartSec + 0.05, timeEndSec),
      });
    }

    cumulativeMs += delayMs;

    if (frame.disposalType === 2) {
      clearRect(composite, frame.dims, width, bg);
    } else if (frame.disposalType === 3 && previous) {
      composite = copyImageData(previous);
    }

    if (frame.disposalType !== 3) {
      previous = copyImageData(composite);
    }

    if (index > 0 && index % 32 === 0) {
      await decodeYield();
    }
  }

  const uniform = applyUniformTimeline(keyframes, Math.max(durationSec, 0.1));

  return {
    width,
    height,
    durationSec: Math.max(uniform.durationSec, 0.1),
    keyframes,
    frameIntervalSec: uniform.frameIntervalSec,
    sliderMaxSec: uniform.sliderMaxSec,
  };
}

/** 解码 GIF 为完整合成帧序列（仅保留采样帧，减少内存） */
export async function decodeGifFile(
  file: File,
  maxFrames = 12,
): Promise<DecodedGif> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));

  const buffer = new Uint8Array(await file.arrayBuffer());
  const gif = parseGIF(buffer);
  const rawFrames = decompressFrames(gif, true);
  const width = gif.lsd.width;
  const height = gif.lsd.height;

  const picked = new Set(sampleFrameIndices(rawFrames.length, maxFrames));

  const bgIndex = gif.lsd.backgroundColorIndex ?? 0;
  const bgColor = gif.gct?.[bgIndex] ?? [255, 255, 255];
  const bg: [number, number, number] = [bgColor[0], bgColor[1], bgColor[2]];

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('GIF canvas unavailable');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  let composite = ctx.getImageData(0, 0, width, height);
  let previous: ImageData | null = null;
  const allFrames: DecodedGifFrame[] = [];

  rawFrames.forEach((frame, index) => {
    blitPatch(composite, frame.patch, frame.dims, width);
    if (picked.has(index)) {
      allFrames.push({
        imageData: copyImageData(composite),
        delayMs: Math.max(20, (frame.delay || 8) * 10),
        index,
      });
    }

    if (frame.disposalType === 2) {
      clearRect(composite, frame.dims, width, bg);
    } else if (frame.disposalType === 3 && previous) {
      composite = copyImageData(previous);
    }

    if (frame.disposalType !== 3) {
      previous = copyImageData(composite);
    }
  });

  return {
    width,
    height,
    frames: allFrames,
  };
}

/** 缩放帧到目标尺寸，白底 */
export function scaleGifFrame(
  frame: ImageData,
  srcW: number,
  srcH: number,
  maxDim: number,
): { imageData: ImageData; width: number; height: number } {
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Scale canvas unavailable');

  const tmp = document.createElement('canvas');
  tmp.width = srcW;
  tmp.height = srcH;
  tmp.getContext('2d')!.putImageData(frame, 0, 0);

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(tmp, 0, 0, width, height);

  return { imageData: ctx.getImageData(0, 0, width, height), width, height };
}
