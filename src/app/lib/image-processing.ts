/**
 * ============================================================================
 * lib/image-processing.ts — 图像处理与傅里叶级数可视化
 * ============================================================================
 */

import {
  prepareSmartDrawImage,
  type SmartDrawAIContour,
  type SmartDrawRepairPhase,
  type SmartDrawTuningParams,
} from './smart-draw-repair';

export type { SmartDrawMode, OutlineStyle, OutlineFitMethod } from './smart-draw-repair';
export type { SmartDrawTuningParams, SmartDrawRepairPhase, SmartDrawAIContour } from './smart-draw-repair';

// ─── 类型定义 ────────────────────────────────────────────────────────────────

/**
 * Point — 二维坐标点
 * x: 横坐标（向右为正）
 * y: 纵坐标（向下为正，Canvas 坐标系）
 */
interface Point {
  x: number;
  y: number;
}

/**
 * Complex — 复数（复平面上的点）
 * DFT 的结果是复数，包含振幅和相位信息
 * re: 实部（Real part）
 * im: 虚部（Imaginary part）
 */
interface Complex {
  re: number;
  im: number;
}

/**
 * ContourMeta — 轮廓的统计元数据
 * 用于过滤噪声（太短、太圆、太小的轮廓）
 */
interface ContourMeta {
  index: number;        // 在 rawContours 数组中的原始索引
  cx: number;           // 轮廓中心的 x 坐标（包围盒中心）
  cy: number;           // 轮廓中心的 y 坐标（包围盒中心）
  minX: number;         // 轮廓最左侧 x
  maxX: number;         // 轮廓最右侧 x
  minY: number;         // 轮廓最上侧 y
  maxY: number;         // 轮廓最下侧 y
  w: number;            // 包围盒宽度（maxX - minX）
  h: number;            // 包围盒高度（maxY - minY）
  boundsArea: number;   // 包围盒面积（w × h）
  pathLength: number;   // 轮廓的折线总长度（像素）
  points: Point[];      // 轮廓上的点序列
  averageStrength: number; // 平均梯度强度（越高说明边缘越明显）
  isClosed: boolean;    // 是否为闭合轮廓（首尾接近）
  radiusCV: number;     // 半径变异系数（暂未使用）
  fillRatio: number;    // 填充率 = 形状面积 / 包围盒面积（点→接近1，线→接近0）
  circularity: number;  // 圆形度 = 4π×面积 / 周长²（完美圆=1，直线≈0）
  aspectRatio: number;  // 宽高比（w / h）
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * boxBlur — 盒式模糊（均值滤波）
 *
 * 【作用】对灰度图进行平滑处理，去掉孤立的噪点。
 * 原理：把每个像素替换为它 3×3 邻域内所有像素的平均值。
 * 就像用橡皮在图上轻轻抹了一遍——细节被模糊，轮廓保留。
 *
 * @param input - 输入灰度数组（每个值 0-255，0=黑，255=白）
 * @param w     - 图像宽度（像素）
 * @param h     - 图像高度（像素）
 * @returns 模糊后的灰度数组
 */
const boxBlur = (input: Uint8Array, w: number, h: number) => {
  // 创建同等大小的输出数组
  const output = new Uint8Array(w * h);

  // 遍历每个像素（跳过边缘1像素，避免越界）
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x; // 当前像素在一维数组中的索引（二维→一维）
      let sum = 0;

      // 遍历 3×3 邻域（ky 和 kx 各为 -1, 0, 1）
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          sum += input[(y + ky) * w + (x + kx)]; // 累加邻域像素值
        }
      }
      output[idx] = sum / 9; // 9 个像素取平均（3×3 = 9）
    }
  }
  return output;
};

/**
 * smoothPoints — 高斯平滑（轮廓平滑）
 *
 * 【作用】消除轮廓追踪产生的锯齿状抖动。
 * 原理：用加权平均平滑每个点（前一个点25%权重 + 当前50% + 后一个25%）。
 * 这是一个简化的"高斯核"（权重分布类似正态分布的形状）。
 *
 * @param points - 原始轮廓点序列
 * @returns 平滑后的轮廓点序列（首尾两点保持不变）
 */
const smoothPoints = (points: Point[]): Point[] => {
  if (points.length < 3) return points; // 少于 3 个点，无法平滑

  const smoothed: Point[] = [];
  smoothed.push(points[0]); // 第一个点直接保留

  // 对中间的每个点，用前后邻居做加权平均
  for (let i = 1; i < points.length - 1; i++) {
    smoothed.push({
      // 0.25 × 前一点 + 0.5 × 当前点 + 0.25 × 后一点
      x: 0.25 * points[i - 1].x + 0.5 * points[i].x + 0.25 * points[i + 1].x,
      y: 0.25 * points[i - 1].y + 0.5 * points[i].y + 0.25 * points[i + 1].y
    });
  }

  smoothed.push(points[points.length - 1]); // 最后一个点直接保留
  return smoothed;
};

const smoothPointsPasses = (points: Point[], passes: number): Point[] => {
  let out = points;
  for (let i = 0; i < passes; i++) out = smoothPoints(out);
  return out;
};

const contourBBox = (points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
};

const minDistPointToPolyline = (p: Point, poly: Point[]): number => {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const d = Math.hypot(p.x - poly[i].x, p.y - poly[i].y);
    if (d < best) best = d;
  }
  return best;
};

const endpointDir = (pts: Point[], atStart: boolean): Point => {
  if (pts.length < 2) return { x: 1, y: 0 };
  const span = Math.min(5, pts.length - 1);
  let x: number;
  let y: number;
  if (atStart) {
    x = pts[span].x - pts[0].x;
    y = pts[span].y - pts[0].y;
  } else {
    const last = pts.length - 1;
    x = pts[last].x - pts[last - span].x;
    y = pts[last].y - pts[last - span].y;
  }
  const len = Math.hypot(x, y);
  if (len < 1e-12) return { x: 1, y: 0 };
  return { x: x / len, y: y / len };
};

/**
 * calculatePathLength — 计算折线总长度
 *
 * 把相邻两点的距离加起来，得到轮廓的"总路程"。
 * 用勾股定理计算两点间距离：d = √(Δx² + Δy²)
 *
 * @param points - 轮廓点序列
 * @returns 总路径长度（像素单位）
 */
const calculatePathLength = (points: Point[]): number => {
  let len = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const dx = points[i + 1].x - points[i].x; // x 方向的差
    const dy = points[i + 1].y - points[i].y; // y 方向的差
    len += Math.sqrt(dx * dx + dy * dy);       // 勾股定理求距离
  }
  return len;
};

const contourCentroid = (points: Point[]): Point => {
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
};

/** AI 轮廓与 Sobel 边缘轮廓去重合并，AI 路径优先 */
const mergeAIContoursWithEdge = (
  aiContours: SmartDrawAIContour[],
  edgeContours: Point[][],
  edgeStrengths: number[],
): { contours: Point[][]; strengths: number[]; closedHints: (boolean | null)[] } => {
  const aiEntries = aiContours
    .map(c => ({ points: smoothPoints(c.points), closed: c.closed }))
    .filter(e => calculatePathLength(e.points) >= 20);

  const edgeKeep: Point[][] = [];
  const strengthKeep: number[] = [];

  for (let i = 0; i < edgeContours.length; i++) {
    const edge = edgeContours[i];
    const overlapsAi = aiEntries.some(({ points: ai }) => {
      const ca = contourCentroid(ai);
      const ce = contourCentroid(edge);
      const dist = Math.hypot(ca.x - ce.x, ca.y - ce.y);
      const lenA = calculatePathLength(ai);
      const lenB = calculatePathLength(edge);
      const lenRatio = Math.min(lenA, lenB) / Math.max(lenA, lenB, 1);
      return dist < 45 && lenRatio > 0.45;
    });
    if (!overlapsAi) {
      edgeKeep.push(edge);
      strengthKeep.push(edgeStrengths[i]);
    }
  }

  return {
    contours: [...aiEntries.map(e => e.points), ...edgeKeep],
    strengths: [...aiEntries.map(() => 255), ...strengthKeep],
    closedHints: [
      ...aiEntries.map(e => e.closed),
      ...edgeKeep.map(() => null),
    ],
  };
};

/**
 * calculatePolygonArea — 计算多边形面积（Shoelace 公式）
 *
 * 鞋带公式（Shoelace Formula）：
 *   A = |Σ(x_i × y_{i+1} - x_{i+1} × y_i)| / 2
 * 适用于任意多边形，不需要是凸多边形。
 * 结果是绝对值（不管顶点是顺时针还是逆时针排列）。
 *
 * @param points - 多边形顶点序列
 * @returns 多边形面积（像素²）
 */
const calculatePolygonArea = (points: Point[]): number => {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length; // 下一个点的索引（最后一个点连接到第一个点）
    area += points[i].x * points[j].y; // 叉乘的 x 部分
    area -= points[j].x * points[i].y; // 叉乘的 y 部分
  }
  return Math.abs(area) / 2; // 除以 2 得到面积，取绝对值去掉符号
};

const DESMOS_FALLBACK_COLORS = [
  '#c74440', '#2d70b3', '#388c46', '#fa7e19', '#6042a6', '#000000',
  '#6fa8dc', '#e06666', '#93c47d', '#f1c232', '#8e7cc3', '#cc0000',
];

const rgbToHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

const isCanvasBackground = (r: number, g: number, b: number): boolean => {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  // 仅用于识别画布留白；图内的白/浅灰服装、头发等不应被当作背景
  return lum > 248 && spread < 18;
};

/**
 * 轮廓+填色模式：跳过纯正黑色格（已由黑色勾线呈现，避免重复填色）。
 * 容差仅覆盖 JPEG/抗锯齿造成的极窄灰阶，不误伤深蓝等深色块。
 */
const isOutlineBlackFillRgb = (r: number, g: number, b: number): boolean => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max <= 24 && max - min <= 10;
};

const isOutlineBlackFillHex = (color: string): boolean => {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return false;
  const hex = m[1];
  return isOutlineBlackFillRgb(
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  );
};

/** 仅用于区域连通分割 */
const quantizeColorKey = (r: number, g: number, b: number): number =>
  ((r >> 1) << 15) | ((g >> 1) << 8) | (b >> 1);

const colorDistance = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

/** 抗锯齿边缘允许小幅偏差；过宽会把腮红、高光并进大色块 */
const FILL_COLOR_TOLERANCE = 10;

const colorsSimilarForFill = (
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): boolean =>
  quantizeColorKey(a.r, a.g, a.b) === quantizeColorKey(b.r, b.g, b.b)
  || colorDistance(a, b) <= FILL_COLOR_TOLERANCE;

/** 从图片四边 flood fill，只标记与边框连通的留白区域 */
const buildBorderBackgroundMask = (
  keys: Uint32Array,
  gw: number,
  gh: number,
  rgbAt: (gx: number, gy: number) => { r: number; g: number; b: number },
  bgKey: number,
): Uint8Array => {
  const isBg = new Uint8Array(gw * gh);
  const stack: number[] = [];

  const seed = (gx: number, gy: number) => {
    const idx = gy * gw + gx;
    if (isBg[idx]) return;
    const { r, g, b } = rgbAt(gx, gy);
    if (keys[idx] !== bgKey && !isCanvasBackground(r, g, b)) return;
    isBg[idx] = 1;
    stack.push(idx);
  };

  for (let gx = 0; gx < gw; gx++) {
    seed(gx, 0);
    seed(gx, gh - 1);
  }
  for (let gy = 1; gy < gh - 1; gy++) {
    seed(0, gy);
    seed(gw - 1, gy);
  }

  while (stack.length) {
    const cur = stack.pop()!;
    const cx = cur % gw;
    const cy = Math.floor(cur / gw);
    const curKey = keys[cur];

    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
      const ni = ny * gw + nx;
      if (isBg[ni]) continue;
      const nb = rgbAt(nx, ny);
      if (keys[ni] !== curKey && !isCanvasBackground(nb.r, nb.g, nb.b)) continue;
      isBg[ni] = 1;
      stack.push(ni);
    }
  }

  return isBg;
};

const sampleContourColorFromData = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  points: Point[],
): string => {
  const samples: { r: number; g: number; b: number }[] = [];
  const step = Math.max(1, Math.floor(points.length / 32));
  let cx = 0, cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= Math.max(1, points.length);
  cy /= Math.max(1, points.length);

  const pushSample = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (y * width + x) * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    if (isCanvasBackground(r, g, b)) return;
    samples.push({ r, g, b });
  };

  for (let i = 0; i < points.length; i += step) {
    const x = Math.round(points[i].x);
    const y = Math.round(points[i].y);
    pushSample(x, y);
    // 边缘像素常落在两种颜色交界、容易采成发灰的黑。往轮廓内侧偏 1px，更接近物体本身的颜色。
    const dx = cx - x;
    const dy = cy - y;
    const dist = Math.hypot(dx, dy);
    if (dist > 1) {
      pushSample(Math.round(x + dx / dist), Math.round(y + dy / dist));
    }
  }

  if (samples.length === 0) return '#000000';

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  const r = median(samples.map(s => s.r));
  const g = median(samples.map(s => s.g));
  const b = median(samples.map(s => s.b));
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  // 真正的黑线（头发、墨线）保持纯黑，避免抗锯齿采成脏棕
  if (lum < 28) return '#000000';

  const quantize = (v: number) => Math.max(0, Math.min(255, Math.round(v / 24) * 24));
  return rgbToHex(quantize(r), quantize(g), quantize(b));
};

const sampleContourColor = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  points: Point[],
): string => {
  const { data } = ctx.getImageData(0, 0, width, height);
  return sampleContourColorFromData(data, width, height, points);
};

// ─── 轮廓提取 ────────────────────────────────────────────────────────────────

/**
 * extractContours — 从 Canvas 图像数据中提取边缘轮廓
 *
 * 这是整个管线中最复杂的函数，包含以下步骤：
 *   1. 灰度化：RGBA → 单通道灰度值
 *   2. 盒式模糊：去噪
 *   3. Sobel 梯度：计算每个像素的边缘强度
 *   4. 自适应阈值：根据图像整体强度动态调整"什么算边缘"
 *   5. 轮廓追踪：从高强度点出发，沿边缘方向走，收集路径
 *   6. 平滑处理：消除锯齿
 *
 * @param ctx    - Canvas 2D 绘图上下文（可以读取像素数据）
 * @param width  - 图像宽度
 * @param height - 图像高度
 * @returns 轮廓点序列数组 + 每条轮廓的平均强度
 */
const extractContours = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  tuning?: SmartDrawTuningParams,
  /** GIF：全动画共用的平均边缘强度，替掉逐帧自适应值 */
  sharedAvgStrength?: number,
): { contours: Point[][], strengths: number[], avgStrength: number } => {

  // 读取 canvas 上所有像素的 RGBA 数据
  // imageData.data 是一个平坦数组：[R0, G0, B0, A0, R1, G1, B1, A1, ...]
  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  // visited 数组：记录每个像素是否已被追踪（防止重复），0=未访问，1=已访问
  const visited = new Uint8Array(width * height);

  // 结果数组
  const contours: Point[][] = [];  // 所有找到的轮廓
  const strengths: number[] = []; // 每条轮廓的平均边缘强度

  // 图像中心坐标（用于"晕影保护"：中心区域允许更低阈值）
  const cx = width / 2;
  const cy = height / 2;

  // ── 步骤 1：灰度化 ──────────────────────────────────────────────────────
  // 把 RGBA 图像转成单通道灰度图（每像素1个值，而不是4个）
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4; // 每个像素在 data 数组中的起始位置
    // 感知亮度公式（比简单平均更准确，符合人眼感知）：
    // Y = 0.299×R + 0.587×G + 0.114×B
    gray[i] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  }

  // ── 步骤 2：盒式模糊（去噪）─────────────────────────────────────────────
  let blurred = boxBlur(gray, width, height);
  const blurPasses = tuning?.blurPasses ?? 1;
  for (let p = 1; p < blurPasses; p++) {
    blurred = boxBlur(blurred, width, height);
  }

  const edgeFactor = tuning?.edgeThresholdFactor ?? 1;

  // ── 步骤 3：3×3 Sobel + 非极大值抑制（Canny 细化）────────────────────────
  // 厚描边/锐化光晕会产生两条平行脊；NMS 把脊压成 1px，后续才不会叠成双线。
  const gxMap = new Float32Array(width * height);
  const gyMap = new Float32Array(width * height);
  const magMap = new Float32Array(width * height);
  let totalGrad = 0;
  let nonZeroCount = 0;

  const IGNORE_MARGIN = Math.max(2, Math.min(12, Math.floor(Math.min(width, height) * 0.04)));

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (x < IGNORE_MARGIN || x > width - 1 - IGNORE_MARGIN ||
          y < IGNORE_MARGIN || y > height - 1 - IGNORE_MARGIN) {
        continue;
      }
      const yw = y * width;
      const y0 = yw - width;
      const y1 = yw + width;
      const gx =
        -blurred[y0 + x - 1] + blurred[y0 + x + 1]
        - 2 * blurred[idx - 1] + 2 * blurred[idx + 1]
        - blurred[y1 + x - 1] + blurred[y1 + x + 1];
      const gy =
        -blurred[y0 + x - 1] - 2 * blurred[y0 + x] - blurred[y0 + x + 1]
        + blurred[y1 + x - 1] + 2 * blurred[y1 + x] + blurred[y1 + x + 1];
      const mag = Math.hypot(gx, gy);
      gxMap[idx] = gx;
      gyMap[idx] = gy;
      magMap[idx] = mag;
      if (mag > 12) {
        totalGrad += mag;
        nonZeroCount++;
      }
    }
  }

  const nmsMap = new Float32Array(width * height);
  for (let y = IGNORE_MARGIN; y < height - IGNORE_MARGIN; y++) {
    for (let x = IGNORE_MARGIN; x < width - IGNORE_MARGIN; x++) {
      const idx = y * width + x;
      const mag = magMap[idx];
      if (mag < 1) continue;
      const gx = gxMap[idx];
      const gy = gyMap[idx];
      const absX = Math.abs(gx);
      const absY = Math.abs(gy);
      let n1 = idx;
      let n2 = idx;
      if (absY > absX * 2.414) {
        n1 = idx - width;
        n2 = idx + width;
      } else if (absX > absY * 2.414) {
        n1 = idx - 1;
        n2 = idx + 1;
      } else if (gx * gy > 0) {
        n1 = idx - width - 1;
        n2 = idx + width + 1;
      } else {
        n1 = idx - width + 1;
        n2 = idx + width - 1;
      }
      if (mag >= magMap[n1] && mag >= magMap[n2]) nmsMap[idx] = mag;
    }
  }

  const gradientMap = new Uint8Array(width * height);
  for (let i = 0; i < nmsMap.length; i++) {
    gradientMap[i] = Math.min(255, nmsMap[i]);
  }

  // ── 步骤 4：计算自适应阈值 ─────────────────────────────────────────────
  // 全局平均梯度强度（边缘的"平均水平"）
  const frameAvgStrength = nonZeroCount > 0 ? (totalGrad / nonZeroCount) : 10;
  // GIF 逐帧各算一次的话，主体一变强，阈值跟着抬高，弱细节（手、耳朵）
  // 就会在某些帧整批掉出去。全动画共用一个值，某个细节留不留只取决于它自己。
  const globalAvgStrength = sharedAvgStrength != null && sharedAvgStrength > 0
    ? sharedAvgStrength
    : frameAvgStrength;

  /**
   * getThresholdAt — 根据位置动态计算启动阈值
   *
   * 设计思路：中心区域的细节更重要，允许较低阈值（0.6×平均）
   *           边缘区域噪声多，需要较高阈值（1.4×平均）
   * 这模拟了"晕影效应"：中心清晰，边缘稍模糊
   */
  const getThresholdAt = (x: number, y: number) => {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);            // 到中心的距离
    const maxDist = Math.sqrt(cx * cx + cy * cy);         // 最大可能距离（角点）
    const factor = (0.6 + (dist / maxDist) * 0.8) * edgeFactor;
    return globalAvgStrength * factor;
  };

  // ── 步骤 5：轮廓追踪 ──────────────────────────────────────────────────────
  /**
   * traceContour — 从起点沿边缘追踪一条完整轮廓
   *
   * 策略：
   * 1. 从高梯度点出发（已通过阈值检测）
   * 2. 在 8 个方向的邻居中，选择梯度最强且未访问的点
   * 3. 继续追踪，直到没有符合条件的邻居（死路）或达到最大点数
   *
   * 动态阈值（Hysteresis，迟滞）：
   * 开始追踪需要高阈值（确保从真实边缘出发）
   * 追踪过程中接受较低阈值（追踪已有线条时可以接受稍弱的边缘）
   */
  const markRidgeVisited = (x: number, y: number) => {
    const idx = y * width + x;
    visited[idx] = 1;
    const gx = gxMap[idx];
    const gy = gyMap[idx];
    const absX = Math.abs(gx);
    const absY = Math.abs(gy);
    let px = 0;
    let py = 0;
    if (absY > absX * 2.414) py = 1;
    else if (absX > absY * 2.414) px = 1;
    else if (gx * gy > 0) { px = 1; py = 1; }
    else { px = 1; py = -1; }
    const mag = nmsMap[idx];
    for (const s of [-1, 1]) {
      const nx = x + s * px;
      const ny = y + s * py;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (nmsMap[ni] <= mag * 0.85) visited[ni] = 1;
    }
  };

  const traceContour = (startX: number, startY: number): { points: Point[], avgStrength: number } => {
    const points: Point[] = [];
    let currentX = startX;
    let currentY = startY;
    let totalStrength = 0;
    let prevDX = 0;
    let prevDY = 0;

    points.push({ x: currentX, y: currentY });
    markRidgeVisited(currentX, currentY);

    const dx = [0, 1, 1, 1, 0, -1, -1, -1];
    const dy = [-1, -1, 0, 1, 1, 1, 0, -1];

    let steps = 0;
    const maxPoints = 8000;

    while (steps < maxPoints) {
      let bestNextX = -1;
      let bestNextY = -1;
      let bestScore = -1;
      const localThresh = getThresholdAt(currentX, currentY) * 0.32;

      for (let i = 0; i < 8; i++) {
        const nx = currentX + dx[i];
        const ny = currentY + dy[i];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nidx = ny * width + nx;
        if (visited[nidx] !== 0) continue;
        const val = nmsMap[nidx];
        if (val <= localThresh) continue;
        // 沿当前走向加分，减少锯齿折返；仍允许拐弯
        let score = val;
        if (prevDX !== 0 || prevDY !== 0) {
          score += 0.35 * val * (dx[i] * prevDX + dy[i] * prevDY);
        }
        if (score > bestScore) {
          bestScore = score;
          bestNextX = nx;
          bestNextY = ny;
        }
      }

      if (bestNextX !== -1) {
        prevDX = Math.sign(bestNextX - currentX);
        prevDY = Math.sign(bestNextY - currentY);
        currentX = bestNextX;
        currentY = bestNextY;
        points.push({ x: currentX, y: currentY });
        markRidgeVisited(currentX, currentY);
        totalStrength += nmsMap[currentY * width + currentX];
      } else {
        break;
      }
      steps++;
    }

    return {
      points,
      avgStrength: totalStrength / (points.length || 1),
    };
  };

  // 逐像素扫描 NMS 脊，避免 SCAN_STEP=2 漏掉细部（眼睛、镜头圈）
  for (let y = IGNORE_MARGIN; y < height - IGNORE_MARGIN; y++) {
    for (let x = IGNORE_MARGIN; x < width - IGNORE_MARGIN; x++) {
      const idx = y * width + x;
      if (visited[idx]) continue;
      const startThresh = getThresholdAt(x, y);
      if (nmsMap[idx] > startThresh) {
        const result = traceContour(x, y);
        if (result.points.length > 12) {
          const pts = result.points;
          const gap = Math.hypot(
            pts[0].x - pts[pts.length - 1].x,
            pts[0].y - pts[pts.length - 1].y,
          );
          // 闭环被 visited 挡住时首尾只差一两格；补上起点，后续才能按圆拟合
          if (gap > 1e-6 && gap <= 6 && pts.length > 16) pts.push({ ...pts[0] });
          contours.push(smoothPointsPasses(pts, 2));
          strengths.push(result.avgStrength);
        }
      }
    }
  }

  return { contours, strengths, avgStrength: frameAvgStrength };
};

// ─── DFT（离散傅里叶变换）────────────────────────────────────────────────────

