import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// GitHub Pages 项目页部署在 https://<user>.github.io/<repo>/ 子路径下，
// 资源必须带这个前缀，否则 JS/CSS 全部 404。
// CI 里通过 VITE_BASE_PATH 注入；本地不设时退回 '/'，npm run dev 不受影响。
const base = process.env.VITE_BASE_PATH || '/';

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@xyflow/') || id.includes('node_modules/d3-')) {
            return 'vendor-xyflow';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons';
          }
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react';
          }
        },
      },
    },
  },
});
