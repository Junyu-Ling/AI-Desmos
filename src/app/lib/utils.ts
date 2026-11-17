/**
 * ============================================================================
 * lib/utils.ts — 通用工具函数库
 * ============================================================================
 *
 * 这个文件存放整个项目中可复用的"工具函数"。
 * 工具函数就像瑞士军刀里的每一把小刀——各自做一件具体的事情。
 *
 * 本文件包含两个函数：
 *   1. parseDesmosResponse  — 从 AI 的回复文字里，把数学公式"挖出来"
 *   2. autoCorrectInput     — 把中文标点自动替换成英文标点（防止 Desmos 报错）
 */

import { normalizeChatLatexText } from './chat-latex';
import {
  DESMOS_TAG_PATTERN,
  normalizeDesmosFormulaLatex,
  normalizeDesmosTagsInText,
  parseDesmosTagAttributes,
  prepareChatMessageDisplay,
} from './desmos-display';
import { normalizeParametricDomains } from './desmos-parametric-domain';
import { detectCalculatorMode } from './desmos-persistence';
import {
  expandFormulaForInject,
  createVariableInjectState,
  isBlockedSliderDefinition,
  seedVariableInjectStateFromCalculator,
  type VariableInjectState,
} from './desmos-variables';

export { prepareChatMessageDisplay, desmosLatexToKatexDisplay } from './desmos-display';

/** @deprecated 使用 prepareChatMessageDisplay */
export function desmosTagsToFormulaMarkers(text: string): string {
  return prepareChatMessageDisplay(text);
}

/** @deprecated 已并入 prepareChatMessageDisplay */
export function tightenChatDisplaySpacing(text: string): string {
  return prepareChatMessageDisplay(text);
}

// ─── 函数一：解析 AI 回复中的 Desmos 公式 ────────────────────────────────────

/**
 * parseDesmosResponse
 *
 * 【作用】
 * AI 回复的文字里，数学公式被包在特殊标签里，例如：
 *   "这是一个圆：<DESMOS>x^2+y^2=1</DESMOS>"
 *
 * 这个函数把那些标签"拆包"：
 *   - display：去掉标签后，给用户看的干净文字
 *   - desmos：取出的公式数组，用来注入 Desmos 画板
 *
 * 【兼容旧格式】
 * 旧版本用的是 [DESMOS: x^2] 这种方括号写法，也能识别。
 *
 * @param text - AI 原始回复字符串
 * @returns 包含 display（展示文字）和 desmos（公式数组）的对象
 */
export const parseDesmosResponse = (text: string): { display: string; desmos: string[] } => {

  // 用来收集所有找到的公式，初始为空数组
  const desmosMatches: string[] = [];

  // 先把展示文字初始化为原始文本，之后会逐步去掉标签
  let displayText = text;

  // ── 第一步：识别新格式 <DESMOS>...</DESMOS> ──────────────────────────────
  const xmlRegex = new RegExp(DESMOS_TAG_PATTERN.source, 'gi');

  let match;

  while ((match = xmlRegex.exec(text)) !== null) {
    const rawContent = match[1];
    const cleanFormula = rawContent.replace(/[\n\r]+/g, ' ').trim();
    if (cleanFormula) {
      desmosMatches.push(cleanFormula);
    }
  }

  displayText = displayText.replace(xmlRegex, '');

  const legacyRegex = /\[DESMOS:\s*([\s\S]*?)\]/g;

  while ((match = legacyRegex.exec(displayText)) !== null) {
    const rawContent = match[1];
    const cleanFormula = rawContent.replace(/[\n\r]+/g, ' ').trim();
    if (cleanFormula) {
      desmosMatches.push(cleanFormula);
    }
  }

  displayText = displayText.replace(legacyRegex, '');

  return {
    display: displayText.trim(),
    desmos: desmosMatches
  };
};

// ─── 函数二：中文标点自动纠正 ────────────────────────────────────────────────

/**
 * autoCorrectInput
 *
 * 【作用】
 * 用户用中文输入法打公式时，容易误输入中文标点符号：
 *   中文逗号 ，  → 应该是英文逗号 ,
 *   中文句号 。  → 应该是英文点号 .
 *   中文括号 （） → 应该是英文括号 ()
 *   中文方括号 【】→ 应该是英文方括号 []
 *
 * 如果用中文标点，Desmos 会报语法错误。
 * 这个函数在用户每次输入时自动替换，用户甚至感觉不到。
 *
 * @param input - 用户在 Desmos 输入框里打的原始字符串
 * @returns 替换后的字符串（英文标点版本）
 */
export interface DesmosInjectOptions {
  /** 纠错模式：替换指定表达式而非清空画板 */
  correctionExprId?: string;
  /** 是否跳过注入（如分析模式） */
  skip?: boolean;
}

export interface DesmosInjectState {
  executedTags: Set<string>;
  /** 已从画板同步过已有变量定义 */
  canvasSeeded: boolean;
  vars: VariableInjectState;
  /** 画板是否为 3D（首次注入时探测一次） */
  is3D?: boolean;
  /** 等待写入的 colorLatex（setExpression 会丢弃该字段，需经 setState） */
  pendingColorLatex: Map<string, string>;
  colorFlushTimer?: ReturnType<typeof setTimeout>;
}

