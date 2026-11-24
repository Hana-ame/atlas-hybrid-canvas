import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { installMockApi } from './core/mockApi';
import { initAuthSession } from './core/apiClient';
import { CanvasErrorBoundary } from './components/CanvasErrorBoundary';

// 统一在入口挂载 /api/* 拦截器，开发态与生产态走同一条路径：
//   - 配置了 VITE_BACKEND_WS_URL  → mockApi 经 WebSocket RPC 转发到真后端（断线再回退本地）
//   - 未配置 VITE_BACKEND_WS_URL  → mockApi 直接在浏览器内跑 apiCore + IndexedDB 作为本地后端
//
// 注意：这里必须是静态 import + 同步调用。用 `await import(...)` 的顶层 await
// 会要求构建 target 提到 es2022，而 Vite 默认 es2020 会直接报
// "Top-level await is not available in the configured target environment"。
installMockApi();
void initAuthSession();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CanvasErrorBoundary variant="app">
      <App />
    </CanvasErrorBoundary>
  </StrictMode>
);
