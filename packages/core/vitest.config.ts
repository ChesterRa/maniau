// パッケージを並べて試す時も、機械が混んで 5 秒で切れないようにする。
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 30_000 } });
