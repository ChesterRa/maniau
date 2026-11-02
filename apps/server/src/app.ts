// API。見る人ごとのデモの家庭（架空の家族。ログインなし）と、その命令。画面には見せる物だけを渡し、
// 事象の列は渡さない（02-foundation §7.1）。身元の確かめ（Cloudflare Access の JWT）と Postgres の
// 置き場所は、この後に足す。
import { Command } from '@maniau/core';
import { Hono } from 'hono';
import { z } from 'zod';
import { DEMO_STAGES, isDemoStage, loadDemoData } from './demo';
import { demoSessions } from './demo-sessions';

export function createApp(): Hono {
  // 起きる時に、デモの家族とお知らせを読み、型と家族の決まりを確かめる（誤りなら起きない）。
  loadDemoData();
  const sessions = demoSessions();
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ ok: true }));
  // デモの家庭を、見る人ごとにサーバーに作る。計画はサーバーで作り、画面は見せる物を受け取る（§7.1）。
  app.post('/api/demo/sessions', async (c) => {
    const body = z.object({ stage: z.string() }).safeParse(await c.req.json().catch(() => ({})));
    if (!body.success || !isDemoStage(body.data.stage)) {
      return c.json({ error: 'unknownStage' }, 400);
    }
    // 家族（使う人を選ぶため）、読み取りの出どころ（録った応答か、手で書いた形か）、段の一覧も返す。
    const data = loadDemoData();
    return c.json({
      sessionId: sessions.create(body.data.stage),
      household: data.household,
      readings: data.readings.map(({ sourceId, origin, model }) => ({ sourceId, origin, model })),
      stages: DEMO_STAGES.map((s) => ({ id: s.id, now: s.now, viewer: s.viewer })),
    });
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
