import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  outputDir: fileURLToPath(new URL('../.local/e2e-results/artifacts', import.meta.url)),
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:15183',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    screenshot: 'only-on-failure',
    trace: 'off',
    ...(process.env.MANIAU_E2E_BROWSER
      ? { launchOptions: { executablePath: process.env.MANIAU_E2E_BROWSER } }
      : {}),
  },
});
