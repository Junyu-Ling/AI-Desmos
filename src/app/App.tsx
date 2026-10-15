/**
 * ============================================================================
 * App.tsx — AI Desmos 智能绘图助手 · 应用根组件
 * ============================================================================
 *
 * 【这个文件的作用】
 * App.tsx 是整个应用的"总指挥"，所有其他组件都由它来组装和控制。
 * 就像一栋楼的设计图——左边是画板，右边是聊天栏，中间可以拖动。
 *
 * 【页面布局结构】
 * ┌──────────────────────────┬──────────────┐
 * │                          │              │
 * │   Desmos 计算器 (左侧)    │  AI 聊天栏   │
 * │   + 加载遮罩层             │  (右侧可拖拽) │
 * │   + AI 纠错按钮            │              │
 * │   + 悬浮打开按钮           │              │
 * │                          │              │
 * └──────────────────────────┴──────────────┘
 *
 * 【核心职责】
 * 1. 管理 Desmos 计算器实例（等 DesmosCalculator 就绪后拿到实例）
 * 2. 监听 Desmos 输入框的错误，在旁边显示"AI 智能纠错"按钮
 * 3. 自动纠正中文标点（把中文逗号替换成英文逗号等）
 * 4. 控制右侧聊天栏的开关状态
 * 5. 首次使用时显示引导页（Onboarding）
 * 6. Desmos 加载完成前显示加载动画
 */

// ─── 导入区 ───────────────────────────────────────────────────────────────────

// React 核心：
// React    — JSX 语法必须导入
// useState — 声明会触发界面更新的"状态变量"
// useEffect — 在组件生命周期特定时刻执行代码（如挂载后、状态变化后）
// useRef   — 持有不触发重渲染的可变引用（DOM 元素、计时器 ID 等）
import React, { useState, useEffect, useRef } from 'react';

// sonner 是一个 Toast（浮动通知）库
// Toaster — 渲染通知容器的组件，放在页面顶层
// toast   — 函数，调用它就能弹出通知
import { Toaster, toast } from 'sonner@2.0.3'; // @版本号锁定兼容版本

// 导入本项目的各个子组件
import { DesmosCalculator } from './components/DesmosCalculator'; // Desmos 计算器组件
import { ChatInterface } from './components/ChatInterface';         // AI 聊天界面组件
import { Onboarding } from './components/Onboarding';               // 首次使用引导页

// 导入工具函数：自动纠正中文标点
import { autoCorrectInput } from './lib/utils';
import {
  DesmosAutoRepairController,
  collectDesmosErrors,
  isAutoRepairCandidate,
} from './lib/desmos-auto-repair';

// re-resizable 是一个让 div 可以拖拽调整大小的库
// Resizable 组件包裹右侧聊天栏，使其左边缘可拖拽
import { Resizable } from 're-resizable';

// 导入图标：
// Wrench      — 扳手图标（AI 智能纠错按钮）
// Loader2     — 旋转加载圈图标（Desmos 加载中）
// AlertCircle — 警告圆圈图标（加载失败）
// RefreshCcw  — 刷新图标（重试按钮）
import { Wrench, Loader2, AlertCircle, RefreshCcw, Pencil, X as XIcon, Undo2, Square } from 'lucide-react';
import { processDrawnPathToFourier, getNextHandDrawStrokeIndex, applyFourierExpressionsProgressively, DRAW_COLOR_PRESETS, type HandDrawStroke } from './lib/image-processing';
import {
  clientToMathCoords,
  getAdaptiveSampleDistance,
  getGraphPaperPixelBounds,
  mathToOverlayCoords,
  type GraphPaperPixelBounds,
} from './lib/draw-coords';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './components/ui/alert-dialog';

// 导入应用 Logo 图片（从 Figma 导入的资源）
import logoImg from 'figma:asset/aa5c219b747d73e46a1c35f49925cf818604e2fb.png';

// 导入国际化 Hook（用于中英双语支持）
import { useLanguage } from './lib/i18n';

// ─── 主组件 ───────────────────────────────────────────────────────────────────

/**
 * App 组件
 * 这是整个应用的根组件，被 main.tsx 中的 ReactDOM.render() 挂载到 #root 元素。
 */
