/**
 * draw-3d.ts — 2D 图像 / Emoji → Desmos Calculator3D 立体重建
 *
 * 旧版：56×56 网格 → 贪心合并同色矩形 → 每个色块挤出成方柱（棱角分明、细节全丢）。
 *
 * 新版（借鉴 Colormap Canyon「高度场」与 The Meadow「列表 + 逐元素颜色」）：
 *   1. 约 110×110 的单元格，每格取抗锯齿中位色（几乎 1:1 保留原图颜色）；
 *      背景用「从边界泛洪」识别，所以眼白、高光这类内部白色不会被挖空。
 *   2. 对前景做距离变换，高度场 h = T·√(1−(1−d/R)²)（圆润的「充气」截面）
 *      再叠加明度浮雕（深色描边微微凸起）→ 平滑的充气立体，而不是方块。
 *   3. 前后两张高度场曲面在轮廓处自然闭合；顶点共享，三角面逐个着色。
 *   4. 全部写成「顶点列表 + 索引列表 + 颜色列表」，每块一条 triangle(V[A],V[B],V[D])，
 *      约 6–8 万个三角面、每块 1000 面。
 */

import type { Desmos3DExpression } from './desmos-3d-lists';
import { applyDesmos3DExpressions, meshToListExpressions, packRgb } from './desmos-3d-lists';

export type Draw3DResult = {
  expressions: Desmos3DExpression[];
  regionCount: number;
  triangleCount: number;
  colorCount: number;
  explanation: string;
};

export type Draw3DOptions = {
  /** 长边网格分辨率（越大越贴图） */
  gridMax?: number;
  /** 三角面预算 */
  maxTriangles?: number;
  /** 最大厚度（Desmos 单位） */
  baseDepth?: number;
  /** 兼容旧参数 */
  includeWalls?: boolean;
  mode?: 'both' | 'fill' | 'outline';
};

const DEFAULT_GRID = 640;
// 预算兼顾填色完整度与「全部代码完整显示」的导入速度：默认约 6 万面，Emoji 最高约 8 万
const DEFAULT_MAX_TRIANGLES = 60000;
const DEFAULT_DEPTH = 2.8;
const BACK_SCALE = 0.7;
const BACK_SHADE = 0.85;

type Cell = {
  r: number;
  g: number;
  b: number;
  empty: boolean;
};

const luminance = (r: number, g: number, b: number): number =>
  (0.299 * r + 0.587 * g + 0.114 * b) / 255;

const quant5 = (r: number, g: number, b: number): number =>
  ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

const median = (arr: number[]): number => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * 估计背景色：取图像最外圈像素里「最多的那一类颜色」。
 * 仅当它占外圈 ≥ 55% 才认定为背景（照片/商品图的白底、纯色底都适用）；否则返回 null（只靠透明通道）。
 * 以前用「近白(≥243)」判背景，浅灰高光面一旦碰到白底边缘就会让泛洪「漏进」物体内部造成缺块。
 */
function estimateBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): [number, number, number] | null {
  const ring = Math.max(2, Math.round(Math.min(width, height) * 0.006));
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  let opaque = 0;
  const add = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    total++;
    if (data[i + 3] < 28) return;
    opaque++;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key);
    if (e) { e.n++; e.r += r; e.g += g; e.b += b; }
    else buckets.set(key, { n: 1, r, g, b });
  };
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (x < ring || y < ring || x >= width - ring || y >= height - ring) add(x, y);
    }
  }
  if (opaque < total * 0.35 || opaque === 0) return null;
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
  if (!best || best.n < opaque * 0.55) return null;
  return [best.r / best.n, best.g / best.n, best.b / best.n];
}
/** 采样成单元格，识别背景（透明 / 与边界相连的近白） */
function buildCells(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  gridMax: number,
): { cells: Cell[]; gw: number; gh: number } {
  const scale = gridMax / Math.max(width, height);
  const gw = Math.max(8, Math.round(width * scale));
  const gh = Math.max(8, Math.round(height * scale));
  const cellW = width / gw;
  const cellH = height / gh;

  const cells: Cell[] = new Array(gw * gh);
  const candidateBg = new Uint8Array(gw * gh);
  const bgColor = estimateBackground(data, width, height);
  // 背景色容差：足够吸收 JPEG 噪声，又不会把贴近白色的浅灰高光面当成背景
  const BG_TOL = 6;
  const isBgLike = (r: number, g: number, b: number): boolean =>
    bgColor
      ? Math.abs(r - bgColor[0]) <= BG_TOL && Math.abs(g - bgColor[1]) <= BG_TOL && Math.abs(b - bgColor[2]) <= BG_TOL
      : Math.min(r, g, b) >= 250 && Math.max(r, g, b) - Math.min(r, g, b) <= 8;

  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const x0 = Math.floor(gx * cellW);
      const y0 = Math.floor(gy * cellH);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil((gx + 1) * cellW)));
      const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil((gy + 1) * cellH)));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 5));
      const stepY = Math.max(1, Math.floor((y1 - y0) / 5));

      const rs: number[] = [];
      const gs: number[] = [];
      const bs: number[] = [];
      let total = 0;
      let transparent = 0;
      let white = 0;
      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) {
          const i = (y * width + x) * 4;
          total++;
          if (data[i + 3] < 28) {
            transparent++;
            continue;
          }
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (isBgLike(r, g, b)) white++;
          rs.push(r);
          gs.push(g);
          bs.push(b);
        }
      }

      const idx = gy * gw + gx;
      if (rs.length === 0) {
        cells[idx] = { r: 255, g: 255, b: 255, empty: true };
        candidateBg[idx] = 1;
        continue;
      }
      const r = median(rs), g = median(gs), b = median(bs);
      cells[idx] = { r, g, b, empty: false };
      if (transparent / Math.max(1, total) > 0.72 || white / Math.max(1, total) > 0.8) {
        candidateBg[idx] = 1;
      }
    }
  }

  // 从边界泛洪：只有与图像边界相连的背景候选格才是真正的背景。
  // 相邻格之间颜色一旦出现台阶（≥5）就不再扩散——浅灰高光面贴着白底时，泛洪不会「漏」进物体内部。
  const bg = new Uint8Array(gw * gh);
  const stack: number[] = [];
  const STEP_TOL = 5;
  const similar = (a: number, b: number): boolean => {
    const ca = cells[a], cb = cells[b];
    if (ca.empty && cb.empty) return true;
    if (ca.empty || cb.empty) return true; // 与透明 / 空格相邻：不设限
    return Math.abs(ca.r - cb.r) <= STEP_TOL && Math.abs(ca.g - cb.g) <= STEP_TOL && Math.abs(ca.b - cb.b) <= STEP_TOL;
  };
  const seed = (x: number, y: number, from = -1) => {
    const i = y * gw + x;
    if (candidateBg[i] && !bg[i] && (from < 0 || similar(from, i))) {
      bg[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < gw; x++) {
    seed(x, 0);
    seed(x, gh - 1);
  }
  for (let y = 0; y < gh; y++) {
    seed(0, y);
    seed(gw - 1, y);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % gw, y = (i / gw) | 0;
    if (x > 0) seed(x - 1, y, i);
    if (x < gw - 1) seed(x + 1, y, i);
    if (y > 0) seed(x, y - 1, i);
    if (y < gh - 1) seed(x, y + 1, i);
  }
  for (let i = 0; i < cells.length; i++) {
    if (bg[i]) cells[i].empty = true;
  }

  // 去掉孤立的单格噪点
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (cells[i].empty) continue;
      const n =
        (x > 0 && !cells[i - 1].empty ? 1 : 0) +
        (x < gw - 1 && !cells[i + 1].empty ? 1 : 0) +
        (y > 0 && !cells[i - gw].empty ? 1 : 0) +
        (y < gh - 1 && !cells[i + gw].empty ? 1 : 0);
      if (n === 0) cells[i].empty = true;
    }
  }

  return { cells, gw, gh };
}