/**
 * computeDFT — 计算点序列的离散傅里叶变换
 *
 * 【DFT 的原理（通俗版）】
 * 把轮廓上的点想象成一首"歌曲"：
 * - 每个点是某个时刻的"音符"（x, y 坐标）
 * - DFT 把这首歌分解成若干个"纯音"（单一频率的正弦波）
 * - 每个"纯音"有自己的频率（转多快）和振幅（多响）
 * - 把所有"纯音"叠加，就能还原原始轮廓
 *
 * 用于图形绘制时：
 * - 每个频率对应一个旋转的圆（本轮/epicycle）
 * - 圆的半径 = 该频率的振幅
 * - 所有圆的端点叠加，描出原始轮廓
 *
 * 【数学公式】
 * X[k] = (1/N) × Σ(n=0 to N-1) (x[n]×cos(2πkn/N) + y[n]×sin(2πkn/N))
 * Y[k] = (1/N) × Σ(n=0 to N-1) (y[n]×cos(2πkn/N) - x[n]×sin(2πkn/N))
 *
 * @param points    - 轮廓点序列（已居中、缩放）
 * @param numCoeffs - 保留的频率个数（越多细节越丰富，越少越平滑）
 * @returns 傅里叶系数数组（每个包含频率 freq、实部 re、虚部 im）
 */
const computeDFT = (points: Point[], numCoeffs: number) => {
  const N = points.length;
  const maxK = Math.floor((N - 1) / 2);
  const actualCoeffs = Math.min(numCoeffs, maxK);

  const computeXk = (k: number): Complex => {
    let sumRe = 0;
    let sumIm = 0;
    for (let n = 0; n < N; n++) {
      const phi = (2 * Math.PI * k * n) / N;
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      sumRe += points[n].x * cos + points[n].y * sin;
      sumIm += points[n].y * cos - points[n].x * sin;
    }
    return { re: sumRe / N, im: sumIm / N };
  };

  const coeffs = [];
  coeffs.push({ freq: 0, ...computeXk(0) });

  for (let i = 1; i <= actualCoeffs; i++) {
    coeffs.push({ freq: i, ...computeXk(i) });
    coeffs.push({ freq: -i, ...computeXk(N - i) });
  }

  return coeffs;
};

// ─── 三次贝塞尔高精度拟合（误差驱动自适应细分）──────────────────────────────

type CubicBez = { p0: Point; p1: Point; p2: Point; p3: Point };

const pointDist = (a: Point, b: Point): number =>
  Math.hypot(b.x - a.x, b.y - a.y);

/** 贝塞尔控制点用 7 位小数，显著压低量化锯齿 */
const fmtDesmosNumBezier = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 1e7) / 1e7;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

const resampleByArcLength = (points: Point[], count: number): Point[] => {
  if (points.length === 0) return [];
  if (points.length === 1 || count <= 1) return [points[0]];
  const lens: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    lens.push(lens[i - 1] + pointDist(points[i - 1], points[i]));
  }
  const total = lens[lens.length - 1];
  if (total <= 1e-9) return Array.from({ length: count }, () => ({ ...points[0] }));

  const out: Point[] = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const target = (total * i) / (count - 1);
    while (j < lens.length - 2 && lens[j + 1] < target) j++;
    const a = lens[j];
    const b = lens[j + 1];
    const t = b > a ? (target - a) / (b - a) : 0;
    const p0 = points[j];
    const p1 = points[Math.min(j + 1, points.length - 1)];
    out.push({
      x: p0.x + (p1.x - p0.x) * t,
      y: p0.y + (p1.y - p0.y) * t,
    });
  }
  return out;
};

/**
 * 按曲率自适应重采样：直边稀疏、弯角/细节处更密，避免整条轮廓均匀过密。
 * minSpacing/maxSpacing 为图像像素弧长。
 */
/**
 * 智能绘图画布尺寸：小图等比例放大到 TARGET，大图缩到 MAX。
 * 放大后可用更大像素间距采样，线条不必再像素级堆点。
 */
const resolveSmartDrawCanvasSize = (
  imgW: number,
  imgH: number,
): { width: number; height: number; scale: number } => {
  const MAX_DIM = 1280;
  // 小图略放大，Sobel/NMS 更稳；过大只会把抗锯齿噪点放大
  const TARGET_DIM = 1200;
  const maxSide = Math.max(imgW, imgH, 1);
  let scale = maxSide < TARGET_DIM ? TARGET_DIM / maxSide : 1;
  if (maxSide * scale > MAX_DIM) scale = MAX_DIM / maxSide;
  return {
    width: Math.max(1, Math.round(imgW * scale)),
    height: Math.max(1, Math.round(imgH * scale)),
    scale,
  };
};

/**
 * 高精度采样：弯处更密、直边仍可疏。
 * boost 随画布增大略增，但上限压住，避免又回到「处处过密」。
 */
const outlineSpacingForCanvas = (width: number, height: number): { min: number; max: number; cap: number } => {
  const maxSide = Math.max(width, height, 1);
  const boost = Math.min(1.9, Math.max(1, maxSide / 640));
  return {
    min: 0.82 * boost,
    max: 3.4 * boost,
    cap: Math.min(720, Math.max(240, Math.round(760 / Math.sqrt(boost)))),
  };
};

/** 最小二乘圆（Kåsa）；rms/r 过大则视为非圆 */
const fitCircleToPoints = (
  pts: Point[],
): { h: number; k: number; r: number; rms: number } | null => {
  if (pts.length < 8) return null;
  let sumX = 0;
  let sumY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  let sumXY = 0;
  let sumX3 = 0;
  let sumY3 = 0;
  let sumX2Y = 0;
  let sumXY2 = 0;
  const n = pts.length;
  for (const p of pts) {
    const x = p.x;
    const y = p.y;
    const x2 = x * x;
    const y2 = y * y;
    sumX += x;
    sumY += y;
    sumX2 += x2;
    sumY2 += y2;
    sumXY += x * y;
    sumX3 += x2 * x;
    sumY3 += y2 * y;
    sumX2Y += x2 * y;
    sumXY2 += x * y2;
  }
  const A = n * sumX2 - sumX * sumX;
  const B = n * sumXY - sumX * sumY;
  const C = n * sumY2 - sumY * sumY;
  const G = 0.5 * (n * sumX3 + n * sumXY2 - sumX * (sumX2 + sumY2));
  const H = 0.5 * (n * sumY3 + n * sumX2Y - sumY * (sumX2 + sumY2));
  const den = A * C - B * B;
  if (Math.abs(den) < 1e-12) return null;
  const h = (G * C - B * H) / den;
  const k = (A * H - G * B) / den;
  let rSum = 0;
  for (const p of pts) rSum += Math.hypot(p.x - h, p.y - k);
  const r = rSum / n;
  if (!(r > 1e-4)) return null;
  let sse = 0;
  for (const p of pts) {
    const d = Math.hypot(p.x - h, p.y - k) - r;
    sse += d * d;
  }
  return { h, k, r, rms: Math.sqrt(sse / n) };
};

/** 三点定圆；共线则失败 */
const circleFrom3Points = (
  a: Point,
  b: Point,
  c: Point,
): { h: number; k: number; r: number } | null => {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-10) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const h = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const k = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - h, a.y - k);
  if (!(r > 1e-4)) return null;
  return { h, k, r };
};

/** 点绕圆心的最大角度缺口（弧度）。近圆 ≈ 0，短弧 ≈ 接近 2π */
const largestAngularGap = (pts: Point[], h: number, k: number): number => {
  const angs: number[] = [];
  for (const p of pts) angs.push(Math.atan2(p.y - k, p.x - h));
  angs.sort((x, y) => x - y);
  if (angs.length < 3) return Math.PI * 2;
  let maxGap = 0;
  for (let i = 1; i < angs.length; i++) {
    const g = angs[i] - angs[i - 1];
    if (g > maxGap) maxGap = g;
  }
  const wrap = angs[0] + Math.PI * 2 - angs[angs.length - 1];
  return wrap > maxGap ? wrap : maxGap;
};

/**
 * 描边常在 NMS 弱处断开，眼睛/镜头会留下一小段缺口。
 * 缺口不到路径长度约 1/4 时补上闭合点，按闭环做面积/圆拟合。
 */
const virtuallyClosePoints = (pts: Point[]): Point[] => {
  if (pts.length < 3) return pts;
  const gap = pointDist(pts[0], pts[pts.length - 1]);
  if (gap < 1e-8) return pts;
  const len = calculatePathLength(pts);
  if (gap <= Math.max(len * 0.28, 1e-4)) return [...pts, { ...pts[0] }];
  return pts;
};

type DetectedCircle = {
  h: number;
  k: number;
  r: number;
  rms: number;
  inliers: boolean[];
  inlierRatio: number;
};

const circleInlierStats = (
  pts: Point[],
  h: number,
  k: number,
  r: number,
  tol: number,
): { mask: boolean[]; count: number; rms: number; coverage: number } => {
  const mask: boolean[] = new Array(pts.length);
  let count = 0;
  let sse = 0;
  const inlierPts: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    const d = Math.abs(Math.hypot(pts[i].x - h, pts[i].y - k) - r);
    const ok = d <= tol;
    mask[i] = ok;
    if (ok) {
      count++;
      sse += d * d;
      inlierPts.push(pts[i]);
    }
  }
  const rms = count > 0 ? Math.sqrt(sse / count) : Infinity;
  const coverage = inlierPts.length >= 3
    ? 1 - largestAngularGap(inlierPts, h, k) / (Math.PI * 2)
    : 0;
  return { mask, count, rms, coverage };
};

/**
 * 圆/扁圆验收：放宽到卡通椭圆眼睛，但仍拒绝乱线、短弧、细长条。
 * 阈值按点集自身尺度，像素坐标和 Desmos 坐标都能用。
 */
const acceptCircleGeometry = (
  pts: Point[],
  circ: { h: number; k: number; r: number; rms: number },
  coverage: number,
): boolean => {
  if (!(circ.r > 1e-4) || pts.length < 8) return false;
  const rel = circ.rms / circ.r;
  const box = contourBBox(pts);
  const bw = box.maxX - box.minX;
  const bh = box.maxY - box.minY;
  const span = Math.max(bw, bh, 1e-6);
  if (circ.r < span * 0.12 || circ.r > span * 1.25) return false;
  const aspect = bw / Math.max(bh, 1e-6);
  if (aspect < 0.36 || aspect > 2.75) return false;
  const closed = virtuallyClosePoints(pts);
  const pathLen = calculatePathLength(closed);
  const circLen = 2 * Math.PI * circ.r;
  if (pathLen < circLen * 0.40 || pathLen > circLen * 1.70) return false;
  const area = calculatePolygonArea(closed);
  const circularity = pathLen > 0 ? (4 * Math.PI * area) / (pathLen * pathLen) : 0;
  const fillRatio = bw * bh > 0 ? area / (bw * bh) : 0;
  if (coverage >= 0.78) {
    // 整圈：扁圆眼睛 rel≈0.10–0.17、圆形度≈0.9；矩形机身圆形度≈0.78 且填满包围盒
    if (rel > 0.19) return false;
    if (circularity < 0.83) return false;
    if (fillRatio > 0.93) return false;
  } else if (coverage >= 0.55) {
    if (rel > 0.12) return false;
  } else {
    return false;
  }
  return true;
};

const spanTol = (pts: Point[]): number => {
  const box = contourBBox(pts);
  return Math.max(box.maxX - box.minX, box.maxY - box.minY, 1) * 0.02;
};

/** 只累计相邻内点的弧长，避免把矩形四角「跳着」连成假圆 */
const inlierArcLength = (pts: Point[], mask: boolean[]): number => {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    if (mask[i] && mask[i - 1]) len += pointDist(pts[i - 1], pts[i]);
  }
  if (pts.length > 2 && mask[0] && mask[pts.length - 1]) {
    len += pointDist(pts[0], pts[pts.length - 1]);
  }
  return len;
};

const longestInlierRunLength = (pts: Point[], mask: boolean[]): number => {
  const n = pts.length;
  if (n < 2) return 0;
  const runs: number[] = [];
  let cur = 0;
  for (let i = 1; i < n; i++) {
    if (mask[i] && mask[i - 1]) cur += pointDist(pts[i - 1], pts[i]);
    else if (cur > 0) {
      runs.push(cur);
      cur = 0;
    }
  }
  if (cur > 0) runs.push(cur);
  if (mask[0] && mask[n - 1] && runs.length > 0) {
    const wrap = pointDist(pts[0], pts[n - 1]);
    if (runs.length === 1 && mask.every(Boolean)) runs[0] += wrap;
    else if (runs.length >= 2) {
      runs[0] += (runs.pop() ?? 0) + wrap;
    }
  }
  let best = 0;
  for (const r of runs) if (r > best) best = r;
  return best;
};

/**
 * 从一条轮廓里找圆：先整段（含补缝），失败再在轮廓上抽三点拟合，
 * 这样镜头粘在机身上、眼睛被眼睑断开时仍能出圆方程。
 */
const detectCircleOnContour = (pts: Point[]): DetectedCircle | null => {
  if (pts.length < 8) return null;
  const closedPts = virtuallyClosePoints(pts);

  const whole = fitCircleToPoints(closedPts);
  if (whole) {
    const coverage = 1 - largestAngularGap(closedPts, whole.h, whole.k) / (Math.PI * 2);
    if (acceptCircleGeometry(closedPts, whole, coverage) && coverage >= 0.72) {
      return {
        ...whole,
        inliers: pts.map(() => true),
        inlierRatio: 1,
      };
    }
  }

  const n = pts.length;
  const step = Math.max(1, Math.floor(n / 16));
  let best: DetectedCircle | null = null;
  let bestScore = -1;
  const box = contourBBox(pts);
  const minR = Math.max(1e-3, Math.min(box.maxX - box.minX, box.maxY - box.minY) * 0.08);
  const maxR = Math.max(box.maxX - box.minX, box.maxY - box.minY) * 0.95;

  for (let i = 0; i < n; i += step) {
    for (let j = i + step * 2; j < n; j += step) {
      for (let k = j + step * 2; k < n; k += step) {
        const c3 = circleFrom3Points(pts[i], pts[j], pts[k]);
        if (!c3 || c3.r < minR || c3.r > maxR) continue;
        const tol = Math.max(0.06 * c3.r, spanTol(pts) * 0.35);
        const stats = circleInlierStats(pts, c3.h, c3.k, c3.r, tol);
        if (stats.count < Math.max(8, n * 0.16)) continue;
        if (stats.coverage < 0.70) continue;
        const inlierPts = pts.filter((_, idx) => stats.mask[idx]);
        const refined = fitCircleToPoints(inlierPts) ?? { ...c3, rms: stats.rms };
        const cov = Math.max(
          stats.coverage,
          1 - largestAngularGap(inlierPts, refined.h, refined.k) / (Math.PI * 2),
        );
        if (!acceptCircleGeometry(inlierPts, refined, cov)) continue;
        const circLen = 2 * Math.PI * refined.r;
        const arcLen = inlierArcLength(pts, stats.mask);
        const longest = longestInlierRunLength(pts, stats.mask);
        // 连续弧必须够长：拒绝矩形四角落在外接圆上的假圆
        if (arcLen < circLen * 0.45 || arcLen > circLen * 1.70) continue;
        if (longest < circLen * 0.38) continue;
        const rel = refined.rms / refined.r;
        const score = cov * 2 + stats.count / n - rel;
        if (score > bestScore) {
          bestScore = score;
          best = {
            h: refined.h,
            k: refined.k,
            r: refined.r,
            rms: refined.rms,
            inliers: stats.mask,
            inlierRatio: stats.count / n,
          };
        }
      }
    }
  }
  return best;
};

/** 圆上的内点去掉后，剩下的开链（含与圆的衔接点），避免圆和折线叠画 */
const outlierRunsFromMask = (pts: Point[], inliers: boolean[]): Point[][] => {
  const n = pts.length;
  if (n === 0 || inliers.length !== n) return [];
  const runs: Point[][] = [];
  let cur: Point[] = [];
  for (let i = 0; i < n; i++) {
    if (!inliers[i]) {
      if (cur.length === 0 && i > 0) cur.push(pts[i - 1]);
      cur.push(pts[i]);
    } else if (cur.length) {
      cur.push(pts[i]);
      runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) {
    if (runs.length > 0 && !inliers[0]) runs[0] = cur.concat(runs[0]);
    else runs.push(cur);
  }
  return runs.filter(r => r.length >= 4 && calculatePathLength(r) > 0.08);
};

const contourLooksClosedCircle = (pts: Point[]): boolean => {
  const hit = detectCircleOnContour(pts);
  return !!(hit && hit.inlierRatio >= 0.62);
};

/** 主方向直线段拟合；rms 为垂距均方根 */
const fitLineToPoints = (
  pts: Point[],
): { a: Point; b: Point; rms: number; length: number } | null => {
  if (pts.length < 4) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let tMin = Infinity;
  let tMax = -Infinity;
  let sse = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    const t = dx * ux + dy * uy;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
    const ortho = -dx * uy + dy * ux;
    sse += ortho * ortho;
  }
  const length = tMax - tMin;
  if (length < 1e-4) return null;
  return {
    a: { x: mx + ux * tMin, y: my + uy * tMin },
    b: { x: mx + ux * tMax, y: my + uy * tMax },
    rms: Math.sqrt(sse / pts.length),
    length,
  };
};

/** 在真实尖角处切开轮廓（用窗口向量，避免像素锯齿被当成角） */
const splitContourAtCorners = (
  pts: Point[],
  isClosed: boolean,
  cosThresh = 0.02,
): Point[][] => {
  if (pts.length < 6) return [pts.slice()];
  const n = pts.length;
  const span = Math.max(2, Math.min(6, Math.round(n * 0.03)));
  const minCornerGap = Math.max(3, span);
  const corners: number[] = [];
  const start = isClosed ? 0 : span;
  const end = isClosed ? n : n - span;
  for (let i = start; i < end; i++) {
    const prev = pts[(i - span + n) % n];
    const cur = pts[i];
    const next = pts[(i + span) % n];
    const ax = cur.x - prev.x;
    const ay = cur.y - prev.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    const cos = (ax * bx + ay * by) / (la * lb);
    if (cos >= cosThresh) continue;
    const last = corners[corners.length - 1];
    if (last != null && i - last < minCornerGap) {
      if (cos < -0.2) corners[corners.length - 1] = i;
      continue;
    }
    corners.push(i);
  }
  if (corners.length === 0) return [pts.slice()];

  if (!isClosed) {
    const cuts = [0, ...corners, n - 1];
    const segs: Point[][] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const a = cuts[i];
      const b = cuts[i + 1];
      if (b - a >= 2) segs.push(pts.slice(a, b + 1));
    }
    return segs.length > 0 ? segs : [pts.slice()];
  }

  const ordered = [...new Set(corners)].sort((a, b) => a - b);
  const segs: Point[][] = [];
  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i];
    const b = ordered[(i + 1) % ordered.length];
    const seg: Point[] = [];
    let j = a;
    for (;;) {
      seg.push(pts[j]);
      if (j === b) break;
      j = (j + 1) % n;
      if (seg.length > n + 2) break;
    }
    if (seg.length >= 3) segs.push(seg);
  }
  return segs.length > 0 ? segs : [pts.slice()];
};

const resampleAdaptiveByCurvature = (
  points: Point[],
  minSpacing: number,
  maxSpacing: number,
  maxPoints = 720,
): Point[] => {
  if (points.length <= 2) return points.slice();
  const minS = Math.max(0.5, minSpacing);
  const maxS = Math.max(minS + 0.25, maxSpacing);
  const out: Point[] = [{ ...points[0] }];
  let carried = 0;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const segLen = pointDist(prev, cur);
    let turn = 0;
    if (i + 1 < points.length) {
      const next = points[i + 1];
      const ax = cur.x - prev.x;
      const ay = cur.y - prev.y;
      const bx = next.x - cur.x;
      const by = next.y - cur.y;
      const la = Math.hypot(ax, ay) || 1;
      const lb = Math.hypot(bx, by) || 1;
      const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
      turn = 1 - cos; // 0=直线，≈2=折返
    }
    const spacing = maxS - (maxS - minS) * Math.min(1, turn / 0.82);
    carried += segLen;
    const isLast = i === points.length - 1;
    if (carried >= spacing || isLast) {
      out.push({ ...cur });
      carried = 0;
    }
  }

  if (out.length > maxPoints) {
    return resampleByArcLength(out, maxPoints);
  }
  return out;
};

const normalizeVec = (x: number, y: number): Point => {
  const len = Math.hypot(x, y);
  if (len < 1e-12) return { x: 1, y: 0 };
  return { x: x / len, y: y / len };
};

/** 折线各点单位切线（前向/后向差分） */
const polylineTangents = (pts: Point[], closed: boolean): Point[] => {
  const n = pts.length;
  const out: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let prev: Point;
    let next: Point;
    if (closed) {
      prev = pts[(i - 1 + n) % n];
      next = pts[(i + 1) % n];
    } else if (i === 0) {
      prev = pts[0];
      next = pts[Math.min(1, n - 1)];
    } else if (i === n - 1) {
      prev = pts[n - 2];
      next = pts[n - 1];
    } else {
      prev = pts[i - 1];
      next = pts[i + 1];
    }
    out[i] = normalizeVec(next.x - prev.x, next.y - prev.y);
  }
  return out;
};

/** 端点固定的 Hermite→三次贝塞尔（切线长度 ∝ 弦长/3） */
const hermiteToCubic = (p0: Point, p3: Point, tIn: Point, tOut: Point): CubicBez => {
  const chord = Math.max(pointDist(p0, p3), 1e-9);
  const s = chord / 3;
  return {
    p0: { ...p0 },
    p1: { x: p0.x + tIn.x * s, y: p0.y + tIn.y * s },
    p2: { x: p3.x - tOut.x * s, y: p3.y - tOut.y * s },
    p3: { ...p3 },
  };
};

const evalCubicBez = (bez: CubicBez, t: number): Point => {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  const a = uu * u;
  const b = 3 * uu * t;
  const c = 3 * u * tt;
  const d = tt * t;
  return {
    x: a * bez.p0.x + b * bez.p1.x + c * bez.p2.x + d * bez.p3.x,
    y: a * bez.p0.y + b * bez.p1.y + c * bez.p2.y + d * bez.p3.y,
  };
};

/** 折线段相对贝塞尔的最大偏差（弦长参数化），返回误差与分裂下标 */
const maxBezierDeviation = (
  pts: Point[],
  bez: CubicBez,
): { err: number; splitAt: number } => {
  if (pts.length <= 2) return { err: 0, splitAt: 0 };
  const lens: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    lens.push(lens[i - 1] + pointDist(pts[i - 1], pts[i]));
  }
  const total = lens[lens.length - 1] || 1;
  let bestErr = 0;
  let bestIdx = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const t = lens[i] / total;
    const q = evalCubicBez(bez, t);
    const e = pointDist(pts[i], q);
    if (e > bestErr) {
      bestErr = e;
      bestIdx = i;
    }
  }
  return { err: bestErr, splitAt: bestIdx };
};

/**
 * 误差驱动递归细分：贴边精度由 maxErr（Desmos 坐标）控制。
 * 弯角处自动多切段，直线处少切，兼顾行数与精度。
 */
const fitCubicBezierAdaptive = (
  pts: Point[],
  tans: Point[],
  i0: number,
  i1: number,
  maxErr: number,
  depth: number,
  maxDepth: number,
  out: CubicBez[],
  segBudget: { left: number },
): void => {
  if (segBudget.left <= 0) return;
  if (i1 <= i0) return;

  if (i1 - i0 === 1) {
    const a = pts[i0];
    const b = pts[i1];
    out.push(hermiteToCubic(a, b, tans[i0], tans[i1]));
    segBudget.left -= 1;
    return;
  }

  const slice = pts.slice(i0, i1 + 1);
  const bez = hermiteToCubic(pts[i0], pts[i1], tans[i0], tans[i1]);
  const { err, splitAt } = maxBezierDeviation(slice, bez);
  const localSplit = i0 + splitAt;

  const canSplit =
    depth < maxDepth
    && segBudget.left > 1
    && err > maxErr
    && localSplit > i0
    && localSplit < i1;

  if (!canSplit) {
    out.push(bez);
    segBudget.left -= 1;
    return;
  }

  fitCubicBezierAdaptive(pts, tans, i0, localSplit, maxErr, depth + 1, maxDepth, out, segBudget);
  fitCubicBezierAdaptive(pts, tans, localSplit, i1, maxErr, depth + 1, maxDepth, out, segBudget);
};

/**
 * 折线 → 高精度三次贝塞尔链。
 * - 先密采样保留细节
 * - 尖角处强制打断
 * - 再按最大几何误差自适应细分
 */
