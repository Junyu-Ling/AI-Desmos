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

  // ── 步骤 3：计算梯度图（Sobel 边缘检测简化版）────────────────────────────
  // 梯度 = 像素亮度变化的速率
  // 边缘处亮度变化剧烈 → 梯度大 → 边缘
  // 平坦区域亮度变化平缓 → 梯度小 → 非边缘
  const gradientMap = new Uint8Array(width * height);
  let totalGrad = 0;     // 所有有效梯度值的总和（用于计算平均值）
  let nonZeroCount = 0;  // 有效梯度点的数量

  // 小图（表情包）边距过大时可用区域几乎为零，按短边自适应
  const IGNORE_MARGIN = Math.max(2, Math.min(16, Math.floor(Math.min(width, height) * 0.06)));

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x; // 当前像素索引

      // 忽略图像边缘区域
      if (x < IGNORE_MARGIN || x > width - 1 - IGNORE_MARGIN ||
          y < IGNORE_MARGIN || y > height - 1 - IGNORE_MARGIN) {
        gradientMap[idx] = 0;
        continue;
      }

      // 简化的 Sobel 梯度计算：
      // gx = 右侧像素 - 左侧像素（水平方向的亮度差）
      // gy = 下方像素 - 上方像素（垂直方向的亮度差）
      const gx = (blurred[idx + 1] - blurred[idx - 1]);
      const gy = (blurred[idx + width] - blurred[idx - width]);

      // 梯度大小 = 两个方向梯度的向量长度（勾股定理）
      const mag = Math.sqrt(gx * gx + gy * gy);

      gradientMap[idx] = Math.min(255, mag); // 限制在 0-255 范围内

      // 统计强边缘像素（梯度 > 10 才算有效）
      if (mag > 10) {
        totalGrad += mag;
        nonZeroCount++;
      }
    }
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
  const traceContour = (startX: number, startY: number): { points: Point[], avgStrength: number } => {
    const points: Point[] = [];    // 收集轮廓上的点
    let currentX = startX;
    let currentY = startY;
    let totalStrength = 0;         // 累计路径强度（用于计算平均值）

    points.push({ x: currentX, y: currentY }); // 把起点加入轮廓
    visited[currentY * width + currentX] = 1;   // 标记起点为已访问

    // 8 方向偏移量（上、右上、右、右下、下、左下、左、左上）
    const dx = [0, 1, 1, 1, 0, -1, -1, -1];
    const dy = [-1, -1, 0, 1, 1, 1, 0, -1];

    let steps = 0;
    const maxPoints = 5000; // 每条轮廓最多 5000 个点（防止无限循环）

    while (steps < maxPoints) {
      let bestNextX = -1, bestNextY = -1, bestNextVal = -1;

      // 追踪过程中的动态阈值（比启动阈值低，允许追踪稍弱的边缘）
      const localThresh = getThresholdAt(currentX, currentY) * 0.4;

      // 检查 8 个方向的邻居，选择最强的有效邻居
      for (let i = 0; i < 8; i++) {
        const nx = currentX + dx[i]; // 邻居的 x 坐标
        const ny = currentY + dy[i]; // 邻居的 y 坐标

        // 检查是否在图像范围内
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const idx = ny * width + nx;

          if (visited[idx] === 0) { // 只考虑未访问的点
            const val = gradientMap[idx];

            // 梯度超过阈值，且比当前找到的最强邻居还强
            if (val > localThresh && val > bestNextVal) {
              bestNextVal = val;
              bestNextX = nx;
              bestNextY = ny;
            }
          }
        }
      }

      if (bestNextX !== -1) {
        // 找到了下一个点，继续追踪
        currentX = bestNextX;
        currentY = bestNextY;
        points.push({ x: currentX, y: currentY });
        visited[currentY * width + currentX] = 1; // 标记为已访问
        totalStrength += bestNextVal;
      } else {
        // 四面都没有合适的邻居（死路），停止追踪
        break;
      }
      steps++;
    }

    return {
      points,
      avgStrength: totalStrength / (points.length || 1) // 平均强度（避免除以0）
    };
  };

  // ── 步骤 6：扫描所有像素，从高梯度点启动轮廓追踪 ─────────────────────────
  const SCAN_STEP = 2; // 扫描步长（每隔 2 像素检查一次，平衡细节与速度）

  for (let y = IGNORE_MARGIN; y < height - IGNORE_MARGIN; y += SCAN_STEP) {
    for (let x = IGNORE_MARGIN; x < width - IGNORE_MARGIN; x += SCAN_STEP) {
      const idx = y * width + x;

      if (visited[idx]) continue; // 已经被追踪过的点，跳过

      // 高启动阈值：只从确定是边缘的强点出发
      const startThresh = getThresholdAt(x, y);
      if (gradientMap[idx] > startThresh) {
        const result = traceContour(x, y);

        // 只保留足够长的轮廓（太短的是噪声）
        if (result.points.length > 15) {
          contours.push(smoothPoints(result.points)); // 平滑后加入结果
          strengths.push(result.avgStrength);         // 记录强度
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
  // 小图尽量放大，边缘更清晰，后续可用更密采样贴边
  const TARGET_DIM = 1100;
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
  const boost = Math.min(1.85, Math.max(1, maxSide / 640));
  return {
    min: 0.95 * boost,
    max: 2.35 * boost,
    cap: Math.min(980, Math.max(280, Math.round(900 / Math.sqrt(boost)))),
  };
};

/** 最小二乘圆（Kåsa）；rms/r 过大则视为非圆 */
const fitCircleToPoints = (
  pts: Point[],
): { h: number; k: number; r: number; rms: number } | null => {
  if (pts.length < 10) return null;
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

/** 在尖角处切开轮廓，便于分段拟合成直线 */
const splitContourAtCorners = (
  pts: Point[],
  isClosed: boolean,
  cosThresh = 0.25,
): Point[][] => {
  if (pts.length < 6) return [pts.slice()];
  const n = pts.length;
  const corners: number[] = [];
  const start = isClosed ? 0 : 1;
  const end = isClosed ? n : n - 1;
  for (let i = start; i < end; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const ax = cur.x - prev.x;
    const ay = cur.y - prev.y;
    const bx = next.x - cur.x;
    const by = next.y - cur.y;
    const la = Math.hypot(ax, ay) || 1;
    const lb = Math.hypot(bx, by) || 1;
    const cos = (ax * bx + ay * by) / (la * lb);
    if (cos < cosThresh) corners.push(i);
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
    const spacing = maxS - (maxS - minS) * Math.min(1, turn / 1.15);
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
    if (cos < 0.15) anchors.push(i); // 仅很尖的角（≈>81°）才强制断点，避免碎成虚线
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
 * 拼接后贝塞尔/密点折线才能连成完整轮廓，精度才会压过傅里叶。
 */
const linkOpenContours = (
  contours: Point[][],
  closedFlags: boolean[],
  maxGapPx: number,
): { contours: Point[][]; closed: boolean[] } => {
  const n = contours.length;
  if (n <= 1) return { contours: contours.map(c => c.slice()), closed: closedFlags.slice() };

  const used = new Array(n).fill(false);
  const outC: Point[][] = [];
  const outClosed: boolean[] = [];

  const ends = contours.map((c, i) => ({
    i,
    closed: closedFlags[i],
    start: c[0],
    end: c[c.length - 1],
    len: calculatePathLength(c),
  }));

  // 长轮廓优先作为种子
  const order = ends.map(e => e.i).sort((a, b) => ends[b].len - ends[a].len);

  for (const seed of order) {
    if (used[seed]) continue;
    used[seed] = true;
    if (closedFlags[seed] || contours[seed].length < 2) {
      outC.push(contours[seed].slice());
      outClosed.push(closedFlags[seed]);
      continue;
    }

    let chain = contours[seed].slice();
    let guard = 0;
    while (guard++ < n) {
      const head = chain[0];
      const tail = chain[chain.length - 1];
      let bestJ = -1;
      let bestDist = maxGapPx;
      let mode: 'prepend' | 'prependRev' | 'append' | 'appendRev' | null = null;

      for (let j = 0; j < n; j++) {
        if (used[j] || closedFlags[j] || contours[j].length < 2) continue;
        const s = contours[j][0];
        const e = contours[j][contours[j].length - 1];
        const dTailS = pointDist(tail, s);
        const dTailE = pointDist(tail, e);
        const dHeadS = pointDist(head, s);
        const dHeadE = pointDist(head, e);
        if (dTailS < bestDist) { bestDist = dTailS; bestJ = j; mode = 'append'; }
        if (dTailE < bestDist) { bestDist = dTailE; bestJ = j; mode = 'appendRev'; }
        if (dHeadE < bestDist) { bestDist = dHeadE; bestJ = j; mode = 'prepend'; }
        if (dHeadS < bestDist) { bestDist = dHeadS; bestJ = j; mode = 'prependRev'; }
      }
      if (bestJ < 0 || !mode) break;
      used[bestJ] = true;
      const other = contours[bestJ];
      if (mode === 'append') chain = chain.concat(other.slice(1));
      else if (mode === 'appendRev') chain = chain.concat(other.slice(0, -1).reverse());
      else if (mode === 'prepend') chain = other.slice(0, -1).concat(chain);
      else chain = other.slice().reverse().slice(0, -1).concat(chain);
    }

    const gap = pointDist(chain[0], chain[chain.length - 1]);
    const closed = gap < maxGapPx || gap < calculatePathLength(chain) * 0.02;
    if (closed && gap > 1e-6) chain = [...chain, chain[0]];
    outC.push(chain);
    outClosed.push(closed);
  }

  return { contours: outC, closed: outClosed };
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

  if (includeFill) {
    const fillCtx = createFillContext(width, height, options.fillImageData, ctx);
    // 黑色勾线时，纯黑格已由轮廓表达，不必再填；彩色勾线时黑发/黑眼必须留下色块
    const skipOutlineBlackFills = includeOutline && !useColorOutline;
    fillPolys = extractColorFillPolygons(
      fillCtx, width, height, offsetX, offsetY, desmosScale, options.maxFillPolygons,
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
    const isClosed = closedHint != null
      ? closedHint
      : (gap < 8 || gap < pathLength * 0.03);

    const area = calculatePolygonArea(pts); // 多边形面积
    const boundsArea = w * h;               // 包围盒面积

    // 圆形度：完美圆形 = 1.0，线条 ≈ 0
    // 公式：C = 4π×A / P²（A=面积，P=周长）
    const circularity = (pathLength > 0) ? (4 * Math.PI * area) / (pathLength * pathLength) : 0;

    // 填充率：形状面积 / 包围盒面积
    // 实心圆 → 0.7-1.0；线条、字母 → 0.1-0.3
    const fillRatio = boundsArea > 0 ? area / boundsArea : 0;

    return {
      index: i, cx, cy, minX, maxX, minY, maxY,
      w, h, boundsArea, pathLength,
      points: pts,
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
  // 贝塞尔高精度模式：大幅放宽过滤，尽量留住线稿细节（傅里叶可更狠地去噪）
  const bezierHiFi = fitMethodEarly === 'bezier' && !options.compactFourier;

  // ── 过滤 A：强度过滤 ──────────────────────────────────────────────────────
  const strengthRatio = bezierHiFi
    ? Math.min(tuning?.strengthThresholdRatio ?? 0.28, 0.14)
    : (tuning?.strengthThresholdRatio ?? 0.28);
  const sortedStrength = [...meta].map(m => m.averageStrength).sort((a, b) => b - a);
  // 门槛按「最强轮廓」的比例算。GIF 逐帧各算一次时，主体强弱一变门槛就跟着动，
  // 同一个部位会在一部分帧里被判成噪声——所以全动画共用一个基准。
  const topStrength = options.sharedContourStrength != null && options.sharedContourStrength > 0
    ? options.sharedContourStrength
    : (sortedStrength.length > 0 ? sortedStrength[0] : 10);
  const strengthThreshold = Math.max(bezierHiFi ? 4 : 8, topStrength * strengthRatio);

  meta.forEach(m => {
    if (m.averageStrength < strengthThreshold) {
      activeSet.delete(m.index); // 从幸存集合中移除
    }
  });

  // ── 过滤 B：几何过滤（消除各种噪声类型）─────────────────────────────────
  const preserveFine = bezierHiFi ? true : (tuning?.preserveFineDetails ?? false);
  const minOpenLength = bezierHiFi ? 12 : (preserveFine ? 40 : 60);
  const minClosedLength = bezierHiFi ? 10 : (preserveFine ? 20 : 30);
  const minBlobSize = bezierHiFi ? 8 : (preserveFine ? 14 : 20);

  meta.forEach(m => {
    if (!activeSet.has(m.index)) return;

    if (m.pathLength < minOpenLength && !m.isClosed) {
      activeSet.delete(m.index);
      return;
    }
    if (m.pathLength < minClosedLength) {
      activeSet.delete(m.index);
      return;
    }

    if (m.w < minBlobSize && m.h < minBlobSize && m.fillRatio > 0.4) {
      activeSet.delete(m.index);
      return;
    }

    // B3：光环/气泡过滤：小面积但高圆形度的噪声环（如相机传感器噪声）
    // 圆形度 > 0.75（接近圆形）且包围盒面积 < 3000 → 是噪声圆，删除
    if (m.circularity > 0.75 && m.boundsArea < 3000) {
      activeSet.delete(m.index);
      return;
    }

    // B4：边框过滤：覆盖几乎整张图的轮廓是 canvas 边框，删除
    if (m.w > W * 0.95 || m.h > H * 0.95) {
      activeSet.delete(m.index);
      return;
    }
  });

  // 从原始轮廓中筛选出幸存的轮廓
  let finalContours = rawContours.filter((_, i) => activeSet.has(i));
  let finalClosed = finalContours.map(c => meta[rawContours.indexOf(c)]?.isClosed ?? false);

  // 贝塞尔：先把碎开放轮廓拼成完整线，再拟合（关键提升线稿完整度）
  if (bezierHiFi && finalContours.length > 1) {
    const linked = linkOpenContours(finalContours, finalClosed, 14);
    finalContours = linked.contours;
    finalClosed = linked.closed;
  }

  // ── 按优先级排序（路径长度 × 强度的乘积越大越重要）─────────────────────
  const contourOrder = finalContours.map((c, i) => ({
    c,
    closed: finalClosed[i],
    len: calculatePathLength(c),
    strength: meta[rawContours.indexOf(c)]?.averageStrength ?? 1,
  }));
  contourOrder.sort((a, b) => (b.len * b.strength) - (a.len * a.strength));
  finalContours = contourOrder.map(o => o.c);
  finalClosed = contourOrder.map(o => o.closed);

  // GIF 不能按本帧重要性截断：主体动作大的帧多出十几条强轮廓，
  // 手、耳朵这类刚好过线的细节就被挤掉，看起来像无缘无故消失。
  // 播放开销由每帧点数预算封顶，不靠少画几条轮廓。
  if (!options.compactFourier) {
    const maxContours = bezierHiFi
      ? Math.max(tuning?.maxContours ?? 50, 140)
      : (tuning?.maxContours ?? 50);
    finalContours = finalContours.slice(0, maxContours);
    finalClosed = finalClosed.slice(0, maxContours);
  }

  const contourExpressions: any[] = [];
  const colorSampleData = useColorOutline
    ? (options.fillImageData?.data ?? ctx.getImageData(0, 0, width, height).data)
    : null;

  const fitMethod = fitMethodEarly;

  /** 高精度：弯段以三次贝塞尔为主，预算与误差收紧 */
  const BEZIER_SEG_BUDGET = options.compactFourier ? 180 : 640;
  const BEZIER_MAX_ERR = Math.max(0.006, desmosScale * (options.compactFourier ? 1.1 : 0.45));
  let bezierSegsUsed = 0;
  const bezierTableOrdinal = { n: 0 };

  finalContours.forEach((rawPoints, idx) => {
    const m = meta[rawContours.indexOf(rawPoints)];
    const isClosed = finalClosed[idx] ?? m?.isClosed ?? false;
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

    // ── 贝塞尔高精度：圆/直线解析式 → 三次贝塞尔主描边 → 折线兜底 ───────
    if (fitMethod === 'bezier') {
      const pathLenPx = calculatePathLength(points);
      // 拟合用更密点（比显示折线略密），圆/弯贴边更准
      const fitImg = resampleAdaptiveByCurvature(
        processedPoints,
        Math.max(0.7, spacingPlan.min * 0.72),
        Math.max(1.4, spacingPlan.max * 0.78),
        Math.min(1200, spacingPlan.cap + 220),
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

      // 闭合近圆 → (x-h)²+(y-k)²=r²（镜头、眼睛等）
      if (isClosed && fitDesmos.length >= 10) {
        const circ = fitCircleToPoints(fitDesmos);
        const rel = circ ? circ.rms / circ.r : 1;
        const circMeta = m?.circularity ?? 0;
        if (circ && circ.r > 0.12 && rel < 0.07 && (circMeta > 0.42 || rel < 0.04)) {
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
          return;
        }
      }

      // 整段近直线 → 参数一次式
      if (!isClosed && fitDesmos.length >= 4) {
        const line = fitLineToPoints(fitDesmos);
        const lineTol = Math.max(0.03, desmosScale * 0.85);
        if (line && line.rms < lineTol && line.length > 0.3) {
          const ax = fmtDesmosNumBezier(line.a.x);
          const ay = fmtDesmosNumBezier(line.a.y);
          const dx = fmtDesmosNumBezier(line.b.x - line.a.x);
          const dy = fmtDesmosNumBezier(line.b.y - line.a.y);
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

      // 尖角分段：直边一次式；弯段三次贝塞尔（比折线更光滑）
      const cornerSegs = splitContourAtCorners(fitImg, isClosed, 0.32);
      if (cornerSegs.length >= 2 && cornerSegs.length <= 18) {
        const lineTolPx = Math.max(0.85, spacingPlan.min * 0.45);
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
          if (line && line.rms < desmosScale * lineTolPx && line.length > 0.22 && segLen > 6) {
            planned.push({ kind: 'line', a: line.a, b: line.b });
            lineLen += segLen;
          } else {
            planned.push({ kind: 'curve', pts: desmosSeg });
          }
        }

        if (totalLen > 0 && lineLen / totalLen >= 0.28) {
          let primEmit = 0;
          for (const piece of planned) {
            if (piece.kind === 'line') {
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
            } else if (piece.pts.length >= 2) {
              const remain = Math.max(0, BEZIER_SEG_BUDGET - bezierSegsUsed);
              const cap = Math.min(48, remain, Math.max(4, Math.round(piece.pts.length / 3)));
              if (cap >= 3 && piece.pts.length >= 4) {
                const segs = fitCubicBezierChain(piece.pts, false, cap, { maxErr: BEZIER_MAX_ERR });
                bezierSegsUsed += segs.length;
                let segEmit = 0;
                for (const bez of segs) {
                  if (pointDist(bez.p0, bez.p3) < 0.012) continue;
                  contourExpressions.push({
                    id: `${idPrefix}bez_curve_${index}_${primEmit}_${segEmit++}`,
                    latex: restrictPlot(buildCubicBezLatex(bez)),
                    color: plotColor,
                    lineWidth,
                    lineOpacity: 1,
                    hidden: false,
                    parametricDomain: { min: '0', max: '1' },
                  });
                }
              } else {
                pushDensePolylineOutline(contourExpressions, piece.pts, {
                  idPrefix,
                  index,
                  color: plotColor,
                  lineWidth,
                  restrict: restrictPlot,
                  tableOrdinal: bezierTableOrdinal,
                });
              }
            }
          }
          return;
        }
      }

      // 主视觉：三次贝塞尔贴边（光滑，精度高于折线折角）
      const remain = Math.max(0, BEZIER_SEG_BUDGET - bezierSegsUsed);
      const perContourCap = Math.min(
        96,
        remain,
        Math.max(8, Math.round(pathLenPx / 18)),
      );
      if (remain >= 4 && fitDesmos.length >= 4 && perContourCap >= 4) {
        const segs = fitCubicBezierChain(fitDesmos, isClosed, perContourCap, {
          maxErr: BEZIER_MAX_ERR,
        });
        if (segs.length > 0) {
          bezierSegsUsed += segs.length;
          let segEmit = 0;
          for (const bez of segs) {
            if (pointDist(bez.p0, bez.p3) < 0.012) continue;
            contourExpressions.push({
              id: `${idPrefix}bez_curve_${index}_${segEmit++}`,
              latex: restrictPlot(buildCubicBezLatex(bez)),
              color: plotColor,
              lineWidth,
              lineOpacity: 1,
              hidden: false,
              parametricDomain: { min: '0', max: '1' },
            });
          }
          return;
        }
      }

      // 兜底：密点折线
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
  const fitNote = fitMethod === 'bezier' ? '，贝塞尔拟合' : '，傅里叶拟合';

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