/** 到最近空格的距离（3-4 倒角距离，单位：格） */
function distanceToEmpty(cells: Cell[], gw: number, gh: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(gw * gh);
  for (let i = 0; i < d.length; i++) d[i] = cells[i].empty ? 0 : INF;
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : d[y * gw + x]);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(
        d[i],
        at(x - 1, y) + 1,
        at(x, y - 1) + 1,
        at(x - 1, y - 1) + 1.4142,
        at(x + 1, y - 1) + 1.4142,
      );
    }
  }
  for (let y = gh - 1; y >= 0; y--) {
    for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(
        d[i],
        at(x + 1, y) + 1,
        at(x, y + 1) + 1,
        at(x + 1, y + 1) + 1.4142,
        at(x - 1, y + 1) + 1.4142,
      );
    }
  }
  return d;
}

type ReliefBuild = {
  positions: Float64Array;
  faces: Int32Array;
  faceColor: Int32Array;
  insideCells: number;
  colorSet: Set<number>;
  gw: number;
  gh: number;
};

/** 高度场平坦度容差：合并块内部角点偏离双线性插值不得超过它（Desmos 单位） */
const MERGE_HEIGHT_EPS = 0.02;
/** 合并块颜色容差（每通道，0–255） */
const MERGE_COLOR_TOL = 3;