const fitCubicBezierChain = (
  raw: Point[],
  isClosed: boolean,
  maxSegments: number,
  options?: { maxErr?: number },
): CubicBez[] => {
  if (raw.length < 2) return [];
  const segCap = Math.max(1, maxSegments);
  /** Desmos 坐标系下最大允许偏差；越小越贴边 */
  const maxErr = options?.maxErr ?? 0.012;

  if (raw.length === 2) {
    const [a, b] = raw;
    const tan = normalizeVec(b.x - a.x, b.y - a.y);
    return [hermiteToCubic(a, b, tan, tan)];
  }

  // 每段目标弧长更短 → 保留更多几何细节后再做误差细分
  let pathLen = 0;
  for (let i = 1; i < raw.length; i++) pathLen += pointDist(raw[i - 1], raw[i]);
  if (isClosed) pathLen += pointDist(raw[raw.length - 1], raw[0]);

  // 误差越紧，预采样越密，贴边更准
  const errFactor = Math.max(0.35, Math.min(1.2, maxErr / 0.012));
  const targetSpacing = Math.max(0.025, Math.min(0.12 * errFactor, pathLen / (segCap * 3.4)));
  const denseCount = Math.min(
    3200,
    Math.max(raw.length, Math.ceil(pathLen / targetSpacing) + 1),
  );

  let pts = resampleByArcLength(raw, denseCount);
  if (pts.length < 2) return [];

  // 闭合轮廓展开成「首点重复在末尾」的开路径，统一走自适应细分
  if (isClosed && pointDist(pts[0], pts[pts.length - 1]) > 1e-9) {
    pts = [...pts, pts[0]];
  }

  const tans = polylineTangents(
    isClosed && pointDist(pts[0], pts[pts.length - 1]) < 1e-9
      ? pts.slice(0, -1)
      : pts,
    isClosed,
  );
  // 展开后末点切线 = 起点切线
  const pathTans: Point[] =
    isClosed && pointDist(pts[0], pts[pts.length - 1]) < 1e-9
      ? [...tans, tans[0]]
      : tans;

  const n = pts.length;
  const anchors: number[] = [0];
  const last = n - 1;
  for (let i = 1; i < last; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const ax = cur.x - prev.x;
    const ay = cur.y - prev.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    const cos = (ax * bx + ay * by) / (la * lb);
    if (cos < -0.05) anchors.push(i); // 仅接近直角/锐角才强制断点，有机曲线保持一段
  }
  if (anchors[anchors.length - 1] !== last) anchors.push(last);

  const uniqAnchors = [...new Set(anchors)].sort((a, b) => a - b);
  const out: CubicBez[] = [];
  const budget = { left: segCap };

  for (let k = 0; k < uniqAnchors.length - 1; k++) {
    if (budget.left <= 0) break;
    fitCubicBezierAdaptive(
      pts,
      pathTans,
      uniqAnchors[k],
      uniqAnchors[k + 1],
      maxErr,
      0,
      16,
      out,
      budget,
    );
  }

  return out.length > 0
    ? out
    : [hermiteToCubic(pts[0], pts[last], pathTans[0], pathTans[pathTans.length - 1])];
};

/** 把贝塞尔链采样成折线（GIF 紧凑播放用） */
const sampleBezierChainPoints = (segs: CubicBez[], samplesPerSeg: number): Point[] => {
  if (segs.length === 0) return [];
  const n = Math.max(2, samplesPerSeg);
  const out: Point[] = [];
  segs.forEach((bez, si) => {
    const start = si === 0 ? 0 : 1;
    for (let i = start; i < n; i++) {
      out.push(evalCubicBez(bez, i / (n - 1)));
    }
  });
  return out;
};

/**
 * 内联三次贝塞尔参数式（不用 B_x 辅助函数）。
 * 必须写 \\cdot，否则 Desmos 会把 tb / t^{2}c 解析成未定义变量，曲线整段消失只剩碎线。
 */
const buildCubicBezLatex = (bez: CubicBez): string => {
  const x0 = fmtDesmosNumBezier(bez.p0.x);
  const x1 = fmtDesmosNumBezier(bez.p1.x);
  const x2 = fmtDesmosNumBezier(bez.p2.x);
  const x3 = fmtDesmosNumBezier(bez.p3.x);
  const y0 = fmtDesmosNumBezier(bez.p0.y);
  const y1 = fmtDesmosNumBezier(bez.p1.y);
  const y2 = fmtDesmosNumBezier(bez.p2.y);
  const y3 = fmtDesmosNumBezier(bez.p3.y);
  const bx =
    `\\left(1-t\\right)^{3}\\cdot${x0}`
    + `+3\\left(1-t\\right)^{2}\\cdot t\\cdot${x1}`
    + `+3\\left(1-t\\right)\\cdot t^{2}\\cdot${x2}`
    + `+t^{3}\\cdot${x3}`;
  const by =
    `\\left(1-t\\right)^{3}\\cdot${y0}`
    + `+3\\left(1-t\\right)^{2}\\cdot t\\cdot${y1}`
    + `+3\\left(1-t\\right)\\cdot t^{2}\\cdot${y2}`
    + `+t^{3}\\cdot${y3}`;
  return `\\left(${bx},${by}\\right)`;
};

/**
 * 把端点接近的开放轮廓拼成更长的链（动漫线稿 Sobel 常碎成短段）。
 * 拼接时要求走向大致连续，避免把手和镜头等无关碎段硬接在一起。
 */
const linkOpenContours = (
  contours: Point[][],
  closedFlags: boolean[],
  strengths: number[],
  maxGapPx: number,
): { contours: Point[][]; closed: boolean[]; strengths: number[] } => {
  const n = contours.length;
  if (n <= 1) {
    return {
      contours: contours.map(c => c.slice()),
      closed: closedFlags.slice(),
      strengths: strengths.slice(),
    };
  }

  const used = new Array(n).fill(false);
  const outC: Point[][] = [];
  const outClosed: boolean[] = [];
  const outS: number[] = [];

  const ends = contours.map((c, i) => ({
    i,
    closed: closedFlags[i],
    start: c[0],
    end: c[c.length - 1],
    len: calculatePathLength(c),
  }));

  const order = ends.map(e => e.i).sort((a, b) => ends[b].len - ends[a].len);
  const closeEnough = (dist: number, align: number) => {
    if (dist > maxGapPx) return false;
    if (dist <= 3.5) return true;
    return align > 0.15;
  };

  for (const seed of order) {
    if (used[seed]) continue;
    used[seed] = true;
    if (closedFlags[seed] || contours[seed].length < 2) {
      outC.push(contours[seed].slice());
      outClosed.push(closedFlags[seed]);
      outS.push(strengths[seed] ?? 0);
      continue;
    }

    let chain = contours[seed].slice();
    let chainStrength = strengths[seed] ?? 0;
    let guard = 0;
    while (guard++ < n) {
      const headTan = endpointDir(chain, true);
      const tailTan = endpointDir(chain, false);
      let bestJ = -1;
      let bestDist = maxGapPx + 1;
      let bestAlign = -2;
      let mode: 'prepend' | 'prependRev' | 'append' | 'appendRev' | null = null;

      for (let j = 0; j < n; j++) {
        if (used[j] || closedFlags[j] || contours[j].length < 2) continue;
        const other = contours[j];
        const sTan = endpointDir(other, true);
        const eTan = endpointDir(other, false);
        const candidates: { dist: number; align: number; mode: typeof mode }[] = [
          {
            dist: pointDist(chain[chain.length - 1], other[0]),
            align: tailTan.x * sTan.x + tailTan.y * sTan.y,
            mode: 'append',
          },
          {
            dist: pointDist(chain[chain.length - 1], other[other.length - 1]),
            align: tailTan.x * (-eTan.x) + tailTan.y * (-eTan.y),
            mode: 'appendRev',
          },
          {
            dist: pointDist(chain[0], other[other.length - 1]),
            align: (-headTan.x) * eTan.x + (-headTan.y) * eTan.y,
            mode: 'prepend',
          },
          {
            dist: pointDist(chain[0], other[0]),
            align: (-headTan.x) * (-sTan.x) + (-headTan.y) * (-sTan.y),
            mode: 'prependRev',
          },
        ];
        for (const cand of candidates) {
          if (!cand.mode || !closeEnough(cand.dist, cand.align)) continue;
          if (cand.dist < bestDist - 0.4 || (Math.abs(cand.dist - bestDist) <= 0.4 && cand.align > bestAlign)) {
            bestDist = cand.dist;
            bestAlign = cand.align;
            bestJ = j;
            mode = cand.mode;
          }
        }
      }
      if (bestJ < 0 || !mode) break;
      used[bestJ] = true;
      chainStrength = Math.max(chainStrength, strengths[bestJ] ?? 0);
      const other = contours[bestJ];
      if (mode === 'append') chain = chain.concat(other.slice(1));
      else if (mode === 'appendRev') chain = chain.concat(other.slice(0, -1).reverse());
      else if (mode === 'prepend') chain = other.slice(0, -1).concat(chain);
      else chain = other.slice().reverse().slice(0, -1).concat(chain);
    }

    const gap = pointDist(chain[0], chain[chain.length - 1]);
    const closed = gap < maxGapPx || gap < calculatePathLength(chain) * 0.025;
    if (closed && gap > 1e-6) chain = [...chain, chain[0]];
    outC.push(chain);
    outClosed.push(closed);
    outS.push(chainStrength);
  }

  return { contours: outC, closed: outClosed, strengths: outS };
};

/**
 * 去掉厚描边的平行双线：较短那条若几乎整段贴着较长那条，视为同一墨线的内/外沿。
 * 长度差很大的嵌套细节（瞳孔、镜头内圈、纽扣）会保留。
 */
const suppressNearDuplicateContours = (
  contours: Point[][],
  closed: boolean[],
  strengths: number[],
  distPx: number,
): { contours: Point[][]; closed: boolean[]; strengths: number[] } => {
  const n = contours.length;
  if (n <= 1) return { contours, closed, strengths };

  const lens = contours.map(c => calculatePathLength(c));
  const boxes = contours.map(contourBBox);
  const order = lens.map((_, i) => i).sort((a, b) => (lens[b] * (strengths[b] || 1)) - (lens[a] * (strengths[a] || 1)));
  const keep = new Array(n).fill(true);

  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    if (!keep[i]) continue;
    const a = contours[i];
    const boxA = boxes[i];
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj];
      if (!keep[j]) continue;
      const lenRatio = lens[j] / Math.max(lens[i], 1);
      if (lenRatio < 0.45) continue;
      const boxB = boxes[j];
      if (
        boxB.maxX < boxA.minX - distPx || boxB.minX > boxA.maxX + distPx
        || boxB.maxY < boxA.minY - distPx || boxB.minY > boxA.maxY + distPx
      ) continue;

      const b = contours[j];
      const step = Math.max(1, Math.floor(b.length / 22));
      let near = 0;
      let total = 0;
      for (let k = 0; k < b.length; k += step) {
        total++;
        if (minDistPointToPolyline(b[k], a) <= distPx) near++;
      }
      if (total > 0 && near / total >= 0.74) keep[j] = false;
    }
  }

  const outC: Point[][] = [];
  const outClosed: boolean[] = [];
  const outS: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    outC.push(contours[i]);
    outClosed.push(closed[i]);
    outS.push(strengths[i]);
  }
  return { contours: outC, closed: outClosed, strengths: outS };
};

/** 写入三次贝塞尔链；跳过退化短段。返回实际画出的段数。 */
const pushBezierChainExpressions = (
  expressions: any[],
  segs: CubicBez[],
  opts: {
    idPrefix: string;
    index: number;
    idExtra?: string;
    color: string;
    lineWidth: number;
    restrict: (latex: string) => string;
  },
): number => {
  let emitted = 0;
  let segEmit = 0;
  const extra = opts.idExtra ?? '';
  for (const bez of segs) {
    if (pointDist(bez.p0, bez.p3) < 0.012) continue;
    expressions.push({
      id: `${opts.idPrefix}bez_curve_${opts.index}${extra}_${segEmit++}`,
      latex: opts.restrict(buildCubicBezLatex(bez)),
      color: opts.color,
      lineWidth: opts.lineWidth,
      lineOpacity: 1,
      hidden: false,
      parametricDomain: { min: '0', max: '1' },
    });
    emitted++;
  }
  return emitted;
};

/** 贝塞尔高精度：密点折线写入表格（贴边远强于傅里叶截断） */
const pushDensePolylineOutline = (
  expressions: any[],
  points: Point[],
  opts: {
    idPrefix: string;
    index: number;
    color: string;
    lineWidth: number;
    restrict: (latex: string) => string;
    tableOrdinal: { n: number };
  },
): void => {
  if (points.length < 2) return;
  const MAX_POINTS = 980;
  let pts = points;
  if (pts.length > MAX_POINTS) {
    pts = resampleByArcLength(pts, MAX_POINTS);
  }
  const xs = pts.map(p => fmtDesmosNumBezier(p.x));
  const ys = pts.map(p => fmtDesmosNumBezier(p.y));
  const ord = opts.tableOrdinal.n++;
  const xLatex = `x_{b${opts.index}t${ord}}`;
  const yLatex = `y_{b${opts.index}t${ord}}`;
  expressions.push({
    id: `${opts.idPrefix}bez_table_${opts.index}_${ord}`,
    type: 'table',
    columns: [
      // 表格默认会画散点；关掉点/线，只当数据源，真正描边交给下方折线式
      { latex: xLatex, values: xs, points: false, lines: false, hidden: false },
      { latex: yLatex, values: ys, points: false, lines: false, hidden: false },
    ],
  });
  expressions.push({
    id: `${opts.idPrefix}bez_plot_${opts.index}_${ord}`,
    latex: opts.restrict(`\\left(${xLatex},${yLatex}\\right)`),
    color: opts.color,
    lines: true,
    points: false,
    pointOpacity: 0,
    pointSize: 0,
    lineWidth: opts.lineWidth,
    lineOpacity: 1,
    hidden: false,
  });
};

// ─── 颜色填充区域（Smart Drawing — Desmos polygon 多块填色）──────────────────

/** Smart Drawing 轮廓线统一使用标准黑色 */
export const SMART_DRAW_OUTLINE_COLOR = '#000000';

type FillPolygon = {
  color: string;
  /** Desmos 坐标系下的顶点（每个点仅 x,y 两维） */
  points: Point[];
  area: number;
};

const fmtDesmosNum = (n: number): string => {
  if (!Number.isFinite(n)) return '0';
  // 5 位小数：填色/轮廓贴边更准，表格单元格也扛得住
  const rounded = Math.round(n * 100000) / 100000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

const fmtDesmosPoint = (x: number, y: number): string =>
  `\\left(${fmtDesmosNum(x)},${fmtDesmosNum(y)}\\right)`;

/**
 * Desmos polygon 语法：每个顶点必须是 (x,y) 二元坐标，至少 3 个顶点。
 * 例：\operatorname{polygon}\left(\left(-1,1\right),\left(1,1\right),\left(0,-1\right)\right)
 */
const buildPolygonLatex = (points: Point[]): string => {
  const valid = points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (valid.length < 3) return '';
  const pts = valid.map(p => fmtDesmosPoint(p.x, p.y)).join(',');
  return `\\operatorname{polygon}\\left(${pts}\\right)`;
};

const canvasRectToDesmos = (
  left: number,
  right: number,
  top: number,
  bottom: number,
  offsetX: number,
  offsetY: number,
  desmosScale: number,
): { xMin: number; xMax: number; yMin: number; yMax: number } => {
  const xMin = (left - offsetX) * desmosScale;
  const xMax = (right - offsetX) * desmosScale;
  const yTop = -(top - offsetY) * desmosScale;
  const yBottom = -(bottom - offsetY) * desmosScale;
  return {
    xMin: Math.min(xMin, xMax),
    xMax: Math.max(xMin, xMax),
    yMin: Math.min(yTop, yBottom),
    yMax: Math.max(yTop, yBottom),
  };
};

const rectBoundsToPolygonPoints = (
  bounds: { xMin: number; xMax: number; yMin: number; yMax: number },
): Point[] => {
  const { xMin, xMax, yMin, yMax } = bounds;
  if (xMin >= xMax || yMin >= yMax) return [];
  return [
    { x: xMin, y: yMin },
    { x: xMax, y: yMin },
    { x: xMax, y: yMax },
    { x: xMin, y: yMax },
  ];
};

/** 合并矩形 + 行内扫描 → 完整覆盖且 polygon 数量可控 */
type FillRect = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  area: number;
  sampleLeft: number;
  sampleTop: number;
  sampleRight: number;
  sampleBottom: number;
};

/** 取区域 RGB 中位数，比均值更贴近原图真实色（避免边缘混色） */
const medianFromHistogram = (hist: Uint32Array, total: number): number => {
  if (total <= 0) return 0;
  const half = Math.floor(total / 2);
  let count = 0;
  for (let v = 0; v < 256; v++) {
    count += hist[v];
    if (count > half) return v;
  }
  return 0;
};

const sampleAreaMedianRgb = (
  src: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): { r: number; g: number; b: number } => {
  const x0 = Math.max(0, Math.floor(left));
  const x1 = Math.min(imgWidth, Math.ceil(right));
  const y0 = Math.max(0, Math.floor(top));
  const y1 = Math.min(imgHeight, Math.ceil(bottom));
  if (x1 <= x0 || y1 <= y0) return { r: 0, g: 0, b: 0 };

  const histR = new Uint32Array(256);
  const histG = new Uint32Array(256);
  const histB = new Uint32Array(256);
  let count = 0;
  const insetX = Math.min(1, Math.floor((x1 - x0) / 4));
  const insetY = Math.min(1, Math.floor((y1 - y0) / 4));

  const accumulate = (xStart: number, xEnd: number, yStart: number, yEnd: number) => {
    for (let y = yStart; y < yEnd; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const i = (y * imgWidth + x) * 4;
        histR[src[i]]++;
        histG[src[i + 1]]++;
        histB[src[i + 2]]++;
        count++;
      }
    }
  };

  accumulate(x0 + insetX, x1 - insetX, y0 + insetY, y1 - insetY);
  if (count === 0) {
    accumulate(x0, x1, y0, y1);
  }

  return {
    r: medianFromHistogram(histR, count),
    g: medianFromHistogram(histG, count),
    b: medianFromHistogram(histB, count),
  };
};

/** 从原图像素区域取 RGB（中位数，用于 1:1 填色） */
const sampleAreaRgb = (
  src: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): { r: number; g: number; b: number } => sampleAreaMedianRgb(
  src, imgWidth, imgHeight, left, top, right, bottom,
);

const sampleRectColorFromSource = (
  src: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  rect: FillRect,
): string => {
  const { r, g, b } = sampleAreaRgb(
    src, imgWidth, imgHeight, rect.sampleLeft, rect.sampleTop, rect.sampleRight, rect.sampleBottom,
  );
  return rgbToHex(r, g, b);
};

const mergeVerticalRects = (rects: FillRect[]): FillRect[] => {
  if (rects.length <= 1) return rects;

  const sorted = [...rects].sort((a, b) =>
    a.sampleLeft - b.sampleLeft
    || a.sampleTop - b.sampleTop
    || a.sampleRight - b.sampleRight,
  );

  const merged: FillRect[] = [];
  for (const rect of sorted) {
    const prev = merged[merged.length - 1];
    const sameColumn =
      prev
      && Math.abs(prev.sampleLeft - rect.sampleLeft) < 0.5
      && Math.abs(prev.sampleRight - rect.sampleRight) < 0.5
      && Math.abs(prev.sampleBottom - rect.sampleTop) < 0.5
      && Math.abs(prev.yMax - rect.yMin) < 1e-6;

    if (sameColumn) {
      prev.yMax = rect.yMax;
      prev.sampleBottom = rect.sampleBottom;
      prev.area += rect.area;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
};

type FillDetailMode = 'row' | 'merged' | 'cell';

const labelToRowRects = (
  label: number,
  labels: Int32Array,
  gw: number,
  gh: number,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  desmosScale: number,
): FillRect[] => {
  const rects: FillRect[] = [];

  for (let gy = 0; gy < gh; gy++) {
    let gx = 0;
    while (gx < gw) {
      while (gx < gw && labels[gy * gw + gx] !== label) gx++;
      if (gx >= gw) break;
      const startGx = gx;
      while (gx < gw && labels[gy * gw + gx] === label) gx++;

      const left = (startGx * width) / gw;
      const right = (gx * width) / gw;
      const top = (gy * height) / gh;
      const bottom = ((gy + 1) * height) / gh;
      const bounds = canvasRectToDesmos(left, right, top, bottom, offsetX, offsetY, desmosScale);

      rects.push({
        ...bounds,
        sampleLeft: left,
        sampleTop: top,
        sampleRight: right,
        sampleBottom: bottom,
        area: (gx - startGx) * height / gh * width / gw,
      });
    }
  }

  return rects;
};

const rectsToFillPolygons = (
  src: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  rects: FillRect[],
): FillPolygon[] =>
  rects.flatMap(rect => {
    const points = rectBoundsToPolygonPoints(rect);
    if (points.length < 3) return [];
    const color = sampleRectColorFromSource(src, imgWidth, imgHeight, rect);
    return [{ color, points, area: rect.area }];
  });

const labelToCellRects = (
  label: number,
  labels: Int32Array,
  gw: number,
  gh: number,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  desmosScale: number,
): FillRect[] => {
  const rects: FillRect[] = [];
  const cellW = width / gw;
  const cellH = height / gh;

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (labels[gy * gw + gx] !== label) continue;

      const left = gx * cellW;
      const right = (gx + 1) * cellW;
      const top = gy * cellH;
      const bottom = (gy + 1) * cellH;
      const bounds = canvasRectToDesmos(left, right, top, bottom, offsetX, offsetY, desmosScale);

      rects.push({
        ...bounds,
        sampleLeft: left,
        sampleTop: top,
        sampleRight: right,
        sampleBottom: bottom,
        area: cellW * cellH,
      });
    }
  }

  return rects;
};

/**
 * 把连通色块的外轮廓描成一条 polygon（代替成堆小矩形）。
 * 格子更密 → 轮廓点更多 → 精度更高；表达式却只有 1 条（再加一张表）。
 */
const labelToRegionOutlinePolygon = (
  label: number,
  labels: Int32Array,
  gw: number,
  gh: number,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  desmosScale: number,
  src: Uint8ClampedArray,
): FillPolygon | null => {
  const has = (gx: number, gy: number) =>
    gx >= 0 && gy >= 0 && gx < gw && gy < gh && labels[gy * gw + gx] === label;

  type Edge = { a: Point; b: Point };
  const edges: Edge[] = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx <= gw; gx++) {
      if (has(gx - 1, gy) === has(gx, gy)) continue;
      const x = (gx * width) / gw;
      edges.push({
        a: { x, y: (gy * height) / gh },
        b: { x, y: ((gy + 1) * height) / gh },
      });
    }
  }
  for (let gy = 0; gy <= gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (has(gx, gy - 1) === has(gx, gy)) continue;
      const y = (gy * height) / gh;
      edges.push({
        a: { x: (gx * width) / gw, y },
        b: { x: ((gx + 1) * width) / gw, y },
      });
    }
  }
  if (edges.length < 3) return null;

  const key = (p: Point) => `${Math.round(p.x * 64)}:${Math.round(p.y * 64)}`;
  const adj = new Map<string, { to: Point; edgeId: number }[]>();
  edges.forEach((edge, edgeId) => {
    const push = (from: Point, to: Point) => {
      const k = key(from);
      if (!adj.has(k)) adj.set(k, []);
      adj.get(k)!.push({ to, edgeId });
    };
    push(edge.a, edge.b);
    push(edge.b, edge.a);
  });

  const used = new Set<number>();
  let bestLoop: Point[] = [];
  for (let startId = 0; startId < edges.length; startId++) {
    if (used.has(startId)) continue;
    const start = edges[startId];
    const startK = key(start.a);
    const loop: Point[] = [{ ...start.a }];
    used.add(startId);
    let cur = { ...start.b };
    for (let guard = 0; guard <= edges.length; guard++) {
      loop.push({ ...cur });
      const options = (adj.get(key(cur)) || []).filter(e => !used.has(e.edgeId));
      if (options.length === 0) break;
      const close = options.find(e => key(e.to) === startK);
      const next = close ?? options[0];
      used.add(next.edgeId);
      cur = { ...next.to };
      if (close && loop.length >= 4) break;
    }
    if (loop.length >= 4 && loop.length > bestLoop.length) {
      bestLoop = loop;
      if (key(bestLoop[bestLoop.length - 1]) === startK) bestLoop.pop();
    }
  }
  if (bestLoop.length < 3) return null;

  // 边长中点插值：默认一圈；轮廓较短时再插一圈，点数约 ×4，贴边更圆滑
  let densified: Point[] = bestLoop;
  const densifyPasses = bestLoop.length < 80 ? 2 : 1;
  for (let pass = 0; pass < densifyPasses; pass++) {
    const next: Point[] = [];
    for (let i = 0; i < densified.length; i++) {
      const a = densified[i];
      const b = densified[(i + 1) % densified.length];
      next.push(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    densified = next;
  }

  const desmosPts = densified.map(p => ({
    x: (p.x - offsetX) * desmosScale,
    y: -(p.y - offsetY) * desmosScale,
  }));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let sx = 0, sy = 0, n = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (labels[gy * gw + gx] !== label) continue;
      const cx = ((gx + 0.5) * width) / gw;
      const cy = ((gy + 0.5) * height) / gh;
      minX = Math.min(minX, (gx * width) / gw);
      maxX = Math.max(maxX, ((gx + 1) * width) / gw);
      minY = Math.min(minY, (gy * height) / gh);
      maxY = Math.max(maxY, ((gy + 1) * height) / gh);
      sx += cx;
      sy += cy;
      n++;
    }
  }
  if (n === 0) return null;
  const { r, g, b } = sampleAreaMedianRgb(
    src, width, height,
    sx / n - 0.5, sy / n - 0.5, sx / n + 0.5, sy / n + 0.5,
  );

  return {
    color: rgbToHex(r, g, b),
    points: desmosPts,
    area: Math.max(1, (maxX - minX) * (maxY - minY)),
  };
};

