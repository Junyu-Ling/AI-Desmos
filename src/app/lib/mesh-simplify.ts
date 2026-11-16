/**
 * mesh-simplify.ts — 保形 + 保色的网格简化
 *
 * 旧做法是「按分数挑三角形、其余直接丢掉」，会在表面上开洞。
 * 这里改用 Garland–Heckbert 二次误差度量（QEM）边折叠：
 *   · 每个顶点累计「到所在平面的距离平方」二次型，折叠后位置取误差最小点；
 *   · 开放边界加垂直约束面，轮廓不收缩；
 *   · 额外加入颜色误差项：折叠会让周围三角形颜色偏离其面积加权平均色的程度计入代价，
 *     所以「几何平坦但上了色」的区域（顶点色 / 贴图绘制）不会被整片塌掉；
 *   · 拒绝让三角形法线翻转 / 破坏流形链接条件的折叠。
 *
 * 超大网格（> 24 万面）先用顶点聚类粗降到约 12 万面，再交给 QEM 精修。
 */

export type SimplifyMesh = {
  /** xyz × n */
  positions: Float64Array;
  /** 三角形顶点索引 × 3m */
  faces: Int32Array;
  /** 每面打包 RGB（r<<16|g<<8|b） */
  faceColor: Int32Array;
};

/** 按 1e-5·包围盒对角线 焊接重合顶点，并去掉退化三角形 */
export function weldMesh(mesh: SimplifyMesh): SimplifyMesh {
  const { positions, faces, faceColor } = mesh;
  const n = positions.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  const q = 1 / (diag * 1e-5);
  const keyMap = new Map<string, number>();
  const remap = new Int32Array(n);
  const outPos: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const k = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = keyMap.get(k);
    if (id === undefined) {
      id = outPos.length / 3;
      keyMap.set(k, id);
      outPos.push(x, y, z);
    }
    remap[i] = id;
  }
  const outFaces: number[] = [];
  const outColor: number[] = [];
  for (let f = 0; f < faces.length / 3; f++) {
    const a = remap[faces[f * 3]], b = remap[faces[f * 3 + 1]], c = remap[faces[f * 3 + 2]];
    if (a === b || b === c || a === c) continue;
    outFaces.push(a, b, c);
    outColor.push(faceColor[f]);
  }
  return {
    positions: Float64Array.from(outPos),
    faces: Int32Array.from(outFaces),
    faceColor: Int32Array.from(outColor),
  };
}