function buildReliefAt(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  gridMax: number,
  options: Draw3DOptions,
): ReliefBuild {
  const baseDepth = options.baseDepth ?? DEFAULT_DEPTH;
  const mode = options.mode ?? 'both';
  const { cells, gw, gh } = buildCells(data, width, height, gridMax);

  // 仅描边模式：只保留轮廓与深色线条格
  if (mode === 'outline') {
    const keep = new Uint8Array(gw * gh);
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const c = cells[i];
        if (c.empty) continue;
        const dark = luminance(c.r, c.g, c.b) < 0.38;
        const rim =
          x === 0 || y === 0 || x === gw - 1 || y === gh - 1 ||
          cells[i - 1].empty || cells[i + 1].empty || cells[i - gw].empty || cells[i + gw].empty;
        if (dark || rim) keep[i] = 1;
      }
    }
    for (let i = 0; i < cells.length; i++) if (!keep[i]) cells[i].empty = true;
  }

  const aspect = width / height;
  const halfX = aspect >= 1 ? 10 : 10 * aspect;
  const halfY = aspect >= 1 ? 10 / aspect : 10;
  const toX = (gx: number) => -halfX + (gx / gw) * 2 * halfX;
  const toY = (gy: number) => halfY - (gy / gh) * 2 * halfY;

  // 高度场：距离变换 → 圆润截面 → 明度浮雕 → 3×3 平滑
  const dist = distanceToEmpty(cells, gw, gh);
  // 截面用 tanh：边缘处有限坡度（约 25°，避开光照表里的高光斑）而不是垂直墙，这样轮廓侧壁不会面向相机侧的高光/暗斑，
  // 中部渐渐趋于平坦，图片内容几乎正对相机，颜色更稳。
  const cellUnits = (2 * halfX) / gw;
  const EDGE_SLOPE = 0.45;
  const h = new Float32Array(gw * gh);
  for (let i = 0; i < h.length; i++) {
    const c = cells[i];
    if (c.empty) continue;
    const round = Math.tanh((EDGE_SLOPE * Math.max(0.2, dist[i] - 0.5) * cellUnits) / baseDepth);
    const bump = 0.03 * (1 - luminance(c.r, c.g, c.b));
    h[i] = baseDepth * (round * (0.86 + bump)) + 0.02;
  }
  const hs = new Float32Array(h.length);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (cells[i].empty) continue;
      let sum = 0, w = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
          const j = yy * gw + xx;
          if (cells[j].empty) continue;
          const wt = dx === 0 && dy === 0 ? 2 : 1;
          sum += h[j] * wt;
          w += wt;
        }
      }
      hs[i] = sum / w;
    }
  }

  // 角点高度：四周全是前景格才取均值，否则贴地（轮廓处前后两面闭合）
  const cw = gw + 1;
  const cornerH = new Float32Array(cw * (gh + 1));
  const cornerBoundary = new Uint8Array(cw * (gh + 1));
  for (let j = 0; j <= gh; j++) {
    for (let i = 0; i <= gw; i++) {
      let sum = 0, n = 0, out = 0;
      for (let dy = -1; dy <= 0; dy++) {
        for (let dx = -1; dx <= 0; dx++) {
          const x = i + dx, y = j + dy;
          if (x < 0 || y < 0 || x >= gw || y >= gh || cells[y * gw + x].empty) {
            out++;
          } else {
            sum += hs[y * gw + x];
            n++;
          }
        }
      }
      const ci = j * cw + i;
      if (n === 0) continue;
      if (out > 0) {
        cornerBoundary[ci] = 1;
        cornerH[ci] = 0;
      } else {
        cornerH[ci] = sum / n;
      }
    }
  }

  // 轮廓抗锯齿：轮廓角点沿轮廓链做 Taubin 平滑（先收缩后膨胀，几乎不缩小形状），
  // 把「台阶状」的格子边变成平滑曲线；内部角点保持不动。
  const cornerX = new Float32Array(cw * (gh + 1));
  const cornerZ = new Float32Array(cw * (gh + 1));
  for (let j = 0; j <= gh; j++) for (let i = 0; i <= gw; i++) {
    cornerX[j * cw + i] = toX(i);
    cornerZ[j * cw + i] = toY(j);
  }
  {
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < gw && y < gh && !cells[y * gw + x].empty;
    // 轮廓边：两侧恰有一侧在内部
    const chain: number[][] = new Array(cw * (gh + 1));
    for (let j = 0; j <= gh; j++) {
      for (let i = 0; i <= gw; i++) {
        const ci = j * cw + i;
        if (!cornerBoundary[ci]) continue;
        const nb: number[] = [];
        // 右边 (i,j)-(i+1,j)：上侧格 (i,j-1)，下侧格 (i,j)
        if (i < gw && inside(i, j - 1) !== inside(i, j)) nb.push(ci + 1);
        if (i > 0 && inside(i - 1, j - 1) !== inside(i - 1, j)) nb.push(ci - 1);
        if (j < gh && inside(i - 1, j) !== inside(i, j)) nb.push(ci + cw);
        if (j > 0 && inside(i - 1, j - 1) !== inside(i, j - 1)) nb.push(ci - cw);
        chain[ci] = nb;
      }
    }
    const smoothPass = (lambda: number) => {
      const nx = Float32Array.from(cornerX), nz = Float32Array.from(cornerZ);
      for (let ci = 0; ci < chain.length; ci++) {
        const nb = chain[ci];
        if (!nb || nb.length !== 2) continue;
        const mx = (cornerX[nb[0]] + cornerX[nb[1]]) / 2;
        const mz = (cornerZ[nb[0]] + cornerZ[nb[1]]) / 2;
        nx[ci] = cornerX[ci] + lambda * (mx - cornerX[ci]);
        nz[ci] = cornerZ[ci] + lambda * (mz - cornerZ[ci]);
      }
      cornerX.set(nx);
      cornerZ.set(nz);
    };
    for (let it = 0; it < 4; it++) {
      smoothPass(0.5);
      smoothPass(-0.53);
    }
  }

  const frontCount = cw * (gh + 1);
  const positions = new Float64Array(frontCount * 2 * 3);
  for (let j = 0; j <= gh; j++) {
    for (let i = 0; i <= gw; i++) {
      const ci = j * cw + i;
      // 图像竖立在 xz 平面（z 向上），正面朝 −y（默认相机一侧），厚度沿 y
      const x = cornerX[ci], up = cornerZ[ci];
      positions[ci * 3] = x;
      positions[ci * 3 + 1] = -cornerH[ci];
      positions[ci * 3 + 2] = up;
      const bi = frontCount + ci;
      positions[bi * 3] = x;
      positions[bi * 3 + 1] = cornerH[ci] * BACK_SCALE;
      positions[bi * 3 + 2] = up;
    }
  }

  const faces: number[] = [];
  const faceColor: number[] = [];
  const colorSet = new Set<number>();
  let insideCells = 0;

  const emit = (a: number, b: number, c: number, col: number) => {
    faces.push(a, b, c);
    faceColor.push(col);
  };

  /** 以 (x,y) 为左上、边长 s 个细格的方块输出前后各 2 个三角形 */
  const emitQuad = (x: number, y: number, s: number, r: number, g: number, b: number) => {
    const c00 = y * cw + x;
    const c10 = c00 + s;
    const c01 = c00 + s * cw;
    const c11 = c01 + s;
    const frontCol = packRgb(r, g, b);
    const backCol = packRgb(r * BACK_SHADE, g * BACK_SHADE, b * BACK_SHADE);
    colorSet.add(quant5(r, g, b));
    const diagA = Math.abs(cornerH[c00] - cornerH[c11]) <= Math.abs(cornerH[c10] - cornerH[c01]);
    if (diagA) {
      emit(c00, c10, c11, frontCol);
      emit(c00, c11, c01, frontCol);
    } else {
      emit(c00, c10, c01, frontCol);
      emit(c10, c11, c01, frontCol);
    }
    // 背面：轮廓贴地的角点与前面共用顶点 → 无缝闭合
    const bk = (c: number) => (cornerBoundary[c] ? c : frontCount + c);
    if (diagA) {
      emit(bk(c00), bk(c11), bk(c10), backCol);
      emit(bk(c00), bk(c01), bk(c11), backCol);
    } else {
      emit(bk(c00), bk(c01), bk(c10), backCol);
      emit(bk(c10), bk(c01), bk(c11), backCol);
    }
  };

  // 自适应合并（四叉树式）：同色且高度场近似平面的整块只用 2 个三角形，
  // 细节与轮廓处保持 1 个细格，所以同样预算下有效分辨率远高于均匀网格。
  const used = new Uint8Array(gw * gh);
  const tryBlock = (bx: number, by: number, s: number): boolean => {
    if (bx + s > gw || by + s > gh) return false;
    let sr = 0, sg = 0, sb = 0;
    for (let y = by; y < by + s; y++) {
      for (let x = bx; x < bx + s; x++) {
        const i = y * gw + x;
        if (used[i] || cells[i].empty) return false;
        sr += cells[i].r;
        sg += cells[i].g;
        sb += cells[i].b;
      }
    }
    const n = s * s;
    const mr = sr / n, mg = sg / n, mb = sb / n;
    for (let y = by; y < by + s; y++) {
      for (let x = bx; x < bx + s; x++) {
        const c = cells[y * gw + x];
        if (
          Math.abs(c.r - mr) > MERGE_COLOR_TOL ||
          Math.abs(c.g - mg) > MERGE_COLOR_TOL ||
          Math.abs(c.b - mb) > MERGE_COLOR_TOL
        ) return false;
      }
    }
    // 角点平坦度
    const h00 = cornerH[by * cw + bx];
    const h10 = cornerH[by * cw + bx + s];
    const h01 = cornerH[(by + s) * cw + bx];
    const h11 = cornerH[(by + s) * cw + bx + s];
    for (let j = 0; j <= s; j++) {
      for (let i = 0; i <= s; i++) {
        const u = i / s, v = j / s;
        const interp = (1 - v) * ((1 - u) * h00 + u * h10) + v * ((1 - u) * h01 + u * h11);
        if (Math.abs(cornerH[(by + j) * cw + bx + i] - interp) > MERGE_HEIGHT_EPS) return false;
      }
    }
    for (let y = by; y < by + s; y++) for (let x = bx; x < bx + s; x++) used[y * gw + x] = 1;
    insideCells += n;
    emitQuad(bx, by, s, mr, mg, mb);
    return true;
  };

  for (const s of [8, 4, 2]) {
    for (let by = 0; by + s <= gh; by += s) {
      for (let bx = 0; bx + s <= gw; bx += s) tryBlock(bx, by, s);
    }
  }
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (used[i] || cells[i].empty) continue;
      used[i] = 1;
      insideCells++;
      const c = cells[i];
      emitQuad(x, y, 1, c.r, c.g, c.b);
    }
  }

  return {
    positions,
    faces: Int32Array.from(faces),
    faceColor: Int32Array.from(faceColor),
    insideCells,
    colorSet,
    gw,
    gh,
  };
}