const buildRegionFillPolygons = (
  raw: { label: number },
  labels: Int32Array,
  gw: number,
  gh: number,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  desmosScale: number,
  mode: FillDetailMode,
  src: Uint8ClampedArray,
): FillPolygon[] => {
  const common = [raw.label, labels, gw, gh, width, height, offsetX, offsetY, desmosScale] as const;
  if (mode === 'cell') {
    return rectsToFillPolygons(src, width, height, labelToCellRects(...common));
  }
  if (mode === 'merged') {
    // 连通域一条外轮廓：行数少、点数多，边缘跟得上勾线
    const outline = labelToRegionOutlinePolygon(
      raw.label, labels, gw, gh, width, height, offsetX, offsetY, desmosScale, src,
    );
    if (outline && outline.points.length >= 3) return [outline];
  }
  const rowRects = labelToRowRects(...common);
  if (mode === 'row') {
    return rectsToFillPolygons(src, width, height, rowRects);
  }
  return rectsToFillPolygons(src, width, height, mergeVerticalRects(rowRects));
};

const detectBorderBackgroundKey = (
  keys: Uint32Array,
  gw: number,
  gh: number,
): number => {
  const counts = new Map<number, number>();
  const border: number[] = [];
  for (let x = 0; x < gw; x++) {
    border.push(keys[x], keys[(gh - 1) * gw + x]);
  }
  for (let y = 1; y < gh - 1; y++) {
    border.push(keys[y * gw], keys[y * gw + gw - 1]);
  }
  for (const k of border) counts.set(k, (counts.get(k) || 0) + 1);
  let bestKey = keys[0];
  let bestCount = 0;
  counts.forEach((c, k) => { if (c > bestCount) { bestCount = c; bestKey = k; } });
  return bestKey;
};

/**
 * 提取填色 polygon：更密的颜色网格，尽量贴齐勾线精度
 */
const MAX_FILL_POLYGONS = 7200;

/** 单张图片 / GIF 每帧共用的最高分辨率与填色精度 */
export const SINGLE_IMAGE_MAX_DIM = 1280;
export const SINGLE_IMAGE_MAX_FILL_POLYGONS = MAX_FILL_POLYGONS;

const computeOptimalFillGrid = (width: number, height: number, maxCells = MAX_FILL_POLYGONS): number => {
  let lo = 96;
  let hi = Math.min(1024, Math.max(width, height));
  let best = 160;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const scale = Math.min(1, mid / Math.max(width, height));
    const gw = Math.max(1, Math.round(width * scale));
    const gh = Math.max(1, Math.round(height * scale));
    if (gw * gh <= maxCells) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
};

const extractPerCellFillPolygons = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  desmosScale: number,
  maxFillPolygons = MAX_FILL_POLYGONS,
  skipOutlineBlackFills = false,
): FillPolygon[] => {
  const gridMax = computeOptimalFillGrid(width, height, maxFillPolygons);
  const seg = buildColorSegmentation(ctx, width, height, gridMax);
  const { gw, gh, borderBg, cellColors } = seg;
  const cellW = width / gw;
  const cellH = height / gh;
  const polys: FillPolygon[] = [];

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const idx = gy * gw + gx;
      if (borderBg[idx]) continue;

      const rgbBase = idx * 3;
      const r = cellColors[rgbBase];
      const g = cellColors[rgbBase + 1];
      const b = cellColors[rgbBase + 2];
      if (isCanvasBackground(r, g, b)) continue;
      if (skipOutlineBlackFills && isOutlineBlackFillRgb(r, g, b)) continue;

      const left = gx * cellW;
      const top = gy * cellH;
      const right = (gx + 1) * cellW;
      const bottom = (gy + 1) * cellH;

      const bounds = canvasRectToDesmos(left, right, top, bottom, offsetX, offsetY, desmosScale);
      const points = rectBoundsToPolygonPoints(bounds);
      if (points.length < 3) continue;

      polys.push({
        color: rgbToHex(r, g, b),
        points,
        area: cellW * cellH,
      });
    }
  }

  return polys;
};

type ColorSegmentation = {
  gw: number;
  gh: number;
  width: number;
  height: number;
  src: Uint8ClampedArray;
  labels: Int32Array;
  borderBg: Uint8Array;
  rawRegions: { label: number; size: number }[];
  /** 每格 RGB（与 gw×gh 对齐，避免 flood-fill 重复采样） */
  cellColors: Uint8Array;
  rgbAt: (gx: number, gy: number) => { r: number; g: number; b: number };
};

/** 与填色相同：按颜色网格分割图像 */
const buildColorSegmentation = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  gridMax: number,
): ColorSegmentation => {
  const scale = Math.min(1, gridMax / Math.max(width, height));
  const gw = Math.max(1, Math.round(width * scale));
  const gh = Math.max(1, Math.round(height * scale));

  const src = ctx.getImageData(0, 0, width, height).data;
  const keys = new Uint32Array(gw * gh);
  const cellColors = new Uint8Array(gw * gh * 3);

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const left = (gx * width) / gw;
      const right = ((gx + 1) * width) / gw;
      const top = (gy * height) / gh;
      const bottom = ((gy + 1) * height) / gh;
      const { r, g, b } = sampleAreaMedianRgb(src, width, height, left, top, right, bottom);
      const cellIdx = gy * gw + gx;
      const rgbBase = cellIdx * 3;
      cellColors[rgbBase] = r;
      cellColors[rgbBase + 1] = g;
      cellColors[rgbBase + 2] = b;
      keys[cellIdx] = quantizeColorKey(r, g, b);
    }
  }

  const rgbAt = (gx: number, gy: number) => {
    const rgbBase = (gy * gw + gx) * 3;
    return {
      r: cellColors[rgbBase],
      g: cellColors[rgbBase + 1],
      b: cellColors[rgbBase + 2],
    };
  };

  const bgKey = detectBorderBackgroundKey(keys, gw, gh);
  const borderBg = buildBorderBackgroundMask(keys, gw, gh, rgbAt, bgKey);
  const visited = new Uint8Array(gw * gh);
  const labels = new Int32Array(gw * gh);
  let nextLabel = 1;
  const rawRegions: { label: number; size: number }[] = [];

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const idx = gy * gw + gx;
      if (visited[idx] || borderBg[idx]) {
        visited[idx] = 1;
        continue;
      }
      const key = keys[idx];
      const seedColor = rgbAt(gx, gy);
      const label = nextLabel++;
      const stack = [idx];
      visited[idx] = 1;
      labels[idx] = label;
      let size = 0;

      while (stack.length) {
        const cur = stack.pop()!;
        size++;
        const cx = cur % gw;
        const cy = Math.floor(cur / gw);
        const curColor = rgbAt(cx, cy);

        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
          const ni = ny * gw + nx;
          if (visited[ni] || borderBg[ni]) continue;
          const nb = rgbAt(nx, ny);
          if (keys[ni] !== key && !colorsSimilarForFill(seedColor, nb) && !colorsSimilarForFill(curColor, nb)) {
            continue;
          }
          visited[ni] = 1;
          labels[ni] = label;
          stack.push(ni);
        }
      }

      rawRegions.push({ label, size });
    }
  }

  return { gw, gh, width, height, src, labels, borderBg, rawRegions, cellColors, rgbAt };
};

const ptKey = (x: number, y: number) =>
  `${Math.round(x * 64)}:${Math.round(y * 64)}`;

/** 从颜色分区边界追踪闭合轮廓（与填色同一套识别） */
const traceSegmentationBoundaryLoops = (seg: ColorSegmentation): { contours: Point[][]; strengths: number[] } => {
  const { gw, gh, width, height, labels, borderBg } = seg;

  const labelAt = (gx: number, gy: number) => {
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return 0;
    if (borderBg[gy * gw + gx]) return 0;
    return labels[gy * gw + gx];
  };

  type Edge = { a: Point; b: Point };
  const edges: Edge[] = [];

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx <= gw; gx++) {
      const left = labelAt(gx - 1, gy);
      const right = labelAt(gx, gy);
      if (left !== right && (left > 0 || right > 0)) {
        const x = (gx * width) / gw;
        edges.push({
          a: { x, y: (gy * height) / gh },
          b: { x, y: ((gy + 1) * height) / gh },
        });
      }
    }
  }

  for (let gy = 0; gy <= gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const top = labelAt(gx, gy - 1);
      const bottom = labelAt(gx, gy);
      if (top !== bottom && (top > 0 || bottom > 0)) {
        const y = (gy * height) / gh;
        edges.push({
          a: { x: (gx * width) / gw, y },
          b: { x: ((gx + 1) * width) / gw, y },
        });
      }
    }
  }

  type AdjEntry = { to: Point; edgeId: number };
  const adj = new Map<string, AdjEntry[]>();
  const addAdj = (from: Point, to: Point, edgeId: number) => {
    const key = ptKey(from.x, from.y);
    if (!adj.has(key)) adj.set(key, []);
    adj.get(key)!.push({ to, edgeId });
  };

  edges.forEach((edge, edgeId) => {
    addAdj(edge.a, edge.b, edgeId);
    addAdj(edge.b, edge.a, edgeId);
  });

  const used = new Set<number>();
  const contours: Point[][] = [];
  const strengths: number[] = [];

  for (let startId = 0; startId < edges.length; startId++) {
    if (used.has(startId)) continue;

    const startEdge = edges[startId];
    const startKey = ptKey(startEdge.a.x, startEdge.a.y);
    const loop: Point[] = [{ ...startEdge.a }];
    used.add(startId);
    let cur = { ...startEdge.b };

    for (let guard = 0; guard <= edges.length; guard++) {
      loop.push({ ...cur });
      const options = (adj.get(ptKey(cur.x, cur.y)) || []).filter(entry => !used.has(entry.edgeId));
      if (options.length === 0) break;

      const close = options.find(entry => ptKey(entry.to.x, entry.to.y) === startKey);
      const next = close ?? options[0];
      used.add(next.edgeId);
      cur = { ...next.to };

      if (close && loop.length >= 4) break;
    }

    if (loop.length < 4) continue;

    const last = loop[loop.length - 1];
    if (ptKey(last.x, last.y) === startKey) loop.pop();

    const smoothed = smoothPoints(loop);
    if (calculatePathLength(smoothed) < 24) continue;

    contours.push(smoothed);
    strengths.push(Math.min(255, calculatePathLength(smoothed) / 4));
  }

  return { contours, strengths };
};

const extractSegmentationContours = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  gridMax = 280,
): { contours: Point[][]; strengths: number[] } => {
  const seg = buildColorSegmentation(ctx, width, height, gridMax);
  return traceSegmentationBoundaryLoops(seg);
};

type FilledRoundFeature = {
  kind: 'circle' | 'ellipse';
  h: number;
  k: number;
  r: number;
  rx: number;
  ry: number;
  theta: number;
};

const sampleSrcRgb = (
  src: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): { r: number; g: number; b: number } => {
  const xi = Math.max(0, Math.min(width - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(height - 1, Math.round(y)));
  const o = (yi * width + xi) * 4;
  return { r: src[o], g: src[o + 1], b: src[o + 2] };
};

const lumOf = (c: { r: number; g: number; b: number }): number =>
  0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

/** 填色像素的惯性椭圆：不依赖描边是否闭合 */
const fitFilledEllipseMoments = (
  pts: Point[],
): { h: number; k: number; rx: number; ry: number; theta: number } | null => {
  const n = pts.length;
  if (n < 10) return null;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  const h = sx / n;
  const k = sy / n;
  let mu20 = 0;
  let mu02 = 0;
  let mu11 = 0;
  for (const p of pts) {
    const dx = p.x - h;
    const dy = p.y - k;
    mu20 += dx * dx;
    mu02 += dy * dy;
    mu11 += dx * dy;
  }
  mu20 /= n;
  mu02 /= n;
  mu11 /= n;
  const theta = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  let varU = 0;
  let varV = 0;
  for (const p of pts) {
    const dx = p.x - h;
    const dy = p.y - k;
    const u = dx * c + dy * s;
    const v = -dx * s + dy * c;
    varU += u * u;
    varV += v * v;
  }
  varU /= n;
  varV /= n;
  const rx = 2 * Math.sqrt(Math.max(varU, 1e-8));
  const ry = 2 * Math.sqrt(Math.max(varV, 1e-8));
  if (!(rx > 1e-3 && ry > 1e-3)) return null;
  return { h, k, rx, ry, theta };
};

const ellipseRadiusNorm = (
  x: number,
  y: number,
  ell: { h: number; k: number; rx: number; ry: number; theta: number },
): number => {
  const dx = x - ell.h;
  const dy = y - ell.k;
  const c = Math.cos(ell.theta);
  const s = Math.sin(ell.theta);
  const u = (dx * c + dy * s) / Math.max(ell.rx, 1e-6);
  const v = (-dx * s + dy * c) / Math.max(ell.ry, 1e-6);
  return Math.hypot(u, v);
};

/**
 * 无序边界点云上的圆拟合。描边缺口、机身粘连时仍能出圆，
 * 不要求点已连成闭合环。
 */
const detectCircleOnPointCloud = (pts: Point[]): DetectedCircle | null => {
  if (pts.length < 8) return null;
  const box = contourBBox(pts);
  const span = Math.max(box.maxX - box.minX, box.maxY - box.minY, 1);
  const minR = span * 0.28;
  const maxR = span * 0.78;
  const aspect = (box.maxX - box.minX) / Math.max(box.maxY - box.minY, 1e-6);
  if (aspect < 0.36 || aspect > 2.75) return null;

  const consider = (
    circ: { h: number; k: number; r: number; rms: number },
    inliers: boolean[],
    inlierCount: number,
  ): DetectedCircle | null => {
    if (!(circ.r > minR && circ.r < maxR)) return null;
    if (circ.rms / circ.r > 0.16) return null;
    const ratio = inlierCount / pts.length;
    if (ratio < 0.55) return null;
    const inlierPts = pts.filter((_, i) => inliers[i]);
    const coverage = inlierPts.length >= 3
      ? 1 - largestAngularGap(inlierPts, circ.h, circ.k) / (Math.PI * 2)
      : 0;
    if (coverage < 0.55) return null;
    return { ...circ, inliers, inlierRatio: ratio };
  };

  const whole = fitCircleToPoints(pts);
  let best: DetectedCircle | null = null;
  let bestScore = -1;
  if (whole) {
    const tol = Math.max(0.08 * whole.r, span * 0.02);
    const stats = circleInlierStats(pts, whole.h, whole.k, whole.r, tol);
    const hit = consider(
      { ...whole, rms: stats.rms },
      stats.mask,
      stats.count,
    );
    if (hit) {
      best = hit;
      bestScore = hit.inlierRatio + (1 - hit.rms / hit.r);
    }
  }

  const n = pts.length;
  const step = Math.max(1, Math.floor(n / 14));
  for (let i = 0; i < n; i += step) {
    for (let j = i + step * 2; j < n; j += step) {
      for (let k = j + step * 2; k < n; k += step) {
        const c3 = circleFrom3Points(pts[i], pts[j], pts[k]);
        if (!c3 || c3.r < minR || c3.r > maxR) continue;
        const tol = Math.max(0.08 * c3.r, span * 0.02);
        const stats = circleInlierStats(pts, c3.h, c3.k, c3.r, tol);
        if (stats.count < Math.max(8, n * 0.5)) continue;
        const inlierPts = pts.filter((_, idx) => stats.mask[idx]);
        const refined = fitCircleToPoints(inlierPts) ?? { ...c3, rms: stats.rms };
        const hit = consider(refined, stats.mask, stats.count);
        if (!hit) continue;
        const score = hit.inlierRatio + (1 - hit.rms / hit.r);
        if (score > bestScore) {
          bestScore = score;
          best = hit;
        }
      }
    }
  }
  return best;
};

const fillInteriorHoles = (mask: Uint8Array, gw: number, gh: number): Uint8Array => {
  const outside = new Uint8Array(gw * gh);
  const stack: number[] = [];
  const seed = (x: number, y: number) => {
    const i = y * gw + x;
    if (mask[i] || outside[i]) return;
    outside[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < gw; x++) {
    seed(x, 0);
    seed(x, gh - 1);
  }
  for (let y = 1; y < gh - 1; y++) {
    seed(0, y);
    seed(gw - 1, y);
  }
  while (stack.length) {
    const cur = stack.pop()!;
    const x = cur % gw;
    const y = Math.floor(cur / gw);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const ni = ny * gw + nx;
      if (mask[ni] || outside[ni]) continue;
      outside[ni] = 1;
      stack.push(ni);
    }
  }
  const filled = new Uint8Array(mask);
  for (let i = 0; i < filled.length; i++) {
    if (!outside[i]) filled[i] = 1;
  }
  return filled;
};

/** 从色块质心沿 24 条射线走到颜色突变，半径变异小则是圆/椭圆 */
const radialBoundaryPoints = (
  src: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  seed: { r: number; g: number; b: number },
  maxR: number,
): Point[] => {
  const pts: Point[] = [];
  const rays = 24;
  for (let i = 0; i < rays; i++) {
    const ang = (i * Math.PI * 2) / rays;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    let hit = maxR;
    for (let r = 2; r <= maxR; r += 1) {
      const rgb = sampleSrcRgb(src, width, height, cx + dx * r, cy + dy * r);
      const lumJump = Math.abs(lumOf(rgb) - lumOf(seed));
      const dist = colorDistance(rgb, seed);
      // 深灰镜头填色与黑色圈边 lum 接近，不能当成边界；米色机身才会双双跳变
      if (lumJump > 36 && dist > 40) {
        hit = r;
        break;
      }
    }
    if (hit < maxR * 0.96) {
      pts.push({ x: cx + dx * hit, y: cy + dy * hit });
    }
  }
  return pts;
};

const featureFromFilledCells = (
  cells: Point[],
  src: Uint8ClampedArray,
  width: number,
  height: number,
  cellArea = 1,
): FilledRoundFeature | null => {
  if (cells.length < 12) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let sx = 0;
  let sy = 0;
  for (const p of cells) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    sx += p.x;
    sy += p.y;
  }
  const pad = Math.sqrt(Math.max(cellArea, 1)) * 0.5;
  const bw = Math.max(maxX - minX + 2 * pad, pad * 2);
  const bh = Math.max(maxY - minY + 2 * pad, pad * 2);
  const minSide = Math.min(width, height);
  if (bw < Math.max(10, minSide * 0.018) || bh < Math.max(10, minSide * 0.018)) return null;
  if (bw > minSide * 0.36 || bh > minSide * 0.36) return null;
  const aspect = bw / Math.max(bh, 1e-6);
  if (aspect < 0.42 || aspect > 2.15) return null;
  const bboxArea = Math.max(bw * bh, 1);
  const fillArea = cells.length * Math.max(cellArea, 1e-6);
  const extent = fillArea / bboxArea;
  // 圆/椭圆 extent≈0.785；矩形机身≈1。高光挖洞的环会略低。
  if (extent < 0.64 || extent > 0.90) return null;

  const ell = fitFilledEllipseMoments(cells);
  if (!ell) return null;
  let inside = 0;
  for (const p of cells) {
    if (ellipseRadiusNorm(p.x, p.y, ell) <= 1.08) inside++;
  }
  const coverage = inside / cells.length;
  const ellArea = Math.PI * ell.rx * ell.ry;
  const occupancy = ellArea > 1 ? fillArea / ellArea : 0;
  if (coverage < 0.80 || occupancy < 0.72 || occupancy > 1.28) return null;

  const cx = sx / cells.length;
  const cy = sy / cells.length;
  const seed = sampleSrcRgb(src, width, height, cx, cy);
  const maxR = Math.max(bw, bh) * 0.85;
  const radialPts = radialBoundaryPoints(src, width, height, cx, cy, seed, maxR);
  let cv = 1;
  if (radialPts.length >= 14) {
    const radii = radialPts.map(p => Math.hypot(p.x - cx, p.y - cy));
    const meanR = radii.reduce((a, b) => a + b, 0) / radii.length;
    let varR = 0;
    for (const r of radii) varR += (r - meanR) * (r - meanR);
    cv = Math.sqrt(varR / radii.length) / Math.max(meanR, 1e-6);
  }

  const cloud = radialPts.length >= 12 ? detectCircleOnPointCloud(radialPts) : null;
  const axisRatio = Math.max(ell.rx, ell.ry) / Math.max(Math.min(ell.rx, ell.ry), 1e-6);
  // 填色 extent 已拒绝矩形；径向 CV 只用来选圆还是椭圆，高光缺口不再一票否决
  const circularEnough = axisRatio < 1.22 && (cv < 0.22 || radialPts.length < 14);
  const ellipseEnough = axisRatio <= 1.85 && extent <= 0.90 && (cv < 0.34 || radialPts.length < 14);

  if (circularEnough && cloud && cloud.r >= 5) {
    return {
      kind: 'circle',
      h: cloud.h,
      k: cloud.k,
      r: cloud.r,
      rx: cloud.r,
      ry: cloud.r,
      theta: 0,
    };
  }
  if (circularEnough) {
    const r = (ell.rx + ell.ry) / 2;
    return { kind: 'circle', h: ell.h, k: ell.k, r, rx: r, ry: r, theta: 0 };
  }
  if (ellipseEnough) {
    if (axisRatio < 1.16) {
      const r = (ell.rx + ell.ry) / 2;
      return { kind: 'circle', h: ell.h, k: ell.k, r, rx: r, ry: r, theta: 0 };
    }
    return {
      kind: 'ellipse',
      h: ell.h,
      k: ell.k,
      r: (ell.rx + ell.ry) / 2,
      rx: ell.rx,
      ry: ell.ry,
      theta: ell.theta,
    };
  }
  return null;
};

const nmsFilledRounds = (
  feats: FilledRoundFeature[],
  width: number,
  height: number,
): FilledRoundFeature[] => {
  const minSide = Math.min(width, height);
  const margin = minSide * 0.08;
  const scored = feats
    .filter(f => {
      if (f.r < minSide * 0.018 || f.r > minSide * 0.11) return false;
      if (f.h - f.r < margin || f.k - f.r < margin) return false;
      if (f.h + f.r > width - margin || f.k + f.r > height - margin) return false;
      const axis = Math.max(f.rx, f.ry) / Math.max(Math.min(f.rx, f.ry), 1e-6);
      return axis <= 1.85;
    })
    .map(f => {
      const pref = f.r / minSide;
      // 眼睛/镜头大约是画面短边的 3%–9%；大块头发/脸得分更低
      const sizeFit = pref >= 0.025 && pref <= 0.09 ? 2.2 : 1;
      const roundBonus = f.kind === 'circle' ? 1.35 : 1;
      return { f, score: sizeFit * roundBonus / (1 + Math.abs(pref - 0.05)) };
    });
  scored.sort((a, b) => b.score - a.score);
  const kept: FilledRoundFeature[] = [];
  for (const { f } of scored) {
    const dup = kept.some(k => {
      const dist = Math.hypot(k.h - f.h, k.k - f.k);
      const similar = Math.abs(k.r - f.r) / Math.max(k.r, f.r) < 0.34;
      return similar && dist < 0.45 * Math.min(k.r, f.r);
    });
    if (!dup) kept.push(f);
    if (kept.length >= 5) break;
  }
  return kept;
};

const cellsFromMask = (
  mask: Uint8Array,
  gw: number,
  gh: number,
  width: number,
  height: number,
): Point[] => {
  const cells: Point[] = [];
  const sx = width / gw;
  const sy = height / gh;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!mask[gy * gw + gx]) continue;
      cells.push({ x: (gx + 0.5) * sx, y: (gy + 0.5) * sy });
    }
  }
  return cells;
};

