import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// 読み取り関数の有無を切り替える試験は、通常の入口とは別に起動する。
export default defineConfig(base, { testMatch: '**/*.trial.ts' });
