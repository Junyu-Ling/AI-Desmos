/**
 * ============================================================================
 * DesmosCalculator.tsx — Desmos 图形计算器封装组件（支持 2D / 3D）
 * ============================================================================
 *
 * 【这个组件做什么？】
 * 把 Desmos（在线数学绘图工具）嵌入到应用中。
 *   1. 动态加载 Desmos JavaScript（v1.11，同脚本含 Calculator3D）
 *   2. 按 mode 创建 GraphingCalculator（2D）或 Calculator3D（3D）
 *   3. 通过回调把实例交给父组件
 *   4. 监听加载状态；移除试用横幅；容器 resize 时调用 resize()
 *
 * 【2D / 3D 切换】
 * mode 变化时销毁旧实例并重建；画板状态不会跨维度保留。
 */

import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, RefreshCcw } from 'lucide-react';

declare global {
  interface Window {
    Desmos: any;
  }
}

/** 计算器维度：2D 平面 / 3D 立体 */
export type CalculatorDimension = '2d' | '3d';

interface DesmosCalculatorProps {
  className?: string;
  /** '2d' = GraphingCalculator；'3d' = Calculator3D */
  mode?: CalculatorDimension;
  onCalculatorReady?: (calculator: any) => void;
  onStatusChange?: (status: 'loading' | 'ready' | 'error') => void;
  options?: any;
}

const API_KEY = 'dcb31709b452b1cf9dc26972add0fda6';

/** v1.11 主脚本已捆绑 Calculator3D（见官方 3D API docs） */
const SCRIPT_URL = `https://www.desmos.com/api/v1.11/calculator.js?apiKey=${API_KEY}`;

export const DesmosCalculator: React.FC<DesmosCalculatorProps> = ({
  className = 'w-full h-full',
  mode = '2d',
  onCalculatorReady,
  onStatusChange,
  options,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const calculatorRef = useRef<any>(null);
  const isMounted = useRef(false);
  const onReadyRef = useRef(onCalculatorReady);
  const optionsRef = useRef(options);

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorDetails, setErrorDetails] = useState<string>('');

  useEffect(() => {
    onReadyRef.current = onCalculatorReady;
  }, [onCalculatorReady]);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    onStatusChange?.(status);
  }, [status, onStatusChange]);

  useEffect(() => {
    isMounted.current = true;
    let checkInterval: ReturnType<typeof setInterval> | undefined;
    let destroyed = false;

    const destroyCalculator = () => {
      if (calculatorRef.current) {
        try {
          calculatorRef.current.destroy();
        } catch {
          /* ignore */
        }
        calculatorRef.current = null;
      }
    };

    const initCalculator = () => {
      if (!isMounted.current || destroyed || !containerRef.current) return;

      try {
        if (!window.Desmos) {
          throw new Error('Desmos object not found');
        }

        const is3d = mode === '3d';
        const ctor = is3d
          ? window.Desmos.Calculator3D
          : window.Desmos.GraphingCalculator;

        if (typeof ctor !== 'function') {
          throw new Error(
            is3d
              ? 'Desmos.Calculator3D unavailable (API key may not enable 3D)'
              : 'Desmos.GraphingCalculator unavailable',
          );
        }

        // 部分 API Key 会按功能开关；若 3D 被禁用则给出明确错误
        const features = window.Desmos.enabledFeatures;
        if (is3d && features && features.Calculator3D === false) {
          throw new Error('Calculator3D disabled for this API key');
        }

        destroyCalculator();
        // 清空容器，避免残留旧 canvas/DOM
        containerRef.current.innerHTML = '';

        const defaultOptions = {
          autosize: true,
          settingsMenu: true,
          zoomButtons: true,
          expressions: true,
          border: false,
        };

        const calculator = ctor(containerRef.current, {
          ...defaultOptions,
          ...optionsRef.current,
        });

        calculatorRef.current = calculator;
        setStatus('ready');
        setErrorDetails('');

        const observer = new MutationObserver(() => {
          const banner = document.querySelector('.dcg-api-warning-banner');
          if (banner) banner.remove();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        onReadyRef.current?.(calculator);
      } catch (err: any) {
        console.error('Desmos init failed:', err);
        if (isMounted.current && !destroyed) {
          setStatus('error');
          setErrorDetails(err?.message || String(err));
        }
      }
    };

    const loadScript = () => {
      setStatus('loading');

      const ready =
        window.Desmos &&
        (mode === '3d'
          ? typeof window.Desmos.Calculator3D === 'function'
          : typeof window.Desmos.GraphingCalculator === 'function');

      if (ready) {
        initCalculator();
        return;
      }

      let script = document.querySelector(
        `script[src="${SCRIPT_URL}"]`,
      ) as HTMLScriptElement | null;

      if (!script) {
        script = document.createElement('script');
        script.src = SCRIPT_URL;
        script.async = true;
        script.onerror = (e: any) => {
          console.error('Desmos script load error:', e);
          if (isMounted.current && !destroyed) {
            setStatus('error');
            setErrorDetails(e?.message || 'script load error');
          }
        };
        document.head.appendChild(script);
      }

      let attempts = 0;
      const MAX_ATTEMPTS = 200;

      checkInterval = setInterval(() => {
        const ok =
          window.Desmos &&
          (mode === '3d'
            ? typeof window.Desmos.Calculator3D === 'function'
            : typeof window.Desmos.GraphingCalculator === 'function');

        if (ok) {
          if (checkInterval) clearInterval(checkInterval);
          initCalculator();
        } else {
          attempts++;
          if (attempts >= MAX_ATTEMPTS) {
            if (checkInterval) clearInterval(checkInterval);
            if (isMounted.current && !destroyed && !calculatorRef.current) {
              console.error('Desmos loading timed out');
              setStatus('error');
              setErrorDetails('Desmos loading timed out');
            }
          }
        }
      }, 100);
    };

    loadScript();

    const resizeObserver = new ResizeObserver(() => {
      if (calculatorRef.current) {
        try {
          calculatorRef.current.resize();
        } catch {
          /* ignore */
        }
      }
    });

    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }

    return () => {
      destroyed = true;
      isMounted.current = false;
      if (checkInterval) clearInterval(checkInterval);
      destroyCalculator();
      resizeObserver.disconnect();
    };
  }, [mode]);

  return (
    <div className={`relative ${className}`}>
      <div ref={containerRef} id="calculator" className="w-full h-full" />

      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-red-50 z-10 p-6 text-center">
          <AlertCircle className="w-10 h-10 text-red-500 mb-3" />
          <h3 className="text-gray-900 font-bold mb-1">加载失败</h3>
          <p className="text-gray-600 text-sm mb-2">无法加载 Desmos API 组件</p>
          {errorDetails && (
            <p className="text-gray-500 text-xs mb-3 max-w-md">{errorDetails}</p>
          )}
          <div className="text-gray-600 text-xs mb-4 space-y-1">
            <p>- 请检查网络连接是否正常</p>
            <p>- 确认可以访问 www.desmos.com</p>
            <p>- 尝试关闭 VPN 或代理</p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50 transition-colors shadow-sm"
          >
            <RefreshCcw size={14} />
            刷新重试
          </button>
        </div>
      )}
    </div>
  );
};
