import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { installMockApi } from './core/mockApi';

// GitHub Pages 是纯静态托管，没有 server/server.ts。
//
// 规则（与 src/core/runtimeConfig.ts 一致）：
//   - 配置了 VITE_BACKEND_WS_URL  → 认作"有后端"，不装 mock，/api/* 走真实网络
//   - 没配置                      → 生产构建下装 mock，数据存 IndexedDB
//   - 开发态（npm run dev）        → 永远不装 mock，打本机真后端
//
// 注意：这里必须是静态 import + 同步调用。用 `await import(...)` 的顶层 await
// 会要求构建 target 提到 es2022，而 Vite 默认 es2020 会直接报
// "Top-level await is not available in the configured target environment"。
if (import.meta.env.PROD) {
  installMockApi();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
