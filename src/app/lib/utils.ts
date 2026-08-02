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
  prepareChatMessageDisplay,
} from './desmos-display';
import {
  expandFormulaForInject,
  createVariableInjectState,
  isBlockedSliderDefinition,
  type VariableInjectState,
} from './desmos-variables';
import { getActiveWindowedPlayback } from './gif-playback';

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
  // 这是一个"正则表达式"（Regular Expression），用于匹配文字中的特定模式。
  // /<DESMOS>([\s\S]*?)<\/DESMOS>/g 的含义：
  //   <DESMOS>       匹配开标签
  //   ([\s\S]*?)     捕获组：匹配任意字符（包括换行），尽量少匹配（懒惰模式）
  //   <\/DESMOS>     匹配闭标签（/ 需要用 \/ 转义）
  //   g              全局模式：找出文本中所有匹配，不止第一个
  const xmlRegex = /<DESMOS>([\s\S]*?)<\/DESMOS>/g;

  // match 用来保存每次匹配到的结果
  let match;

  // exec() 每次调用会找到下一个匹配，循环直到找不到为止
  while ((match = xmlRegex.exec(text)) !== null) {
    // match[1] 是第一个捕获组里的内容，即 <DESMOS> 和 </DESMOS> 之间的公式
    const rawContent = match[1];

    // 把公式里的换行符（\n \r）全替换成空格，让公式保持在一行
    // Desmos 不支持多行公式，必须单行
    const cleanFormula = rawContent.replace(/[\n\r]+/g, ' ').trim();

    // 只有公式不为空才收录
    if (cleanFormula) {
      desmosMatches.push(cleanFormula); // 推入公式数组
    }
  }

  // 把展示文字中的 <DESMOS>...</DESMOS> 标签全部删掉，只留普通文字
  // replace() 的第二个参数是空字符串 ''，相当于"删除匹配到的部分"
  displayText = displayText.replace(xmlRegex, '');

  // ── 第二步：识别旧格式 [DESMOS: ...] ────────────────────────────────────
  // 这是早期版本使用的格式，现在仍然保留兼容，防止旧聊天记录显示异常
  // /\[DESMOS:\s*([\s\S]*?)\]/g 含义：
  //   \[DESMOS:\s*   匹配 [DESMOS: 开头（\s* 允许有任意空格）
  //   ([\s\S]*?)     捕获公式内容
  //   \]             匹配 ] 结束符
  const legacyRegex = /\[DESMOS:\s*([\s\S]*?)\]/g;

  while ((match = legacyRegex.exec(displayText)) !== null) {
    const rawContent = match[1];
    const cleanFormula = rawContent.replace(/[\n\r]+/g, ' ').trim();
    if (cleanFormula) {
      desmosMatches.push(cleanFormula); // 旧格式公式也推入同一个数组
    }
  }

  // 同样把展示文字里的旧格式标签也删掉
  displayText = displayText.replace(legacyRegex, '');

  // ── 返回结果 ──────────────────────────────────────────────────────────────
  // trim() 去掉首尾多余的空白字符
  return {
    display: displayText.trim(), // 给用户看的纯文字
    desmos: desmosMatches        // 给 Desmos 用的公式列表
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
  hasClearedCanvas: boolean;
  vars: VariableInjectState;
}

export function createDesmosInjectState(): DesmosInjectState {
  return {
    executedTags: new Set(),
    hasClearedCanvas: false,
    vars: createVariableInjectState(),
  };
}

/**
 * 从流式 AI 回复中解析 <DESMOS> 标签并注入画板
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
  const injectBatch = (cleanFormula: string, correctionExprId?: string | null) => {
    const injectOne = (latex: string, exprId: string) => {
      if (correctionExprId && correctionExprId !== 'unknown') {
        calculator.setExpression({ id: correctionExprId, latex });
        return;
      }
      calculator.setExpression({ id: exprId, latex });
    };

    if (correctionExprId && correctionExprId !== 'unknown') {
      if (!state.hasClearedCanvas) {
        injectOne(cleanFormula, correctionExprId);
        state.hasClearedCanvas = true;
      }
      return;
    }

    if (!state.hasClearedCanvas) {
      const gifPlayback = getActiveWindowedPlayback();
      if (!gifPlayback || gifPlayback.getFrameCount() === 0) {
        calculator.setBlank();
        state.vars = createVariableInjectState();
      }
      state.hasClearedCanvas = true;
    }

    const toInject = expandFormulaForInject(cleanFormula, state.vars);
    for (const { latex, exprId } of toInject) {
      injectOne(latex, exprId);
    }
  };

  while ((match = tagRegex.exec(normalizedRaw)) !== null) {
    const fullTag = match[0];
    const formulaContent = match[1];
    const tagKey = fullTag.toLowerCase();

    if (state.executedTags.has(tagKey)) continue;
    state.executedTags.add(tagKey);

    const cleanFormula = normalizeDesmosFormulaLatex(formulaContent);

    if (isBlockedSliderDefinition(cleanFormula)) continue;
    if (!cleanFormula) continue;

    try {
      injectBatch(cleanFormula, options.correctionExprId);
    } catch (e) {
      console.error('[Desmos] Injection failed:', e);
    }
  }

  while ((match = legacyRegex.exec(normalizedRaw)) !== null) {
    const fullTag = match[0];
    const formulaContent = match[1];
    const tagKey = fullTag.toLowerCase();
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
    // .replace(目标字符, 替换字符) 是字符串的替换方法
    // /，/g 是正则表达式，g 表示全局替换（不只替换第一个）
    .replace(/，/g, ',')   // 中文逗号 → 英文逗号
    .replace(/。/g, '.')   // 中文句号 → 英文点号
    .replace(/（/g, '(')   // 中文左括号 → 英文左括号
    .replace(/）/g, ')')   // 中文右括号 → 英文右括号
    .replace(/【/g, '[')   // 中文左方括号 → 英文左方括号
    .replace(/】/g, ']');  // 中文右方括号 → 英文右方括号
};
