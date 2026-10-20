import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// 开发期：
//   pnpm dev        → 纯前端 + 内置 mock API（无需 Rust 服务）
//   pnpm dev:real   → 代理 /api 到真实 Rust 服务（先设置 MWB_DEV_BACKEND，如 http://127.0.0.1:8765，
//                     并把服务启动 URL 里的 ?token= 带到前端地址：http://localhost:5173/?token=...）
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = env.MWB_DEV_BACKEND || ''
  return {
    plugins: [vue()],
    base: '/',
    server: {
      port: Number(env.MWB_DEV_PORT || 5173),
      strictPort: false,
      proxy: backend
        ? {
            '/api': { target: backend, changeOrigin: false },
          }
        : undefined,
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      target: ['chrome110', 'edge110'],
      emptyOutDir: true,
      chunkSizeWarningLimit: 2048,
    },
  }
})
