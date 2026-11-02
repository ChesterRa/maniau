// API。デモの家族（段の事象、見る人ごとのデモの家庭と命令）。身元の確かめ（Cloudflare Access の JWT）と
// Postgres の置き場所は、この後に足す。
import { readFileSync } from 'node:fs';
import { Command, Household, validateHousehold } from '@maniau/core';
import { Hono } from 'hono';
import { z } from 'zod';
import { demoStage, isDemoStage } from './demo';
import { demoSessions } from './demo-sessions';

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
  const sessions = demoSessions();
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/demo/household', (c) => c.json(demoHousehold));
  // デモの段（架空の家族の事象の列と時刻）。ログインなし。実在の家族の物は別の置き場所に置く。
  app.get('/api/demo/stage/:id', (c) => {
    const id = c.req.param('id');
    if (!isDemoStage(id)) return c.json({ error: 'unknownStage' }, 404);
    return c.json(demoStage(id));
  });
  // デモの家庭を、見る人ごとにサーバーに作る。計画はサーバーで作り、画面は見せる物を受け取る（§7.1）。
  app.post('/api/demo/sessions', async (c) => {
    const body = z.object({ stage: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success || !isDemoStage(body.data.stage)) {
      return c.json({ error: 'unknownStage' }, 400);
    }
    return c.json({ sessionId: sessions.create(body.data.stage) });
  });
  app.get('/api/demo/sessions/:sid/view', async (c) => {
    const member = c.req.query('member');
    if (!member) return c.json({ error: 'memberRequired' }, 400);
    const view = await sessions.view(c.req.param('sid'), member);
    return view ? c.json(view) : c.json({ error: 'unknownSession' }, 404);
  });
  app.post('/api/demo/sessions/:sid/commands', async (c) => {
    const body = z
      .object({ memberId: z.string().min(1), operationId: z.string().min(1), command: Command })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'badCommand' }, 400);
    const { memberId, operationId, command } = body.data;
    const done = await sessions.command(c.req.param('sid'), memberId, operationId, command);
    if (!done) return c.json({ error: 'unknownSession' }, 404);
    const status = { ok: 200, noop: 200, conflict: 409, forbidden: 403, invalid: 400 } as const;
    return c.json(done, status[done.result.status]);
  });
  return app;
}
