/**
 * draw-3d.ts — 2D 图像 / Emoji → Desmos Calculator3D 立体重建
 *
 * 策略（非平面贴图）：
 *   1. 量化颜色网格 → 贪心合并同色矩形
 *   2. 每个色块挤出为棱柱（顶/底三角面 + 侧壁），高度随明度/区域变化
 *   3. 轮廓边界生成窄带竖墙（ribbon），保留描边色
 *   4. 预算控制 + 与 model-3d 相同的渐进注入接口
 */

import type { Desmos3DExpression } from './model-3d';
import { applyModel3DExpressionsProgressively } from './model-3d';

export type Draw3DResult = {
  expressions: Desmos3DExpression[];
  regionCount: number;
  triangleCount: number;
  colorCount: number;
  explanation: string;
};

export type Draw3DOptions = {
  /** 长边网格分辨率（越大越贴图，表达式越多） */
  gridMax?: number;
  /** 三角面预算 */
  maxTriangles?: number;
  /** 挤出基础厚度（Desmos 单位） */
  baseDepth?: number;
  /** 是否生成侧壁与描边墙 */
  includeWalls?: boolean;
  mode?: 'both' | 'fill' | 'outline';
};

const DEFAULT_GRID = 56;
const DEFAULT_MAX_TRIANGLES = 2200;
const DEFAULT_DEPTH = 2.4;

const fmt = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  const t = Math.round(n * 1e4) / 1e4;
  return Object.is(t, -0) ? '0' : String(t);
};

const fmtPt = (x: number, y: number, z: number) =>
  `\\left(${fmt(x)},${fmt(y)},${fmt(z)}\\right)`;

const triangleLatex = (
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
) =>
  `\\operatorname{triangle}\\left(${fmtPt(ax, ay, az)},${fmtPt(bx, by, bz)},${fmtPt(cx, cy, cz)}\\right)`;

const rgbToHex = (r: number, g: number, b: number): string => {
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
};

const isBackground = (r: number, g: number, b: number, a: number): boolean => {
  if (a < 28) return true;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  // 近白底
  return min >= 245 && max - min <= 12;
};

const quantizeKey = (r: number, g: number, b: number): number =>
  ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

type Cell = {
  key: number;
  r: number;
  g: number;
  b: number;
  empty: boolean;
};

type RectRegion = {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number;
  r: number;
  g: number;
  b: number;
};

/** 从 ImageData 建量化网格（跳过背景） */
function buildColorGrid(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  gridMax: number,
): { cells: Cell[]; gw: number; gh: number; cellW: number; cellH: number } {
  const scale = gridMax / Math.max(width, height);
  const gw = Math.max(8, Math.round(width * scale));
  const gh = Math.max(8, Math.round(height * scale));
  const cellW = width / gw;
  const cellH = height / gh;
  const cells: Cell[] = new Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor(gx * cellW);
      const y0 = Math.floor(gy * cellH);
      const x1 = Math.min(width, Math.ceil((gx + 1) * cellW));
      const y1 = Math.min(height, Math.ceil((gy + 1) * cellH));

      // 中位数采样（抗锯齿更稳）
      const rs: number[] = [];
      const gs: number[] = [];
      const bs: number[] = [];
      let bg = 0;
      let total = 0;
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) {
          const i = (y * width + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          total++;
          if (isBackground(r, g, b, a)) {
            bg++;
            continue;
          }
          rs.push(r);
          gs.push(g);
          bs.push(b);
        }
      }

      const idx = gy * gw + gx;
      if (rs.length === 0 || bg / Math.max(1, total) > 0.72) {
        cells[idx] = { key: -1, r: 255, g: 255, b: 255, empty: true };
        continue;
      }
      const mid = (arr: number[]) => {
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      const r = mid(rs);
      const g = mid(gs);
      const b = mid(bs);
      cells[idx] = { key: quantizeKey(r, g, b), r, g, b, empty: false };
    }
  }

  return { cells, gw, gh, cellW, cellH };
}

/** 贪心矩形合并（同色连通） */
function greedyMeshRects(cells: Cell[], gw: number, gh: number): RectRegion[] {
  const used = new Uint8Array(gw * gh);
  const rects: RectRegion[] = [];

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (used[i] || cells[i].empty) continue;
      const key = cells[i].key;
      const { r, g, b } = cells[i];

      let maxX = x;
      while (
        maxX + 1 < gw &&
        !used[y * gw + maxX + 1] &&
        !cells[y * gw + maxX + 1].empty &&
        cells[y * gw + maxX + 1].key === key
      ) {
        maxX++;
      }

      let maxY = y;
      outer: while (maxY + 1 < gh) {
        for (let xx = x; xx <= maxX; xx++) {
          const j = (maxY + 1) * gw + xx;
          if (used[j] || cells[j].empty || cells[j].key !== key) break outer;
        }
        maxY++;
      }

      for (let yy = y; yy <= maxY; yy++) {
        for (let xx = x; xx <= maxX; xx++) {
          used[yy * gw + xx] = 1;
        }
      }

      rects.push({ x0: x, y0: y, x1: maxX + 1, y1: maxY + 1, r, g, b });
    }
  }

  return rects;
}

