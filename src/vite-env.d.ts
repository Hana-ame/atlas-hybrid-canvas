/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
  readonly VITE_BASE_PATH?: string;
  readonly VITE_PROXY_ALLOWED_HOSTS?: string;
  // 演示用 mock 保存密钥；未设置时 mockApi 回退到内置的 atlas-demo-key
  readonly VITE_MOCK_SAVE_KEY?: string;
  // 外部后端 WebSocket 地址（如 wss://xxx.example.com/ws）。
  // 留空 = 纯静态模式：/api/* 在浏览器内执行、无协同房间。
  // 填了 = 连后端模式：不装本地处理，/api/* 经 WS 转发给服务端。
  readonly VITE_BACKEND_WS_URL?: string;
  // 浏览器模式下的代理白名单与限流（服务端模式读不带 VITE_ 前缀的那组）
  readonly VITE_PROXY_RATE_LIMIT_PER_MIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
