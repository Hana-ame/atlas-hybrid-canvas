import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// GitHub Pages 是纯静态托管，没有 server/server.ts。
// 生产构建下装上浏览器内 mock，让 /api/* 三个契约接口依旧可用。
// 开发态（npm run dev）保持打真后端，行为不变。
if (import.meta.env.PROD) {
  const { installMockApi } = await import('./core/mockApi');
  installMockApi();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