function luminance(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function regionDepth(
  rect: RectRegion,
  baseDepth: number,
  gw: number,
  gh: number,
): number {
  const area = (rect.x1 - rect.x0) * (rect.y1 - rect.y0);
  const lum = luminance(rect.r, rect.g, rect.b);
  // 暗色更厚、小细节略薄，增加立体层次
  const areaFactor = 0.55 + 0.45 * Math.min(1, area / ((gw * gh) / 40));
  const lumFactor = 0.45 + (1 - lum) * 0.9;
  return baseDepth * areaFactor * lumFactor;
}

type Tri = {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  color: string;
};

function pushQuad(
  out: Tri[],
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  x3: number, y3: number, z3: number,
  color: string,
) {
  out.push({
    ax: x0, ay: y0, az: z0,
    bx: x1, by: y1, bz: z1,
    cx: x2, cy: y2, cz: z2,
    color,
  });
  out.push({
    ax: x0, ay: y0, az: z0,
    bx: x2, by: y2, bz: z2,
    cx: x3, cy: y3, cz: z3,
    color,
  });
}

/** 矩形棱柱 → 三角面 */
function extrudeRect(
  rect: RectRegion,
  toWorld: (gx: number, gy: number) => { x: number; y: number },
  z0: number,
  z1: number,
  includeWalls: boolean,
): Tri[] {
  const color = rgbToHex(rect.r, rect.g, rect.b);
  const p00 = toWorld(rect.x0, rect.y0);
  const p10 = toWorld(rect.x1, rect.y0);
  const p11 = toWorld(rect.x1, rect.y1);
  const p01 = toWorld(rect.x0, rect.y1);
  const out: Tri[] = [];

  // 顶面
  pushQuad(
    out,
    p00.x, p00.y, z1, p10.x, p10.y, z1, p11.x, p11.y, z1, p01.x, p01.y, z1,
    color,
  );
  // 底面
  pushQuad(
    out,
    p00.x, p00.y, z0, p01.x, p01.y, z0, p11.x, p11.y, z0, p10.x, p10.y, z0,
    color,
  );

  if (includeWalls) {
    // 四壁
    pushQuad(out, p00.x, p00.y, z0, p10.x, p10.y, z0, p10.x, p10.y, z1, p00.x, p00.y, z1, color);
    pushQuad(out, p10.x, p10.y, z0, p11.x, p11.y, z0, p11.x, p11.y, z1, p10.x, p10.y, z1, color);
    pushQuad(out, p11.x, p11.y, z0, p01.x, p01.y, z0, p01.x, p01.y, z1, p11.x, p11.y, z1, color);
    pushQuad(out, p01.x, p01.y, z0, p00.x, p00.y, z0, p00.x, p00.y, z1, p01.x, p01.y, z1, color);
  }

  return out;
}

/** 色块边界 → 竖墙 ribbon */
function buildOutlineWalls(
  cells: Cell[],
  gw: number,
  gh: number,
  toWorld: (gx: number, gy: number) => { x: number; y: number },
  wallZ0: number,
  wallZ1: number,
  maxWallTris: number,
): Tri[] {
  const out: Tri[] = [];
  const tryEdge = (
    gx0: number, gy0: number, gx1: number, gy1: number,
    a: Cell, b: Cell | null,
  ) => {
    if (a.empty) return;
    if (b && !b.empty && b.key === a.key) return;
    const color = rgbToHex(a.r, a.g, a.b);
    // 深色优先当描边
    const lum = luminance(a.r, a.g, a.b);
    if (lum > 0.85 && b && !b.empty) return;
    const p0 = toWorld(gx0, gy0);
    const p1 = toWorld(gx1, gy1);
    pushQuad(
      out,
      p0.x, p0.y, wallZ0, p1.x, p1.y, wallZ0, p1.x, p1.y, wallZ1, p0.x, p0.y, wallZ1,
      lum < 0.2 ? '#000000' : color,
    );
  };

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const a = cells[y * gw + x];
      if (a.empty) continue;
      // 右邻
      const right = x + 1 < gw ? cells[y * gw + x + 1] : null;
      tryEdge(x + 1, y, x + 1, y + 1, a, right);
      // 下邻
      const down = y + 1 < gh ? cells[(y + 1) * gw + x] : null;
      tryEdge(x, y + 1, x + 1, y + 1, a, down);
      // 外边界
      if (x === 0) tryEdge(x, y, x, y + 1, a, null);
      if (y === 0) tryEdge(x, y, x + 1, y, a, null);
      if (x === gw - 1) tryEdge(x + 1, y, x + 1, y + 1, a, null);
      if (y === gh - 1) tryEdge(x, y + 1, x + 1, y + 1, a, null);
      if (out.length >= maxWallTris) return out;
    }
  }
  return out;
}

