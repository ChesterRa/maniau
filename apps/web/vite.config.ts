import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 開発の時は、API をサーバー（apps/server）へ渡す。
    proxy: { '/api': 'http://localhost:8787' },
  },
});