const connectedMasks = (
  flags: Uint8Array,
  gw: number,
  gh: number,
  minSize: number,
): Uint8Array[] => {
  const seen = new Uint8Array(gw * gh);
  const out: Uint8Array[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i] || seen[i]) continue;
    const mask = new Uint8Array(gw * gh);
    const stack = [i];
    seen[i] = 1;
    let size = 0;
    while (stack.length) {
      const cur = stack.pop()!;
      mask[cur] = 1;
      size++;
      const x = cur % gw;
      const y = Math.floor(cur / gw);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (!flags[ni] || seen[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    if (size >= minSize) out.push(mask);
  }
  return out;
};

/**
 * 在填色原图上找圆/椭圆：色块惯性椭圆 + 无序点云 RANSAC + 径向采样。
 * 拍立得镜头（米色机身上的深色实心圆）和浅灰椭圆眼睛不依赖 Sobel 闭环。
 */
const detectFilledRoundFeatures = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): FilledRoundFeature[] => {
  const gridMax = Math.min(480, Math.max(width, height));
  const seg = buildColorSegmentation(ctx, width, height, gridMax);
  const { gw, gh, src, labels, borderBg, rgbAt } = seg;
  const minCells = Math.max(12, Math.round((gw * gh) * 0.00035));
  const maxCells = Math.round(gw * gh * 0.08);
  const found: FilledRoundFeature[] = [];
  const cellArea = (width / gw) * (height / gh);
  const sx = width / gw;
  const sy = height / gh;

  const considerCells = (cells: Point[]) => {
    if (cells.length < minCells || cells.length > maxCells) return;
    const feat = featureFromFilledCells(cells, src, width, height, cellArea);
    if (feat) found.push(feat);
  };

  const byLabel = new Map<number, Point[]>();
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      if (borderBg[i]) continue;
      const lab = labels[i];
      if (lab <= 0) continue;
      let arr = byLabel.get(lab);
      if (!arr) {
        arr = [];
        byLabel.set(lab, arr);
      }
      arr.push({ x: (gx + 0.5) * sx, y: (gy + 0.5) * sy });
    }
  }
  for (const cells of byLabel.values()) considerCells(cells);

  // 亮度分层：浅灰眼睛 / 深色镜头在 RGB 量化碎片化时仍能成块
  const lumFlagsDark = new Uint8Array(gw * gh);
  const lumFlagsMid = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      if (borderBg[i]) continue;
      const c = rgbAt(gx, gy);
      if (isCanvasBackground(c.r, c.g, c.b)) continue;
      const lum = lumOf(c);
      const chroma = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      if (lum < 110) lumFlagsDark[i] = 1;
      else if (lum >= 110 && lum <= 210 && chroma < 52) lumFlagsMid[i] = 1;
    }
  }
  const erode4 = (mask: Uint8Array) => {
    const out = new Uint8Array(gw * gh);
    for (let y = 1; y < gh - 1; y++) {
      for (let x = 1; x < gw - 1; x++) {
        const i = y * gw + x;
        if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - gw] && mask[i + gw]) out[i] = 1;
      }
    }
    return out;
  };
  const dilate4 = (mask: Uint8Array) => {
    const out = new Uint8Array(mask);
    for (let y = 1; y < gh - 1; y++) {
      for (let x = 1; x < gw - 1; x++) {
        if (!mask[y * gw + x]) continue;
        out[y * gw + x - 1] = 1;
        out[y * gw + x + 1] = 1;
        out[(y - 1) * gw + x] = 1;
        out[(y + 1) * gw + x] = 1;
      }
    }
    return out;
  };
  // 开运算剥掉细黑线：镜头实心圆留下，机身黑色描边消失（放大后描边更粗，多蚀几次）
  let darkOpened = lumFlagsDark;
  for (let i = 0; i < 3; i++) darkOpened = erode4(darkOpened);
  for (let i = 0; i < 3; i++) darkOpened = dilate4(darkOpened);
  for (const part of connectedMasks(darkOpened, gw, gh, minCells)) {
    considerCells(cellsFromMask(fillInteriorHoles(part, gw, gh), gw, gh, width, height));
  }
  for (const part of connectedMasks(lumFlagsDark, gw, gh, minCells)) {
    considerCells(cellsFromMask(part, gw, gh, width, height));
  }
  for (const part of connectedMasks(lumFlagsMid, gw, gh, minCells)) {
    considerCells(cellsFromMask(part, gw, gh, width, height));
  }

  // 深色实心圆补检（镜头）：只从暗且均匀的格子做径向采样，不扫整图
  if (nmsFilledRounds(found, width, height).length < 3) {
    const minR = Math.min(width, height) * 0.025;
    const maxR = Math.min(width, height) * 0.11;
    const step = 8;
    for (let gy = 2; gy < gh - 2; gy += step) {
      for (let gx = 2; gx < gw - 2; gx += step) {
        const i = gy * gw + gx;
        if (borderBg[i] || !lumFlagsDark[i]) continue;
        const seed = rgbAt(gx, gy);
        let varSum = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            varSum += colorDistance(seed, rgbAt(gx + dx, gy + dy));
          }
        }
        if (varSum / 25 > 16) continue;
        const cx = (gx + 0.5) * sx;
        const cy = (gy + 0.5) * sy;
        const radialPts = radialBoundaryPoints(src, width, height, cx, cy, seed, maxR * 1.4);
        if (radialPts.length < 18) continue;
        const radii = radialPts.map(p => Math.hypot(p.x - cx, p.y - cy));
        const sortedR = [...radii].sort((a, b) => a - b);
        const medR = sortedR[Math.floor(sortedR.length / 2)];
        const outerPts = radialPts.filter((_, idx) => radii[idx] >= medR * 0.72);
        const cloud = detectCircleOnPointCloud(outerPts.length >= 14 ? outerPts : radialPts);
        if (cloud && cloud.r >= minR && cloud.r <= maxR) {
          found.push({
            kind: 'circle',
            h: cloud.h,
            k: cloud.k,
            r: cloud.r,
            rx: cloud.r,
            ry: cloud.r,
            theta: 0,
          });
        }
      }
    }
  }

  return nmsFilledRounds(found, width, height);
};

const contourMatchesRoundFeature = (pts: Point[], feat: FilledRoundFeature): boolean => {
  if (pts.length < 3) return false;
  const ell = {
    h: feat.h,
    k: feat.k,
    rx: Math.max(feat.rx, feat.r),
    ry: Math.max(feat.ry, feat.r),
    theta: feat.theta,
  };
  const tol = 0.22;
  let near = 0;
  let inside = 0;
  for (const p of pts) {
    const rho = ellipseRadiusNorm(p.x, p.y, ell);
    if (Math.abs(rho - 1) <= tol) near++;
    if (rho < 1 + tol) inside++;
  }
  const fracNear = near / pts.length;
  const fracInside = inside / pts.length;
  if (fracNear >= 0.50) return true;
  const c = contourCentroid(pts);
  const box = contourBBox(pts);
  const span = Math.max(box.maxX - box.minX, box.maxY - box.minY);
  const featSpan = Math.max(feat.rx, feat.ry) * 2;
  if (ellipseRadiusNorm(c.x, c.y, ell) < 0.92 && span < featSpan * 1.4) return true;
  if (fracInside > 0.72 && span < featSpan * 1.65) return true;
  return false;
};

/**
 * 从色块边界里捞真正的圆/扁圆（卡通眼睛、拍立得镜头）。
 * Sobel 追踪常把这些环拆开或粘到眼镜框/机身上；填色检测已改为主路径。
 */
const extractCircularRegionLoops = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): Point[][] => {
  const feats = detectFilledRoundFeatures(ctx, width, height);
  return feats.map(f => {
    const pts: Point[] = [];
    for (let i = 0; i < 32; i++) {
      const ang = (i * Math.PI * 2) / 32;
      const c = Math.cos(f.theta);
      const s = Math.sin(f.theta);
      const u = f.rx * Math.cos(ang);
      const v = f.ry * Math.sin(ang);
      pts.push({ x: f.h + u * c - v * s, y: f.k + u * s + v * c });
    }
    return pts;
  });
};

const extractColorFillPolygons = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  desmosScale: number,
  maxFillPolygons = MAX_FILL_POLYGONS,
  skipOutlineBlackFills = false,
  detailMode: FillDetailMode = 'cell',
): FillPolygon[] => {
  if (detailMode === 'cell') {
    return extractPerCellFillPolygons(
      ctx, width, height, offsetX, offsetY, desmosScale, maxFillPolygons, skipOutlineBlackFills,
    );
  }

  // 采样网格远密于最终矩形数：先细切再同色合并，边缘才跟得上勾线
  const gridMax = computeOptimalFillGrid(
    width,
    height,
    Math.min(MAX_FILL_POLYGONS, Math.max(maxFillPolygons * 12, 2800)),
  );
  let polys = extractColorFillPolygonsAtGrid(
    ctx, width, height, offsetX, offsetY, desmosScale, gridMax, detailMode,
  );
  polys = polys.filter(poly => {
    if (skipOutlineBlackFills && isOutlineBlackFillHex(poly.color)) return false;
    return true;
  });
  if (polys.length > maxFillPolygons) {
    polys.sort((a, b) => b.area - a.area);
    polys = polys.slice(0, maxFillPolygons);
  }
  return polys;
};

const extractColorFillPolygonsAtGrid = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  desmosScale: number,
  gridMax: number,
  mode: FillDetailMode = 'row',
): FillPolygon[] => {
  const { gw, gh, src, labels, rawRegions } = buildColorSegmentation(ctx, width, height, gridMax);

  const minSize = 1;
  rawRegions.sort((a, b) => b.size - a.size);

  const polys: FillPolygon[] = [];
  for (const raw of rawRegions) {
    if (raw.size < minSize) continue;
    polys.push(...buildRegionFillPolygons(
      raw, labels, gw, gh, width, height, offsetX, offsetY, desmosScale, mode, src,
    ));
  }

  return polys;
};

/** 帧间隔可能是 0.0335 这类值，必须留够小数位，否则区间会互相错位 */
const formatDesmosTime = (sec: number): string => {
  const rounded = Math.round(sec * 10000) / 10000;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
};

/** 本帧可见条件（不含外层花括号），供「限制」与「门控」两种写法复用 */
const buildFrameConditionLatex = (
  frameSlot: number,
  sliderVar: string,
  smooth: boolean,
  frameCount?: number,
  timeRange?: { start: number; end: number },
  timeBased?: boolean,
  timeEndInclusive?: boolean,
): string => {
  if (timeBased && timeRange) {
    // 区间以本帧刻度为中心（±半帧），滑块刻度落在区间正中，
    // 浮点误差不会把某一格顶到相邻帧上，换帧节奏也就完全均匀。
    const half = Math.max((timeRange.end - timeRange.start) / 2, 0.0005);
    const start = formatDesmosTime(timeRange.start - half);
    const end = formatDesmosTime(timeRange.start + half);
    const upperOp = timeEndInclusive ? '\\le' : '<';
    return `${start}\\le ${sliderVar}${upperOp}${end}`;
  }
  if (!smooth) {
    return `${sliderVar}=${frameSlot}`;
  }
  const total = frameCount ?? frameSlot;
  if (frameSlot < total) {
    return `${frameSlot}\\le ${sliderVar}<${frameSlot + 1}`;
  }
  return `${frameSlot}\\le ${sliderVar}\\le ${frameSlot + 0.999}`;
};

const buildFrameVisibilityRestriction = (
  frameSlot: number,
  sliderVar: string,
  smooth: boolean,
  frameCount?: number,
  timeRange?: { start: number; end: number },
  timeBased?: boolean,
  timeEndInclusive?: boolean,
): string => `\\left\\{${buildFrameConditionLatex(
  frameSlot, sliderVar, smooth, frameCount, timeRange, timeBased, timeEndInclusive,
)}\\right\\}`;

const buildFillPolygonExpressions = (
  polys: FillPolygon[],
  options: Pick<ImageFourierOptions,
    'frameSlot' | 'frameSliderVar' | 'idPrefix' | 'gifFrameCount' | 'gifSmoothSlider'
    | 'gifTimeBasedSlider' | 'gifTimeStart' | 'gifTimeEnd' | 'skipFrameRestriction' | 'gifIsLastFrame'
  > = {},
): any[] => {
  const expressions: any[] = [];
  const prefix = options.idPrefix ?? '';
  const skipRestriction = options.skipFrameRestriction ?? false;
  const restrict = (latex: string) => {
    if (skipRestriction) return latex;
    if (options.frameSlot != null && options.frameSliderVar) {
      return `${latex}${buildFrameVisibilityRestriction(
        options.frameSlot,
        options.frameSliderVar,
        options.gifSmoothSlider ?? false,
        options.gifFrameCount,
        options.gifTimeStart != null && options.gifTimeEnd != null
          ? { start: options.gifTimeStart, end: options.gifTimeEnd }
          : undefined,
        options.gifTimeBasedSlider,
        options.gifIsLastFrame,
      )}`;
    }
    return latex;
  };

  /**
   * 点数够多时用表格存坐标：左侧只占 1 行表 + 1 行 polygon(x,y)，
   * 单元格里可以塞更密的点，比赛时也能展开看数据。
   * 少于 8 个点的小矩形仍内联，避免表格爆炸。
   */
  const TABLE_POINT_THRESHOLD = 8;
  /** 一张表最多挂多少对列，超出再开新表 */
  const MAX_COLS_PER_TABLE = 24;

  let tableOrdinal = 0;
  let colPairInTable = 0;
  let pendingTable: {
    id: string;
    type: 'table';
    columns: { latex: string; values: string[] }[];
  } | null = null;

  const flushTable = () => {
    if (!pendingTable || pendingTable.columns.length === 0) {
      pendingTable = null;
      colPairInTable = 0;
      return;
    }
    expressions.push(pendingTable);
    pendingTable = null;
    colPairInTable = 0;
  };

  polys.forEach((poly, i) => {
    if (poly.points.length < 3) return;

    if (poly.points.length >= TABLE_POINT_THRESHOLD) {
      if (!pendingTable || colPairInTable >= MAX_COLS_PER_TABLE) {
        flushTable();
        pendingTable = {
          id: `${prefix}fill_table_${tableOrdinal++}`,
          type: 'table',
          columns: [],
        };
      }
      const pair = colPairInTable++;
      const slot = options.frameSlot ?? 0;
      const xLatex = options.frameSlot != null
        ? `x_{g${slot}t${tableOrdinal - 1}c${pair}}`
        : `x_{f${tableOrdinal - 1}c${pair}}`;
      const yLatex = options.frameSlot != null
        ? `y_{g${slot}t${tableOrdinal - 1}c${pair}}`
        : `y_{f${tableOrdinal - 1}c${pair}}`;

      pendingTable.columns.push(
        {
          latex: xLatex,
          values: poly.points.map(p => fmtDesmosNum(p.x)),
          points: false,
          lines: false,
        },
        {
          latex: yLatex,
          values: poly.points.map(p => fmtDesmosNum(p.y)),
          points: false,
          lines: false,
        },
      );
      expressions.push({
        id: `${prefix}fill_poly_${i}`,
        latex: restrict(`\\operatorname{polygon}\\left(${xLatex},${yLatex}\\right)`),
        color: poly.color,
        fill: true,
        fillOpacity: 1,
        lineOpacity: 0,
        hidden: false,
      });
      return;
    }

    const latex = buildPolygonLatex(poly.points);
    if (!latex) return;
    expressions.push({
      id: `${prefix}fill_poly_${i}`,
      latex: restrict(latex),
      color: poly.color,
      fill: true,
      fillOpacity: 1,
      lineOpacity: 0,
      hidden: false,
    });
  });

  flushTable();
  return expressions;
};

// ─── 生成 Desmos 表达式 ───────────────────────────────────────────────────────

const createFillContext = (
  width: number,
  height: number,
  fillImageData?: ImageData,
  fallbackCtx?: CanvasRenderingContext2D,
): CanvasRenderingContext2D => {
  if (fillImageData) {
    let ctx: CanvasRenderingContext2D | null = null;
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      ctx = canvas.getContext('2d');
    } else if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null;
    }
    if (!ctx) throw new Error('Fill canvas unavailable');
    ctx.putImageData(fillImageData, 0, 0);
    return ctx;
  }
  if (!fallbackCtx) throw new Error('Fill context unavailable');
  return fallbackCtx;
};

export type ImageFourierOptions = {
  /** 智能绘图模式：仅轮廓 / 仅涂色 / 轮廓+涂色，默认 both */
  mode?: import('./smart-draw-repair').SmartDrawMode;
  /** 轮廓拟合：bezier=三次贝塞尔多段；fourier=傅里叶参数曲线（默认） */
  fitMethod?: import('./smart-draw-repair').OutlineFitMethod;
  /** 仅轮廓：mono=黑色线稿，color=沿边缘采样原色 */
  outlineStyle?: import('./smart-draw-repair').OutlineStyle;
  /** AI/启发式修复后的拟合参数 */
  tuning?: SmartDrawTuningParams;
  /** AI 视觉模型追踪的主轮廓（与边缘检测合并） */
  aiContours?: SmartDrawAIContour[];
  /** 填色专用原图像素（未经对比度/锐化修复，保证颜色 1:1） */
  fillImageData?: ImageData;
  /** 是否启用 AI 视觉分析（默认 true；DeepSeek/Gemini 可走服务端代理） */
  enableAiRepair?: boolean;
  apiKey?: string;
  onRepairProgress?: (phase: SmartDrawRepairPhase) => void;
  /** GIF 多帧：每帧独立变量命名空间（如 3 → F_{301}） */
  varNamespace?: number;
  /** GIF 多帧：当前帧序号（1-based），用于 \\left\\{f=k\\right\\} 限制 */
  frameSlot?: number;
  frameSliderVar?: string;
  /** 表达式 id 前缀（GIF 帧隔离） */
  idPrefix?: string;
  /** GIF 连续滑块：用 k≤f<k+1 区间代替 f=k 整数跳变 */
  gifSmoothSlider?: boolean;
  /** GIF 总帧数（配合 gifSmoothSlider） */
  gifFrameCount?: number;
  /** GIF 时间轴滑块：用 t_start≤t<t_end 限制可见性 */
  gifTimeBasedSlider?: boolean;
  gifTimeStart?: number;
  gifTimeEnd?: number;
  /** 时间轴末帧：上界用 ≤，避免滑块到 duration 时末帧消失 */
  gifIsLastFrame?: boolean;
  /** 填色 polygon 数量上限（GIF 多帧时降低） */
  maxFillPolygons?: number;
  /** cell=逐格（单图）；merged=同色矩形合并（GIF，行数少、观感接近） */
  fillDetailMode?: 'row' | 'merged' | 'cell';
  /** 轮廓压成 3 个列表 + 1 条曲线（少 2 行辅助函数） */
  compactFourier?: boolean;
  /** 播放管理器控制可见性时，不在 latex 上附加时间限制 */
  skipFrameRestriction?: boolean;
  /**
   * GIF：全动画共用的边缘统计（由 measureOutlineCalibration 标定）。
   * 不传就退回逐帧自适应——那样同一个细节会在部分帧被算掉。
   */
  sharedEdgeStrength?: number;
  sharedContourStrength?: number;
};

/**
 * generateFourierExpressions — 核心：从 Canvas 生成 Desmos 傅里叶表达式
 *
 * 这是主处理函数，被 processImageToFourier 和 processEmojiToFourier 都调用。
 *
 * 【输出的 Desmos 表达式结构（每条轮廓 6 个表达式）】
 *   F_{idx} = [k0, k1, k2, ...]  → 频率列表（隐藏）
 *   R_{idx} = [r0, r1, r2, ...]  → 傅里叶系数实部列表（隐藏）
 *   I_{idx} = [i0, i1, i2, ...]  → 傅里叶系数虚部列表（隐藏）
 *   X_{idx}(t) = total(R cos(Ft) - I sin(Ft))  → X 坐标函数（隐藏）
 *   Y_{idx}(t) = total(R sin(Ft) + I cos(Ft))  → Y 坐标函数（隐藏）
 *   (X_{idx}(t), Y_{idx}(t))                   → 参数曲线（可见）
 *
 * @param ctx    - Canvas 绘图上下文
 * @param width  - 图像宽度
 * @param height - 图像高度
 * @returns Desmos 表达式数组 + 说明文字
 */
/** GIF 每帧傅里叶变量步长（须大于单帧最大轮廓数 ~55，避免跨帧 F_n 互相覆盖） */
const GIF_FOURIER_VAR_STRIDE = 64;