function canvasToDesmos3D(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: Draw3DOptions = {},
): Draw3DResult {
  const gridMax = options.gridMax ?? DEFAULT_GRID;
  const maxTriangles = options.maxTriangles ?? DEFAULT_MAX_TRIANGLES;
  const baseDepth = options.baseDepth ?? DEFAULT_DEPTH;
  const includeWalls = options.includeWalls !== false;
  const mode = options.mode ?? 'both';
  const includeFill = mode !== 'outline';
  const includeOutline = mode !== 'fill';

  const { cells, gw, gh } = buildColorGrid(data, width, height, gridMax);

  // 映射到约 [-10,10]×[-10,10] 的 xy 平面（y 向上）
  const aspect = width / height;
  const halfX = aspect >= 1 ? 10 : 10 * aspect;
  const halfY = aspect >= 1 ? 10 / aspect : 10;
  const toWorld = (gx: number, gy: number) => ({
    x: -halfX + (gx / gw) * 2 * halfX,
    y: halfY - (gy / gh) * 2 * halfY,
  });

  const tris: Tri[] = [];
  let regionCount = 0;
  const colorSet = new Set<string>();

  if (includeFill) {
    const rects = greedyMeshRects(cells, gw, gh);
    // 大区域先画（遮挡更自然）
    rects.sort((a, b) =>
      (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0),
    );
    regionCount = rects.length;

    for (const rect of rects) {
      const depth = regionDepth(rect, baseDepth, gw, gh);
      const z0 = 0;
      const z1 = depth;
      const piece = extrudeRect(rect, toWorld, z0, z1, includeWalls);
      colorSet.add(rgbToHex(rect.r, rect.g, rect.b));
      for (const t of piece) {
        tris.push(t);
        if (tris.length >= maxTriangles * 0.85) break;
      }
      if (tris.length >= maxTriangles * 0.85) break;
    }
  }

  if (includeOutline) {
    const wallBudget = Math.max(80, maxTriangles - tris.length);
    const walls = buildOutlineWalls(
      cells, gw, gh, toWorld,
      0,
      baseDepth * 1.15,
      wallBudget,
    );
    for (const t of walls) {
      tris.push(t);
      colorSet.add(t.color);
      if (tris.length >= maxTriangles) break;
    }
  }

  // 若仍过多，均匀抽样保留外形
  let kept = tris;
  if (kept.length > maxTriangles) {
    const step = kept.length / maxTriangles;
    const sampled: Tri[] = [];
    for (let i = 0; i < maxTriangles; i++) {
      sampled.push(kept[Math.floor(i * step)]);
    }
    kept = sampled;
  }

  const expressions: Desmos3DExpression[] = [
    {
      id: 'd3d_note',
      type: 'text',
      text: `3D draw · regions ${regionCount} · tris ${kept.length} · colors ${colorSet.size}`,
    },
  ];

  kept.forEach((t, i) => {
    expressions.push({
      id: `d3d_t_${i}`,
      latex: triangleLatex(t.ax, t.ay, t.az, t.bx, t.by, t.bz, t.cx, t.cy, t.cz),
      color: t.color,
      fillOpacity: 0.95,
    });
  });

  return {
    expressions,
    regionCount,
    triangleCount: kept.length,
    colorCount: colorSet.size,
    explanation: 'draw_3d_complete',
  };
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsDataURL(file);
  });
}

function drawImageToCanvas(
  img: HTMLImageElement,
  maxSide = 512,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(32, Math.round(img.width * scale));
  const h = Math.max(32, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No ctx');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return { canvas, ctx };
}

export async function processImageToDesmos3D(
  file: File,
  options: Draw3DOptions = {},
): Promise<Draw3DResult> {
  const dataUrl = await readFileAsDataURL(file);
  const img = await loadImageElement(dataUrl);
  const { canvas, ctx } = drawImageToCanvas(img);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return canvasToDesmos3D(imageData.data, canvas.width, canvas.height, options);
}

export async function processEmojiToDesmos3D(
  emoji: string,
  options: Draw3DOptions = {},
): Promise<Draw3DResult> {
  const size = 768;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return {
      expressions: [],
      regionCount: 0,
      triangleCount: 0,
      colorCount: 0,
      explanation: 'draw_3d_fail',
    };
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.font = `${size * 0.72}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, size / 2, size / 2 + size * 0.04);
  const imageData = ctx.getImageData(0, 0, size, size);
  // Emoji 细节多：略提高网格
  return canvasToDesmos3D(imageData.data, size, size, {
    gridMax: 64,
    maxTriangles: 2400,
    baseDepth: 2.8,
    ...options,
  });
}

export { applyModel3DExpressionsProgressively as applyDraw3DExpressionsProgressively };
