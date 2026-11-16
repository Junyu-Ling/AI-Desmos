/**
 * obj-texture.ts — OBJ 贴图（MTL map_Kd）支持
 *
 * 大多数网上下载的 OBJ 都是「几何 + 贴图」：Kd 往往只是 0.8 的灰色，真正的颜色在贴图里。
 * 以前只读 Kd，所以带贴图的人物/场景整体变成灰色或单色。这里：
 *   1) 读取用户一起选的图片文件，按文件名（不区分大小写、忽略路径）匹配 MTL 里的 map_Kd；
 *   2) 按 UV 对每个三角面采样贴图（线性空间平均，抗锯齿）；
 *   3) 低面数模型的几何面不够细、盖不住贴图细节 → 按「贴图覆盖的像素数」把三角面细分（1→4），
 *      直到用满三角面预算，让 30000 个面尽量多带走贴图信息。
 */

export type TextureImage = { width: number; height: number; data: Uint8ClampedArray };
export type TextureMap = Map<string, TextureImage>;

/** 贴图查找键：小写文件名（去路径、去引号） */
export const textureKey = (name: string): string =>
  name.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').split('/').pop()!.toLowerCase();

export const isImageFile = (file: File): boolean =>
  /^image\//.test(file.type) || /\.(png|jpe?g|webp|bmp|gif|tga|tiff?)$/i.test(file.name);

const MAX_TEXTURE_SIDE = 2048;

/** 读入图片文件为像素数组（过大时缩小到 2048） */
export async function loadTextureImages(files: File[]): Promise<TextureMap> {
  const map: TextureMap = new Map();
  for (const file of files) {
    if (!isImageFile(file)) continue;
    try {
      const bmp = await createImageBitmap(file);
      const s = Math.min(1, MAX_TEXTURE_SIDE / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * s));
      const h = Math.max(1, Math.round(bmp.height * s));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;
      ctx.drawImage(bmp, 0, 0, w, h);
      map.set(textureKey(file.name), { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data });
      bmp.close?.();
    } catch {
      /* 解码失败的贴图忽略 */
    }
  }
  return map;
}

/** 解析 MTL 的 map_Kd（兼容 `-s 1 1 1 -o 0 0 0 file.png` 等选项），返回 材质名 → 贴图键 */
export function parseMtlTextures(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('newmtl ')) {
      current = line.slice(7).trim();
      continue;
    }
    if (current && (lower.startsWith('map_kd ') || lower.startsWith('map_ka '))) {
      if (lower.startsWith('map_ka ') && out.has(current)) continue;
      // 去掉所有选项（以 - 开头，带 1~3 个数字参数），取最后的文件名（可能含空格）
      const tokens = line.slice(7).trim().split(/\s+/);
      let i = 0;
      while (i < tokens.length && tokens[i].startsWith('-')) {
        i++;
        while (i < tokens.length && /^[-+]?[\d.]+$/.test(tokens[i])) i++;
      }
      const file = tokens.slice(i).join(' ');
      if (file) out.set(current, textureKey(file));
    }
  }
  return out;
}

const toLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const toSrgb = (l: number): number => {
  const c = Math.max(0, Math.min(1, l));
  return 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
};
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = toLinear(i);

