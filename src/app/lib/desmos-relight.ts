/**
 * desmos-relight.ts — 抵消 Desmos 3D 默认光照对「颜色」的扭曲
 *
 * 问题：Desmos 3D 的三角面会被固定在相机上的多盏灯着色（含两处镜面高光、一处暗斑）。
 *       直接把图片/材质颜色塞进去，白色会过曝成灰/糊白，暗部被抬亮，浮雕的曲率还会把颜色搅脏，
 *       所以看上去「颜色很古怪」。
 *
 * 实测（见 desmos-lighting-table.ts）：在线性色彩空间里  out = A(n) + K(n)·albedo，
 * 其中 n 是相机坐标系下的法线。于是对每个面：先算它在默认相机里的 (A,K)，
 * 再反解出应该写入的颜色，使屏幕上最终看到的就是目标颜色（只保留少量方向明暗以维持立体感）。
 */
import {
  LIGHTING_A_B64,
  LIGHTING_A_SCALE,
  LIGHTING_GRID,
  LIGHTING_K_B64,
  LIGHTING_K_SCALE,
} from './desmos-lighting-table';

let tableA: Float32Array | null = null;
let tableK: Float32Array | null = null;

function decodeB64(b64: string, scale: number): Float32Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Float32Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) / scale;
  return out;
}

function ensureTables() {
  if (!tableA || !tableK) {
    tableA = decodeB64(LIGHTING_A_B64, LIGHTING_A_SCALE);
    tableK = decodeB64(LIGHTING_K_B64, LIGHTING_K_SCALE);
  }
}

/** 双线性采样：nx 右、ny 上（相机空间法线的屏幕分量，[-1,1]） */
export function sampleLighting(nx: number, ny: number): { A: number; K: number } {
  ensureTables();
  const N = LIGHTING_GRID;
  const half = (N - 1) / 2;
  const r2 = nx * nx + ny * ny;
  if (r2 > 1) {
    const s = 1 / Math.sqrt(r2);
    nx *= s;
    ny *= s;
  }
  const fx = Math.min(N - 1.001, Math.max(0, (nx + 1) * half));
  const fy = Math.min(N - 1.001, Math.max(0, (ny + 1) * half));
  const i = Math.floor(fx), j = Math.floor(fy);
  const tx = fx - i, ty = fy - j;
  const at = (arr: Float32Array) =>
    (arr[j * N + i] * (1 - tx) + arr[j * N + i + 1] * tx) * (1 - ty) +
    (arr[(j + 1) * N + i] * (1 - tx) + arr[(j + 1) * N + i + 1] * tx) * ty;
  return { A: at(tableA!), K: at(tableK!) };
}

const toLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const toSrgb = (l: number): number => {
  const c = Math.max(0, Math.min(1, l));
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
};

/** 默认相机（与 uprightViewMatrix 同约定）的正交基：D 指向相机，Rt 屏幕右，U 屏幕上 */
export function cameraBasis(azimuthDeg = 24, elevationDeg = 16) {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const D = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
  const cross = (p: number[], q: number[]) => [
    p[1] * q[2] - p[2] * q[1],
    p[2] * q[0] - p[0] * q[2],
    p[0] * q[1] - p[1] * q[0],
  ];
  const rt0 = cross([0, 0, 1], D);
  const rl = Math.hypot(rt0[0], rt0[1], rt0[2]) || 1;
  const Rt = rt0.map(v => v / rl);
  const U = cross(D, Rt);
  return { D, Rt, U };
}

export type RelightOptions = {
  azimuth?: number;
  elevation?: number;
  /**
   * 保留多少「方向明暗」(0–1)。0 = 完全抹平（颜色最忠实，但像贴图）；1 = 不修正方向明暗。
   * 默认 0.3：保留一点立体感，高光/暗斑/过曝被消除。
   */
  keepShading?: number;
};

/** 参考（正对相机）光照：用于把明暗变化归一化 */
function referenceGain(): number {
  const { A, K } = sampleLighting(0, 0);
  return A + K * 0.4;
}

/**
 * 对每个三角面计算「应写入 Desmos 的颜色」，使默认相机下看到的颜色 ≈ 原色。
 * @returns 新的逐面打包颜色（r·65536+g·256+b）
 */
export function relightFaceColors(
  positions: ArrayLike<number>,
  faces: ArrayLike<number>,
  faceColor: ArrayLike<number>,
  options: RelightOptions = {},
): Int32Array {
  const { D, Rt, U } = cameraBasis(options.azimuth ?? 24, options.elevation ?? 16);
  const keep = options.keepShading ?? 0.3;
  const ref = referenceGain();
  const m = Math.floor(faces.length / 3);
  const out = new Int32Array(m);
  // 查表很便宜，但 sRGB↔线性的 pow 较贵：对 256 级预先建表
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) lin[i] = toLinear(i);

  for (let f = 0; f < m; f++) {
    const a = faces[f * 3] * 3, b = faces[f * 3 + 1] * 3, c = faces[f * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    const q = faceColor[f] & 0xffffff;
    if (len < 1e-12) {
      out[f] = q;
      continue;
    }
    nx /= len; ny /= len; nz /= len;
    let sx = nx * Rt[0] + ny * Rt[1] + nz * Rt[2];
    let sy = nx * U[0] + ny * U[1] + nz * U[2];
    const sz = nx * D[0] + ny * D[1] + nz * D[2];
    if (sz < 0) { sx = -sx; sy = -sy; } // 双面着色：法线朝向相机一侧

    const { A, K } = sampleLighting(sx, sy);
    const kk = Math.max(0.2, K);
    const gain = (A + K * 0.4) / ref;
    const m2 = 1 + keep * (gain - 1);

    const r = lin[(q >> 16) & 255], g = lin[(q >> 8) & 255], bl = lin[q & 255];
    const cr = (r * m2 - A) / kk;
    const cg = (g * m2 - A) / kk;
    const cb = (bl * m2 - A) / kk;
    out[f] =
      (Math.round(toSrgb(cr)) << 16) | (Math.round(toSrgb(cg)) << 8) | Math.round(toSrgb(cb));
  }
  return out;
}
