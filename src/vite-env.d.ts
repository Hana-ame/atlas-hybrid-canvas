/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
  readonly VITE_BASE_PATH?: string;
  readonly VITE_PROXY_ALLOWED_HOSTS?: string;
  // 与服务端 PROXY_CLIENT_TOKEN 配对；配置后端 token 时前端必须带同值，否则 /api/proxy 等会被 401
  readonly VITE_PROXY_CLIENT_TOKEN?: string;
  // 演示用 mock 保存密钥；未设置时 mockApi 回退到内置的 atlas-demo-key
  readonly VITE_MOCK_SAVE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
