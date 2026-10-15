/**
 * 把「只在部分帧里被识别出来」的轮廓补回中间那些空档。
 *
 * 边缘追踪是逐帧独立跑的：动作模糊、抗锯齿一变，同一只手就可能在第 n 帧
 * 被画出来、第 n+1 帧整条丢掉。观感不是物体离开了画面，而是细节无缘无故闪掉。
 *
 * 规则：只填两侧都还在的短间隙（默认最多 3 帧）。真的走出画面、后面再也没回来
 * 的轮廓不会被凭空续上。
 */
import { retimeGifFrameExpressions } from './image-processing';
import { GIF_TIME_SLIDER } from './gif-quality';
import type { GifFrameArchive, StoredGifFrame } from './gif-frame-archive';

/** 间隙超过这个长度，更可能是物体真的离开了，不再补 */
const MAX_GAP = 3;

type OutlineFeat = {
  expr: any;
  cx: number;
  cy: number;
  span: number;
  length: number;
  color: string;
};

const readPoints = (expr: any): { x: number[]; y: number[] } | null => {
  const data = expr?.gifOutline;
  if (!data || !Array.isArray(data.x) || !Array.isArray(data.y)) return null;
  if (data.x.length < 2 || data.x.length !== data.y.length) return null;
  const x = data.x.map(Number);
  const y = data.y.map(Number);
  if (x.some(v => !Number.isFinite(v)) || y.some(v => !Number.isFinite(v))) return null;
  return { x, y };
};

const featFromExpr = (expr: any): OutlineFeat | null => {
  const pts = readPoints(expr);
  if (!pts) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, length = 0;
  for (let i = 0; i < pts.x.length; i++) {
    const px = pts.x[i], py = pts.y[i];
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (i > 0) length += Math.hypot(px - pts.x[i - 1], py - pts.y[i - 1]);
  }
  return {
    expr,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    span: Math.max(maxX - minX, maxY - minY, 0.01),
    length,
    color: String(expr?.color ?? ''),
  };
};

/** 两条轮廓是不是同一个部位：位置近、尺寸接近、颜色相同 */
const isSameDetail = (a: OutlineFeat, b: OutlineFeat): boolean => {
  if (a.color && b.color && a.color !== b.color) return false;
  const spanRatio = Math.min(a.span, b.span) / Math.max(a.span, b.span);
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length, 0.01);
  if (spanRatio < 0.4 || lenRatio < 0.4) return false;
  const maxDist = Math.max(1.6, 0.55 * Math.max(a.span, b.span));
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) <= maxDist;
};

const nearestIndex = (needle: OutlineFeat, haystack: OutlineFeat[], skip: boolean[]): number => {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < haystack.length; i++) {
    if (skip[i] || !isSameDetail(needle, haystack[i])) continue;
    const dist = Math.hypot(needle.cx - haystack[i].cx, needle.cy - haystack[i].cy);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
};

const holdOutlineIntoFrame = (
  source: OutlineFeat,
  fromFrame: StoredGifFrame,
  intoFrame: StoredGifFrame,
  serial: number,
  isLastFrame: boolean,
): any => {
  const fromSlot = fromFrame.index + 1;
  const toSlot = intoFrame.index + 1;
  const [cloned] = retimeGifFrameExpressions([{ ...source.expr }], {
    fromSlot,
    toSlot,
    timeStart: intoFrame.timeStart,
    timeEnd: intoFrame.timeEnd,
    sliderVar: GIF_TIME_SLIDER,
    isLastFrame,
  });
  cloned.id = `gif_f${toSlot}_dft_plot_hold_${fromSlot}_${serial}`;
  return cloned;
};

/**
 * 扫描归档里每一帧的轮廓，把短间隙补上。
 * 必须在合并扁平列表之前调用，这样补上的点列会一起进播放数据。
 */
export function stabilizeGifOutlineArchive(archive: GifFrameArchive): void {
  const frames = archive.getOrderedFrames();
  if (frames.length < 3) return;

  const feats = frames.map(frame => {
    const list: OutlineFeat[] = [];
    for (const expr of frame.expressions) {
      const feat = featFromExpr(expr);
      if (feat) list.push(feat);
    }
    list.sort((a, b) => b.length - a.length);
    return list;
  });

  const additions = frames.map(() => [] as any[]);
  let serial = 0;

  for (let i = 0; i < frames.length; i++) {
    for (const feat of feats[i]) {
      let foundAt = -1;
      for (let k = 1; k <= MAX_GAP + 1 && i + k < frames.length; k++) {
        if (nearestIndex(feat, feats[i + k], feats[i + k].map(() => false)) >= 0) {
          foundAt = k;
          break;
        }
      }
      if (foundAt <= 1) continue;

      for (let g = 1; g < foundAt; g++) {
        const gapFeats = feats[i + g];
        const alreadyThere = gapFeats.some(other => isSameDetail(feat, other));
        if (alreadyThere) continue;
        const lastIndex = frames[frames.length - 1].index;
        const held = holdOutlineIntoFrame(
          feat, frames[i], frames[i + g], serial++, frames[i + g].index === lastIndex,
        );
        additions[i + g].push(held);
        const heldFeat = featFromExpr(held);
        if (heldFeat) feats[i + g].push(heldFeat);
      }
    }
  }

  for (let i = 0; i < frames.length; i++) {
    if (additions[i].length === 0) continue;
    archive.replace(i, [...frames[i].expressions, ...additions[i]]);
  }
}
