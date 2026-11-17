/**
 * Desmos 自由变量校验 — 确保每个变量在引用前都有初值定义
 */

const RESERVED = new Set([
  'x', 'y', 'z', 't', 'u', 'v', 'e', 'pi', 'tau', 'theta', 'rho', 'phi', 'infty', 'infinity',
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp',
  'min', 'max', 'mod', 'floor', 'ceil', 'round', 'total', 'gcd', 'lcm',
  'mean', 'median', 'stdev', 'corr', 'var', 'length', 'count',
]);

const LATEX_CMD_RE = /\\[a-zA-Z]+/g;
const IDENT_RE = /(?<![\\a-zA-Z_])([a-zA-Z]_\{\d+\}|[a-zA-Z]_\d|[a-zA-Z](?![a-zA-Z_{]))/g;

/** 匹配变量赋值：a=1、W=30、h_{1}=0、C_{roof}=… */
const ASSIGN_RE = /^([a-zA-Z](?:_\{[a-zA-Z0-9]+\}|_[a-zA-Z0-9])?)\s*=(?!=)/;

/** 函数定义：f(x)=…、s_{phere}(u,v)=…、r_{x}\left(\theta,p\right)=… */
const FUNC_DEF_RE = /^([a-zA-Z](?:_\{[a-zA-Z0-9]+\}|_[a-zA-Z0-9])?)\s*(?:\\left)?\(([^()]*?)(?:\\right)?\)\s*=(?!=)/;

/** 坐标/参数名：x=3、y=x^2、z=…、r=… 是图形而不是变量赋值 */
const GRAPH_LHS = new Set(['x', 'y', 'z', 'r']);

const IDENT_TOKEN = String.raw`(?:[a-zA-Z]|\\[a-zA-Z]+)(?:_\{[a-zA-Z0-9]+\}|_[a-zA-Z0-9])?`;

/** for / with 绑定的局部变量：\operatorname{for}i=[1...10]、\operatorname{with}k=2,s=.1 */
function extractBoundVariables(latex: string): Set<string> {
  const bound = new Set<string>();
  const re = new RegExp(String.raw`\\operatorname\{(?:for|with)\}\s*`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(latex)) !== null) {
    let rest = latex.slice(m.index + m[0].length);
    const bindRe = new RegExp(String.raw`^\s*(${IDENT_TOKEN})\s*=`);
    let bm = bindRe.exec(rest);
    while (bm) {
      bound.add(bm[1].replace(/^\\/, ''));
      rest = rest.slice(bm[0].length);
      let depth = 0;
      let i = 0;
      for (; i < rest.length; i++) {
        const ch = rest[i];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') {
          if (depth === 0) break;
          depth--;
        } else if (ch === ',' && depth === 0) break;
      }
      if (rest[i] !== ',') break;
      rest = rest.slice(i + 1);
      bm = bindRe.exec(rest);
    }
  }
  return bound;
}

/** 解析函数定义，返回函数名与形参 */
export function parseFunctionDefinition(latex: string): { name: string; params: string[] } | null {
  const m = FUNC_DEF_RE.exec(latex.trim());
  if (!m) return null;
  const params = m[2]
    .split(',')
    .map(p => p.trim().replace(/^\\/, ''))
    .filter(Boolean);
  return { name: m[1], params };
}

const ZERO_DEFAULT = new Set(['h', 'k', 'c', 'd', 'o', 'u', 'v', 'x0', 'y0', 'cx', 'cy', 'ox', 'oy']);
const SPAN_DEFAULT = new Set(['w', 'W']);
const HEIGHT_DEFAULT = new Set(['h', 'H']);
const RADIUS_DEFAULT = new Set(['r', 'R']);

export function isReservedVariable(name: string): boolean {
  const base = name.replace(/_\{?\d+\}?$/i, '').toLowerCase();
  return RESERVED.has(base) || RESERVED.has(name.toLowerCase());
}

export function parseAssignmentVariable(latex: string): string | null {
  const m = ASSIGN_RE.exec(latex.trim());
  if (!m || GRAPH_LHS.has(m[1])) return null;
  return m[1];
}

