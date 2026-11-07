import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // パッケージを並べて試す時も、機械が混んで 5 秒で切れないようにする。
  test: { testTimeout: 30_000 },
  server: {
    // 開発の時は、API をサーバー（apps/server）へ渡す。
    proxy: { '/api': 'http://localhost:8787' },
  },
});