const generateFourierExpressions = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: ImageFourierOptions = {},
): { expressions: any[], explanation: string } => {
  const mode = options.mode ?? 'both';
  const tuning = options.tuning;
  const includeOutline = mode !== 'fill';
  const includeFill = mode !== 'outline';
  // Desmos 坐标系略放大，细部更容易看清
  const desmosScale = 30 / Math.max(width, height);
  const offsetX = width / 2;
  const offsetY = height / 2;
  const spacingPlan = outlineSpacingForCanvas(width, height);
  const idPrefix = options.idPrefix ?? (options.frameSlot ? `gif_f${options.frameSlot}_` : '');
  const frameSliderVar = options.frameSliderVar ?? 'f';
  const skipRestriction = options.skipFrameRestriction ?? false;
  const frameVisibilityArgs = () => [
    options.frameSlot!,
    frameSliderVar,
    options.gifSmoothSlider ?? false,
    options.gifFrameCount,
    options.gifTimeStart != null && options.gifTimeEnd != null
      ? { start: options.gifTimeStart, end: options.gifTimeEnd }
      : undefined,
    options.gifTimeBasedSlider,
    options.gifIsLastFrame,
  ] as const;

  const restrictPlot = (latex: string) => (
    skipRestriction || options.frameSlot == null
      ? latex
      : `${latex}${buildFrameVisibilityRestriction(...frameVisibilityArgs())}`
  );

  /** 折线门控：`{条件:1}`，条件不成立时为 undefined，乘上去即整条隐藏 */
  const frameGateLatex = skipRestriction || options.frameSlot == null
    ? null
    : `\\left\\{${buildFrameConditionLatex(...frameVisibilityArgs())}:1\\right\\}`;

  let fillPolys: FillPolygon[] = [];
  let fillExpressions: any[] = [];
  const useColorOutline = includeOutline && !includeFill && (options.outlineStyle ?? 'color') === 'color';
  // 圆/椭圆必须看未经对比度拉伸的原图填色，Sobel 修复画布会把镜头/眼睛糊进机身
  const fillSrcCtx = createFillContext(width, height, options.fillImageData, ctx);
  const filledRounds = includeOutline
    ? detectFilledRoundFeatures(fillSrcCtx, width, height)
    : [];

  if (includeFill) {
    // 黑色勾线时，纯黑格已由轮廓表达，不必再填；彩色勾线时黑发/黑眼必须留下色块
    const skipOutlineBlackFills = includeOutline && !useColorOutline;
    fillPolys = extractColorFillPolygons(
      fillSrcCtx, width, height, offsetX, offsetY, desmosScale, options.maxFillPolygons,
      skipOutlineBlackFills,
      options.fillDetailMode ?? 'cell',
    );
    fillPolys = fillPolys.filter(poly => !skipOutlineBlackFills || !isOutlineBlackFillHex(poly.color));
    fillPolys.sort((a, b) => {
      const avgY = (poly: FillPolygon) =>
        poly.points.reduce((sum, p) => sum + p.y, 0) / poly.points.length;
      return avgY(b) - avgY(a);
    });
    fillExpressions = buildFillPolygonExpressions(fillPolys, {
      frameSlot: options.frameSlot,
      frameSliderVar,
      idPrefix,
      gifSmoothSlider: options.gifSmoothSlider,
      gifFrameCount: options.gifFrameCount,
      gifTimeBasedSlider: options.gifTimeBasedSlider,
      gifTimeStart: options.gifTimeStart,
      gifTimeEnd: options.gifTimeEnd,
      skipFrameRestriction: options.skipFrameRestriction,
      gifIsLastFrame: options.gifIsLastFrame,
    });
  }

  if (!includeOutline) {
    return {
      expressions: fillExpressions,
      explanation: fillPolys.length > 0
        ? `绘画已完成（${fillPolys.length} 个色块，仅涂色）。`
        : '绘画已完成。',
    };
  }

  // 第一步：Sobel 边缘检测提取线稿轮廓
  let { contours: rawContours, strengths } = extractContours(
    ctx, width, height, tuning, options.sharedEdgeStrength,
  );
  let closedHints: (boolean | null)[] = rawContours.map(() => null);

  // 低对比 / 小表情包：Sobel 可能为空，用色块边界兜底
  if (rawContours.length === 0) {
    const fallback = extractSegmentationContours(ctx, width, height);
    rawContours = fallback.contours;
    strengths = fallback.strengths;
    closedHints = rawContours.map(() => true);
  }

  if (options.aiContours && options.aiContours.length > 0 && includeOutline) {
    const merged = mergeAIContoursWithEdge(options.aiContours, rawContours, strengths);
    rawContours = merged.contours;
    strengths = merged.strengths;
    closedHints = merged.closedHints;
  }
  const W = width;
  const H = height;

  // ── 元数据分析 ─────────────────────────────────────────────────────────────
  // 为每条轮廓计算各种统计指标，用于后续过滤噪声
  const meta: ContourMeta[] = rawContours.map((pts, i) => {
    // 计算轮廓的包围盒（最小外接矩形）
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const w = maxX - minX;          // 包围盒宽
    const h = maxY - minY;          // 包围盒高
    const cx = (minX + maxX) / 2;   // 包围盒中心 x
    const cy = (minY + maxY) / 2;   // 包围盒中心 y

    const pathLength = calculatePathLength(pts); // 轮廓总长度

    // 检测轮廓是否闭合：首点和尾点的距离是否足够近
    const start = pts[0];
    const end = pts[pts.length - 1];
    const gap = Math.sqrt((start.x - end.x) ** 2 + (start.y - end.y) ** 2);
    const closedHint = closedHints[i];
    const closeGap = Math.max(12, Math.min(W, H) * 0.02);

    const area = calculatePolygonArea(pts); // 多边形面积（鞋带会把首尾连上）
    const boundsArea = w * h;               // 包围盒面积

    // 圆形度：完美圆形 = 1.0，线条 ≈ 0
    // 公式：C = 4π×A / P²（A=面积，P=周长）
    const circularity = (pathLength > 0) ? (4 * Math.PI * area) / (pathLength * pathLength) : 0;

    // 填充率：形状面积 / 包围盒面积
    // 实心圆 → 0.7-1.0；线条、字母 → 0.1-0.3
    const fillRatio = boundsArea > 0 ? area / boundsArea : 0;

    // 不要让 AI 的 open hint 盖掉几何上的近圆；描边缺口对眼睛/镜头很常见
    let isClosed = closedHint === true
      || gap < closeGap
      || gap < pathLength * 0.08;
    if (!isClosed && circularity > 0.45 && gap < Math.max(closeGap * 2.8, pathLength * 0.25)) {
      isClosed = true;
    }
    if (!isClosed && pts.length >= 8) {
      const circFit = fitCircleToPoints(pts);
      if (circFit) {
        const cov = 1 - largestAngularGap(pts, circFit.h, circFit.k) / (Math.PI * 2);
        if (cov > 0.55 && circFit.rms / circFit.r < 0.16) isClosed = true;
      }
    }

    let points = pts;
    if (isClosed && gap > 1e-6) points = [...pts, { ...pts[0] }];

    return {
      index: i, cx, cy, minX, maxX, minY, maxY,
      w, h, boundsArea, pathLength,
      points,
      averageStrength: strengths[i], // 该轮廓的平均边缘强度
      isClosed,
      radiusCV: 0, // 暂未使用
      fillRatio,
      circularity,
      area,
      aspectRatio: h > 0 ? w / h : 1 // 宽高比
    };
  });

  // ── 噪声过滤 ──────────────────────────────────────────────────────────────
  // activeSet 记录"幸存"的轮廓索引（初始包含所有轮廓）
  // Set 是 JavaScript 中的集合，查找和删除都是 O(1) 复杂度
  const activeSet = new Set(meta.map(m => m.index));

  const fitMethodEarly = options.fitMethod === 'bezier' ? 'bezier' : 'fourier';
  // 贝塞尔高精度：先留碎段以便拼接，拼完再去弱噪声（傅里叶可更狠地去噪）
  const bezierHiFi = fitMethodEarly === 'bezier' && !options.compactFourier;

  // ── 过滤 A：强度过滤 ──────────────────────────────────────────────────────
  const strengthRatio = bezierHiFi
    ? Math.min(tuning?.strengthThresholdRatio ?? 0.28, 0.18)
    : (tuning?.strengthThresholdRatio ?? 0.28);
  const sortedStrength = [...meta].map(m => m.averageStrength).sort((a, b) => b - a);
  // 门槛按「最强轮廓」的比例算。GIF 逐帧各算一次时，主体强弱一变门槛就跟着动，
  // 同一个部位会在一部分帧里被判成噪声——所以全动画共用一个基准。
  const topStrength = options.sharedContourStrength != null && options.sharedContourStrength > 0
    ? options.sharedContourStrength
    : (sortedStrength.length > 0 ? sortedStrength[0] : 10);
  const strengthThreshold = Math.max(bezierHiFi ? 6 : 8, topStrength * strengthRatio);

  meta.forEach(m => {
    if (m.averageStrength < strengthThreshold) {
      activeSet.delete(m.index);
    }
  });

  // ── 过滤 B：几何过滤。短碎段先留着给拼接；真正的圆（眼睛/镜头）不得删。
  const preserveFine = bezierHiFi ? true : (tuning?.preserveFineDetails ?? false);
  const minOpenLengthPreLink = bezierHiFi ? 8 : (preserveFine ? 40 : 60);
  const minClosedLengthPreLink = bezierHiFi ? 14 : (preserveFine ? 20 : 30);
  const minBlobSize = bezierHiFi ? 6 : (preserveFine ? 14 : 20);

  meta.forEach(m => {
    if (!activeSet.has(m.index)) return;

    if (m.w > W * 0.95 || m.h > H * 0.95) {
      activeSet.delete(m.index);
      return;
    }

    // 极弱且极短的开放碎渣；能拼上的短段交给后续 link
    if (!m.isClosed && m.pathLength < minOpenLengthPreLink && m.averageStrength < strengthThreshold * 1.25) {
      activeSet.delete(m.index);
      return;
    }
    if (m.isClosed && m.pathLength < minClosedLengthPreLink && m.averageStrength < strengthThreshold * 1.1) {
      activeSet.delete(m.index);
      return;
    }

    // 实心小色块噪声；高圆形度的小环（瞳孔、镜头、卡通眼）要留
    if (m.w < minBlobSize && m.h < minBlobSize && m.fillRatio > 0.55 && m.circularity < 0.42) {
      activeSet.delete(m.index);
    }
  });

  const survivors = meta.filter(m => activeSet.has(m.index));
  let finalContours = survivors.map(m => m.points);
  let finalClosed = survivors.map(m => m.isClosed);
  let finalStrengths = survivors.map(m => m.averageStrength);

  if (filledRounds.length > 0) {
    const keptC: Point[][] = [];
    const keptClosed: boolean[] = [];
    const keptS: number[] = [];
    for (let i = 0; i < finalContours.length; i++) {
      const pts = finalContours[i];
      if (filledRounds.some(f => contourMatchesRoundFeature(pts, f))) continue;
      keptC.push(pts);
      keptClosed.push(finalClosed[i]);
      keptS.push(finalStrengths[i]);
    }
    finalContours = keptC;
    finalClosed = keptClosed;
    finalStrengths = keptS;
  }

  if (bezierHiFi && finalContours.length > 1) {
    const linkGap = Math.max(18, Math.round(Math.min(W, H) * 0.024));
    const linked = linkOpenContours(finalContours, finalClosed, finalStrengths, linkGap);
    finalContours = linked.contours;
    finalClosed = linked.closed;
    finalStrengths = linked.strengths;

    const minOpenAfter = 26;
    const minClosedAfter = 18;
    const keptC: Point[][] = [];
    const keptClosed: boolean[] = [];
    const keptS: number[] = [];
    for (let i = 0; i < finalContours.length; i++) {
      const len = calculatePathLength(finalContours[i]);
      const closed = finalClosed[i];
      const strong = (finalStrengths[i] ?? 0) >= strengthThreshold * 1.05;
      const keepRound = contourLooksClosedCircle(finalContours[i]);
      if (closed) {
        if (len < minClosedAfter && !strong && !keepRound) continue;
      } else if (len < minOpenAfter && !strong && !keepRound) {
        continue;
      }
      keptC.push(finalContours[i]);
      keptClosed.push(closed || keepRound);
      keptS.push(finalStrengths[i]);
    }
    finalContours = keptC;
    finalClosed = keptClosed;
    finalStrengths = keptS;

    for (let i = 0; i < finalContours.length; i++) {
      const c = finalContours[i];
      if (c.length < 3) continue;
      const gap = pointDist(c[0], c[c.length - 1]);
      if (finalClosed[i]) {
        if (gap > 1e-6) finalContours[i] = [...c, { ...c[0] }];
        continue;
      }
      if (contourLooksClosedCircle(c)) {
        finalClosed[i] = true;
        if (gap > 1e-6) finalContours[i] = [...c, { ...c[0] }];
      }
    }

    const dupDist = Math.max(5, Math.min(12, Math.min(W, H) * 0.01));
    const deduped = suppressNearDuplicateContours(finalContours, finalClosed, finalStrengths, dupDist);
    finalContours = deduped.contours;
    finalClosed = deduped.closed;
    finalStrengths = deduped.strengths;
  }

  if (filledRounds.length > 0) {
    const keptC: Point[][] = [];
    const keptClosed: boolean[] = [];
    const keptS: number[] = [];
    for (let i = 0; i < finalContours.length; i++) {
      if (filledRounds.some(f => contourMatchesRoundFeature(finalContours[i], f))) continue;
      keptC.push(finalContours[i]);
      keptClosed.push(finalClosed[i]);
      keptS.push(finalStrengths[i]);
    }
    finalContours = keptC;
    finalClosed = keptClosed;
    finalStrengths = keptS;
  }

  const contourOrder = finalContours.map((c, i) => ({
    c,
    closed: finalClosed[i],
    strength: finalStrengths[i] ?? 1,
    len: calculatePathLength(c),
  }));
  contourOrder.sort((a, b) => (b.len * b.strength) - (a.len * a.strength));
  finalContours = contourOrder.map(o => o.c);
  finalClosed = contourOrder.map(o => o.closed);
  finalStrengths = contourOrder.map(o => o.strength);

  // GIF 不能按本帧重要性截断：主体动作大的帧多出十几条强轮廓，
  // 手、耳朵这类刚好过线的细节就被挤掉，看起来像无缘无故消失。
  // 播放开销由每帧点数预算封顶，不靠少画几条轮廓。
  if (!options.compactFourier) {
    const maxContours = bezierHiFi
      ? Math.max(tuning?.maxContours ?? 50, 96)
      : (tuning?.maxContours ?? 50);
    finalContours = finalContours.slice(0, maxContours);
    finalClosed = finalClosed.slice(0, maxContours);
    finalStrengths = finalStrengths.slice(0, maxContours);
  }

  const contourExpressions: any[] = [];
  const colorSampleData = useColorOutline
    ? (options.fillImageData?.data ?? ctx.getImageData(0, 0, width, height).data)
    : null;

  const fitMethod = fitMethodEarly;

  /** 贴边误差以像素计；平滑后再拟合，避免跟着像素锯齿切碎 */
  const BEZIER_SEG_BUDGET = options.compactFourier ? 180 : 560;
  const BEZIER_MAX_ERR = Math.max(0.005, desmosScale * (options.compactFourier ? 1.1 : 0.38));
  let bezierSegsUsed = 0;
  const bezierTableOrdinal = { n: 0 };
  const emittedCircles: { h: number; k: number; r: number }[] = [];
  const lineWidthOutline = fillPolys.length > 0 ? 2 : 2.5;

  filledRounds.forEach((feat, fillIdx) => {
    const h = (feat.h - offsetX) * desmosScale;
    const k = -(feat.k - offsetY) * desmosScale;
    const rx = feat.rx * desmosScale;
    const ry = feat.ry * desmosScale;
    const r = feat.r * desmosScale;
    const minClosedR = Math.max(0.18, desmosScale * 8);
    if (r < minClosedR || r > 12) return;
    const dup = emittedCircles.some(e => (
      Math.hypot(e.h - h, e.k - k) < 0.35 * Math.min(e.r, r)
      && Math.abs(e.r - r) / Math.max(e.r, r) < 0.28
    ));
    if (dup) return;
    const peri: Point[] = [];
    for (let i = 0; i < 16; i++) {
      const ang = (i * Math.PI * 2) / 16;
      const c = Math.cos(feat.theta);
      const s = Math.sin(feat.theta);
      const u = feat.rx * Math.cos(ang);
      const v = feat.ry * Math.sin(ang);
      peri.push({ x: feat.h + u * c - v * s, y: feat.k + u * s + v * c });
    }
    const plotColor = colorSampleData
      ? sampleContourColorFromData(colorSampleData, width, height, peri)
      : SMART_DRAW_OUTLINE_COLOR;
    const hs = fmtDesmosNumBezier(h);
    const ks = fmtDesmosNumBezier(k);
    const asEllipse = feat.kind === 'ellipse'
      && (Math.max(rx, ry) / Math.max(Math.min(rx, ry), 1e-6) >= 1.12);
    if (!asEllipse) {
      contourExpressions.push({
        id: `${idPrefix}bez_circle_fill_${fillIdx}`,
        latex: restrictPlot(
          `\\left(x-${hs}\\right)^{2}+\\left(y-${ks}\\right)^{2}=${fmtDesmosNumBezier(r * r)}`,
        ),
        color: plotColor,
        lineWidth: lineWidthOutline,
        lineOpacity: 1,
        hidden: false,
      });
    } else {
      const rx2 = fmtDesmosNumBezier(rx * rx);
      const ry2 = fmtDesmosNumBezier(ry * ry);
      const theta = -feat.theta;
      const ct = Math.cos(theta);
      const st = Math.sin(theta);
      const latex = Math.abs(st) < 0.12
        ? `\\frac{\\left(x-${hs}\\right)^{2}}{${rx2}}+\\frac{\\left(y-${ks}\\right)^{2}}{${ry2}}=1`
        : `\\frac{\\left(\\left(x-${hs}\\right)\\cdot${fmtDesmosNumBezier(ct)}+\\left(y-${ks}\\right)\\cdot${fmtDesmosNumBezier(st)}\\right)^{2}}{${rx2}}+\\frac{\\left(-\\left(x-${hs}\\right)\\cdot${fmtDesmosNumBezier(st)}+\\left(y-${ks}\\right)\\cdot${fmtDesmosNumBezier(ct)}\\right)^{2}}{${ry2}}=1`;
      contourExpressions.push({
        id: `${idPrefix}bez_ellipse_fill_${fillIdx}`,
        latex: restrictPlot(latex),
        color: plotColor,
        lineWidth: lineWidthOutline,
        lineOpacity: 1,
        hidden: false,
      });
    }
    emittedCircles.push({ h, k, r });
  });

  finalContours.forEach((rawPoints, idx) => {
    const isClosed = finalClosed[idx] ?? false;
    let processedPoints = [...rawPoints];

    // ── 开放轮廓处理：防止"回程线"─────────────────────────────────────────
    // 仅傅里叶需要「去而复返」；贝塞尔按真实开/闭路径分段即可
    if (fitMethod === 'fourier' && !isClosed) {
      const reversed = [...processedPoints].reverse().slice(1, -1);
      const tip = processedPoints[processedPoints.length - 1];
      const root = processedPoints[0];
      const pauseTip  = [tip, tip, tip];
      const pauseRoot = [root, root, root];
      processedPoints = [...processedPoints, ...pauseTip, ...reversed, ...pauseRoot];
    }

    // 贝塞尔：间距随画布放大而放宽；傅里叶仍按 targetPointCount
    const targetCount = tuning?.targetPointCount ?? 400;
    const step = fitMethod === 'bezier'
      ? 1
      : Math.max(1, Math.floor(processedPoints.length / targetCount));
    const points = fitMethod === 'bezier'
      ? resampleAdaptiveByCurvature(
        processedPoints,
        spacingPlan.min,
        spacingPlan.max,
        spacingPlan.cap,
      )
      : processedPoints.filter((_, i) => i % step === 0);

    const toDesmos = (p: Point): Point => ({
      x: (p.x - offsetX) * desmosScale,
      y: -(p.y - offsetY) * desmosScale,
    });

    const centeredPoints = points.map(toDesmos);

    const index = idx;
    const plotColor = colorSampleData
      ? sampleContourColorFromData(colorSampleData, width, height, processedPoints)
      : SMART_DRAW_OUTLINE_COLOR;

    const lineWidth = fillPolys.length > 0 ? 2 : 2.5;

    // ── 贝塞尔：每种轮廓只画一种描边（圆 / 直线 / 贝塞尔 / 折线，不叠画）──
    if (fitMethod === 'bezier') {
      const fitSrc = smoothPointsPasses(processedPoints, 1);
      const fitImg = resampleAdaptiveByCurvature(
        fitSrc,
        Math.max(0.65, spacingPlan.min * 0.7),
        Math.max(1.6, spacingPlan.max * 0.9),
        Math.min(900, spacingPlan.cap + 160),
      );
      const fitDesmos = fitImg.map(toDesmos);
      const denseDesmos = options.compactFourier
        ? resampleAdaptiveByCurvature(
          points,
          spacingPlan.min * 1.15,
          spacingPlan.max * 1.1,
          Math.min(spacingPlan.cap, 480),
        ).map(toDesmos)
        : points.map(toDesmos);

      if (options.compactFourier) {
        const xs = denseDesmos.map(p => fmtDesmosNumBezier(p.x));
        const ys = denseDesmos.map(p => fmtDesmosNumBezier(p.y));
        const gate = frameGateLatex ? `\\cdot ${frameGateLatex}` : '';
        contourExpressions.push({
          id: `${idPrefix}dft_plot_${index}`,
          latex: `\\left(\\left[${xs.join(',')}\\right]${gate},\\left[${ys.join(',')}\\right]${gate}\\right)`,
          color: plotColor,
          lines: true,
          points: false,
          lineWidth,
          lineOpacity: 1,
          hidden: false,
          gifOutline: { x: xs, y: ys },
        });
        return;
      }

      const pathLenPx = calculatePathLength(fitImg);

      const emitCircleLatex = (circ: DetectedCircle): boolean => {
        if (circ.r < Math.max(0.18, desmosScale * 8) || circ.r > 12) return false;
        const dup = emittedCircles.some(e => (
          Math.hypot(e.h - circ.h, e.k - circ.k) < 0.35 * Math.min(e.r, circ.r)
          && Math.abs(e.r - circ.r) / Math.max(e.r, circ.r) < 0.28
        ));
        if (dup) return false;
        const h = fmtDesmosNumBezier(circ.h);
        const k = fmtDesmosNumBezier(circ.k);
        const r2 = fmtDesmosNumBezier(circ.r * circ.r);
        contourExpressions.push({
          id: `${idPrefix}bez_circle_${index}`,
          latex: restrictPlot(
            `\\left(x-${h}\\right)^{2}+\\left(y-${k}\\right)^{2}=${r2}`,
          ),
          color: plotColor,
          lineWidth,
          lineOpacity: 1,
          hidden: false,
        });
        emittedCircles.push({ h: circ.h, k: circ.k, r: circ.r });
        return true;
      };

      const emitOpenChain = (desmosPts: Point[], extra: string) => {
        if (desmosPts.length < 2) return;
        if (desmosPts.length >= 4) {
          const line = fitLineToPoints(desmosPts);
          const lineTol = Math.max(0.028, desmosScale * 0.8);
          if (line && line.rms < lineTol && line.length > 0.3) {
            const a = desmosPts[0];
            const b = desmosPts[desmosPts.length - 1];
            const ax = fmtDesmosNumBezier(a.x);
            const ay = fmtDesmosNumBezier(a.y);
            const dx = fmtDesmosNumBezier(b.x - a.x);
            const dy = fmtDesmosNumBezier(b.y - a.y);
            contourExpressions.push({
              id: `${idPrefix}bez_line_${index}${extra}`,
              latex: restrictPlot(`\\left(${ax}+(${dx})t,${ay}+(${dy})t\\right)`),
              color: plotColor,
              lineWidth,
              lineOpacity: 1,
              hidden: false,
              parametricDomain: { min: '0', max: '1' },
            });
            return;
          }
        }
        const remain = Math.max(0, BEZIER_SEG_BUDGET - bezierSegsUsed);
        const cap = Math.min(36, remain, Math.max(4, Math.round(desmosPts.length / 4)));
        if (cap >= 3 && desmosPts.length >= 4) {
          const segs = fitCubicBezierChain(desmosPts, false, cap, { maxErr: BEZIER_MAX_ERR });
          const emitted = pushBezierChainExpressions(contourExpressions, segs, {
            idPrefix,
            index,
            idExtra: extra,
            color: plotColor,
            lineWidth,
            restrict: restrictPlot,
          });
          bezierSegsUsed += segs.length;
          if (emitted > 0) return;
        }
      };

      // 近圆：填色检测已负责眼睛/镜头。Sobel 只在填色没找到时补，避免把头发拟成假圆。
      const minClosedR = Math.max(0.18, desmosScale * 8);
      const maxClosedR = Math.min(12, desmosScale * Math.min(width, height) * 0.11);
      const circleHit = filledRounds.length >= 2 ? null : detectCircleOnContour(fitDesmos);
      if (circleHit && circleHit.r >= minClosedR && circleHit.r <= maxClosedR) {
        emitCircleLatex(circleHit);
        if (circleHit.inlierRatio < 0.68) {
          const runs = outlierRunsFromMask(fitDesmos, circleHit.inliers);
          let rest = 0;
          for (const run of runs) {
            if (calculatePathLength(run) < desmosScale * 10) continue;
            emitOpenChain(run, `_rest${rest++}`);
          }
        }
        return;
      }

      // 整段近直线 → 参数一次式（端点用真实首尾，避免过冲叠线）
      if (!isClosed && fitDesmos.length >= 4) {
        const line = fitLineToPoints(fitDesmos);
        const lineTol = Math.max(0.028, desmosScale * 0.8);
        if (line && line.rms < lineTol && line.length > 0.3) {
          const a = fitDesmos[0];
          const b = fitDesmos[fitDesmos.length - 1];
          const ax = fmtDesmosNumBezier(a.x);
          const ay = fmtDesmosNumBezier(a.y);
          const dx = fmtDesmosNumBezier(b.x - a.x);
          const dy = fmtDesmosNumBezier(b.y - a.y);
          contourExpressions.push({
            id: `${idPrefix}bez_line_${index}`,
            latex: restrictPlot(`\\left(${ax}+(${dx})t,${ay}+(${dy})t\\right)`),
            color: plotColor,
            lineWidth,
            lineOpacity: 1,
            hidden: false,
            parametricDomain: { min: '0', max: '1' },
          });
          return;
        }
      }

      // 矩形/相机机身：真尖角切开后用衔接的一次式；弯段仍走贝塞尔，不叠折线
      const cornerSegs = splitContourAtCorners(fitImg, isClosed, 0.02);
      if (cornerSegs.length >= 2 && cornerSegs.length <= 12) {
        const lineTolPx = Math.max(0.9, spacingPlan.min * 0.5);
        type Planned =
          | { kind: 'line'; a: Point; b: Point }
          | { kind: 'curve'; pts: Point[] };
        const planned: Planned[] = [];
        let lineLen = 0;
        let totalLen = 0;

        for (const seg of cornerSegs) {
          const segLen = calculatePathLength(seg);
          totalLen += segLen;
          const desmosSeg = seg.map(toDesmos);
          if (seg.length < 4) {
            planned.push({ kind: 'curve', pts: desmosSeg });
            continue;
          }
          const line = fitLineToPoints(desmosSeg);
          if (line && line.rms < desmosScale * lineTolPx && line.length > 0.22 && segLen > 8) {
            planned.push({
              kind: 'line',
              a: desmosSeg[0],
              b: desmosSeg[desmosSeg.length - 1],
            });
            lineLen += segLen;
          } else {
            planned.push({ kind: 'curve', pts: desmosSeg });
          }
        }

        if (totalLen > 0 && lineLen / totalLen >= 0.45) {
          let primEmit = 0;
          let drew = 0;
          for (const piece of planned) {
            if (piece.kind === 'line') {
              if (pointDist(piece.a, piece.b) < 0.05) continue;
              const ax = fmtDesmosNumBezier(piece.a.x);
              const ay = fmtDesmosNumBezier(piece.a.y);
              const dx = fmtDesmosNumBezier(piece.b.x - piece.a.x);
              const dy = fmtDesmosNumBezier(piece.b.y - piece.a.y);
              contourExpressions.push({
                id: `${idPrefix}bez_line_${index}_${primEmit++}`,
                latex: restrictPlot(`\\left(${ax}+(${dx})t,${ay}+(${dy})t\\right)`),
                color: plotColor,
                lineWidth,
                lineOpacity: 1,
                hidden: false,
                parametricDomain: { min: '0', max: '1' },
              });
              drew++;
            } else if (piece.pts.length >= 4 && calculatePathLength(piece.pts) >= desmosScale * 10) {
              const remain = Math.max(0, BEZIER_SEG_BUDGET - bezierSegsUsed);
              const cap = Math.min(36, remain, Math.max(4, Math.round(piece.pts.length / 4)));
              if (cap >= 3) {
                const segs = fitCubicBezierChain(piece.pts, false, cap, { maxErr: BEZIER_MAX_ERR });
                const emitted = pushBezierChainExpressions(contourExpressions, segs, {
                  idPrefix,
                  index,
                  idExtra: `_${primEmit++}`,
                  color: plotColor,
                  lineWidth,
                  restrict: restrictPlot,
                });
                bezierSegsUsed += segs.length;
                drew += emitted;
              }
            }
          }
          if (drew > 0) return;
        }
      }

      // 主视觉：一条轮廓一条贝塞尔链（不再叠密点折线）
      const remain = Math.max(0, BEZIER_SEG_BUDGET - bezierSegsUsed);
      const perContourCap = Math.min(
        80,
        remain,
        Math.max(10, Math.round(pathLenPx / 16)),
      );
      if (remain >= 4 && fitDesmos.length >= 4 && perContourCap >= 4) {
        const segs = fitCubicBezierChain(fitDesmos, isClosed, perContourCap, {
          maxErr: BEZIER_MAX_ERR,
        });
        if (segs.length > 0) {
          const emitted = pushBezierChainExpressions(contourExpressions, segs, {
            idPrefix,
            index,
            color: plotColor,
            lineWidth,
            restrict: restrictPlot,
          });
          bezierSegsUsed += segs.length;
          if (emitted > 0) return;
        }
      }

      // 仅当贝塞尔画不出时才折线兜底，绝不与曲线叠在同一轮廓上
      pushDensePolylineOutline(contourExpressions, denseDesmos, {
        idPrefix,
        index,
        color: plotColor,
        lineWidth,
        restrict: restrictPlot,
        tableOrdinal: bezierTableOrdinal,
      });
      return;
    }

    // ── 傅里叶拟合（默认）────────────────────────────────────────────────
    const fourierCap = tuning?.fourierK ?? 100;
    let K = Math.min(fourierCap, Math.floor((points.length - 1) / 2));
    if (K < 5) K = 5;

    const coeffs = computeDFT(centeredPoints, K);

    if (options.compactFourier) {
      const curve = sampleFourierCurvePoints(
        coeffs,
        resolveGifOutlineSampleCount(K, finalContours.length),
      );
      const xs = curve.map(p => fmtDesmosNum(p.x));
      const ys = curve.map(p => fmtDesmosNum(p.y));
      const listX = `\\left[${xs.join(',')}\\right]`;
      const listY = `\\left[${ys.join(',')}\\right]`;
      const gate = frameGateLatex ? `\\cdot ${frameGateLatex}` : '';

      contourExpressions.push({
        id: `${idPrefix}dft_plot_${index}`,
        latex: `\\left(${listX}${gate},${listY}${gate}\\right)`,
        color: plotColor,
        lines: true,
        points: false,
        lineWidth,
        lineOpacity: 1,
        hidden: false,
        gifOutline: { x: xs, y: ys },
      });
      return;
    }

    const L_freq = coeffs.map(c => c.freq);
    const L_real = coeffs.map(c => c.re.toFixed(5));
    const L_imag = coeffs.map(c => c.im.toFixed(5));

    const nameKey = options.varNamespace !== undefined
      ? (options.varNamespace - 1) * GIF_FOURIER_VAR_STRIDE + index
      : index;
    const id_freq = `F_{${nameKey}}`;
    const id_re   = `R_{${nameKey}}`;
    const id_im   = `I_{${nameKey}}`;
    const func_X  = `X_{${nameKey}}`;
    const func_Y  = `Y_{${nameKey}}`;

    contourExpressions.push(
      { id: `${idPrefix}dft_freq_${index}`, latex: `${id_freq} = [${L_freq.join(',')}]`, hidden: true },
      { id: `${idPrefix}dft_real_${index}`, latex: `${id_re} = [${L_real.join(',')}]`, hidden: true },
      { id: `${idPrefix}dft_imag_${index}`, latex: `${id_im} = [${L_imag.join(',')}]`, hidden: true },
      {
        id: `${idPrefix}dft_x_${index}`,
        latex: `${func_X}(t) = \\operatorname{total}(${id_re}\\cos(${id_freq}t) - ${id_im}\\sin(${id_freq}t))`,
        hidden: true,
      },
      {
        id: `${idPrefix}dft_y_${index}`,
        latex: `${func_Y}(t) = \\operatorname{total}(${id_re}\\sin(${id_freq}t) + ${id_im}\\cos(${id_freq}t))`,
        hidden: true,
      },
      {
        id: `${idPrefix}dft_plot_${index}`,
        latex: restrictPlot(`(${func_X}(t), ${func_Y}(t))`),
        color: plotColor,
        lineWidth,
        lineOpacity: 1,
        hidden: false,
        parametricDomain: { min: "0", max: "2\\pi" },
      },
    );
  });

  // both：列表顺序填色→轮廓（层叠线条置顶）；渐进动画先勾线再填色见 applyFourierExpressionsProgressively
  const expressions = includeFill
    ? [...fillExpressions, ...contourExpressions]
    : contourExpressions;

  const aiUsed = (options.aiContours?.length ?? 0) > 0;
  const outlineNote = aiUsed
    ? `（AI 精确轮廓 ${Math.min(options.aiContours!.length, finalContours.length)} 条 + 边缘检测补充）`
    : '';
  const circleCount = contourExpressions.filter(e => String(e.id ?? '').includes('bez_circle_')).length;
  const ellipseCount = contourExpressions.filter(e => String(e.id ?? '').includes('bez_ellipse_')).length;
  const lineCount = contourExpressions.filter(e => String(e.id ?? '').includes('bez_line_')).length;
  const closedFormNote = [
    `${circleCount} 个圆方程`,
    ellipseCount > 0 ? `${ellipseCount} 个椭圆方程` : null,
    `${lineCount} 条直线`,
  ].filter(Boolean).join('，');
  const fitNote = fitMethod === 'bezier'
    ? `，贝塞尔拟合（${closedFormNote}）`
    : `，傅里叶拟合（${closedFormNote}）`;

  return {
    expressions,
    explanation: includeFill && fillPolys.length > 0
      ? `绘画已完成（${fillPolys.length} 个色块 + ${finalContours.length} 条轮廓${fitNote}${outlineNote}）。`
      : includeFill
        ? '绘画已完成。'
        : useColorOutline
          ? `绘画已完成（${finalContours.length} 条彩色轮廓${fitNote}${outlineNote}，仅勾线）。`
          : `绘画已完成（${finalContours.length} 条黑色轮廓${fitNote}${outlineNote}，仅勾线）。`,
  };
};