/** 顶点聚类：二分格子尺寸，直到剩余面数接近目标 */
function clusterReduce(mesh: SimplifyMesh, targetFaces: number): SimplifyMesh {
  const { positions, faces, faceColor } = mesh;
  const n = positions.length / 3;
  const m = faces.length / 3;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const ext = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;

  const run = (cells: number) => {
    const cs = ext / cells;
    const cellOf = new Int32Array(n);
    const ids = new Map<number, number>();
    const sum: number[] = [];
    const cnt: number[] = [];
    for (let i = 0; i < n; i++) {
      const ix = Math.floor((positions[i * 3] - minX) / cs);
      const iy = Math.floor((positions[i * 3 + 1] - minY) / cs);
      const iz = Math.floor((positions[i * 3 + 2] - minZ) / cs);
      const key = (ix * 4096 + iy) * 4096 + iz;
      let id = ids.get(key);
      if (id === undefined) {
        id = cnt.length;
        ids.set(key, id);
        sum.push(0, 0, 0);
        cnt.push(0);
      }
      cellOf[i] = id;
      sum[id * 3] += positions[i * 3];
      sum[id * 3 + 1] += positions[i * 3 + 1];
      sum[id * 3 + 2] += positions[i * 3 + 2];
      cnt[id]++;
    }
    const outFaces: number[] = [];
    const outColor: number[] = [];
    const seen = new Set<string>();
    for (let f = 0; f < m; f++) {
      const a = cellOf[faces[f * 3]], b = cellOf[faces[f * 3 + 1]], c = cellOf[faces[f * 3 + 2]];
      if (a === b || b === c || a === c) continue;
      const sorted = [a, b, c].sort((p, q) => p - q);
      const k = `${sorted[0]},${sorted[1]},${sorted[2]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      outFaces.push(a, b, c);
      outColor.push(faceColor[f]);
    }
    const outPos = new Float64Array(cnt.length * 3);
    for (let i = 0; i < cnt.length; i++) {
      outPos[i * 3] = sum[i * 3] / cnt[i];
      outPos[i * 3 + 1] = sum[i * 3 + 1] / cnt[i];
      outPos[i * 3 + 2] = sum[i * 3 + 2] / cnt[i];
    }
    return {
      positions: outPos,
      faces: Int32Array.from(outFaces),
      faceColor: Int32Array.from(outColor),
    } as SimplifyMesh;
  };

  let lo = 8, hi = 2000;
  let best = run(lo);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const r = run(mid);
    if (r.faces.length / 3 <= targetFaces) {
      best = r;
      lo = mid;
    } else {
      hi = mid - 1;
    }
    if (hi - lo <= 2) break;
  }
  return best;
}

type HeapItem = {
  u: number;
  v: number;
  cost: number;
  vu: number;
  vv: number;
  x: number;
  y: number;
  z: number;
};

class MinHeap {
  private a: HeapItem[] = [];
  get size() {
    return this.a.length;
  }
  push(it: HeapItem) {
    const a = this.a;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): HeapItem | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      const n = a.length;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < n && a[l].cost < a[s].cost) s = l;
        if (r < n && a[r].cost < a[s].cost) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

export type SimplifyOptions = {
  /** 颜色误差权重（越大越保色），单位≈世界坐标² */
  colorWeight?: number;
  /** 开放边界约束强度 */
  boundaryWeight?: number;
};

export function simplifyMesh(
  input: SimplifyMesh,
  targetFaces: number,
  options: SimplifyOptions = {},
): SimplifyMesh {
  let mesh = weldMesh(input);
  if (mesh.faces.length / 3 <= targetFaces) return mesh;

  if (mesh.faces.length / 3 > 240000) {
    mesh = weldMesh(clusterReduce(mesh, 120000));
    if (mesh.faces.length / 3 <= targetFaces) return mesh;
  }

  const colorWeight = options.colorWeight ?? 0.05;
  const boundaryWeight = options.boundaryWeight ?? 6;

  const nV = mesh.positions.length / 3;
  const nF = mesh.faces.length / 3;
  const P = Float64Array.from(mesh.positions);
  const F = Int32Array.from(mesh.faces);
  const colR = new Float32Array(nF);
  const colG = new Float32Array(nF);
  const colB = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    const c = mesh.faceColor[f];
    colR[f] = ((c >> 16) & 255) / 255;
    colG[f] = ((c >> 8) & 255) / 255;
    colB[f] = (c & 255) / 255;
  }

  const faceAlive = new Uint8Array(nF).fill(1);
  const vertAlive = new Uint8Array(nV).fill(1);
  const vertVer = new Int32Array(nV);
  const vertFaces: number[][] = Array.from({ length: nV }, () => []);
  for (let f = 0; f < nF; f++) {
    vertFaces[F[f * 3]].push(f);
    vertFaces[F[f * 3 + 1]].push(f);
    vertFaces[F[f * 3 + 2]].push(f);
  }

  // 二次型 10 个分量：a2 ab ac ad b2 bc bd c2 cd d2
  const Q = new Float64Array(nV * 10);
  const addPlane = (vi: number, a: number, b: number, c: number, d: number, w: number) => {
    const o = vi * 10;
    Q[o] += w * a * a;
    Q[o + 1] += w * a * b;
    Q[o + 2] += w * a * c;
    Q[o + 3] += w * a * d;
    Q[o + 4] += w * b * b;
    Q[o + 5] += w * b * c;
    Q[o + 6] += w * b * d;
    Q[o + 7] += w * c * c;
    Q[o + 8] += w * c * d;
    Q[o + 9] += w * d * d;
  };

  const faceArea = new Float64Array(nF);
  const faceNx = new Float64Array(nF);
  const faceNy = new Float64Array(nF);
  const faceNz = new Float64Array(nF);

  const computeFaceGeom = (f: number) => {
    const a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz);
    faceArea[f] = L / 2;
    if (L > 1e-20) {
      faceNx[f] = nx / L;
      faceNy[f] = ny / L;
      faceNz[f] = nz / L;
    } else {
      faceNx[f] = faceNy[f] = faceNz[f] = 0;
    }
  };

  for (let f = 0; f < nF; f++) {
    computeFaceGeom(f);
    const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
    const nx = faceNx[f], ny = faceNy[f], nz = faceNz[f];
    const d = -(nx * P[a * 3] + ny * P[a * 3 + 1] + nz * P[a * 3 + 2]);
    const w = faceArea[f];
    addPlane(a, nx, ny, nz, d, w);
    addPlane(b, nx, ny, nz, d, w);
    addPlane(c, nx, ny, nz, d, w);
  }

  // 开放边界：加垂直于该面且过该边的约束面
  const edgeFaceCount = new Map<number, number>();
  const ekey = (a: number, b: number) => (a < b ? a * nV + b : b * nV + a);
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < 3; k++) {
      const key = ekey(F[f * 3 + k], F[f * 3 + ((k + 1) % 3)]);
      edgeFaceCount.set(key, (edgeFaceCount.get(key) || 0) + 1);
    }
  }
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < 3; k++) {
      const a = F[f * 3 + k], b = F[f * 3 + ((k + 1) % 3)];
      if (edgeFaceCount.get(ekey(a, b)) !== 1) continue;
      const ex = P[b * 3] - P[a * 3], ey = P[b * 3 + 1] - P[a * 3 + 1], ez = P[b * 3 + 2] - P[a * 3 + 2];
      // n_b = e × n_face
      let bx = ey * faceNz[f] - ez * faceNy[f];
      let by = ez * faceNx[f] - ex * faceNz[f];
      let bz = ex * faceNy[f] - ey * faceNx[f];
      const L = Math.hypot(bx, by, bz);
      if (L < 1e-20) continue;
      bx /= L;
      by /= L;
      bz /= L;
      const d = -(bx * P[a * 3] + by * P[a * 3 + 1] + bz * P[a * 3 + 2]);
      const w = boundaryWeight * (ex * ex + ey * ey + ez * ez);
      addPlane(a, bx, by, bz, d, w);
      addPlane(b, bx, by, bz, d, w);
    }
  }

  const quadricError = (o: number, x: number, y: number, z: number) =>
    Q[o] * x * x + 2 * Q[o + 1] * x * y + 2 * Q[o + 2] * x * z + 2 * Q[o + 3] * x +
    Q[o + 4] * y * y + 2 * Q[o + 5] * y * z + 2 * Q[o + 6] * y +
    Q[o + 7] * z * z + 2 * Q[o + 8] * z + Q[o + 9];

  const tmpQ = new Float64Array(10);

  /** 颜色误差：u、v 周围的存活面相对其面积加权平均色的方差 */
  const colorError = (u: number, v: number): number => {
    let sw = 0, sr = 0, sg = 0, sb = 0;
    let sr2 = 0, sg2 = 0, sb2 = 0;
    const visit = (vi: number) => {
      for (const f of vertFaces[vi]) {
        if (!faceAlive[f]) continue;
        const w = faceArea[f];
        sw += w;
        sr += w * colR[f];
        sg += w * colG[f];
        sb += w * colB[f];
        sr2 += w * colR[f] * colR[f];
        sg2 += w * colG[f] * colG[f];
        sb2 += w * colB[f] * colB[f];
      }
    };
    visit(u);
    visit(v);
    if (sw <= 0) return 0;
    const varR = sr2 - (sr * sr) / sw;
    const varG = sg2 - (sg * sg) / sw;
    const varB = sb2 - (sb * sb) / sw;
    // 重复统计共享面的影响很小，忽略
    return Math.max(0, varR + varG + varB);
  };

  const evalEdge = (u: number, v: number): HeapItem => {
    const ou = u * 10, ov = v * 10;
    for (let i = 0; i < 10; i++) tmpQ[i] = Q[ou + i] + Q[ov + i];
    const q = tmpQ;
    let x: number, y: number, z: number;
    // 解 [A]x = -[b]
    const a00 = q[0], a01 = q[1], a02 = q[2], a11 = q[4], a12 = q[5], a22 = q[7];
    const b0 = -q[3], b1 = -q[6], b2 = -q[8];
    const det =
      a00 * (a11 * a22 - a12 * a12) - a01 * (a01 * a22 - a12 * a02) + a02 * (a01 * a12 - a11 * a02);
    const err = (px: number, py: number, pz: number) =>
      q[0] * px * px + 2 * q[1] * px * py + 2 * q[2] * px * pz + 2 * q[3] * px +
      q[4] * py * py + 2 * q[5] * py * pz + 2 * q[6] * py +
      q[7] * pz * pz + 2 * q[8] * pz + q[9];
    const ux = P[u * 3], uy = P[u * 3 + 1], uz = P[u * 3 + 2];
    const vx = P[v * 3], vy = P[v * 3 + 1], vz = P[v * 3 + 2];
    const mx = (ux + vx) / 2, my = (uy + vy) / 2, mz = (uz + vz) / 2;
    const scale = Math.abs(a00) + Math.abs(a11) + Math.abs(a22) + 1e-30;
    let best = Infinity;
    x = mx; y = my; z = mz;
    if (Math.abs(det) > 1e-9 * scale * scale * scale) {
      const dx =
        (b0 * (a11 * a22 - a12 * a12) - a01 * (b1 * a22 - a12 * b2) + a02 * (b1 * a12 - a11 * b2)) / det;
      const dy =
        (a00 * (b1 * a22 - a12 * b2) - b0 * (a01 * a22 - a12 * a02) + a02 * (a01 * b2 - b1 * a02)) / det;
      const dz =
        (a00 * (a11 * b2 - b1 * a12) - a01 * (a01 * b2 - b1 * a02) + b0 * (a01 * a12 - a11 * a02)) / det;
      // 最优点别飞太远
      const edgeLen = Math.hypot(ux - vx, uy - vy, uz - vz);
      if (Math.hypot(dx - mx, dy - my, dz - mz) < 2 * edgeLen + 1e-12) {
        const e = err(dx, dy, dz);
        if (e < best) {
          best = e;
          x = dx; y = dy; z = dz;
        }
      }
    }
    for (const [cx, cy, cz] of [[ux, uy, uz], [vx, vy, vz], [mx, my, mz]] as const) {
      const e = err(cx, cy, cz);
      if (e < best) {
        best = e;
        x = cx; y = cy; z = cz;
      }
    }
    const cost = Math.max(0, best) + colorWeight * colorError(u, v);
    return { u, v, cost, vu: vertVer[u], vv: vertVer[v], x, y, z };
  };

  const heap = new MinHeap();
  const pushed = new Set<number>();
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < 3; k++) {
      const a = F[f * 3 + k], b = F[f * 3 + ((k + 1) % 3)];
      const key = ekey(a, b);
      if (pushed.has(key)) continue;
      pushed.add(key);
      heap.push(evalEdge(Math.min(a, b), Math.max(a, b)));
    }
  }
  pushed.clear();

  let faceCount = nF;

  const neighbors = (vi: number): Set<number> => {
    const s = new Set<number>();
    for (const f of vertFaces[vi]) {
      if (!faceAlive[f]) continue;
      for (let k = 0; k < 3; k++) {
        const w = F[f * 3 + k];
        if (w !== vi) s.add(w);
      }
    }
    return s;
  };

  /** 折叠后三角形法线是否翻转 / 退化 */
  const wouldFlip = (u: number, v: number, nx: number, ny: number, nz: number): boolean => {
    for (const vi of [u, v]) {
      for (const f of vertFaces[vi]) {
        if (!faceAlive[f]) continue;
        const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
        const hasU = a === u || b === u || c === u;
        const hasV = a === v || b === v || c === v;
        if (hasU && hasV) continue; // 将被删除
        const pa = a === u || a === v ? [nx, ny, nz] : [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
        const pb = b === u || b === v ? [nx, ny, nz] : [P[b * 3], P[b * 3 + 1], P[b * 3 + 2]];
        const pc = c === u || c === v ? [nx, ny, nz] : [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
        const e1x = pb[0] - pa[0], e1y = pb[1] - pa[1], e1z = pb[2] - pa[2];
        const e2x = pc[0] - pa[0], e2y = pc[1] - pa[1], e2z = pc[2] - pa[2];
        const cx = e1y * e2z - e1z * e2y;
        const cy = e1z * e2x - e1x * e2z;
        const cz = e1x * e2y - e1y * e2x;
        const L = Math.hypot(cx, cy, cz);
        if (L < 1e-14) return true;
        const dot = (cx * faceNx[f] + cy * faceNy[f] + cz * faceNz[f]) / L;
        if (dot < 0.25) return true;
      }
    }
    return false;
  };

  let guard = 0;
  const maxIter = nF * 8;
  while (faceCount > targetFaces && heap.size > 0 && guard++ < maxIter) {
    const it = heap.pop()!;
    const { u, v } = it;
    if (!vertAlive[u] || !vertAlive[v]) continue;
    if (it.vu !== vertVer[u] || it.vv !== vertVer[v]) continue;

    // 链接条件：共有邻点数 == 共享面数
    const nu = neighbors(u);
    const nv = neighbors(v);
    if (!nu.has(v)) continue;
    let common = 0;
    for (const w of nu) if (nv.has(w)) common++;
    let shared = 0;
    for (const f of vertFaces[u]) {
      if (!faceAlive[f]) continue;
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      if (a === v || b === v || c === v) shared++;
    }
    if (common !== shared) continue;
    if (wouldFlip(u, v, it.x, it.y, it.z)) continue;

    // 执行折叠：v → u
    for (const f of vertFaces[v]) {
      if (!faceAlive[f]) continue;
      const a = F[f * 3], b = F[f * 3 + 1], c = F[f * 3 + 2];
      if (a === u || b === u || c === u) {
        faceAlive[f] = 0;
        faceCount--;
        continue;
      }
      if (a === v) F[f * 3] = u;
      else if (b === v) F[f * 3 + 1] = u;
      else F[f * 3 + 2] = u;
      vertFaces[u].push(f);
    }
    vertAlive[v] = 0;
    vertFaces[v] = [];
    P[u * 3] = it.x;
    P[u * 3 + 1] = it.y;
    P[u * 3 + 2] = it.z;
    for (let i = 0; i < 10; i++) Q[u * 10 + i] += Q[v * 10 + i];
    vertVer[u]++;
    // 清理 u 的死面，刷新受影响面的几何
    vertFaces[u] = vertFaces[u].filter(f => faceAlive[f]);
    for (const f of vertFaces[u]) computeFaceGeom(f);
    for (const w of neighbors(u)) {
      heap.push(evalEdge(Math.min(u, w), Math.max(u, w)));
    }
  }

  // 压缩输出
  const remap = new Int32Array(nV).fill(-1);
  const outPos: number[] = [];
  const outFaces: number[] = [];
  const outColor: number[] = [];
  for (let f = 0; f < nF; f++) {
    if (!faceAlive[f]) continue;
    const idx = [F[f * 3], F[f * 3 + 1], F[f * 3 + 2]];
    if (idx[0] === idx[1] || idx[1] === idx[2] || idx[0] === idx[2]) continue;
    for (let k = 0; k < 3; k++) {
      if (remap[idx[k]] < 0) {
        remap[idx[k]] = outPos.length / 3;
        outPos.push(P[idx[k] * 3], P[idx[k] * 3 + 1], P[idx[k] * 3 + 2]);
      }
      outFaces.push(remap[idx[k]]);
    }
    outColor.push(mesh.faceColor[f]);
  }
  void quadricError;
  return {
    positions: Float64Array.from(outPos),
    faces: Int32Array.from(outFaces),
    faceColor: Int32Array.from(outColor),
  };
}
