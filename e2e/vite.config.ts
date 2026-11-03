// いつもの画面を別のポートで出し、試験の API だけにつなぐ。
// 手元の .env は読まず、作り手の開発サーバーも使わない。
import { fileURLToPath } from 'node:url';
import base from '../apps/web/vite.config.ts';

export default {
  ...base,
  root: fileURLToPath(new URL('../apps/web', import.meta.url)),
  envDir: fileURLToPath(new URL('../.local/e2e-empty-env', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 15183,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:18797' },
  },
};