export function isVariableAssignment(latex: string): boolean {
  return parseAssignmentVariable(latex) != null;
}

export function extractUsedVariables(latex: string): string[] {
  const local = extractBoundVariables(latex);
  const fn = parseFunctionDefinition(latex);
  if (fn) fn.params.forEach(p => local.add(p));
  const stripped = latex
    .replace(/\\operatorname\{[a-zA-Z]+\}/g, ' ')
    .replace(LATEX_CMD_RE, ' ')
    .replace(/\.(?:x|y|z)(?![a-zA-Z])/g, ' ')
    .replace(/(?<![_{\w])[0-9.]+/g, ' ');
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(IDENT_RE.source, 'g');
  while ((m = re.exec(stripped)) !== null) {
    const id = m[1];
    if (isReservedVariable(id) || local.has(id)) continue;
    // 紧跟括号的是函数调用（f(x)、g\left(…\right)），不自动补成变量
    const after = stripped.slice(m.index + m[0].length);
    if (/^\s*(?:\(|left\s*\()/.test(after) || /^\s*\(/.test(after)) continue;
    found.add(id);
  }
  if (fn) found.delete(fn.name);
  return Array.from(found);
}

/** 为未定义变量生成合理初值 */
export function getDefaultAssignment(varName: string): string {
  const v = varName;
  const lower = v.replace(/_\{?\d+\}?$/i, '').toLowerCase();

  if (ZERO_DEFAULT.has(lower) || ZERO_DEFAULT.has(v)) return `${v}=0`;
  if (SPAN_DEFAULT.has(v)) return `${v}=30`;
  if (HEIGHT_DEFAULT.has(v) && v === 'H') return `${v}=10`;
  if (RADIUS_DEFAULT.has(v)) return `${v}=2`;
  if (lower === 'n') return `${v}=5`;
  if (lower === 's') return `${v}=1`;
  return `${v}=1`;
}

/** 禁止单独定义 t/θ/u/v 滑块（Desmos 保留）；s 可用作缩放等普通变量 */
export function isBlockedSliderDefinition(latex: string): boolean {
  return /^\s*t\s*=\s*[-+]?\d/.test(latex)
    || /^\s*\\?theta\s*=\s*[-+]?\d/i.test(latex)
    || /^\s*[uv]\s*=\s*[-+]?\d/i.test(latex);
}

export type VariableInjectState = {
  definedVars: Set<string>;
  /** 由系统自动补全的变量（可被 AI 正式赋值覆盖） */
  autoDefinedVars: Set<string>;
  /** 变量 → Desmos 表达式 id，用于更新而非重复创建 */
  varExprIds: Map<string, string>;
  injectSeq: number;
};

export function createVariableInjectState(): VariableInjectState {
  return {
    definedVars: new Set(),
    autoDefinedVars: new Set(),
    varExprIds: new Map(),
    injectSeq: 0,
  };
}

export type DesmosInjectItem = {
  latex: string;
  exprId: string;
};

/**
 * 将单条 AI 公式展开为待注入列表：
 * - 图形/不等式/参数方程：**始终**写入 Desmos
 * - 变量赋值：首次写入；若此前仅为自动补全则可被 AI 正式赋值覆盖；重复 AI 赋值则跳过
 */
export function expandFormulaForInject(
  latex: string,
  state: VariableInjectState,
): DesmosInjectItem[] {
  const items: DesmosInjectItem[] = [];
  const assignVar = parseAssignmentVariable(latex);
  const nextId = () => `ai_${state.injectSeq++}`;

  const ensureDefined = (vars: string[]) => {
    for (const v of vars) {
      if (state.definedVars.has(v)) continue;
      const id = nextId();
      items.push({ latex: getDefaultAssignment(v), exprId: id });
      state.definedVars.add(v);
      state.autoDefinedVars.add(v);
      state.varExprIds.set(v, id);
    }
  };

  const fnDef = parseFunctionDefinition(latex);
  if (fnDef) {
    ensureDefined(extractUsedVariables(latex));
    state.definedVars.add(fnDef.name);
    state.autoDefinedVars.delete(fnDef.name);
    items.push({ latex, exprId: nextId() });
    return items;
  }

  if (assignVar) {
    ensureDefined(extractUsedVariables(latex).filter(v => v !== assignVar));
    if (state.definedVars.has(assignVar)) {
      if (state.autoDefinedVars.has(assignVar)) {
        const id = state.varExprIds.get(assignVar) ?? nextId();
        items.push({ latex, exprId: id });
        state.autoDefinedVars.delete(assignVar);
      }
      return items;
    }
    const id = nextId();
    items.push({ latex, exprId: id });
    state.definedVars.add(assignVar);
    state.varExprIds.set(assignVar, id);
    return items;
  }

  ensureDefined(extractUsedVariables(latex));
  items.push({ latex, exprId: nextId() });
  return items;
}

/** 从画板已有表达式同步变量定义，避免 AI 追加注入时重复赋值或覆盖已有 ai_* 行 */
export function seedVariableInjectStateFromCalculator(
  calculator: any,
  state: VariableInjectState,
): void {
  const list = calculator?.getState?.()?.expressions?.list ?? [];
  let maxAiSeq = -1;
  for (const expr of list) {
    const id = String(expr?.id ?? '').trim();
    const aiMatch = /^ai_(\d+)$/.exec(id);
    if (aiMatch) {
      maxAiSeq = Math.max(maxAiSeq, parseInt(aiMatch[1], 10));
    }
    const latex = String(expr?.latex ?? '').trim();
    const fnDef = parseFunctionDefinition(latex);
    if (fnDef) {
      state.definedVars.add(fnDef.name);
      continue;
    }
    const assignVar = parseAssignmentVariable(latex);
    if (!assignVar || state.definedVars.has(assignVar)) continue;
    state.definedVars.add(assignVar);
    if (id) state.varExprIds.set(assignVar, id);
  }
  if (maxAiSeq >= 0) {
    state.injectSeq = Math.max(state.injectSeq, maxAiSeq + 1);
  }
}

/** 按依赖顺序排列：先赋值、再图形；并补全缺失的变量初值 */
export function orderFormulasWithDefinitions(formulas: string[]): string[] {
  const defined = new Set<string>();
  const assignments: string[] = [];
  const graphs: string[] = [];

  for (const f of formulas) {
    if (isVariableAssignment(f)) assignments.push(f);
    else graphs.push(f);
  }

  const result: string[] = [];
  const queue = [...assignments, ...graphs];

  while (queue.length > 0) {
    let progressed = false;
    for (let i = 0; i < queue.length; i++) {
      const formula = queue[i];
      const assignVar = parseAssignmentVariable(formula);
      const needed = extractUsedVariables(formula).filter(v => !defined.has(v));

      if (needed.length > 0) {
        for (const v of needed) {
          if (defined.has(v)) continue;
          result.push(getDefaultAssignment(v));
          defined.add(v);
        }
        progressed = true;
      }

      if (assignVar) {
        if (defined.has(assignVar)) {
          queue.splice(i, 1);
          progressed = true;
          break;
        }
        result.push(formula);
        defined.add(assignVar);
        queue.splice(i, 1);
        progressed = true;
        break;
      }

      const stillMissing = extractUsedVariables(formula).filter(v => !defined.has(v));
      if (stillMissing.length === 0) {
        result.push(formula);
        queue.splice(i, 1);
        progressed = true;
        break;
      }
    }
    if (!progressed && queue.length > 0) {
      const formula = queue.shift()!;
      const missing = extractUsedVariables(formula).filter(v => !defined.has(v));
      for (const v of missing) {
        result.push(getDefaultAssignment(v));
        defined.add(v);
      }
      result.push(formula);
    }
  }

  return result;
}

/** 模板表达式：赋值行优先于图形行 */
export function sortTemplateExpressions<T extends { latex: string }>(exprs: T[]): T[] {
  const assigns: T[] = [];
  const rest: T[] = [];
  for (const e of exprs) {
    if (isVariableAssignment(e.latex)) assigns.push(e);
    else rest.push(e);
  }
  return [...assigns, ...rest];
}
