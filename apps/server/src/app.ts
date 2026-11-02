// API。今はデモの家族を返すだけ。身元の確かめ（Cloudflare Access の JWT）と事象の記録は、この後に足す。
import { readFileSync } from 'node:fs';
import { Household, validateHousehold } from '@maniau/core';
import { Hono } from 'hono';

const DEMO_HOUSEHOLD_URL = new URL('../../../data/demo/household.json', import.meta.url);

export function loadDemoHousehold(): Household {
  const household = Household.parse(JSON.parse(readFileSync(DEMO_HOUSEHOLD_URL, 'utf8')));
  const issues = validateHousehold(household);
  if (issues.length > 0) {
    throw new Error(`デモの家族の情報に誤りがある：${JSON.stringify(issues)}`);
  }
  return household;
}

export function createApp(): Hono {
  const demoHousehold = loadDemoHousehold();
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/demo/household', (c) => c.json(demoHousehold));
  return app;
}
