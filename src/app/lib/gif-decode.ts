/**
 * GIF 解码：逐帧合成完整画布图像（支持 disposal）
 * 高保真模式：按时间轴采样（约每秒一帧）+ 场景变化检测
 */
import { parseGIF, decompressFrames } from 'gifuct-js';

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
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < total; i++) {
      const dist = Math.abs(frameTimesSec[i] - sec);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    picked.add(bestIdx);
  }

  // 固定间隔边界补帧
  for (let sec = minInterval; sec < durationSec; sec += minInterval) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < total; i++) {
      const dist = Math.abs(frameTimesSec[i] - sec);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    picked.add(bestIdx);
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

  rawFrames.forEach((frame, index) => {
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
  });

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

  rawFrames.forEach((frame, index) => {
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
  });

  return {
    width,
    height,
    durationSec: Math.max(durationSec, 0.1),
    keyframes,
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