export function createDesmosInjectState(): DesmosInjectState {
  return {
    executedTags: new Set(),
    canvasSeeded: false,
    vars: createVariableInjectState(),
    pendingColorLatex: new Map(),
  };
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

/** 把 color="C_{roof}" / color="\operatorname{rgb}(…)" 这类颜色表达式统一经 setState 写入 */
function flushPendingColorLatex(calculator: any, state: DesmosInjectState) {
  if (state.pendingColorLatex.size === 0 || !calculator?.getState) return;
  const pending = new Map(state.pendingColorLatex);
  state.pendingColorLatex.clear();
  try {
    const graph = calculator.getState();
    let changed = false;
    for (const e of graph?.expressions?.list ?? []) {
      const c = pending.get(String(e?.id));
      if (c && e.colorLatex !== c) {
        e.colorLatex = c;
        changed = true;
      }
    }
    if (changed) calculator.setState(graph, { allowUndo: true });
  } catch (e) {
    console.error('[Desmos] colorLatex flush failed:', e);
  }
}

function scheduleColorFlush(calculator: any, state: DesmosInjectState) {
  if (state.colorFlushTimer) clearTimeout(state.colorFlushTimer);
  state.colorFlushTimer = setTimeout(() => flushPendingColorLatex(calculator, state), 350);
}

/**
 * 从流式 AI 回复中解析 <DESMOS> 标签并注入画板
 * 默认**追加**到现有画板，不会 setBlank 清空 GIF/已有公式。
 * 参数区间（{0\le u\le 2\pi} 等）会转成 Desmos 的区间字段，保证曲面/曲线完整画出。
 */
export function processDesmosStreamChunk(
  fullRawContent: string,
  calculator: any,
  state: DesmosInjectState,
  options: DesmosInjectOptions = {},
): string {
  const normalizedRaw = normalizeDesmosTagsInText(fullRawContent);

  if (options.skip || !calculator) {
    return normalizeChatLatexText(prepareChatMessageDisplay(normalizedRaw));
  }

  const tagRegex = new RegExp(DESMOS_TAG_PATTERN.source, 'gi');
  const legacyRegex = /\[DESMOS:?\s*([\s\S]*?)\]/gi;
  let match;

  const ensureCanvasContext = () => {
    if (state.canvasSeeded) return;
    seedVariableInjectStateFromCalculator(calculator, state.vars);
    state.is3D = detectCalculatorMode(calculator) === '3d';
    state.canvasSeeded = true;
  };

  const buildExpression = (latex: string, exprId: string, color?: string) => {
    if (state.is3D === undefined) state.is3D = detectCalculatorMode(calculator) === '3d';
    const dom = normalizeParametricDomains(latex, !!state.is3D);
    const expr: Record<string, unknown> = { id: exprId, latex: dom.latex };
    if (dom.parametricDomain) expr.parametricDomain = dom.parametricDomain;
    if (dom.parametricDomain3Du) expr.parametricDomain3Du = dom.parametricDomain3Du;
    if (dom.parametricDomain3Dv) expr.parametricDomain3Dv = dom.parametricDomain3Dv;
    if (color && HEX_COLOR_RE.test(color)) expr.color = color;
    else if (color) {
      state.pendingColorLatex.set(exprId, color);
      scheduleColorFlush(calculator, state);
    }
    return expr;
  };

  const injectBatch = (cleanFormula: string, correctionExprId?: string | null, color?: string) => {
    const injectOne = (latex: string, exprId: string, withColor: boolean) => {
      if (correctionExprId && correctionExprId !== 'unknown') {
        calculator.setExpression(buildExpression(latex, correctionExprId, withColor ? color : undefined));
        return;
      }
      const existingIds = calculator?.getState?.()?.expressions?.list
        ?.map((e: { id?: string }) => String(e?.id ?? '')) ?? [];
      if (existingIds.includes(exprId)) return;
      calculator.setExpression(buildExpression(latex, exprId, withColor ? color : undefined));
    };

    if (correctionExprId && correctionExprId !== 'unknown') {
      const correctionKey = `__correction__:${correctionExprId}`;
      if (state.executedTags.has(correctionKey)) return;
      state.executedTags.add(correctionKey);
      injectOne(cleanFormula, correctionExprId, true);
      return;
    }

    ensureCanvasContext();

    const toInject = expandFormulaForInject(cleanFormula, state.vars);
    toInject.forEach(({ latex, exprId }, i) => {
      injectOne(latex, exprId, i === toInject.length - 1);
    });
  };

  while ((match = tagRegex.exec(normalizedRaw)) !== null) {
    const fullTag = match[0];
    const formulaContent = match[1];
    // 不能转小写：R=2 与 r=2 是两条不同的公式
    const tagKey = fullTag;

    if (state.executedTags.has(tagKey)) continue;
    state.executedTags.add(tagKey);

    const cleanFormula = normalizeDesmosFormulaLatex(formulaContent);

    if (isBlockedSliderDefinition(cleanFormula)) continue;
    if (!cleanFormula) continue;

    try {
      injectBatch(cleanFormula, options.correctionExprId, parseDesmosTagAttributes(fullTag).color);
    } catch (e) {
      console.error('[Desmos] Injection failed:', e);
    }
  }

  while ((match = legacyRegex.exec(normalizedRaw)) !== null) {
    const fullTag = match[0];
    const formulaContent = match[1];
    const tagKey = fullTag;
    if (state.executedTags.has(tagKey)) continue;
    state.executedTags.add(tagKey);
    const cleanFormula = normalizeDesmosFormulaLatex(formulaContent);
    if (!cleanFormula || isBlockedSliderDefinition(cleanFormula)) continue;
    try {
      injectBatch(cleanFormula, options.correctionExprId);
    } catch (e) {
      console.error('[Desmos] Injection failed:', e);
    }
  }

  return normalizeChatLatexText(prepareChatMessageDisplay(normalizedRaw));
}

export const autoCorrectInput = (input: string): string => {
  return input
    .replace(/，/g, ',')
    .replace(/。/g, '.')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/【/g, '[')
    .replace(/】/g, ']');
};
