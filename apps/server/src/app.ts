// API。今はデモの家族と、デモの段の事象を返すだけ。身元の確かめ（Cloudflare Access の JWT）と事象の記録は、この後に足す。
import { readFileSync } from 'node:fs';
import { Household, validateHousehold } from '@maniau/core';
import { Hono } from 'hono';
import { demoStage, isDemoStage } from './demo';

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
  // デモの段（架空の家族の事象の列と時刻）。ログインなし。実在の家族の物は別の置き場所に置く。
  app.get('/api/demo/stage/:id', (c) => {
    const id = c.req.param('id');
    if (!isDemoStage(id)) return c.json({ error: 'unknownStage' }, 404);
    return c.json(demoStage(id));
  });
  return app;
}
