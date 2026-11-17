/**
 * 参数区间规范化
 *
 * Desmos 的参数曲线 t、参数曲面 u/v 默认只取 [0,1]，写在 \left\{0\le u\le 2\pi\right\}
 * 里的限制式**不会扩大**区间，只会在 [0,1] 内再裁剪——这正是「曲面只画出一小片、填色残缺」的根因。
 * 这里把这类限制式改写成表达式的区间字段：
 *   · 2D / 3D 曲线 t → parametricDomain
 *   · 3D 曲面 u、v → parametricDomain3Du / parametricDomain3Dv
 * 没写区间、但以裸参数做三角函数自变量（\cos(u)、\sin v…）时，按整周 [0,2π] 补全。
 */

export type DomainBound = { min: string; max: string };

export type ParametricDomainResult = {
  latex: string;
  parametricDomain?: DomainBound;
  parametricDomain3Du?: DomainBound;
  parametricDomain3Dv?: DomainBound;
};

type Group = { start: number; end: number; inner: string };

const OPEN_LEFT = '\\left\\{';
const CLOSE_RIGHT = '\\right\\}';

/** 找出顶层（不在括号/方括号内）的限制式 {…} 组 */
function findTopLevelRestrictionGroups(latex: string): Group[] {
  const groups: Group[] = [];
  let depth = 0;
  let i = 0;
  while (i < latex.length) {
    if (latex.startsWith(OPEN_LEFT, i) || latex.startsWith('\\{', i)) {
      const openLen = latex.startsWith(OPEN_LEFT, i) ? OPEN_LEFT.length : 2;
      let j = i + openLen;
      let braceDepth = 1;
      let innerEnd = -1;
      let closeLen = 0;
      while (j < latex.length) {
        if (latex.startsWith(OPEN_LEFT, j)) { braceDepth++; j += OPEN_LEFT.length; continue; }
        if (latex.startsWith('\\{', j)) { braceDepth++; j += 2; continue; }
        if (latex.startsWith(CLOSE_RIGHT, j)) {
          braceDepth--;
          if (braceDepth === 0) { innerEnd = j; closeLen = CLOSE_RIGHT.length; break; }
          j += CLOSE_RIGHT.length;
          continue;
        }
        if (latex.startsWith('\\}', j)) {
          braceDepth--;
          if (braceDepth === 0) { innerEnd = j; closeLen = 2; break; }
          j += 2;
          continue;
        }
        j++;
      }
      if (innerEnd < 0) break;
      if (depth === 0) {
        groups.push({ start: i, end: innerEnd + closeLen, inner: latex.slice(i + openLen, innerEnd) });
      }
      i = innerEnd + closeLen;
      continue;
    }
    const ch = latex[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    i++;
  }
  return groups;
}

/** 按顶层逗号切分 */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === sep && depth === 0) {
      parts.push(s.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts;
}

const CMP_RE = /\\leq?(?![a-zA-Z])|\\geq?(?![a-zA-Z])|\\lt(?![a-zA-Z])|\\gt(?![a-zA-Z])|<=?|>=?/g;

/** 解析 a\le u\le b、u\le b、a\le u、b\ge u\ge a 等 */
function parseDomainCondition(part: string, vars: string[]): { v: string; min?: string; max?: string } | null {
  const tokens: string[] = [];
  const ops: ('lt' | 'gt')[] = [];
  let last = 0;
  let depth = 0;
  for (let i = 0; i < part.length; i++) {
    const ch = part[i];
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (depth !== 0) continue;
    CMP_RE.lastIndex = i;
    const m = CMP_RE.exec(part);
    if (m && m.index === i) {
      tokens.push(part.slice(last, i));
      ops.push(/^(\\le|\\lt|<)/.test(m[0]) ? 'lt' : 'gt');
      i += m[0].length - 1;
      last = i + 1;
    }
  }
  tokens.push(part.slice(last));
  const clean = tokens.map(t => t.replace(/\\left|\\right/g, '').trim());
  if (clean.some(t => !t)) return null;

  const isVar = (t: string) => vars.includes(t);
  if (clean.length === 3 && isVar(clean[1]) && ops[0] === ops[1]) {
    const v = clean[1];
    if (mentionsVar(clean[0], v) || mentionsVar(clean[2], v)) return null;
    return ops[0] === 'lt' ? { v, min: clean[0], max: clean[2] } : { v, min: clean[2], max: clean[0] };
  }
  if (clean.length === 2) {
    if (isVar(clean[0]) && !mentionsVar(clean[1], clean[0])) {
      return ops[0] === 'lt' ? { v: clean[0], max: clean[1] } : { v: clean[0], min: clean[1] };
    }
    if (isVar(clean[1]) && !mentionsVar(clean[0], clean[1])) {
      return ops[0] === 'lt' ? { v: clean[1], min: clean[0] } : { v: clean[1], max: clean[0] };
    }
  }
  return null;
}

/** 去掉命令名、下标后判断是否以自由变量出现 */
function stripForScan(latex: string): string {
  return latex
    .replace(/\\operatorname\{[a-zA-Z]+\}/g, ' ')
    .replace(/_\{[^{}]*\}|_[a-zA-Z0-9]/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ');
}

function mentionsVar(latex: string, v: string): boolean {
  return new RegExp(`(?<![a-zA-Z.])${v}(?![a-zA-Z])`).test(stripForScan(latex));
}

/** for / with 里把参数名当局部变量绑定时，不能动它的区间 */
function isBoundLocally(latex: string, v: string): boolean {
  return new RegExp(String.raw`\\operatorname\{(?:for|with)\}[^=]*?(?<![a-zA-Z])${v}\s*=`).test(latex);
}

/** 顶层是否有 = 号（函数/变量定义、隐式方程），这类表达式不改区间 */
function hasTopLevelEquals(latex: string): boolean {
  let depth = 0;
  for (let i = 0; i < latex.length; i++) {
    const ch = latex[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) return true;
  }
  return false;
}

/** 裸参数（或整数倍）作三角函数自变量，且没有出现 π·参数 的归一化写法 → 需要整周区间 */
function wantsFullTurn(latex: string, v: string): boolean {
  const piScaled = new RegExp(
    String.raw`\\pi\s*(?:\\cdot|\*)?\s*(?:\\left\()?\s*${v}(?![a-zA-Z])|(?<![a-zA-Z])${v}\s*(?:\\cdot|\*)?\s*\\pi`,
  );
  if (piScaled.test(latex)) return false;
  const trigArg = new RegExp(
    String.raw`\\(?:sin|cos|tan|sec|csc|cot)\s*(?:\^\{?[0-9]+\}?)?\s*(?:(?:\\left)?\(\s*[0-9.]*\s*${v}\s*(?:\\right)?\)|[0-9.]*\s*${v}(?![a-zA-Z]))`,
  );
  return trigArg.test(latex);
}

/**
 * 把限制式里的参数区间转成 Desmos 区间字段；is3D 决定 u/v 是否算参数
 */
export function normalizeParametricDomains(latex: string, is3D: boolean): ParametricDomainResult {
  const result: ParametricDomainResult = { latex };
  if (!latex || hasTopLevelEquals(latex.replace(/\\left\\\{[\s\S]*?\\right\\\}/g, ''))) return result;

  const params = is3D ? ['u', 'v', 't'] : ['t'];
  const groups = findTopLevelRestrictionGroups(latex);
  const found: Record<string, { min?: string; max?: string }> = {};
  const removals: Group[] = [];

  for (const g of groups) {
    if (g.inner.includes(':')) continue;
    const parts = splitTopLevel(g.inner, ',');
    const parsed = parts.map(p => parseDomainCondition(p, params));
    if (parsed.some(p => !p)) continue;
    for (const p of parsed) {
      const cur = (found[p!.v] ??= {});
      if (p!.min !== undefined) cur.min = p!.min;
      if (p!.max !== undefined) cur.max = p!.max;
    }
    removals.push(g);
  }

  let body = latex;
  for (const g of [...removals].sort((a, b) => b.start - a.start)) {
    body = body.slice(0, g.start) + body.slice(g.end);
  }
  body = body.trim();

  const domains: Record<string, DomainBound> = {};
  for (const v of params) {
    if (!mentionsVar(body, v) || isBoundLocally(body, v)) {
      delete found[v];
      continue;
    }
    if (found[v]) {
      domains[v] = { min: found[v].min ?? '0', max: found[v].max ?? '1' };
    } else if (wantsFullTurn(body, v)) {
      domains[v] = { min: '0', max: '2\\pi' };
    }
  }

  // 被移走的限制式里如果有参数已不在式中，保留原式不动
  const removedVars = removals.flatMap(g => splitTopLevel(g.inner, ',').map(p => parseDomainCondition(p, params)!.v));
  if (removedVars.some(v => !domains[v])) {
    const fallback: ParametricDomainResult = { latex };
    for (const v of params) {
      if (!domains[v] || removedVars.includes(v)) continue;
      assignDomain(fallback, v, domains[v], is3D);
    }
    return fallback;
  }

  result.latex = body;
  for (const v of Object.keys(domains)) assignDomain(result, v, domains[v], is3D);
  return result;
}

function assignDomain(out: ParametricDomainResult, v: string, d: DomainBound, is3D: boolean) {
  if (v === 't') out.parametricDomain = d;
  else if (is3D && v === 'u') out.parametricDomain3Du = d;
  else if (is3D && v === 'v') out.parametricDomain3Dv = d;
}
