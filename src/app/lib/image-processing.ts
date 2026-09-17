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

export type { SmartDrawMode, OutlineStyle } from './smart-draw-repair';
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

/** 抗锯齿边缘允许小幅偏差；收紧以减少跨色块合并 */
const FILL_COLOR_TOLERANCE = 22;

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
  const step = Math.max(1, Math.floor(points.length / 24));

  for (let i = 0; i < points.length; i += step) {
    const x = Math.round(points[i].x);
    const y = Math.round(points[i].y);
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const idx = (y * width + x) * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    if (!isCanvasBackground(r, g, b)) samples.push({ r, g, b });
  }

  if (samples.length === 0) return '#000000';

  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  return rgbToHex(
    median(samples.map(s => s.r)),
    median(samples.map(s => s.g)),
    median(samples.map(s => s.b)),
  );
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
): { contours: Point[][], strengths: number[] } => {

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

  const IGNORE_MARGIN = 16; // 忽略图像边缘 16 像素（边缘区域常有噪声）

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x; // 当前像素索引

      // 忽略图像边缘区域
      if (x < IGNORE_MARGIN || x > width - IGNORE_MARGIN ||
          y < IGNORE_MARGIN || y > height - IGNORE_MARGIN) {
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
  const globalAvgStrength = nonZeroCount > 0 ? (totalGrad / nonZeroCount) : 10;

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

  return { contours, strengths };
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
  const rounded = Math.round(n * 10000) / 10000;
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
 * 提取填色 polygon：逐格取原图中位数颜色，尽量 1:1 还原
 */
const MAX_FILL_POLYGONS = 3600;

/** 单张图片 / GIF 每帧共用的最高分辨率与填色精度 */
export const SINGLE_IMAGE_MAX_DIM = 1280;
export const SINGLE_IMAGE_MAX_FILL_POLYGONS = MAX_FILL_POLYGONS;

const computeOptimalFillGrid = (width: number, height: number, maxCells = MAX_FILL_POLYGONS): number => {
  let lo = 96;
  let hi = Math.min(720, Math.max(width, height));
  let best = 128;

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

  // 更密的采样网格再合并：边缘更齐，最终矩形更少
  const gridMax = computeOptimalFillGrid(
    width,
    height,
    Math.min(MAX_FILL_POLYGONS, Math.max(maxFillPolygons * 8, 1600)),
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

  polys.forEach((poly, i) => {
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
  const desmosScale = 20 / Math.max(width, height);
  const offsetX = width / 2;
  const offsetY = height / 2;
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

  if (includeFill) {
    const fillCtx = createFillContext(width, height, options.fillImageData, ctx);
    const skipOutlineBlackFills = includeOutline;
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
  let { contours: rawContours, strengths } = extractContours(ctx, width, height, tuning);
  let closedHints: (boolean | null)[] = rawContours.map(() => null);

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

  // ── 过滤 A：强度过滤 ──────────────────────────────────────────────────────
  const strengthRatio = tuning?.strengthThresholdRatio ?? 0.28;
  const sortedStrength = [...meta].map(m => m.averageStrength).sort((a, b) => b - a);
  const topStrength = sortedStrength.length > 0 ? sortedStrength[0] : 10;
  const strengthThreshold = Math.max(8, topStrength * strengthRatio);

  meta.forEach(m => {
    if (m.averageStrength < strengthThreshold) {
      activeSet.delete(m.index); // 从幸存集合中移除
    }
  });

  // ── 过滤 B：几何过滤（消除各种噪声类型）─────────────────────────────────
  const preserveFine = tuning?.preserveFineDetails ?? false;
  const minOpenLength = preserveFine ? 40 : 60;
  const minClosedLength = preserveFine ? 20 : 30;
  const minBlobSize = preserveFine ? 14 : 20;

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

  // ── 按优先级排序（路径长度 × 强度的乘积越大越重要）─────────────────────
  finalContours.sort((a, b) => {
    const mA = meta[rawContours.indexOf(a)];
    const mB = meta[rawContours.indexOf(b)];
    return (mB.pathLength * mB.averageStrength) - (mA.pathLength * mA.averageStrength);
  });

  const maxContours = tuning?.maxContours ?? 50;
  finalContours = finalContours.slice(0, maxContours);

  const contourExpressions: any[] = [];
  const useColorOutline = !includeFill && (options.outlineStyle ?? 'mono') === 'color';
  const colorSampleData = useColorOutline
    ? (options.fillImageData?.data ?? ctx.getImageData(0, 0, width, height).data)
    : null;

  finalContours.forEach((rawPoints, idx) => {
    const m = meta[rawContours.indexOf(rawPoints)];
    let processedPoints = [...rawPoints]; // 复制一份（不修改原始数据）

    // ── 开放轮廓处理：防止"回程线"─────────────────────────────────────────
    // 开放轮廓（首尾不接）的参数方程结束时会画一条直线回起点，很难看。
    // 解决方案：让轮廓走到终点后，原路返回，形成"去而复返"的完整路径。
    // 这样 DFT 不会看到突变，也就不会产生难看的"Gibbs 过冲"（高频振铃）。
    if (!m.isClosed) {
      // 把轮廓反转（从终点走回起点），去掉首尾避免重复
      const reversed = [...processedPoints].reverse().slice(1, -1);

      // 在转折点添加"暂停"点（重复3次）：让 DFT 平滑处理转折
      const tip = processedPoints[processedPoints.length - 1]; // 终点
      const root = processedPoints[0];                          // 起点
      const pauseTip  = [tip, tip, tip];   // 终点暂停
      const pauseRoot = [root, root, root]; // 起点暂停

      // 最终路径：起点→终点→暂停→原路返回→暂停→(回到起点，首尾相连)
      processedPoints = [...processedPoints, ...pauseTip, ...reversed, ...pauseRoot];
    }

    const targetCount = tuning?.targetPointCount ?? 400;
    const step = Math.max(1, Math.floor(processedPoints.length / targetCount));
    // 每隔 step 个点取一个（i % step === 0 时保留）
    const points = processedPoints.filter((_, i) => i % step === 0);

    // ── 坐标系转换 ────────────────────────────────────────────────────────
    const centeredPoints = points.map(p => ({
      x: (p.x - offsetX) * desmosScale,  // 中心化 + 缩放
      y: -(p.y - offsetY) * desmosScale   // 中心化 + 缩放 + 翻转 Y 轴（Canvas Y 向下，Desmos Y 向上）
    }));

    const fourierCap = tuning?.fourierK ?? 100;
    let K = Math.min(fourierCap, Math.floor((points.length - 1) / 2));
    if (K < 5) K = 5; // 至少 5 个频率（否则图形太粗糙）

    // ── 计算 DFT ──────────────────────────────────────────────────────────
    const coeffs = computeDFT(centeredPoints, K);

    const index = idx;
    const plotColor = colorSampleData
      ? sampleContourColorFromData(colorSampleData, width, height, processedPoints)
      : SMART_DRAW_OUTLINE_COLOR;

    const lineWidth = fillPolys.length > 0 ? 2 : 2.5;

    if (options.compactFourier) {
      // GIF：级数在这里就展开成点列，Desmos 只连折线，重绘不再做三角函数。
      // 点列直接内联，一条轮廓只占 1 行，也不会和单图的 X_n/Y_n 撞名。
      const curve = sampleFourierCurvePoints(coeffs, resolveOutlineSampleCount(K));
      const listX = `\\left[${curve.map(p => fmtDesmosNum(p.x)).join(',')}\\right]`;
      const listY = `\\left[${curve.map(p => fmtDesmosNum(p.y)).join(',')}\\right]`;
      // 用 {条件:1} 乘在坐标上做门控：条件不成立即 undefined，整条折线隐藏
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
      });
      return;
    }

    // 提取各频率的参数
    const L_freq = coeffs.map(c => c.freq);            // 频率列表：[0, 1, -1, 2, -2, ...]
    const L_real = coeffs.map(c => c.re.toFixed(5));   // 实部（保留5位小数，平衡精度和体积）
    const L_imag = coeffs.map(c => c.im.toFixed(5));   // 虚部

    // varNamespace = 帧序号（1-based）；第 1 帧从 F_0 起，第 2 帧从 F_64 起，互不冲突
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

  return {
    expressions,
    explanation: includeFill && fillPolys.length > 0
      ? `绘画已完成（${fillPolys.length} 个色块 + ${finalContours.length} 条黑色轮廓${outlineNote}）。`
      : includeFill
        ? '绘画已完成。'
        : useColorOutline
          ? `绘画已完成（${finalContours.length} 条彩色轮廓${outlineNote}，仅勾线）。`
          : `绘画已完成（${finalContours.length} 条黑色轮廓${outlineNote}，仅勾线）。`,
  };
};

/** 供 GIF 等多帧管线直接调用 */
export const generateFourierExpressionsFromContext = generateFourierExpressions;

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

/** K 个谐波用约 3K 个采样点即看不出折线感 */
const resolveOutlineSampleCount = (K: number): number =>
  Math.max(120, Math.min(300, K * 3));

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
  // 折线轮廓（lines:true）不是参数曲线，不能带 parametricDomain
  const isPolyline = expr?.lines === true;
  if (!isPolyline && (/(?:^|_)dft_plot_\d+$/.test(id) || /(?:^|_)hd_plot_\d+$/.test(id))) {
    options.parametricDomain = { min: '0', max: '2\\pi' };
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

const isOutlinePlotExpression = (expr: any): boolean =>
  /(?:^|_)dft_plot_\d+$/.test(String(expr?.id || ''))
  || /(?:^|_)hd_plot_\d+$/.test(String(expr?.id || ''));

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
    if (isSliderExpression(expr) || isFolderExpression(expr)) meta.push(expr);
    else if (isFillExpression(expr)) fills.push(expr);
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

  const { fills: rawFills, contours: rawContours } = partitionExpressions(expressions);
  const fills = rawFills.map(prepareFourierExpression);
  const contours = rawContours.map(prepareFourierExpression);
  const contourGroups = groupContourExpressions(contours);
  const bothMode = mode === 'both' && fills.length > 0 && contourGroups.length > 0;
  const fillBatchCount = fills.length > 0 ? Math.ceil(fills.length / DESMOS_EXPR_BATCH) : 0;
  const outlineStepCount = contourGroups.length;
  const totalSteps = bothMode
    ? outlineStepCount + fillBatchCount
    : outlineStepCount + fillBatchCount;

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
        await yieldQuick();
      }
    }

    // 2) 再填色显现
    if (!signal?.aborted) {
      for (let i = 0; i < fills.length; i += DESMOS_EXPR_BATCH) {
        if (signal?.aborted) break;
        const batch = fills.slice(i, i + DESMOS_EXPR_BATCH);
        pushVisibleFillBatch(calculator, batch);
        bump('fill', Math.min(i + batch.length, fills.length), fills.length);
        await yieldQuick();
      }
      bringOutlinePlotsToFront(calculator, contours);
    }
  } else {
    // 仅轮廓或仅填色
    for (let i = 0; i < contourGroups.length; i++) {
      if (signal?.aborted) break;
      pushExprBatch(calculator, contourGroups[i]);
      bump('outline', i + 1, outlineStepCount || totalSteps);
      await yieldQuick();
    }
    for (let i = 0; i < fills.length; i += DESMOS_EXPR_BATCH) {
      if (signal?.aborted) break;
      pushExprBatch(calculator, fills.slice(i, i + DESMOS_EXPR_BATCH));
      bump('fill', Math.min(i + DESMOS_EXPR_BATCH, fills.length), fills.length);
      await yieldQuick();
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

const GIF_STREAM_FILL_BATCH = 16;
const GIF_STREAM_FILL_BATCH_FAST = 24;
const GIF_STREAM_CONTOUR_BATCH = 8;
const GIF_STREAM_CONTOUR_BATCH_FAST = 12;

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
  const pushBatch = appendOnly
    ? (batch: any[]) => pushExprBatchAppend(calculator, batch, knownIds)
    : (batch: any[]) => { pushExprBatch(calculator, batch); return batch.length; };
  const stamp = (expr: any) => {
    const prepared = prepareFourierExpression(expr);
    if (folderId && !isSliderExpression(prepared) && !isFolderExpression(prepared)) {
      prepared.folderId = folderId;
      prepared.secret = true;
      if (!isFillExpression(prepared) && !isOutlinePlotExpression(prepared)) {
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
    if (batchTick % 2 === 0) await yieldToInteractive();
    else await yieldQuick();
  };

  if (folderId) {
    added += pushBatch([{
      id: folderId,
      type: 'folder',
      title: options?.folderTitle || folderId,
      collapsed: true,
      hidden: folderHidden,
      secret: false,
    }]);
    await yieldAfterBatch();
  }

  const { fills, contours } = partitionExpressions(frameExpressions);
  const fillBatch = fastInject ? GIF_STREAM_FILL_BATCH_FAST : GIF_STREAM_FILL_BATCH;
  const contourBatch = fastInject ? GIF_STREAM_CONTOUR_BATCH_FAST : GIF_STREAM_CONTOUR_BATCH;
  const bothMode = outlineFirst && !deferVisibility && fills.length > 0 && contours.length > 0;
  const contourGroups = bothMode ? groupContourExpressions(contours.map(stamp)) : [];

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
          const MAX_DIM = 1280;
          const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
          canvas.width = img.width * scale;
          canvas.height = img.height * scale;

          const ctx = canvas.getContext('2d');
          if (!ctx) { reject('No ctx'); return; }

          ctx.fillStyle = 'white';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
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