function buildRelief(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: Draw3DOptions,
): Draw3DResult {
  const maxTriangles = options.maxTriangles ?? DEFAULT_MAX_TRIANGLES;

  // 找到「预算内最细」的网格：先按目标细度试，超预算就按比例收缩（面数大致 ∝ 边界长度）
  let gridMax = options.gridMax ?? DEFAULT_GRID;
  let best = buildReliefAt(data, width, height, gridMax, options);
  for (let attempt = 0; attempt < 8 && best.faces.length / 3 > maxTriangles; attempt++) {
    const ratio = Math.max(0.55, Math.min(0.97, (maxTriangles / (best.faces.length / 3)) * 0.98));
    gridMax = Math.max(32, Math.floor(gridMax * ratio));
    best = buildReliefAt(data, width, height, gridMax, options);
  }

  const built3d = meshToListExpressions(best.positions, best.faces, best.faceColor, 'd3d');

  const expressions: Desmos3DExpression[] = [
    {
      id: 'd3d_note',
      type: 'text',
      text: `3D relief · grid ${best.gw}×${best.gh} · cells ${best.insideCells} · tris ${built3d.triangleCount} · colors ${best.colorSet.size}`,
    },
    ...built3d.expressions,
  ];

  return {
    expressions,
    regionCount: best.insideCells,
    triangleCount: built3d.triangleCount,
    colorCount: best.colorSet.size,
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
  maxSide = 768,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(32, Math.round(img.width * scale));
  const h = Math.max(32, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No ctx');
  // 不预填白底：保留 PNG/Emoji 的透明通道，由 buildCells 识别背景
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
  return buildRelief(imageData.data, canvas.width, canvas.height, options);
}

export async function processEmojiToDesmos3D(
  emoji: string,
  options: Draw3DOptions = {},
): Promise<Draw3DResult> {
  const size = 768;
  const big = 1536;
  const failed: Draw3DResult = {
      expressions: [],
      regionCount: 0,
      triangleCount: 0,
      colorCount: 0,
      explanation: 'draw_3d_fail',
    };

  // 1) 在大画布上用较小字号绘制（不同系统的 Emoji 字形大小差异很大，避免被裁切）
  const src = document.createElement('canvas');
  src.width = big;
  src.height = big;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  if (!sctx) return failed;
  // 透明底：Emoji 内部的白色（眼白、牙齿）才不会被当成背景挖掉
  sctx.clearRect(0, 0, big, big);
  sctx.font = `${big * 0.45}px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",serif`;
  sctx.textAlign = 'center';
  sctx.textBaseline = 'middle';
  sctx.fillText(emoji, big / 2, big / 2);

  // 2) 求不透明像素包围盒
  const full = sctx.getImageData(0, 0, big, big).data;
  let minX = big, minY = big, maxX = -1, maxY = -1;
  for (let y = 0; y < big; y += 2) {
    for (let x = 0; x < big; x += 2) {
      if (full[(y * big + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return failed;

  // 3) 紧致裁剪后缩放到 768 画布（占 92%），让网格全部用在字形上
  const bw = maxX - minX + 2;
  const bh = maxY - minY + 2;
  const fit = (size * 0.92) / Math.max(bw, bh);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return failed;
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const dw = bw * fit;
  const dh = bh * fit;
  ctx.drawImage(src, minX, minY, bw, bh, (size - dw) / 2, (size - dh) / 2, dw, dh);

  const imageData = ctx.getImageData(0, 0, size, size);
  return buildRelief(imageData.data, size, size, {
    gridMax: 640,
    maxTriangles: 80000,
    baseDepth: 3.2,
    ...options,
  });
}
export { applyDesmos3DExpressions as applyDraw3DExpressionsProgressively };
