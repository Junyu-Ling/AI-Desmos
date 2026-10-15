/**
 * Desmos 语法自动修复：
 * 1) 本地规则先修（下标、括号、标点…）
 * 2) 修不掉的交给 AI 纠错模式
 */

export type DesmosExprError = {
  id: string;
  latex: string;
  error: string;
};

/** 只自动修 AI 注入的公式，不打扰用户手写的行 */
export function isAutoRepairCandidate(id: string): boolean {
  return /^ai_\d+$/.test(id) || id.startsWith('ai_');
}

export function collectDesmosErrors(calculator: any): DesmosExprError[] {
  if (!calculator?.getExpressions || !calculator.expressionAnalysis) return [];
  const out: DesmosExprError[] = [];
  for (const expr of calculator.getExpressions()) {
    if (!expr?.id || !expr.latex?.trim()) continue;
    if (expr.type === 'table' || expr.type === 'folder') continue;
    const analysis = calculator.expressionAnalysis[expr.id];
    if (!analysis?.isError) continue;
    out.push({
      id: String(expr.id),
      latex: String(expr.latex),
      error: String(analysis.errorMessage || 'Syntax Error'),
    });
  }
  return out;
}

/**
 * 本地启发式修复。返回 null 表示规则帮不上忙。
 */
export function tryLocalDesmosRepair(latex: string, errorMessage = ''): string | null {
  let next = latex.trim();
  if (!next) return null;

  const before = next;

  // 中文标点
  next = next
    .replace(/，/g, ',')
    .replace(/。/g, '.')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/【/g, '[')
    .replace(/】/g, ']')
    .replace(/；/g, ';')
    .replace(/：/g, ':');

  // a1 / x12 → a_{1} / x_{12}（避免粘连数字）
  next = next.replace(/(?<![\\a-zA-Z_])([a-zA-Z])(\d+)(?![a-zA-Z_{])/g, '$1_{$2}');

  // 裸绝对值 |x| → \left|x\right|
  if (!/\\left\s*\|/.test(next) && /\|[^|]+\|/.test(next)) {
    next = next.replace(/\|([^|]+)\|/g, '\\left|$1\\right|');
  }

  // a\cdot x / a*x → ax（Desmos 隐式乘法）
  next = next.replace(/([a-zA-Z0-9\}])\s*(?:\\cdot|\*)\s*([a-zA-Z\\])/g, '$1$2');

  // 多余分号（Desmos 不支持一条里多式）
  if (next.includes(';')) {
    next = next.split(';')[0].trim();
  }

  // 域限制前误加的逗号：f(x), \{ → f(x)\{
  next = next.replace(/,\s*(\\left\\\{|\\\{)/g, '$1');

  // 积分误写 dx 前逗号
  next = next.replace(/,\s*d([a-zA-Z])/g, ' d$1');

  // 不成对的 \left( 补 \right)
  const leftCount = (next.match(/\\left\(/g) || []).length;
  const rightCount = (next.match(/\\right\)/g) || []).length;
  if (leftCount > rightCount) {
    next += '\\right)'.repeat(leftCount - rightCount);
  }

  // 错误信息里点名未定义变量时，本地无法补语义，留给 AI
  const err = errorMessage.toLowerCase();
  if (err.includes("doesn't exist") || err.includes('does not exist') || err.includes('未定义')) {
    // 若只是下标问题上面已修；否则交 AI
    if (next === before) return null;
  }

  if (next === before) return null;
  return next;
}

/** 把本地修复写回画板，并确认错误是否消失 */
export function applyLocalRepair(
  calculator: any,
  err: DesmosExprError,
): boolean {
  const fixed = tryLocalDesmosRepair(err.latex, err.error);
  if (!fixed || !calculator?.setExpression) return false;
  try {
    calculator.setExpression({ id: err.id, latex: fixed });
  } catch {
    return false;
  }
  // Desmos 异步分析：先乐观返回；调用方稍后会再扫一遍
  return true;
}

export type AutoRepairQueueItem = DesmosExprError & {
  attempts: number;
};

/**
 * 管理自动修复状态，避免同一条死循环。
 */
export class DesmosAutoRepairController {
  private attempted = new Map<string, number>();
  private inFlight = new Set<string>();
  private maxAttempts: number;

  constructor(maxAttempts = 2) {
    this.maxAttempts = maxAttempts;
  }

  reset(): void {
    this.attempted.clear();
    this.inFlight.clear();
  }

  canAttempt(id: string): boolean {
    if (this.inFlight.has(id)) return false;
    return (this.attempted.get(id) ?? 0) < this.maxAttempts;
  }

  markStart(id: string): void {
    this.inFlight.add(id);
    this.attempted.set(id, (this.attempted.get(id) ?? 0) + 1);
  }

  markDone(id: string): void {
    this.inFlight.delete(id);
  }

  /**
   * 处理当前错误列表：
   * - 先本地修
   * - 修不掉的返回给调用方走 AI
   */
  process(
    calculator: any,
    errors: DesmosExprError[],
  ): { localFixed: string[]; needAi: DesmosExprError[] } {
    const localFixed: string[] = [];
    const needAi: DesmosExprError[] = [];

    for (const err of errors) {
      if (!isAutoRepairCandidate(err.id)) continue;
      if (!this.canAttempt(err.id)) continue;

      this.markStart(err.id);
      const ok = applyLocalRepair(calculator, err);
      if (ok) {
        localFixed.push(err.id);
        this.markDone(err.id);
        continue;
      }
      // 本地失败：留给 AI，inFlight 保持到 AI 回调结束
      needAi.push(err);
    }

    return { localFixed, needAi };
  }

  /** AI 纠错请求发出后仍占着名额；完成后释放 */
  releaseAi(id: string): void {
    this.markDone(id);
  }
}