/** 双线性采样（重复寻址，OBJ 的 v 向上 → 图像 y 向下），返回线性空间 rgb */
function sampleLinear(tex: TextureImage, u: number, v: number, out: number[]) {
  const { width: W, height: H, data } = tex;
  let fx = (u - Math.floor(u)) * W - 0.5;
  let fy = (1 - (v - Math.floor(v))) * H - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const px = (x: number, y: number, c: number) => {
    const xx = ((x % W) + W) % W, yy = ((y % H) + H) % H;
    return LIN[data[(yy * W + xx) * 4 + c]];
  };
  for (let c = 0; c < 3; c++) {
    const a = px(x0, y0, c) * (1 - tx) + px(x0 + 1, y0, c) * tx;
    const b = px(x0, y0 + 1, c) * (1 - tx) + px(x0 + 1, y0 + 1, c) * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
}

const BARY: Array<[number, number, number]> = [
  [1 / 3, 1 / 3, 1 / 3],
  [2 / 3, 1 / 6, 1 / 6],
  [1 / 6, 2 / 3, 1 / 6],
  [1 / 6, 1 / 6, 2 / 3],
];

/** 三角形内多点采样平均 → 打包 sRGB */
function sampleTriangleColor(
  tex: TextureImage,
  u0: number, v0: number, u1: number, v1: number, u2: number, v2: number,
): number {
  const tmp = [0, 0, 0];
  let r = 0, g = 0, b = 0;
  for (const [a, bb, c] of BARY) {
    sampleLinear(tex, a * u0 + bb * u1 + c * u2, a * v0 + bb * v1 + c * v2, tmp);
    r += tmp[0]; g += tmp[1]; b += tmp[2];
  }
  const n = BARY.length;
  return (
    (Math.round(toSrgb(r / n)) << 16) | (Math.round(toSrgb(g / n)) << 8) | Math.round(toSrgb(b / n))
  );
}

export type TexturedSource = {
  /** 已按最终坐标系变换好的顶点 xyz */
  positions: ArrayLike<number>;
  /** 三角形（顶点索引） */
  triangles: Array<[number, number, number]>;
  /** vt 表 */
  uvs: Array<[number, number]>;
  /** 每三角形三个角的 vt 下标（无则 -1） */
  triangleUV: Array<[number, number, number]>;
  /** 每三角形的贴图（无贴图的面为 null） */
  faceTexture: Array<TextureImage | null>;
  /** 无贴图面的回退色 */
  fallbackColor: ArrayLike<number>;
};

/**
 * 把带贴图的网格展开成「非索引」三角形（顶点之后由 weldMesh 焊接），并按贴图像素数细分。
 * @param budget 目标三角面数上限
 */
export function buildTexturedTriangles(
  src: TexturedSource,
  budget: number,
): { positions: Float64Array; faces: Int32Array; faceColor: Int32Array } {
  const m = src.triangles.length;
  // 每面的贴图覆盖像素数
  const footprint = new Float64Array(m);
  for (let t = 0; t < m; t++) {
    const tex = src.faceTexture[t];
    const uv = src.triangleUV[t];
    if (!tex || uv[0] < 0 || uv[1] < 0 || uv[2] < 0) continue;
    const [ua, va] = src.uvs[uv[0]], [ub, vb] = src.uvs[uv[1]], [uc, vc] = src.uvs[uv[2]];
    footprint[t] = Math.abs((ub - ua) * (vc - va) - (uc - ua) * (vb - va)) * 0.5 * tex.width * tex.height;
  }

  const level = new Uint8Array(m);
  const levelsFor = (tau: number): number => {
    let total = 0;
    for (let t = 0; t < m; t++) {
      let L = 0;
      if (footprint[t] > 0) {
        L = Math.ceil(Math.log(Math.max(1e-9, footprint[t] / tau)) / Math.log(4));
        L = Math.max(0, Math.min(4, L));
      }
      level[t] = L;
      total += 4 ** L;
    }
    return total;
  };
  // 二分「每个子面至少覆盖 tau 个像素」，使总面数 ≤ budget
  let lo = 0.5, hi = 4096;
  if (levelsFor(lo) <= budget) hi = lo;
  else {
    for (let it = 0; it < 22; it++) {
      const mid = Math.sqrt(lo * hi);
      if (levelsFor(mid) <= budget) hi = mid;
      else lo = mid;
    }
  }
  levelsFor(hi);

  const pos: number[] = [];
  const col: number[] = [];
  const P = src.positions;

  const emit = (
    ax: number, ay: number, az: number, au: number, av: number,
    bx: number, by: number, bz: number, bu: number, bv: number,
    cx: number, cy: number, cz: number, cu: number, cv: number,
    L: number, tex: TextureImage,
  ) => {
    if (L <= 0) {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      col.push(sampleTriangleColor(tex, au, av, bu, bv, cu, cv));
      return;
    }
    const abx = (ax + bx) / 2, aby = (ay + by) / 2, abz = (az + bz) / 2, abu = (au + bu) / 2, abv = (av + bv) / 2;
    const bcx = (bx + cx) / 2, bcy = (by + cy) / 2, bcz = (bz + cz) / 2, bcu = (bu + cu) / 2, bcv = (bv + cv) / 2;
    const cax = (cx + ax) / 2, cay = (cy + ay) / 2, caz = (cz + az) / 2, cau = (cu + au) / 2, cav = (cv + av) / 2;
    const n = L - 1;
    emit(ax, ay, az, au, av, abx, aby, abz, abu, abv, cax, cay, caz, cau, cav, n, tex);
    emit(abx, aby, abz, abu, abv, bx, by, bz, bu, bv, bcx, bcy, bcz, bcu, bcv, n, tex);
    emit(cax, cay, caz, cau, cav, bcx, bcy, bcz, bcu, bcv, cx, cy, cz, cu, cv, n, tex);
    emit(abx, aby, abz, abu, abv, bcx, bcy, bcz, bcu, bcv, cax, cay, caz, cau, cav, n, tex);
  };

  for (let t = 0; t < m; t++) {
    const [ia, ib, ic] = src.triangles[t];
    const tex = src.faceTexture[t];
    const uv = src.triangleUV[t];
    if (tex && uv[0] >= 0 && uv[1] >= 0 && uv[2] >= 0) {
      const [ua, va] = src.uvs[uv[0]], [ub, vb] = src.uvs[uv[1]], [uc, vc] = src.uvs[uv[2]];
      // 跨 UV 接缝的面（u/v 相差过大）不细分，避免插值乱采样
      const seam = Math.max(Math.abs(ua - ub), Math.abs(ub - uc), Math.abs(uc - ua),
        Math.abs(va - vb), Math.abs(vb - vc), Math.abs(vc - va)) > 0.5;
      emit(
        P[ia * 3], P[ia * 3 + 1], P[ia * 3 + 2], ua, va,
        P[ib * 3], P[ib * 3 + 1], P[ib * 3 + 2], ub, vb,
        P[ic * 3], P[ic * 3 + 1], P[ic * 3 + 2], uc, vc,
        seam ? 0 : level[t], tex,
      );
    } else {
      pos.push(
        P[ia * 3], P[ia * 3 + 1], P[ia * 3 + 2],
        P[ib * 3], P[ib * 3 + 1], P[ib * 3 + 2],
        P[ic * 3], P[ic * 3 + 1], P[ic * 3 + 2],
      );
      col.push(src.fallbackColor[t]);
    }
  }

  const n = col.length;
  const faces = new Int32Array(n * 3);
  for (let i = 0; i < n * 3; i++) faces[i] = i;
  return { positions: Float64Array.from(pos), faces, faceColor: Int32Array.from(col) };
}