function App() {

  // ═══════════════════════════════════════════════════════════════════════════
  // 状态变量（useState）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * calculator — Desmos 计算器实例
   * 初始为 null，当 DesmosCalculator 组件加载完毕后，
   * 通过 onCalculatorReady 回调将实例存入这里。
   * 之后 ChatInterface 需要这个实例来操控画板（添加/清空公式）。
   */
  const [calculator, setCalculator] = useState<any>(null);

  /**
   * showOnboarding — 是否显示引导页
   * 初始为 false，挂载后检查 localStorage 决定是否显示。
   */
  const [showOnboarding, setShowOnboarding] = useState(false);

  /**
   * isChatOpen — 右侧 AI 聊天栏是否展开
   * true  = 显示聊天栏（左右分栏布局）
   * false = 隐藏聊天栏（只有画板，右下角有一个悬浮打开按钮）
   */
  const [isChatOpen, setIsChatOpen] = useState(true);

  /**
   * activeError — 当前检测到的表达式错误信息
   * 当用户在 Desmos 输入框中输入了有语法错误的公式，
   * 这个状态存储错误信息和"AI 智能纠错"按钮的定位。
   *
   * null    = 没有错误，不显示纠错按钮
   * 对象时  = 有错误，显示纠错按钮
   *
   * 对象结构：
   *   id    — 出错表达式的 ID（Desmos 内部标识）
   *   latex — 出错的 LaTeX 公式字符串
   *   error — 错误描述文本
   *   top   — 纠错按钮的垂直位置（距容器顶部的像素数）
   *   right — 纠错按钮的水平位置（距容器左边的像素数）
   */
  const [activeError, setActiveError] = useState<{
    id: string;
    latex: string;
    error: string;
    top: number;
    right: number;
  } | null>(null); // 初始值 null 表示没有错误

  /**
   * externalQuery — 从 App 传递给 ChatInterface 的"外部查询"
   * 当用户点击"AI 智能纠错"按钮时，App 会把纠错请求写入这里，
   * ChatInterface 监听这个值并自动发送查询。
   * 发送完后 ChatInterface 调用 onExternalQueryHandled 把它清空。
   */
  const [externalQuery, setExternalQuery] = useState('');

  /**
   * externalCorrectionExprId — 纠错目标表达式的 ID
   * 配合 externalQuery 使用：告诉 ChatInterface 把 AI 修正的公式
   * 直接替换画板上对应 ID 的那条公式，而不是清空整个画板重画。
   */
  const [externalCorrectionExprId, setExternalCorrectionExprId] = useState('');
  const autoRepairRef = useRef(new DesmosAutoRepairController(2));
  const autoRepairTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRepairAiBusyRef = useRef(false);

  /**
   * desmosStatus — Desmos 计算器的加载状态
   * 'loading' — 脚本加载中（初始状态，显示加载动画）
   * 'ready'   — 加载完毕（隐藏加载动画，用户可以使用画板）
   * 'error'   — 加载失败（显示错误提示和重试按钮）
   */
  const [desmosStatus, setDesmosStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  // ── Hand-drawing mode ──────────────────────────────────────────────────
  const [drawMode, setDrawMode] = useState(false);
  const [drawModePickerOpen, setDrawModePickerOpen] = useState(false);
  const [drawCanvasMode, setDrawCanvasMode] = useState<'keep' | 'clear'>('clear');
  const [graphOverlayBounds, setGraphOverlayBounds] = useState<GraphPaperPixelBounds | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawProcessing, setDrawProcessing] = useState(false);
  const [strokeCount, setStrokeCount] = useState(0);
  const [drawColor, setDrawColor] = useState(DRAW_COLOR_PRESETS[0]);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const currentStroke = useRef<{ x: number; y: number }[]>([]);
  const currentStrokeColorRef = useRef(DRAW_COLOR_PRESETS[0]);
  const allStrokes = useRef<HandDrawStroke[]>([]);
  const drawCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const isDrawingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const canvasSizeRef = useRef<{ w: number; h: number } | null>(null);
  const canvasDprRef = useRef(1);
  const desmosContainerRef = useRef<HTMLDivElement | null>(null);
  const redrawPendingRef = useRef(false);
  const drawAbortRef = useRef<AbortController | null>(null);
  const MIN_STROKE_POINTS = 3;
  const MIN_STROKE_MATH_LENGTH = 0.04;

  // ═══════════════════════════════════════════════════════════════════════════
  // Refs（useRef）
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * calculatorContainerRef — 指向左侧 Desmos 面板（不含聊天栏）
   * 用于在这个区域上监听事件（input、focus 等），
   * 以便检测 Desmos 内部输入框的状态。
   * 同时也被设置为最外层容器的 ref（见 JSX 部分）。
   */
  const calculatorContainerRef = useRef<HTMLDivElement>(null);

  // ═══════════════════════════════════════════════════════════════════════════
  // 国际化
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * t — 翻译函数，通过 key 获取当前语言的界面文字
   * 例如：t('loading_title') 中文时返回"正在加载 Desmos..."
   *                           英文时返回"Loading Desmos..."
   */
  const { t } = useLanguage();

  // ═══════════════════════════════════════════════════════════════════════════
  // Effect：引导页初始化
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 应用首次挂载时执行：
   * 检查 localStorage 中是否有"已完成引导"的标记。
   * - 没有标记 → 显示引导页，关闭聊天栏（引导期间减少干扰）
   * - 有标记   → 直接打开聊天栏（老用户跳过引导）
   *
   * [] 空依赖数组表示"只在组件挂载时执行一次"
   */
  useEffect(() => {
    // localStorage.getItem 读取本地存储的值，没有该键则返回 null
    const isCompleted = localStorage.getItem('desmos_onboarding_completed');
    if (!isCompleted) {
      // 从未完成引导 → 显示引导页，同时关闭聊天栏（引导期间界面更简洁）
      setShowOnboarding(true);
      setIsChatOpen(false);
    } else {
      // 已完成引导 → 直接展开聊天栏
      setIsChatOpen(true);
    }
  }, []); // 空数组 = 只执行一次

  /**
   * handleOnboardingComplete — 引导完成回调
   * 被 Onboarding 组件调用，执行以下操作：
   * 1. 关闭引导页
   * 2. 延迟 500ms 后展开聊天栏（避免引导页和聊天栏同时切换造成视觉跳跃）
   */
  const handleOnboardingComplete = () => {
    setShowOnboarding(false); // 立即关闭引导页
    setTimeout(() => setIsChatOpen(true), 500); // 500ms 后打开聊天栏
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Effect：中文标点自动纠正 + 英文输入设置
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 这个 effect 在 calculatorContainerRef 所指向的容器上绑定两个事件监听器：
   *
   * 1. input 事件：每次用户在 Desmos 输入框中输入字符时触发
   *    → 调用 autoCorrectInput 把中文标点替换成英文标点
   *
   * 2. focus 事件：每次用户点击聚焦到 Desmos 输入框时触发
   *    → 设置多个 DOM 属性，提示浏览器/系统使用英文输入模式
   *
   * 为什么使用"事件代理"（在父容器监听，而不是在每个输入框上）？
   * Desmos 的输入框是动态创建的，我们无法直接拿到它们的引用。
   * 在父容器上监听，任何子元素触发的事件都会"冒泡"上来，一样能捕获到。
   * 第三个参数 true 表示使用"捕获阶段"（比冒泡更早，能拦截 Desmos 内部处理之前）。
   */
  useEffect(() => {
    if (!calculatorContainerRef.current) return; // 容器还没挂载，提前退出

    /**
     * handleInput — 输入事件处理器
     * 每次输入框内容变化时，检查并纠正中文标点。
     *
     * e.target 是触发事件的具体 DOM 元素（输入框）
     * 只处理 TEXTAREA 和文本 INPUT（Desmos 使用这两种标签）
     */
    const handleInput = (e: Event) => {
      const target = e.target as HTMLTextAreaElement | HTMLInputElement;
      // 聊天栏、设置等应用内输入框不纠正（避免与 React 受控状态冲突导致标点重复）
      if (target.closest('[data-app-input]')) return;
      // 只处理文本输入类型的元素
      if (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type === 'text')) {
        const original = target.value;         // 当前输入框的值
        const corrected = autoCorrectInput(original); // 纠正中文标点

        // 只有内容实际发生了变化才进行替换（避免不必要的 DOM 操作）
        if (original !== corrected) {
          // 获取当前光标位置（selectionStart/End 是光标的开始和结束位置）
          const start = target.selectionStart;
          const end = target.selectionEnd;

          target.value = corrected; // 直接修改 DOM（非 React 方式，但更快）

          // 恢复光标位置（不然每次替换光标都会跳到末尾）
          if (start !== null && end !== null) {
            target.setSelectionRange(start, end);
          }
        }
      }
    };

    /**
     * handleFocus — 聚焦事件处理器
     * 每次用户点击 Desmos 输入框时，设置一系列属性提示系统使用英文输入。
     * 这些属性并不能强制切换输入法，但某些浏览器/系统会响应它们。
     */
    const handleFocus = (e: Event) => {
      const target = e.target as HTMLTextAreaElement | HTMLInputElement;
      if (target.closest('[data-app-input]')) return;
      if (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type === 'text')) {
        // lang="en" 告诉浏览器这个输入框期望英文内容
        target.setAttribute('lang', 'en');
        // inputmode="url" 暗示系统切换到 URL 输入键盘（通常是英文模式）
        target.setAttribute('inputmode', 'url');
        // autocapitalize="none" 禁用自动大写
        target.setAttribute('autocapitalize', 'none');
        // autocorrect="off" 禁用自动更正
        target.setAttribute('autocorrect', 'off');
        // spellcheck="false" 禁用拼写检查（避免数学公式被标红）
        target.setAttribute('spellcheck', 'false');
      }
    };

    // 获取容器 DOM 元素
    const container = calculatorContainerRef.current;

    // addEventListener 的第三个参数 true = 使用"捕获阶段"监听
    // 捕获阶段 > 目标阶段 > 冒泡阶段
    // 用捕获阶段可以确保我们在 Desmos 内部处理之前先收到事件
    container.addEventListener('input', handleInput, true);
    container.addEventListener('focus', handleFocus, true);

    // 清理函数：组件卸载时移除事件监听（防止内存泄漏）
    return () => {
      container.removeEventListener('input', handleInput, true);
      container.removeEventListener('focus', handleFocus, true);
    };
  }, []); // 只在挂载时绑定一次

  // ═══════════════════════════════════════════════════════════════════════════
  // Effect：检测表达式错误，显示 AI 智能纠错按钮
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 这个 effect 持续监测 Desmos 输入框中是否有语法错误。
   * 一旦检测到错误，就在错误公式旁边显示"AI 智能纠错"按钮。
   *
   * 【检测策略】
   * 方式一（优先）：通过 Desmos API 的 expressionAnalysis 对象
   *   → calculator.expressionAnalysis[exprId].isError 为 true 时，说明有错误
   * 方式二（回退）：通过 DOM 节点检查
   *   → 找到 .dcg-error-msg 或 .dcg-expressionitem-error 类名的元素
   *
   * 【触发时机】多种事件 + 定时轮询，保证实时性：
   *   - input    — 用户输入时立即检测
   *   - focusin  — 聚焦时检测
   *   - keyup    — 松开按键时检测
   *   - click    — 点击时检测
   *   - setInterval(500ms) — 每 0.5 秒定时检测（捕获 Desmos 异步校验结果）
   *
   * 依赖数组 [calculator]：等 calculator 实例就绪后才开始监测
   */
  useEffect(() => {
    // calculator 还没就绪，不监测（等待 Desmos 加载完成）
    if (!calculatorContainerRef.current || !calculator) return;
    const container = calculatorContainerRef.current;

    /**
     * checkErrorState — 扫描画板上所有表达式，找出语法错误并定位纠错按钮
     *
     * 优先显示当前聚焦的错误公式；若无聚焦项，则显示第一个错误公式。
     * 错误修复前按钮保持可见，不再因失焦而消失。
     */
    const findExprItemById = (exprId: string): Element | null => {
      const byAttr = container.querySelector(`.dcg-expressionitem[expr-id="${exprId}"]`);
      if (byAttr) return byAttr;

      return Array.from(container.querySelectorAll('.dcg-expressionitem')).find(item => {
        const id = item.getAttribute('expr-id')
          || Array.from(item.attributes).find(a => a.name.includes('id'))?.value;
        return id === exprId;
      }) || null;
    };

    const checkErrorState = () => {
      const active = document.activeElement as HTMLElement;
      const focusedExprItem = active?.tagName === 'TEXTAREA' && container.contains(active)
        ? active.closest('.dcg-expressionitem')
        : null;
      const focusedExprId = focusedExprItem
        ? focusedExprItem.getAttribute('expr-id')
          || Array.from(focusedExprItem.attributes).find(a => a.name.includes('id'))?.value
        : null;

      const errors: Array<{ id: string; latex: string; error: string }> = [];

      if (calculator.getExpressions && calculator.expressionAnalysis) {
        for (const expr of calculator.getExpressions()) {
          if (!expr.id || !expr.latex?.trim()) continue;
          const analysis = calculator.expressionAnalysis[expr.id];
          if (analysis?.isError) {
            errors.push({
              id: expr.id,
              latex: expr.latex,
              error: analysis.errorMessage || 'Syntax Error',
            });
          }
        }
      }

      if (errors.length === 0 && focusedExprItem) {
        let exprId = focusedExprItem.getAttribute('expr-id');
        if (!exprId) {
          const idAttr = Array.from(focusedExprItem.attributes).find(a => a.name.includes('id'));
          if (idAttr) exprId = idAttr.value;
        }

        const errorNode = focusedExprItem.querySelector('.dcg-error-msg');
        if (errorNode || focusedExprItem.classList.contains('dcg-error') || focusedExprItem.classList.contains('dcg-expressionitem-error')) {
          let latex = '';
          if (exprId && typeof calculator.getExpressions === 'function') {
            const targetExpr = calculator.getExpressions().find((e: any) => e.id === exprId);
            if (targetExpr) latex = targetExpr.latex;
          }
          errors.push({
            id: exprId || 'unknown',
            latex,
            error: errorNode?.textContent || '公式包含语法错误',
          });
        }
      }

      if (errors.length === 0) {
        setActiveError(null);
        return;
      }

      // AI 注入的公式出错：先本地修，修不掉再自动开 AI 纠错（无需用户点按钮）
      const aiErrors = errors.filter(e => isAutoRepairCandidate(e.id));
      if (aiErrors.length > 0 && calculator && !autoRepairAiBusyRef.current) {
        if (autoRepairTimerRef.current) clearTimeout(autoRepairTimerRef.current);
        autoRepairTimerRef.current = setTimeout(() => {
          const latest = collectDesmosErrors(calculator).filter(e => isAutoRepairCandidate(e.id));
          if (latest.length === 0) return;
          const { needAi } = autoRepairRef.current.process(calculator, latest);
          const next = needAi[0];
          if (!next || autoRepairAiBusyRef.current) {
            needAi.forEach(e => autoRepairRef.current.releaseAi(e.id));
            return;
          }
          autoRepairAiBusyRef.current = true;
          setIsChatOpen(true);
          setExternalCorrectionExprId(next.id);
          setExternalQuery(t('ai_fix_query', { latex: next.latex, error: next.error }));
          setActiveError(null);
          toast.message(t('ai_auto_fix_toast'));
          // 等 AI 流式写回后再放开；期间避免连环开多轮纠错
          window.setTimeout(() => {
            autoRepairRef.current.releaseAi(next.id);
            autoRepairAiBusyRef.current = false;
          }, 14000);
        }, 900);
      }

      const target = (focusedExprId && errors.find(e => e.id === focusedExprId)) || errors[0];
      const exprItem = target.id !== 'unknown' ? findExprItemById(target.id) : focusedExprItem;

      if (!exprItem) {
        setActiveError({
          id: target.id,
          latex: target.latex,
          error: target.error,
          top: 120,
          right: 280,
        });
        return;
      }

      const rect = exprItem.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setActiveError({
        id: target.id,
        latex: target.latex,
        error: target.error,
        top: rect.top - containerRect.top,
        right: rect.right - containerRect.left,
      });
    };

    // 绑定多种事件，保证实时检测
    container.addEventListener('input', checkErrorState, true);    // 输入时
    container.addEventListener('focusin', checkErrorState, true);  // 聚焦时
    container.addEventListener('keyup', checkErrorState, true);    // 松键时
    container.addEventListener('click', checkErrorState, true);    // 点击时

    // setInterval 定时轮询（每 500ms 检查一次）
    // 因为 Desmos 的错误检测是异步的，事件触发时可能还没出错，轮询能捕获到
    const interval = setInterval(checkErrorState, 500);

    let unsubscribeChange: (() => void) | undefined;
    if (typeof calculator.observeEvent === 'function') {
      calculator.observeEvent('change', checkErrorState);
      unsubscribeChange = () => {
        if (typeof calculator.unobserveEvent === 'function') {
          calculator.unobserveEvent('change', checkErrorState);
        }
      };
    }

    // 清理函数：移除所有事件监听和定时器
    return () => {
      container.removeEventListener('input', checkErrorState, true);
      container.removeEventListener('focusin', checkErrorState, true);
      container.removeEventListener('keyup', checkErrorState, true);
      container.removeEventListener('click', checkErrorState, true);
      clearInterval(interval);
      unsubscribeChange?.();
      if (autoRepairTimerRef.current) clearTimeout(autoRepairTimerRef.current);
    };
  }, [calculator, t]); // t：自动纠错文案随语言切换

  useEffect(() => {
    if (calculator) {
      desmosContainerRef.current = document.getElementById('calculator') as HTMLDivElement | null;
    }
  }, [calculator]);

  // ── Drawing mode handlers ───────────────────────────────────────────────
  const getDesmosContainerRect = () => desmosContainerRef.current?.getBoundingClientRect() ?? null;

  const updateGraphOverlayBounds = () => {
    if (!calculator) return;
    const bounds = getGraphPaperPixelBounds(calculator);
    if (bounds) setGraphOverlayBounds(bounds);
  };

  const getMathPointFromClient = (clientX: number, clientY: number) => {
    const rect = getDesmosContainerRect();
    if (!rect || !calculator) return null;
    return clientToMathCoords(calculator, rect, clientX, clientY);
  };

  const getStrokeMathLength = (stroke: { x: number; y: number }[]) => {
    let len = 0;
    for (let i = 1; i < stroke.length; i++) {
      len += Math.hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y);
    }
    return len;
  };

  const clearDesmosPanel = () => {
    if (calculator && typeof calculator.setBlank === 'function') {
      calculator.setBlank();
    }
  };

  const enterDrawMode = (mode: 'keep' | 'clear') => {
    setDrawCanvasMode(mode);
    allStrokes.current = [];
    setStrokeCount(0);
    currentStroke.current = [];
    isDrawingRef.current = false;
    activePointerIdRef.current = null;
    canvasSizeRef.current = null;
    drawCtxRef.current = null;
    setIsDrawing(false);
    setDrawMode(true);
  };

  const handleDrawModeChoice = (mode: 'keep' | 'clear') => {
    setDrawModePickerOpen(false);
    if (mode === 'clear') {
      clearDesmosPanel();
    }
    enterDrawMode(mode);
    requestAnimationFrame(updateGraphOverlayBounds);
  };

  const handleDrawButtonClick = () => {
    if (drawMode) {
      handleCancelDraw();
      return;
    }
    setDrawModePickerOpen(true);
  };

  const redrawAllStrokes = () => {
    const ctx = drawCtxRef.current;
    const canvas = drawCanvasRef.current;
    if (!ctx || !canvas || !calculator || !graphOverlayBounds) return;

    const strokesToDraw: HandDrawStroke[] = [...allStrokes.current];
    if (isDrawingRef.current && currentStroke.current.length >= 2) {
      strokesToDraw.push({
        points: currentStroke.current,
        color: currentStrokeColorRef.current,
      });
    }

    const cssW = graphOverlayBounds.width;
    const cssH = graphOverlayBounds.height;
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    strokesToDraw.forEach(strokeData => {
      const stroke = strokeData.points;
      if (stroke.length < 2) return;

      ctx.beginPath();
      let started = false;
      ctx.strokeStyle = strokeData.color;

      stroke.forEach(point => {
        const overlayPt = mathToOverlayCoords(calculator, graphOverlayBounds, point.x, point.y);
        if (!overlayPt) return;
        if (!started) {
          ctx.moveTo(overlayPt.x, overlayPt.y);
          started = true;
        } else {
          ctx.lineTo(overlayPt.x, overlayPt.y);
        }
      });

      if (started) ctx.stroke();
    });
  };

  const scheduleRedraw = () => {
    if (redrawPendingRef.current) return;
    redrawPendingRef.current = true;
    requestAnimationFrame(() => {
      redrawPendingRef.current = false;
      redrawAllStrokes();
    });
  };

  const setupDrawCanvas = () => {
    const canvas = drawCanvasRef.current;
    if (!canvas || !drawMode || !graphOverlayBounds) return;

    const w = graphOverlayBounds.width;
    const h = graphOverlayBounds.height;
    if (w === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const prev = canvasSizeRef.current;
    const sizeChanged = !prev || prev.w !== w || prev.h !== h || canvasDprRef.current !== dpr;

    if (sizeChanged) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvasSizeRef.current = { w, h };
      canvasDprRef.current = dpr;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawCtxRef.current = ctx;
    }

    redrawAllStrokes();
  };

  useEffect(() => {
    if (!drawMode || !calculator) {
      setGraphOverlayBounds(null);
      return;
    }

    updateGraphOverlayBounds();

    const handleChange = () => {
      updateGraphOverlayBounds();
      requestAnimationFrame(setupDrawCanvas);
    };

    if (typeof calculator.observeEvent === 'function') {
      calculator.observeEvent('change', handleChange);
    }

    const container = desmosContainerRef.current;
    const ro = new ResizeObserver(handleChange);
    if (container) ro.observe(container);

    return () => {
      if (typeof calculator.unobserveEvent === 'function') {
        calculator.unobserveEvent('change', handleChange);
      }
      ro.disconnect();
    };
  }, [drawMode, calculator]);

  useEffect(() => {
    if (!drawMode) {
      drawCtxRef.current = null;
      canvasSizeRef.current = null;
      return;
    }

    const raf = requestAnimationFrame(setupDrawCanvas);
    return () => cancelAnimationFrame(raf);
  }, [drawMode, graphOverlayBounds]);

  const ensureDrawCtx = () => {
    setupDrawCanvas();
    return drawCtxRef.current;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = ensureDrawCtx();
    if (!ctx) return;

    const pt = getMathPointFromClient(e.clientX, e.clientY);
    if (!pt) return;

    currentStrokeColorRef.current = drawColor;
    currentStroke.current = [pt];
    isDrawingRef.current = true;
    activePointerIdRef.current = e.pointerId;
    setIsDrawing(true);
    e.currentTarget.setPointerCapture(e.pointerId);
    scheduleRedraw();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    if (activePointerIdRef.current !== null && e.pointerId !== activePointerIdRef.current) return;

    const pt = getMathPointFromClient(e.clientX, e.clientY);
    if (!pt) return;

    const last = currentStroke.current[currentStroke.current.length - 1];
    const minDist = getAdaptiveSampleDistance(currentStroke.current);
    if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < minDist) return;

    currentStroke.current.push(pt);
    scheduleRedraw();
  };

  const finishStroke = () => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    activePointerIdRef.current = null;
    setIsDrawing(false);
    const stroke = currentStroke.current;
    currentStroke.current = [];
    if (stroke.length >= MIN_STROKE_POINTS && getStrokeMathLength(stroke) >= MIN_STROKE_MATH_LENGTH) {
      allStrokes.current.push({
        points: stroke,
        color: currentStrokeColorRef.current,
      });
      setStrokeCount(allStrokes.current.length);
    }
    scheduleRedraw();
  };

  const handleUndoDraw = () => {
    if (drawProcessing || allStrokes.current.length === 0) return;
    allStrokes.current.pop();
    setStrokeCount(allStrokes.current.length);
    scheduleRedraw();
  };

  useEffect(() => {
    if (!drawMode) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        handleUndoDraw();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawMode, drawProcessing, strokeCount]);

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== null && e.pointerId !== activePointerIdRef.current) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch { /* already released */ }
    finishStroke();
  };

  const handleStopDrawProcessing = () => {
    drawAbortRef.current?.abort();
    drawAbortRef.current = null;
    setDrawProcessing(false);
  };

  const handleConfirmDraw = async () => {
    const strokes = allStrokes.current;
    if (strokes.length === 0) return;

    drawAbortRef.current?.abort();
    const controller = new AbortController();
    drawAbortRef.current = controller;
    setDrawProcessing(true);
    try {
      const allExpressions: any[] = [];
      let validIdx = 0;
      const strokeStartIndex = drawCanvasMode === 'keep'
        ? getNextHandDrawStrokeIndex(calculator)
        : 0;

      strokes.forEach(strokeData => {
        const { expressions } = processDrawnPathToFourier(
          strokeData.points, strokeStartIndex + validIdx, strokeData.color,
        );
        if (expressions.length > 0) {
          allExpressions.push(...expressions);
          validIdx++;
        }
      });
      if (calculator && allExpressions.length > 0) {
        if (drawCanvasMode === 'clear') {
          clearDesmosPanel();
        }
        await applyFourierExpressionsProgressively(calculator, allExpressions, {
          clearFirst: false,
          signal: controller.signal,
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('Hand draw conversion failed', error);
    } finally {
      drawAbortRef.current = null;
      setDrawProcessing(false);
      allStrokes.current = [];
      currentStroke.current = [];
      setStrokeCount(0);
      isDrawingRef.current = false;
      activePointerIdRef.current = null;
      const canvas = drawCanvasRef.current;
      if (canvas && graphOverlayBounds) {
        drawCtxRef.current?.clearRect(0, 0, graphOverlayBounds.width, graphOverlayBounds.height);
      }
      canvasSizeRef.current = null;
      drawCtxRef.current = null;
      setGraphOverlayBounds(null);
      setDrawMode(false);
    }
  };

  const handleCancelDraw = () => {
    allStrokes.current = [];
    currentStroke.current = [];
    setStrokeCount(0);
    isDrawingRef.current = false;
    activePointerIdRef.current = null;
    setIsDrawing(false);
    const canvas = drawCanvasRef.current;
    if (canvas && graphOverlayBounds) {
      drawCtxRef.current?.clearRect(0, 0, graphOverlayBounds.width, graphOverlayBounds.height);
    }
    drawCtxRef.current = null;
    canvasSizeRef.current = null;
    setGraphOverlayBounds(null);
    setDrawMode(false);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // JSX 渲染
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 整个应用的 UI 结构：
   * - 最外层 flex 容器：横向排列（左画板 + 右聊天栏）
   * - 左侧：flex-1 弹性拉伸，占据剩余空间
   * - 右侧：Resizable 可拖拽宽度，默认 320px
   */
  return (
    // 最外层容器：铺满整个视口，flex 横向布局，overflow-hidden 防止内容溢出滚动条
    <div className="flex w-screen h-screen overflow-hidden bg-gray-50 font-sans">

      {/* ── Toast 通知容器 ───────────────────────────────────────────────────
          放在最顶层，确保通知显示在所有内容之上
          position="top-center" 通知从顶部中央出现
          richColors 使不同类型通知有不同颜色（成功=绿，错误=红）
          closeButton 给每条通知添加关闭按钮 */}
      <Toaster position="top-center" richColors closeButton />

      <AlertDialog open={drawModePickerOpen} onOpenChange={setDrawModePickerOpen}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('draw_mode_canvas_title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('draw_mode_canvas_desc')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:justify-center gap-2">
            <AlertDialogCancel>{t('training_cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-white text-gray-700 border border-gray-200 hover:bg-gray-50"
              onClick={() => handleDrawModeChoice('keep')}
            >
              {t('draw_mode_canvas_keep')}
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => handleDrawModeChoice('clear')}
            >
              {t('draw_mode_canvas_clear')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── 引导页遮罩 ────────────────────────────────────────────��──────────
          showOnboarding 为 true 时渲染，false 时整个节点不存在（不只是隐藏）
          这比 display: none 更彻底，可以防止引导页占用事件监听器 */}
      {showOnboarding && (
        <Onboarding onComplete={handleOnboardingComplete} />
      )}

      {/* ━━━ 左侧：Desmos 计算器区域 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          flex-1 = 弹性填充剩余空间（聊天栏有固定宽度，画板占据其余全部）
          relative = 内部绝对定位元素的参考容器
          min-w-0 = 防止 flex 子元素在极小宽度时溢出（CSS flex 的一个已知问题）
          z-0 = 层叠顺序最低（确保右侧聊天栏的阴影能覆盖左侧） */}
      <div className="flex-1 relative min-w-0 flex flex-col h-full z-0" ref={calculatorContainerRef}>

        {/* Desmos 计算器组件
            onCalculatorReady   — 计算器就绪时的回调，把实例存入 calculator 状态
            onStatusChange      — 状态变化回调，更新 desmosStatus（用于控制加载/错误遮罩）
            className           — 宽高设为 100%，铺满左侧区域 */}
        <DesmosCalculator
          onCalculatorReady={setCalculator}   // 直接传入 setState 函数作为回调
          onStatusChange={setDesmosStatus}     // 直接传入 setState 函数作为回调
          className="w-full h-full"
        />

        {/* Hand-draw canvas overlay — aligned 1:1 with Desmos graphpaper */}
        {drawMode && graphOverlayBounds && (
          <canvas
            ref={drawCanvasRef}
            className="absolute z-25"
            style={{
              left: graphOverlayBounds.left,
              top: graphOverlayBounds.top,
              width: graphOverlayBounds.width,
              height: graphOverlayBounds.height,
              cursor: 'crosshair',
              touchAction: 'none',
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onLostPointerCapture={handlePointerUp}
          />
        )}

        {/* Draw mode control bar */}
        {drawMode && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-2 animate-in fade-in duration-200">
            <div className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-2xl shadow-xl">
              <span className="flex items-center gap-1.5 text-sm text-gray-600 select-none pr-1">
                <Pencil size={13} style={{ color: drawColor }} />
                {drawProcessing
                  ? t('draw_mode_processing')
                  : strokeCount > 0
                    ? t('draw_mode_strokes', { count: String(strokeCount) })
                    : t('draw_mode_hint')}
              </span>
              <div className="flex items-center gap-1 px-1 border-l border-gray-200 pl-2">
                {DRAW_COLOR_PRESETS.map(color => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setDrawColor(color)}
                    className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${
                      drawColor === color ? 'border-gray-900 scale-110' : 'border-white shadow-sm'
                    }`}
                    style={{ backgroundColor: color }}
                    title={t('draw_mode_color')}
                  />
                ))}
                <label
                  className="relative w-5 h-5 rounded-full border-2 border-gray-200 overflow-hidden cursor-pointer hover:scale-110 transition-transform"
                  title={t('draw_mode_color_custom')}
                >
                  <input
                    type="color"
                    value={drawColor}
                    onChange={(e) => setDrawColor(e.target.value)}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <span
                    className="absolute inset-0 rounded-full"
                    style={{
                      background: 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)',
                    }}
                  />
                </label>
              </div>
              {drawProcessing && (
                <button
                  type="button"
                  onClick={handleStopDrawProcessing}
                  className="flex items-center gap-1 px-3 py-1.5 bg-red-50 text-red-600 rounded-xl text-sm font-semibold hover:bg-red-100 active:scale-95 transition-all"
                  title={t('task_cancel')}
                >
                  <Square size={14} fill="currentColor" />
                  {t('task_cancel')}
                </button>
              )}
              {strokeCount > 0 && !drawProcessing && (
                <>
                  <button
                    onClick={handleUndoDraw}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-gray-100 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-200 active:scale-95 transition-all"
                    title={t('draw_mode_undo')}
                  >
                    <Undo2 size={14} />
                    {t('draw_mode_undo')}
                  </button>
                  <button
                    onClick={handleConfirmDraw}
                    className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 active:scale-95 transition-all"
                  >
                    ✓ {t('draw_mode_confirm')}
                  </button>
                </>
              )}
              <button
                onClick={drawProcessing ? handleStopDrawProcessing : handleCancelDraw}
                className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <XIcon size={15} />
              </button>
            </div>
          </div>
        )}

        {/* Draw mode toggle button (bottom-left) */}
        {desmosStatus === 'ready' && !showOnboarding && (
          <button
            onClick={handleDrawButtonClick}
            className={`absolute bottom-8 left-6 z-20 flex items-center gap-1.5 px-3 py-2 rounded-full shadow-lg text-sm font-semibold transition-all active:scale-95 ${
              drawMode
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-white text-gray-700 border border-gray-200 hover:bg-gray-50'
            }`}
          >
            <Pencil size={14} />
            {drawMode ? t('draw_mode_exit') : t('draw_mode_btn')}
          </button>
        )}

        {/* ── 加载遮罩层 ────────────────────────────────────────────────────
            条件：Desmos 正在加载中 且 引导页未显示（引导页期间不需要显示）
            absolute inset-0 = 绝对定位，覆盖整个左侧区域
            z-30 = 在 Desmos 画板（z-0）之上，在引导页（z-100）之下
            bg-white/90 = 半透明白色背景（能隐约看到后面的画板容器）
            backdrop-blur-sm = 背景轻微模糊 */}
        {desmosStatus === 'loading' && !showOnboarding && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-white/90 backdrop-blur-sm">
            {/* 内容容器：垂直居中，带淡入动画 */}
            <div className="flex flex-col items-center gap-4 animate-in fade-in duration-500">

              {/* Logo + 旋转加载图标（右下角小角标） */}
              <div className="relative">
                {/* Logo 图片 */}
                <div className="w-16 h-16 rounded-2xl overflow-hidden shadow-lg">
                  <img src={logoImg} alt="AI Desmos" className="w-full h-full object-cover" />
                </div>
                {/* 蓝色圆形角标（右下角），内含旋转加载图标 */}
                <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center shadow-md">
                  <Loader2 className="w-3.5 h-3.5 text-white animate-spin" /> {/* animate-spin = CSS 旋转动画 */}
                </div>
              </div>

              {/* 加载提示文字（通过翻译函数支持中英双语） */}
              <div className="text-center">
                <p className="text-gray-800 text-sm">{t('loading_title')}</p>     {/* "正在加载 Desmos..." */}
                <p className="text-gray-400 text-xs mt-1">{t('loading_desc')}</p> {/* "数学引擎启动中，请稍候" */}
              </div>

              {/* 跳动圆点动画（三个圆点依次跳动） */}
              <div className="flex gap-1 mt-2">
                {/* animationDelay 错开每个圆点的跳动时机，形成"波浪"效果 */}
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        {/* ── 错误遮罩层（加载失败时） ───────────────────────────────────────
            条件：Desmos 加载失败 且 引导页未显示
            bg-red-50/95 = 浅红色背景（半透明），视觉上提示出错 */}
        {desmosStatus === 'error' && !showOnboarding && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-red-50/95 backdrop-blur-sm p-6 text-center">
            {/* 警告图标 */}
            <AlertCircle className="w-10 h-10 text-red-500 mb-3" />
            {/* 错误标题 */}
            <h3 className="text-gray-900 mb-1">{t('loading_error_title')}</h3>
            {/* 错误说明 */}
            <p className="text-gray-600 text-sm mb-4">{t('loading_error_desc')}</p>
            {/* 排查建议（三条） */}
            <div className="text-gray-600 text-xs mb-4 space-y-1">
              <p>- {t('loading_error_tip1')}</p>
              <p>- {t('loading_error_tip2')}</p>
              <p>- {t('loading_error_tip3')}</p>
            </div>
            {/* 刷新重试按钮 */}
            <button
              onClick={() => window.location.reload()} // 刷新整个页面
              className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50 transition-colors shadow-sm"
            >
              <RefreshCcw size={14} />
              {t('loading_retry')}
            </button>
          </div>
        )}

        {/* ── AI 智能纠错按钮 ────────────────────────────────────────────────
            条件：activeError 不为 null（检测到公式错误时显示）
            absolute 定位，位置由 activeError.top 和 activeError.right 动态计算
            pointer-events-none 在容器上（避免容器本身拦截鼠标事件），
            但按钮本身加 pointer-events-auto 恢复可点击性 */}
        {activeError && (
          <div
            className="absolute z-10 animate-in fade-in slide-in-from-left-4 duration-300 pointer-events-none"
            style={{
              top: activeError.top + 10,   // 在出错公式下方 10px 处显示
              left: activeError.right + 12 // 在出错公式右边 12px 处显示
            }}
          >
            <button
              onClick={() => {
                if (!activeError.id || activeError.id === 'unknown') {
                  toast.error(t('ai_fix_no_id'));
                  return;
                }

                setIsChatOpen(true);
                setExternalCorrectionExprId(activeError.id);
                setExternalQuery(t('ai_fix_query', { latex: activeError.latex, error: activeError.error }));
                setActiveError(null);
              }}
              // pointer-events-auto 恢复按钮自身的可点击性
              className="pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 bg-red-50 hover:bg-red-100 border border-red-200 text-red-600 rounded-full shadow-lg text-sm font-medium transition-all group active:scale-95"
            >
              {/* 扳手图标：悬停时旋转 12 度（group-hover 效果） */}
              <Wrench className="w-4 h-4 group-hover:rotate-12 transition-transform" />
              {/* 按钮文字：通过 t() 支持中英双语 */}
              <span>{t('ai_fix_btn')}</span>
            </button>
          </div>
        )}

        {/* ── 悬浮打开聊天按钮（聊天栏关闭时显示） ──────────────────────────
            条件：聊天栏已关闭（!isChatOpen）且 引导页未显示（!showOnboarding）
            absolute bottom-8 right-6 = 固定在左侧区域的右下角
            圆形 Logo 按钮，点击后展开聊天栏 */}
        {!isChatOpen && !showOnboarding && (
          <button
            onClick={() => setIsChatOpen(true)} // 点击展开聊天栏
            className="absolute bottom-8 right-6 w-16 h-16 rounded-full shadow-xl flex items-center justify-center z-10 hover:scale-105 active:scale-95 transition-transform overflow-hidden animate-in fade-in zoom-in duration-300"
          >
            <img src={logoImg} alt="AI Desmos" className="w-full h-full object-cover" />
          </button>
        )}
      </div>

      {/* ━━━ 右侧：可拖拽 AI 聊天栏 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          条件：isChatOpen 为 true 时才渲染（关闭时完全不存在于 DOM 中）
          Resizable 组件让用户可以拖拽左边缘调整聊天栏宽度 */}
      {isChatOpen && (
        <Resizable
          defaultSize={{ width: 320, height: '100%' }} // 默认宽度 320px，高度铺满
          minWidth={320}   // 最小可拖拽到 320px（不能太窄）
          maxWidth={800}   // 最大可拖拽到 800px（不能太宽，要留出画板空间）
          enable={{
            // 只允许拖拽左边缘（其他方向禁用）
            top: false, right: false, bottom: false, left: true,
            topRight: false, bottomRight: false, bottomLeft: false, topLeft: false
          }}
          className="border-l border-gray-200 bg-white shadow-2xl z-20 relative min-w-0 overflow-hidden" // 左边框分隔线 + 深阴影
          handleClasses={{
            // 左边缘拖拽把手的 CSS 类：悬停时显示蓝色半透明条
            left: 'hover:bg-blue-500/20 transition-colors w-1 cursor-col-resize z-50'
          }}
        >
          {/* AI 聊天界面组件
              calculator              — 传入 Desmos 计算器实例（ChatInterface 用它操控画板）
              onClose                 — 关闭聊天栏的回调
              externalQuery           — App 传来的纠错查询（自动触发 AI 对话）
              externalCorrectionExprId— 纠错目标的表达式 ID
              onExternalQueryHandled  — 处理完外部查询后的回调（清空 query 和 exprId）*/}
          <ChatInterface
            calculator={calculator}
            onClose={() => setIsChatOpen(false)}
            externalQuery={externalQuery}
            externalCorrectionExprId={externalCorrectionExprId}
            onExternalQueryHandled={() => {
              setExternalQuery('');           // 清空查询，防止重复触发
              setExternalCorrectionExprId(''); // 清空纠错目标 ID
            }}
          />
        </Resizable>
      )}
    </div>
  );
}

// 默认导出 App 组件（React 应用的入口约定）
// main.tsx 中会 import App from './App' 然后渲染它
export default App;
