import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { installMockApi } from './core/mockApi';

// GitHub Pages 是纯静态托管，没有 server/server.ts。
// 生产构建下装上浏览器内 mock，让 /api/* 三个契约接口依旧可用。
// 开发态（npm run dev）保持打真后端，行为不变。
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