/** 供 GIF 等多帧管线直接调用 */
export const generateFourierExpressionsFromContext = generateFourierExpressions;

export type OutlineCalibration = {
  /** 平均边缘强度，决定「哪些像素算边缘」 */
  edgeStrength: number;
  /** 最强轮廓的平均强度，决定「哪些轮廓算噪声」 */
  contourStrength: number;
  /** 预处理也必须全动画一致，否则同一部位有的帧被反色/锐化、有的没有 */
  invertColors: boolean;
  contrastBoost: number;
  blurPasses: number;
};

/**
 * 量一帧的边缘统计，供 GIF 标定全动画共用阈值。
 *
 * 这两个值原本每帧各算一次，于是同一个细节的存活与否要看它当帧的「邻居」有多强：
 * 主体动作幅度大的帧阈值被抬高，手、耳朵这类弱边缘就整批掉出去，播起来忽有忽无。
 * 先在若干帧上量出来取中位数，再让每帧都用同一组阈值，细节存活就只取决于它自己。
 */
export function measureOutlineCalibration(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  tuning?: SmartDrawTuningParams,
): OutlineCalibration {
  const { strengths, avgStrength } = extractContours(ctx, width, height, tuning);
  let top = 0;
  for (const s of strengths) if (s > top) top = s;
  return {
    edgeStrength: avgStrength,
    contourStrength: top,
    invertColors: false,
    contrastBoost: 1.35,
    blurPasses: 1,
  };
}

/**
 * 合并多帧标定值，取最低的那一档。
 *
 * 取最低而不是取平均：只要某个细节在任意一帧够格被画出来，就让它在每帧都够格。
 * 取中位数会被动作幅度大的帧拉高，弱细节反而在所有帧都被判成噪声（实测那只手
 * 从「7/24 帧出现」变成「0/24 帧出现」——一致了，但整个细节没了）。
 *
 * 下限压在中位数的一半：个别近乎空白的帧算出来的门槛极低，直接采用会让所有帧
 * 一起冒噪声。
 */
export function mergeOutlineCalibrations(
  samples: OutlineCalibration[],
): OutlineCalibration | null {
  const edges = samples.map(s => s.edgeStrength).filter(v => v > 0).sort((a, b) => a - b);
  const contours = samples.map(s => s.contourStrength).filter(v => v > 0).sort((a, b) => a - b);
  if (edges.length === 0 || contours.length === 0) return null;
  const lowestSane = (list: number[]) => {
    const mid = list[Math.floor(list.length / 2)];
    return Math.max(list[0], mid * 0.5);
  };
  const midOf = (list: number[], fallback: number) => {
    if (list.length === 0) return fallback;
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return {
    edgeStrength: lowestSane(edges),
    contourStrength: lowestSane(contours),
    invertColors: samples.filter(s => s.invertColors).length * 2 >= samples.length,
    contrastBoost: midOf(samples.map(s => s.contrastBoost).filter(v => v > 0), 1.35),
    blurPasses: Math.round(midOf(samples.map(s => s.blurPasses), 1)),
  };
}

/**
 * 匹配本模块生成的帧可见条件：
 *   填色  `\left\{A\le s<B\right\}`
 *   折线  `\left\{A\le s<B:1\right\}`
 * 两种都由 buildFrameConditionLatex 产出，格式完全受控。
 */
const buildFrameConditionRegex = (sliderVar: string): RegExp => new RegExp(
  `\\\\left\\\\\\{\\s*-?[\\d.]+\\s*\\\\le\\s*${sliderVar}\\s*(?:<|\\\\le)\\s*-?[\\d.]+\\s*(:1)?\\\\right\\\\\\}`,
  'g',
);

/**
 * 把某一帧的表达式改挂到另一个时间格上。
 *
 * 用途：某帧识别失败会没有任何表达式，那一格就是空白（看起来像丢帧、像卡顿）。
 * 与其留空，不如把上一帧原样多停一格——观感是定格，而不是闪白。
 */
export function retimeGifFrameExpressions(
  expressions: any[],
  options: {
    fromSlot: number;
    toSlot: number;
    timeStart: number;
    timeEnd: number;
    sliderVar?: string;
    isLastFrame?: boolean;
  },
): any[] {
  const sliderVar = options.sliderVar ?? 's';
  const condition = buildFrameConditionLatex(
    options.toSlot,
    sliderVar,
    false,
    undefined,
    { start: options.timeStart, end: options.timeEnd },
    true,
    options.isLastFrame,
  );
  const condRe = buildFrameConditionRegex(sliderVar);
  const fromPrefix = `gif_f${options.fromSlot}_`;
  const toPrefix = `gif_f${options.toSlot}_`;

  return expressions.map(expr => {
    const next = { ...expr };
    if (typeof next.id === 'string' && next.id.startsWith(fromPrefix)) {
      next.id = `${toPrefix}${next.id.slice(fromPrefix.length)}`;
    }
    if (typeof next.latex === 'string') {
      next.latex = next.latex.replace(
        condRe,
        (_match, gate) => `\\left\\{${condition}${gate ?? ''}\\right\\}`,
      );
    }
    return next;
  });
}

/**
 * 把傅里叶级数在生成阶段就算成点列。
 *
 * 参数曲线 (total(R cos Ft - I sin Ft), total(R sin Ft + I cos Ft)) 每次重绘
 * 都要自适应采样上千个 t，每个 t 还要做 2K 次三角函数；GIF 每动一次滑块
 * 全部帧的曲线都要重算，必然掉帧。折线只是一串定点，重绘几乎零成本。
 */
const sampleFourierCurvePoints = (
  coeffs: { freq: number; re: number; im: number }[],
  sampleCount: number,
): Point[] => {
  const pts: Point[] = [];
  // i 取到 sampleCount（t=2π）与起点重合，闭合轮廓不留缺口
  for (let i = 0; i <= sampleCount; i++) {
    const t = (2 * Math.PI * i) / sampleCount;
    let x = 0;
    let y = 0;
    for (const c of coeffs) {
      const cos = Math.cos(c.freq * t);
      const sin = Math.sin(c.freq * t);
      x += c.re * cos - c.im * sin;
      y += c.re * sin + c.im * cos;
    }
    pts.push({ x, y });
  }
  return pts;
};

/**
 * K 个谐波用约 3K 个采样点即看不出折线感。
 * 上限 200：表情包尺寸下再密也看不出差别，而播放开销与点数成正比
 * （轮廓拉满时，每条 300 点只有 17fps、200 点能到 20fps）。
 */
const resolveOutlineSampleCount = (K: number): number =>
  Math.max(120, Math.min(200, K * 3));

/**
 * GIF 每帧的折线点数预算（≈20fps 的实测水位）。
 *
 * 原来的做法是限制轮廓条数，但那会让轮廓互相抢名额：主体动作大的帧多出十几条
 * 强轮廓，就把手、耳朵这类弱细节挤出榜外，同一个细节于是忽有忽无。
 * 改成限制总点数后，轮廓多的帧只是每条画得疏一点，不会有细节被整条丢掉，
 * 而播放开销（正比于点数）依然是封顶的。
 */
const GIF_OUTLINE_POINT_BUDGET = 12000;

/** 再疏也要 64 个点，否则小轮廓会看出棱角 */
const GIF_OUTLINE_MIN_SAMPLES = 64;

const resolveGifOutlineSampleCount = (K: number, contourCount: number): number => {
  const share = Math.floor(GIF_OUTLINE_POINT_BUDGET / Math.max(1, contourCount));
  const budgeted = Math.max(GIF_OUTLINE_MIN_SAMPLES, Math.min(240, share));
  // 谐波数摆在那，采样再密也变不出细节
  return Math.min(budgeted, Math.max(GIF_OUTLINE_MIN_SAMPLES, K * 3));
};

// ─── 公共导出函数 ─────────────────────────────────────────────────────────────

export function getNextHandDrawStrokeIndex(calculator: any): number {
  if (!calculator || typeof calculator.getExpressions !== 'function') return 0;

  let maxIdx = -1;
  for (const expr of calculator.getExpressions()) {
    const match = expr.id?.match(/^hd_plot_(\d+)$/);
    if (match) maxIdx = Math.max(maxIdx, parseInt(match[1], 10));
  }
  return maxIdx + 1;
}


const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    if (ms <= 0) {
      const timer = setTimeout(resolve, 0);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

const prepareFourierExpression = (expr: any): any => {
  const options = { ...expr };
  const id = String(expr.id || '');
  // 自带的点列元数据只在生成/合并阶段用，Desmos 不认识
  delete options.gifOutline;
  if (options.type === 'table') {
    // 表格列默认散点：统一关掉，只保留后续折线/polygon 描边
    if (Array.isArray(options.columns)) {
      options.columns = options.columns.map((col: any) => ({
        ...col,
        points: false,
        lines: false,
      }));
    }
    return options;
  }
  // 折线轮廓（lines:true）不是参数曲线，不能带 parametricDomain
  const isPolyline = expr?.lines === true;
  if (isPolyline) {
    options.points = false;
    options.pointOpacity = 0;
    if (options.pointSize == null) options.pointSize = 0;
  }
  if (!isPolyline && /(?:^|_)bez_curve_\d+_\d+$/.test(id)) {
    if (!options.parametricDomain) options.parametricDomain = { min: '0', max: '1' };
    options.points = false;
    options.pointOpacity = 0;
  } else if (!isPolyline && (/(?:^|_)dft_plot_\d+$/.test(id) || /(?:^|_)hd_plot_\d+$/.test(id))) {
    options.parametricDomain = { min: '0', max: '2\\pi' };
    options.points = false;
  }
  if (/(?:^|_)fill_poly_\d+$/.test(id)) {
    if (options.fill === undefined) options.fill = true;
    if (options.fillOpacity === undefined) options.fillOpacity = 1;
    if (options.lineOpacity === undefined) options.lineOpacity = 0;
  }
  return options;
};

const isFillExpression = (expr: any): boolean =>
  /(?:^|_)fill_poly_\d+$/.test(String(expr.id || ''));

const isTableExpression = (expr: any): boolean =>
  expr?.type === 'table'
  || /(?:^|_)(?:fill_table|bez_table)_\d+/.test(String(expr?.id || ''));

const isOutlinePlotExpression = (expr: any): boolean =>
  /(?:^|_)dft_plot_\d+$/.test(String(expr?.id || ''))
  || /(?:^|_)bez_plot_\d+_\d+$/.test(String(expr?.id || ''))
  || /(?:^|_)bez_curve_\d+_\d+$/.test(String(expr?.id || ''))
  || /(?:^|_)hd_plot_\d+$/.test(String(expr?.id || ''))
  || /^gif_flat_plot_\d+$/.test(String(expr?.id || ''));

const isBezierHelperExpression = (expr: any): boolean =>
  /(?:^|_)bez_b[xy]$/.test(String(expr?.id || ''));

const toHiddenFillExpr = (expr: any) => ({
  ...prepareFourierExpression(expr),
  hidden: true,
  fillOpacity: 0,
  lineOpacity: 0,
});

const toVisibleFillPatch = (expr: any) => ({
  id: prepareFourierExpression(expr).id,
  hidden: false,
  fillOpacity: 1,
  lineOpacity: 0,
});

const getContourGroupKey = (expr: any): string | null => {
  const id = String(expr.id || '');
  const dft = id.match(/^(.*)dft_(?:plot|freq|real|imag|x|y)_(\d+)$/);
  if (dft) return `${dft[1]}dft_${dft[2]}`;
  const bez = id.match(/^(.*)bez_(?:plot|curve)_(\d+)_\d+$/);
  if (bez) return `${bez[1]}bez_${bez[2]}`;
  const hd = id.match(/^(.*)hd_(?:plot|freq|real|imag|x|y)_(\d+)$/);
  if (hd) return `${hd[1]}hd_${hd[2]}`;
  return null;
};

const groupContourExpressions = (contours: any[]): any[][] => {
  const groups = new Map<string, any[]>();
  const order: string[] = [];

  for (const expr of contours) {
    const key = getContourGroupKey(expr);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(expr);
  }

  return order.map(key => groups.get(key)!);
};

const isSliderExpression = (expr: any): boolean => {
  const id = String(expr?.id || '');
  return id === 'gif_time_slider' || id === 'gif_frame_slider';
};

const isFolderExpression = (expr: any): boolean =>
  expr?.type === 'folder' || /^gif_folder_\d+$/.test(String(expr?.id || ''));

const partitionExpressions = (expressions: any[]) => {
  const meta: any[] = [];
  const fills: any[] = [];
  const contours: any[] = [];
  for (const expr of expressions) {
    if (
      isSliderExpression(expr)
      || isFolderExpression(expr)
      || isTableExpression(expr)
      || isBezierHelperExpression(expr)
    ) {
      meta.push(expr);
    } else if (isFillExpression(expr)) fills.push(expr);
    else contours.push(expr);
  }
  return { meta, fills, contours };
};

/** 让出主线程，保证 Desmos 滑块与用户输入仍可响应 */
export const yieldToInteractive = (): Promise<void> =>
  new Promise(resolve => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });

/** 单帧 rAF 让出（高速注入时使用） */
export const yieldQuick = (): Promise<void> =>
  new Promise(resolve => {
    requestAnimationFrame(resolve);
  });

const yieldFrame = (): Promise<void> => yieldQuick();

export type ProgressiveDrawPhase = 'fill' | 'outline' | 'inject';

export type ProgressiveDrawOptions = {
  clearFirst?: boolean;
  /** 智能绘图模式；both 时强制先勾线再填色动画 */
  mode?: import('./smart-draw-repair').SmartDrawMode;
  /** 每条可见轮廓曲线之间的间隔（毫秒） */
  contourDelayMs?: number;
  /** 每个填色 polygon 之间的间隔（毫秒） */
  fillDelayMs?: number;
  onProgress?: (
    step: number,
    totalSteps: number,
    phase: ProgressiveDrawPhase,
    phaseDone?: number,
    phaseTotal?: number,
  ) => void;
  signal?: AbortSignal;
};

/** 小批量快速注入：进度更新更密、主线程不易卡死 */
const DESMOS_EXPR_BATCH = 20;

const pushExprBatch = (calculator: any, chunk: any[]) => {
  if (!chunk.length) return;
  if (typeof calculator.setExpressions === 'function') {
    calculator.setExpressions(chunk);
    return;
  }
  chunk.forEach(expr => calculator.setExpression(expr));
};

export const getCalculatorExprIdSet = (calculator: any): Set<string> => {
  const ids = new Set<string>();
  for (const item of calculator?.getState?.()?.expressions?.list ?? []) {
    const id = String(item?.id || '');
    if (id) ids.add(id);
  }
  return ids;
};

/** 仅追加 id 尚未存在的表达式，避免 Desmos 同 id 覆盖上一行 */
const pushExprBatchAppend = (
  calculator: any,
  chunk: any[],
  knownIds?: Set<string>,
): number => {
  if (!chunk.length) return 0;
  const existing = knownIds ?? getCalculatorExprIdSet(calculator);
  const novel = chunk.filter(expr => {
    const id = String(expr?.id || '');
    return id && !existing.has(id);
  });
  if (!novel.length) return 0;
  pushExprBatch(calculator, novel);
  for (const expr of novel) {
    existing.add(String(expr.id));
  }
  return novel.length;
};

/** 填色完成后把黑色勾线重新置顶，避免被后写入的色块盖住 */
const bringOutlinePlotsToFront = (calculator: any, contours: any[]) => {
  const plots = contours.filter(isOutlinePlotExpression).map(prepareFourierExpression);
  if (!plots.length) return;
  for (const plot of plots) {
    if (typeof calculator.removeExpression === 'function') {
      calculator.removeExpression({ id: plot.id });
    }
  }
  for (let i = 0; i < plots.length; i += DESMOS_EXPR_BATCH) {
    pushExprBatch(calculator, plots.slice(i, i + DESMOS_EXPR_BATCH));
  }
};

const pushVisibleFillBatch = (calculator: any, batch: any[]) => {
  const patches = batch.map(toVisibleFillPatch);
  if (typeof calculator.setExpressions === 'function') {
    calculator.setExpressions(patches);
    return;
  }
  patches.forEach(expr => calculator.setExpression(expr));
};

const pushVisibleFillBatchAppend = (calculator: any, batch: any[]) => {
  pushExprBatchAppend(calculator, batch.map(toVisibleFillPatch));
};

/** both 模式渐进注入：用户先见勾线、再见填色；填色底层静默预载 */
export async function applyFourierExpressionsProgressively(
  calculator: any,
  expressions: any[],
  options: ProgressiveDrawOptions = {},
): Promise<void> {
  if (!calculator || expressions.length === 0) return;

  const {
    clearFirst = true,
    mode = 'both',
    onProgress,
    signal,
  } = options;

  if (clearFirst) calculator.setBlank();

  const { meta: rawMeta, fills: rawFills, contours: rawContours } = partitionExpressions(expressions);
  const meta = rawMeta.map(prepareFourierExpression);
  const fills = rawFills.map(prepareFourierExpression);
  const contours = rawContours.map(prepareFourierExpression);
  const contourGroups = groupContourExpressions(contours);
  const bothMode = mode === 'both' && fills.length > 0 && contourGroups.length > 0;
  const fillBatchCount = fills.length > 0 ? Math.ceil(fills.length / DESMOS_EXPR_BATCH) : 0;
  const outlineStepCount = contourGroups.length;
  const totalSteps = bothMode
    ? outlineStepCount + fillBatchCount
    : outlineStepCount + fillBatchCount;

  // 表格列必须先于 polygon(x_i,y_i) 存在
  if (meta.length > 0) {
    for (let i = 0; i < meta.length; i += DESMOS_EXPR_BATCH) {
      pushExprBatch(calculator, meta.slice(i, i + DESMOS_EXPR_BATCH));
    }
  }

  let step = 0;
  const bump = (phase: ProgressiveDrawPhase, phaseDone: number, phaseTotal: number) => {
    step += 1;
    onProgress?.(step, totalSteps, phase, phaseDone, phaseTotal);
  };

  const flushRemaining = () => {
    if (bothMode) {
      for (let i = 0; i < fills.length; i += DESMOS_EXPR_BATCH) {
        pushExprBatch(calculator, fills.slice(i, i + DESMOS_EXPR_BATCH).map(toHiddenFillExpr));
      }
      for (let i = 0; i < contourGroups.length; i++) {
        pushExprBatch(calculator, contourGroups[i]);
      }
      for (let i = 0; i < fills.length; i += DESMOS_EXPR_BATCH) {
        pushVisibleFillBatch(calculator, fills.slice(i, i + DESMOS_EXPR_BATCH));
      }
      bringOutlinePlotsToFront(calculator, contours);
      onProgress?.(totalSteps, totalSteps, 'fill', fills.length, fills.length);
      return;
    }
    for (let i = 0; i < contourGroups.length; i++) {
      pushExprBatch(calculator, contourGroups[i]);
    }
    for (let i = 0; i < fills.length; i += DESMOS_EXPR_BATCH) {
      pushExprBatch(calculator, fills.slice(i, i + DESMOS_EXPR_BATCH));
    }
    if (totalSteps > 0) {
      onProgress?.(totalSteps, totalSteps, fills.length > 0 ? 'fill' : 'outline', totalSteps, totalSteps);
    }
  };

  if (bothMode) {
    // 0) 填色静默预载（hidden + fillOpacity:0，不占进度；保证最终线条在色块上方）
    for (let i = 0; i < fills.length; i += DESMOS_EXPR_BATCH) {
      if (signal?.aborted) break;
      pushExprBatch(
        calculator,
        fills.slice(i, i + DESMOS_EXPR_BATCH).map(toHiddenFillExpr),
      );
    }

    // 1) 先勾线 — 用户可见的第一阶段
    if (!signal?.aborted) {
      for (let i = 0; i < contourGroups.length; i++) {
        if (signal?.aborted) break;
        pushExprBatch(calculator, contourGroups[i]);
        bump('outline', i + 1, outlineStepCount);
        if (i % 3 === 2) await yieldQuick();
      }
    }

    // 2) 再填色显现
    if (!signal?.aborted) {
      for (let i = 0; i < fills.length; i += DESMOS_EXPR_BATCH) {
        if (signal?.aborted) break;
        const batch = fills.slice(i, i + DESMOS_EXPR_BATCH);
        pushVisibleFillBatch(calculator, batch);
        bump('fill', Math.min(i + batch.length, fills.length), fills.length);
        if ((i / DESMOS_EXPR_BATCH) % 2 === 1) await yieldQuick();
      }
      bringOutlinePlotsToFront(calculator, contours);
    }
  } else {
    // 仅轮廓或仅填色
    for (let i = 0; i < contourGroups.length; i++) {
      if (signal?.aborted) break;
      pushExprBatch(calculator, contourGroups[i]);
      bump('outline', i + 1, outlineStepCount || totalSteps);
      if (i % 3 === 2) await yieldQuick();
    }
    for (let i = 0; i < fills.length; i += DESMOS_EXPR_BATCH) {
      if (signal?.aborted) break;
      pushExprBatch(calculator, fills.slice(i, i + DESMOS_EXPR_BATCH));
      bump('fill', Math.min(i + DESMOS_EXPR_BATCH, fills.length), fills.length);
      if ((i / DESMOS_EXPR_BATCH) % 2 === 1) await yieldQuick();
    }
  }

  if (signal?.aborted) {
    flushRemaining();
  }
}

/** 立即写入全部表达式（无动画）；填色在前、轮廓在后 */
export function applyFourierExpressionsToCalculator(
  calculator: any,
  expressions: any[],
) {
  if (!calculator) return;
  calculator.setBlank();
  const { meta, fills, contours } = partitionExpressions(expressions);
  const ordered = [
    ...meta.map(prepareFourierExpression),
    ...fills.map(prepareFourierExpression),
    ...contours.map(prepareFourierExpression),
  ];
  for (let i = 0; i < ordered.length; i += DESMOS_EXPR_BATCH) {
    pushExprBatch(calculator, ordered.slice(i, i + DESMOS_EXPR_BATCH));
  }
}

/** GIF 动画：分批写入，填色优先；避免 Desmos / 主线程卡死 */
export async function applyGifExpressionsToCalculator(
  calculator: any,
  expressions: any[],
  options: {
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
    /** 终止时保留已写入部分 */
    commitPartialOnAbort?: boolean;
  } = {},
): Promise<{ committed: number; total: number; partial: boolean }> {
  if (!calculator || expressions.length === 0) {
    return { committed: 0, total: 0, partial: false };
  }

  const GIF_FILL_BATCH = 32;
  const GIF_CONTOUR_BATCH = 16;
  const total = expressions.length;

  calculator.setBlank();
  const { meta, fills, contours } = partitionExpressions(expressions);
  let committed = 0;

  const injectBatch = async (batch: any[]) => {
    if (batch.length === 0) return;
    pushExprBatch(calculator, batch.map(prepareFourierExpression));
    committed += batch.length;
    options.onProgress?.(committed, total);
    await yieldFrame();
  };

  const injectSection = async (items: any[], batchSize: number) => {
    for (let i = 0; i < items.length; i += batchSize) {
      if (options.signal?.aborted) {
        return false;
      }
      await injectBatch(items.slice(i, i + batchSize));
    }
    return true;
  };

  await injectBatch(meta);
  if (options.signal?.aborted) {
    return { committed, total, partial: committed > 0 };
  }

  if (!await injectSection(fills, GIF_FILL_BATCH)) {
    return { committed, total, partial: options.commitPartialOnAbort !== false && committed > 0 };
  }
  if (!await injectSection(contours, GIF_CONTOUR_BATCH)) {
    return { committed, total, partial: options.commitPartialOnAbort !== false && committed > 0 };
  }

  return { committed: total, total, partial: false };
}

const GIF_STREAM_FILL_BATCH = 40;
const GIF_STREAM_FILL_BATCH_FAST = 64;
const GIF_STREAM_CONTOUR_BATCH = 20;
const GIF_STREAM_CONTOUR_BATCH_FAST = 32;

/** 流式注入：写入时间滑块（首次 setBlank） */
export function initGifStreamCalculator(
  calculator: any,
  durationSec: number,
  sliderVar = 's',
  sliderStep = '0.01',
): void {
  if (!calculator) return;
  calculator.setBlank();
  const stepValue = parseFloat(sliderStep);
  const minMax = Number.isFinite(stepValue) && stepValue > 0 ? stepValue : 0.001;
  const max = Math.max(minMax, Math.round(durationSec * 10000) / 10000);
  pushExprBatch(calculator, [prepareFourierExpression({
    id: 'gif_time_slider',
    latex: `${sliderVar}=0`,
    sliderBounds: { min: '0', max: formatDesmosTime(max), step: sliderStep },
    hidden: false,
  })]);
}

export type AppendGifFrameOptions = {
  deferVisibility?: boolean;
  fastInject?: boolean;
  outlineFirst?: boolean;
  appendOnly?: boolean;
  /** 避免每批 getState；调用方维护已写入 id */
  knownIds?: Set<string>;
  folderId?: string;
  folderTitle?: string;
  folderHidden?: boolean;
  /** 比赛需要能展开看公式；默认折叠以免列表一次撑爆 */
  folderCollapsed?: boolean;
};

/** 流式/批量注入单帧：小批次 + 让出主线程，避免列表一次性暴涨卡死 */
export async function appendGifFrameToCalculator(
  calculator: any,
  frameExpressions: any[],
  options?: AppendGifFrameOptions,
): Promise<number> {
  if (!calculator || frameExpressions.length === 0) return 0;

  const deferVisibility = options?.deferVisibility ?? false;
  const fastInject = options?.fastInject ?? false;
  const outlineFirst = options?.outlineFirst ?? false;
  const appendOnly = options?.appendOnly ?? false;
  const knownIds = options?.knownIds;
  const folderId = options?.folderId;
  const folderHidden = options?.folderHidden ?? false;
  const folderCollapsed = options?.folderCollapsed ?? true;
  const pushBatch = appendOnly
    ? (batch: any[]) => pushExprBatchAppend(calculator, batch, knownIds)
    : (batch: any[]) => { pushExprBatch(calculator, batch); return batch.length; };
  const stamp = (expr: any) => {
    const prepared = prepareFourierExpression(expr);
    if (folderId && !isSliderExpression(prepared) && !isFolderExpression(prepared)) {
      prepared.folderId = folderId;
      // 表格、填色、轮廓都要在列表里可见；只有纯辅助行才 hidden
      if (
        !isFillExpression(prepared)
        && !isOutlinePlotExpression(prepared)
        && !isTableExpression(prepared)
      ) {
        prepared.hidden = true;
      }
    }
    return prepared;
  };
  const prepareForStream = (expr: any, hidden = deferVisibility) => {
    const prepared = stamp(expr);
    if (isSliderExpression(prepared) || isFolderExpression(prepared)) return prepared;
    if (!hidden) return prepared;
    return { ...prepared, hidden: true };
  };

  let added = 0;
  let batchTick = 0;
  const yieldAfterBatch = async () => {
    batchTick += 1;
    if (batchTick % 4 === 0) await yieldQuick();
  };

  if (folderId) {
    added += pushBatch([{
      id: folderId,
      type: 'folder',
      title: options?.folderTitle || folderId,
      collapsed: folderCollapsed,
      hidden: folderHidden,
      secret: false,
    }]);
    await yieldAfterBatch();
  }

  const { meta, fills, contours } = partitionExpressions(frameExpressions);
  const fillBatch = fastInject ? GIF_STREAM_FILL_BATCH_FAST : GIF_STREAM_FILL_BATCH;
  const contourBatch = fastInject ? GIF_STREAM_CONTOUR_BATCH_FAST : GIF_STREAM_CONTOUR_BATCH;
  const bothMode = outlineFirst && !deferVisibility && fills.length > 0 && contours.length > 0;
  const contourGroups = bothMode ? groupContourExpressions(contours.map(stamp)) : [];

  // 表格必须先于 polygon(x,y) 写入，否则列名还不存在
  for (let i = 0; i < meta.length; i += 8) {
    const batch = meta.slice(i, i + 8).map(e => stamp(e));
    added += pushBatch(batch);
    await yieldAfterBatch();
  }

  if (bothMode) {
    for (let i = 0; i < fills.length; i += fillBatch) {
      const batch = fills.slice(i, i + fillBatch).map(e => stamp(toHiddenFillExpr(e)));
      added += pushBatch(batch);
      await yieldAfterBatch();
    }
    for (let i = 0; i < contourGroups.length; i += 1) {
      added += pushBatch(contourGroups[i]);
      await yieldAfterBatch();
    }
    for (let i = 0; i < fills.length; i += fillBatch) {
      const batch = fills.slice(i, i + fillBatch).map(e => {
        const next = stamp(e);
        return folderId ? { ...next, hidden: folderHidden } : next;
      });
      if (appendOnly) {
        pushVisibleFillBatchAppend(calculator, batch);
      } else {
        pushVisibleFillBatch(calculator, batch);
      }
      await yieldAfterBatch();
    }
    bringOutlinePlotsToFront(calculator, contours.map(stamp));
    return added;
  }

  for (let i = 0; i < fills.length; i += fillBatch) {
    const batch = fills.slice(i, i + fillBatch).map(e => prepareForStream(e));
    added += pushBatch(batch);
    await yieldAfterBatch();
  }
  for (let i = 0; i < contours.length; i += contourBatch) {
    const batch = contours.slice(i, i + contourBatch).map(e => prepareForStream(e));
    added += pushBatch(batch);
    await yieldAfterBatch();
  }
  return added;
}

/** 流式注入：更新滑块时长上限（可保留当前时间，避免预览/播放被重置到 0） */
export function updateGifStreamDuration(
  calculator: any,
  durationSec: number,
  sliderVar = 's',
  sliderStep = '0.01',
  currentSec?: number,
): void {
  if (!calculator) return;
  // 生成初期只有一两帧时上界可能小于步长，至少留一格，否则滑块范围非法
  const stepValue = parseFloat(sliderStep);
  const minMax = Number.isFinite(stepValue) && stepValue > 0 ? stepValue : 0.001;
  const max = Math.max(minMax, Math.round(durationSec * 10000) / 10000);
  let value = currentSec;
  if (value == null || !Number.isFinite(value)) {
    for (const item of calculator.getState?.()?.expressions?.list ?? []) {
      if (item?.id !== 'gif_time_slider') continue;
      const latex = String(item.latex ?? '');
      const eq = latex.indexOf('=');
      if (eq < 0) break;
      const parsed = parseFloat(latex.slice(eq + 1));
      if (Number.isFinite(parsed)) value = parsed;
      break;
    }
  }
  if (value == null || !Number.isFinite(value)) value = 0;
  value = Math.max(0, Math.min(value, max));
  calculator.setExpression(prepareFourierExpression({
    id: 'gif_time_slider',
    latex: `${sliderVar}=${formatDesmosTime(value)}`,
    sliderBounds: { min: '0', max: formatDesmosTime(max), step: sliderStep },
    hidden: false,
  }));
}

/**
 * processImageToFourier — 处理图片文件，生成 Desmos 傅里叶表达式
 *
 * 【使用流程】
 * 1. 用户上传图片文件
 * 2. FileReader 把文件读成 Data URL（base64 字符串）
 * 3. 创建 Image 对象加载图片
 * 4. 把图片绘制到 Canvas
 * 5. 调用 generateFourierExpressions 生成表达式
 *
 * @param file - 用户选择的图片文件（File 对象）
 * @returns Promise：异步操作，完成后包含 expressions 和 explanation
 */
export const processImageToFourier = (
  file: File,
  options: ImageFourierOptions = {},
): Promise<{
  expressions: any[],
  explanation: string
}> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      const img = new Image();

      img.onload = async () => {
        try {
          const canvas = document.createElement('canvas');
          const sized = resolveSmartDrawCanvasSize(img.width, img.height);
          canvas.width = sized.width;
          canvas.height = sized.height;

          const ctx = canvas.getContext('2d');
          if (!ctx) { reject('No ctx'); return; }

          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          // 小图放大时用高质量插值，减少锯齿影响边缘检测
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          const fillImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const mode = options.mode ?? 'both';
          const { tuning, aiContours } = await prepareSmartDrawImage(
            ctx,
            canvas.width,
            canvas.height,
            dataUrl,
            mode,
            {
              apiKey: options.apiKey,
              enableAiRepair: options.enableAiRepair,
              onProgress: options.onRepairProgress,
            },
          );

          resolve(generateFourierExpressions(ctx, canvas.width, canvas.height, {
            ...options,
            mode,
            tuning,
            aiContours,
            fillImageData,
          }));
        } catch (err) {
          reject(err);
        }
      };

      img.onerror = () => reject(new Error('Image load failed'));
      img.src = dataUrl;
    };

    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsDataURL(file);
  });
};

