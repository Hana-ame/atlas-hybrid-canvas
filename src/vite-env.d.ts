/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PROD: boolean;
  readonly DEV: boolean;
  readonly MODE: string;
  readonly BASE_URL: string;
  readonly VITE_BASE_PATH?: string;
  readonly VITE_PROXY_ALLOWED_HOSTS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
