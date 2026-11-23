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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
