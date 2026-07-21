/**
 * ============================================================================
 * vite.config.ts — Vite 构建工具配置文件
 * ============================================================================
 *
 * 【Vite 是什么？】
 * Vite 是一个现代化的前端构建工具（类似 webpack，但速度更快）。
 * 它负责：
 *   - 开发模式：启动本地开发服务器（热模块替换，修改代码立即刷新）
 *   - 生产构建：把 TypeScript/React 代码打包成浏览器可运行的 JS 文件
 *
 * 【这个配置文件的作用】
 * 告诉 Vite 如何处理这个项目：
 *   1. 使用哪些插件（React、Tailwind CSS）
 *   2. 路径别名（@ 指向 src/app，简化长路径导入）
 *   3. 自定义资源解析规则（figma: 协议）
 */

// defineConfig：Vite 提供的辅助函数，让配置对象有 TypeScript 类型提示
import { defineConfig, loadEnv } from 'vite'

// path：Node.js 内置模块，提供跨平台的文件路径操作工具
import path from 'path'

// @tailwindcss/vite：Tailwind CSS 的 Vite 插件
// Tailwind 是一个"原子化 CSS 框架"：用类名描述样式（如 "bg-blue-500 text-white rounded"）
// 这个插件让 Vite 在打包时自动处理 Tailwind 类名
import tailwindcss from '@tailwindcss/vite'

// @vitejs/plugin-react：React 的 Vite 插件
// 让 Vite 能理解并编译 JSX（React 的 HTML 扩展语法）和 TypeScript
import react from '@vitejs/plugin-react'


/**
 * figmaAssetResolver — 自定义 Figma 资源解析插件
 *
 * 项目中的图片资源使用 "figma:asset/..." 协议引用（而不是普通的文件路径）。
 * 这是 Figma Make 工具的约定：从 Figma 设计稿导出的资源用特殊前缀标识。
 *
 * 这个插件的作用：
 * 当代码中出现 import x from 'figma:asset/xxx.png' 时，
 * 把 "figma:asset/xxx.png" 替换成实际的文件路径 "src/assets/xxx.png"。
 *
 * @returns Vite 插件对象（包含 name 和 resolveId 方法）
 */
/**
 * stripPackageVersion — 去掉 Figma Make 导出代码里的 @version 后缀
 * 例如 "sonner@2.0.3" → "sonner"
 */
function stripPackageVersion() {
  const versionSuffix = /(@[^/]+\/[^@]+|[^@/]+)@\d+\.\d+\.\d+$/

  return {
    name: 'strip-package-version',
    resolveId(id: string, importer: string | undefined, options: { skipSelf?: boolean }) {
      const match = id.match(versionSuffix)
      if (!match) return

      return this.resolve(match[1], importer, { ...options, skipSelf: true })
    },
  }
}

function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver', // 插件名称（用于调试和错误信息）

    /**
     * resolveId — Vite 的模块解析钩子
     * 每当代码中有 import 语句时，Vite 都会调用这个方法。
     * 我们检查 import 的路径是否以 "figma:asset/" 开头，
     * 如果是，就把它转换成 src/assets/ 下对应的文件路径。
     *
     * @param id - import 语句中的模块标识符（如 "figma:asset/logo.png"）
     * @returns 解析后的绝对路径，或 undefined（表示不处理这个 import）
     */
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        // 提取文件名部分（去掉 "figma:asset/" 前缀）
        const filename = id.replace('figma:asset/', '')

        // path.resolve(__dirname, 'src/assets', filename)
        // 把三个部分拼接成绝对路径：
        //   __dirname = 当前文件所在目录（项目根目录）
        //   'src/assets' = 资源文件夹
        //   filename = 具体文件名
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

// 导出 Vite 配置对象（Vite 会自动读取这个默认导出）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const serverDeepSeekKey = env.DEEPSEEK_API_KEY || env.VITE_DEEPSEEK_API_KEY || '';
  const serverGeminiKey = env.GEMINI_API_KEY || env.VITE_GEMINI_API_KEY || '';

  const injectBearer = (
    proxyReq: import('http').ClientRequest,
    req: import('http').IncomingMessage,
    fallbackKey: string,
  ) => {
    const auth = req.headers['authorization'];
    const bearerMatch = typeof auth === 'string' && auth.match(/^Bearer\s+(.+)$/i);
    const key = (bearerMatch?.[1]?.trim()) || fallbackKey;
    if (key) proxyReq.setHeader('Authorization', `Bearer ${key}`);
  };

  return {
  plugins: [
    stripPackageVersion(), // 自定义：解析 package@version 导入
    figmaAssetResolver(), // 自定义：解析 figma:asset/ 资源路径

    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),        // React JSX/TypeScript 支持
    tailwindcss(),  // Tailwind CSS 处理
  ],

  // resolve.alias：路径别名配置
  // 让代码可以用 "@/..." 代替冗长的 "../../src/app/..." 相对路径
  // 例如：import { useLanguage } from '@/lib/i18n' 
  //        等同于 import { useLanguage } from '../../src/app/lib/i18n'
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/app'), // @ 指向 src/app 目录
    },
  },

  server: {
    proxy: {
      '/api/deepseek': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/deepseek/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            injectBearer(proxyReq, req, serverDeepSeekKey);
          });
        },
      },
      '/api/gemini': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/gemini/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            injectBearer(proxyReq, req, serverGeminiKey);
          });
        },
      },
    },
  },
};
});
