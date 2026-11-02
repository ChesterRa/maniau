// 試験の設定。試験ごとに PGlite に移行を当てるので重い。機械が混んでいる時に、既定の5秒で切れないよう
// にする（止まった試験は、これで見つける）。
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { testTimeout: 30_000 },
});