/**
 * processEmojiToFourier — 处理 Emoji 字符，生成 Desmos 傅里叶表达式
 *
 * 【原理】
 * 把 Emoji 文字渲染到 Canvas 上，然后用同样的管线处理。
 * 相当于把 Emoji 当作一张图片来处理。
 * 浏览器内置的字体渲染会把 Emoji 画成彩色图形，
 * 我们再从中提取轮廓。
 *
 * @param emoji - Emoji 字符（如 "🦋"、"🍎"）
 * @returns Promise：完成后包含 expressions 和 explanation
 */
export const processEmojiToFourier = (
  emoji: string,
  options: ImageFourierOptions = {},
): Promise<{
  expressions: any[],
  explanation: string
}> => {
  return new Promise(async (resolve) => {
    const canvas = document.createElement('canvas');
    const size = 1024;
    canvas.width = size;
    canvas.height = size;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      resolve({ expressions: [], explanation: 'Failed to create canvas' });
      return;
    }

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, size, size);
    ctx.font = `${size * 0.75}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'black';
    ctx.fillText(emoji, size / 2, size / 2 + size * 0.05);

    const dataUrl = canvas.toDataURL('image/png');
    const fillImageData = ctx.getImageData(0, 0, size, size);
    const mode = options.mode ?? 'both';

    try {
      const { tuning, aiContours } = await prepareSmartDrawImage(
        ctx, size, size, dataUrl, mode,
        {
          apiKey: options.apiKey,
          enableAiRepair: options.enableAiRepair,
          onProgress: options.onRepairProgress,
        },
      );
      resolve(generateFourierExpressions(ctx, size, size, {
        ...options, mode, tuning, aiContours, fillImageData,
      }));
    } catch {
      resolve(generateFourierExpressions(ctx, size, size, options));
    }
  });
};

/**
 * processImageToPoints — processImageToFourier 的别名
 *
 * 保留这个名字是为了兼容项目其他地方的旧代码引用。
 * 实际上它们是完全相同的函数。
 */
export const processImageToPoints = processImageToFourier;

// ═══════════════════════════════════════════════════════════════════════════
// HAND-DRAWN PATH  →  FOURIER  (skip image/edge step entirely)
// ═══════════════════════════════════════════════════════════════════════════

export const DRAW_COLOR_PRESETS = [
  SMART_DRAW_OUTLINE_COLOR, '#2563eb', '#dc2626', '#16a34a', '#ea580c', '#9333ea',
  '#0891b2', '#db2777', '#ca8a04', '#4f46e5',
];

export type HandDrawStroke = {
  points: { x: number; y: number }[];
  color: string;
};

const resamplePathByDistance = (points: Point[], minDist: number): Point[] => {
  if (points.length < 2) return points;

  const result: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const last = result[result.length - 1];
    const d = Math.hypot(points[i].x - last.x, points[i].y - last.y);
    if (d >= minDist) result.push(points[i]);
  }

  const tail = points[points.length - 1];
  const last = result[result.length - 1];
  if (Math.hypot(tail.x - last.x, tail.y - last.y) > minDist * 0.2) {
    result.push(tail);
  }

  return result;
};

const resamplePathByArcLength = (points: Point[], targetCount: number): Point[] => {
  if (points.length <= targetCount || targetCount < 2) return points;

  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(
      cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y),
    );
  }

  const total = cumulative[cumulative.length - 1];
  if (total <= 0) return points;

  const result: Point[] = [];
  for (let j = 0; j < targetCount; j++) {
    const target = (total * j) / (targetCount - 1);
    let seg = 0;
    while (seg < cumulative.length - 2 && cumulative[seg + 1] < target) seg++;

    const segStart = cumulative[seg];
    const segEnd = cumulative[seg + 1];
    const t = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
    const a = points[seg];
    const b = points[Math.min(seg + 1, points.length - 1)];
    result.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    });
  }

  return result;
};

const resamplePathUniform = (points: Point[], targetCount: number): Point[] => {
  if (points.length <= targetCount) return points;

  const result: Point[] = [];
  const step = (points.length - 1) / (targetCount - 1);
  for (let i = 0; i < targetCount; i++) {
    result.push(points[Math.round(i * step)]);
  }
  return result;
};

/** Chaikin 角点切割 — 消除手绘微抖，保留整体形状 */
const chaikinSmooth = (points: Point[], closed: boolean, iterations = 1): Point[] => {
  let current = points;
  for (let iter = 0; iter < iterations; iter++) {
    if (current.length < 3) break;

    const next: Point[] = [];
    const segments = closed ? current.length : current.length - 1;

    for (let i = 0; i < segments; i++) {
      const p0 = current[i];
      const p1 = current[(i + 1) % current.length];
      next.push(
        { x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y },
        { x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y },
      );
    }

    if (!closed) {
      next.unshift(current[0]);
      next.push(current[current.length - 1]);
    }

    current = next;
  }
  return current;
};

const smoothPathRepeated = (points: Point[], passes: number): Point[] => {
  let current = points;
  for (let i = 0; i < passes; i++) {
    current = smoothPoints(current);
  }
  return current;
};

const prepareHandDrawPathForDFT = (points: Point[], isClosed: boolean): Point[] => {
  if (isClosed) {
    const reversed = [...points].reverse().slice(1, -1);
    const tip = points[points.length - 1];
    const root = points[0];
    return [...points, tip, tip, ...reversed, root, root];
  }

  // 开放路径：往返闭合，避免 DFT 首尾硬连产生 Gibbs 尖刺
  const reversed = [...points].reverse().slice(1, -1);
  const tip = points[points.length - 1];
  const root = points[0];
  return [...points, tip, tip, tip, ...reversed, root, root, root];
};

const chooseHandDrawCoeffCount = (
  numPoints: number,
  pathLength: number,
  isClosed: boolean,
): number => {
  const maxK = Math.floor((numPoints - 1) / 2);
  const lengthFactor = Math.ceil(pathLength * (isClosed ? 10 : 8));
  const detailCap = isClosed ? 88 : 64;
  return Math.max(10, Math.min(maxK, detailCap, lengthFactor));
};

/** 频域高斯低通 — 抑制高频尖刺（Gibbs 振铃） */
const attenuateFourierCoeffs = (
  coeffs: { freq: number; re: number; im: number }[],
  cutoff: number,
): { freq: number; re: number; im: number }[] => {
  const safeCutoff = Math.max(4, cutoff);
  return coeffs.map(c => {
    const absF = Math.abs(c.freq);
    if (absF === 0) return c;
    const weight = Math.exp(-0.5 * (absF / safeCutoff) ** 2);
    return { ...c, re: c.re * weight, im: c.im * weight };
  });
};

const preprocessHandDrawPath = (
  rawPath: Point[],
): { points: Point[]; pathLength: number; isClosed: boolean } => {
  const pathLength = calculatePathLength(rawPath);
  const minDist = Math.max(0.003, pathLength / 500);

  let pts = resamplePathByDistance(rawPath, minDist);

  const start = pts[0];
  const end = pts[pts.length - 1];
  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  const isClosed = gap < Math.max(0.06, pathLength * 0.05);

  pts = chaikinSmooth(pts, isClosed, isClosed ? 1 : 2);
  pts = smoothPathRepeated(pts, isClosed ? 2 : 3);

  const TARGET = isClosed ? 640 : 520;
  if (pts.length > TARGET) {
    pts = resamplePathByArcLength(pts, TARGET);
  }

  return { points: pts, pathLength, isClosed };
};

export const processDrawnPathToFourier = (
  rawPath: { x: number; y: number }[],
  strokeIndex = 0,
  color = SMART_DRAW_OUTLINE_COLOR,
): { expressions: any[]; explanation: string } => {
  if (rawPath.length < 3) return { expressions: [], explanation: '路径太短，请多画一些。' };

  const pathLength = calculatePathLength(rawPath);
  if (pathLength < 0.04) return { expressions: [], explanation: '路径太短，请多画一些。' };

  const { points: pts, pathLength: smoothLength, isClosed } = preprocessHandDrawPath(rawPath as Point[]);
  if (pts.length < 4) return { expressions: [], explanation: '路径太短，请多画一些。' };

  const processedPts = prepareHandDrawPathForDFT(pts, isClosed);
  const K = chooseHandDrawCoeffCount(processedPts.length, smoothLength, isClosed);
  let coeffs = computeDFT(processedPts, K);
  coeffs = attenuateFourierCoeffs(coeffs, K * 0.5);

  const L_freq = coeffs.map(c => c.freq);
  const L_real = coeffs.map(c => c.re.toFixed(5));
  const L_imag = coeffs.map(c => c.im.toFixed(5));

  const s = strokeIndex;
  const expressions: any[] = [
    { id: `hd_freq_${s}`, latex: `F_{hd${s}}=[${L_freq.join(',')}]`, hidden: true },
    { id: `hd_real_${s}`, latex: `R_{hd${s}}=[${L_real.join(',')}]`, hidden: true },
    { id: `hd_imag_${s}`, latex: `I_{hd${s}}=[${L_imag.join(',')}]`, hidden: true },
    {
      id: `hd_x_${s}`,
      latex: `X_{hd${s}}(t)=\\operatorname{total}(R_{hd${s}}\\cos(F_{hd${s}}t)-I_{hd${s}}\\sin(F_{hd${s}}t))`,
      hidden: true,
    },
    {
      id: `hd_y_${s}`,
      latex: `Y_{hd${s}}(t)=\\operatorname{total}(R_{hd${s}}\\sin(F_{hd${s}}t)+I_{hd${s}}\\cos(F_{hd${s}}t))`,
      hidden: true,
    },
    {
      id: `hd_plot_${s}`,
      latex: `(X_{hd${s}}(t),Y_{hd${s}}(t))`,
      color,
      lineWidth: 2.5,
      hidden: false,
      parametricDomain: { min: '0', max: '2\\pi' },
    },
  ];

  return { expressions, explanation: '手绘已转换为傅里叶参数方程。' };
};
