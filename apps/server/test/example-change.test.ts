// 例のお知らせの続き（架空の延期の連絡）を、名前だけの家庭の試用で試せる：一通目の例を入れ、試用の時計がその連絡の
// 届いた時（12/4 17:52）を過ぎてからだけ足せる（時計は動かさない）。足すと、頼んでいた相手への取り消しの連絡が、
// 送った本人の今やることに出て、伝えたと記録すれば消える。画面と同じ HTTP 命令を通し、録ってある読み取りを使う
// （Claude を呼ばない。外への連絡はしない）。
import { type Command, type Household, helperAskOption, type RoutineDay } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { View } from '../src/views';

type App = ReturnType<typeof createApp>;
const headers = { 'content-type': 'application/json' };
let nextOperation = 0;

async function view(app: App, session: string, memberId = 'a1'): Promise<View> {
  const response = await app.request(`/api/demo/sessions/${session}/view?member=${memberId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as View;
}
async function command(app: App, session: string, body: Command, memberId = 'a1'): Promise<View> {
  const response = await app.request(`/api/demo/sessions/${session}/commands`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ memberId, operationId: `change-${++nextOperation}`, command: body }),
  });
  const data = (await response.json()) as { result: { status: string }; view: View };
  expect(response.status).toBe(200);
  expect(['ok', 'noop']).toContain(data.result.status);
  return data.view;
}
async function save(app: App, session: string, household: Household): Promise<View> {
  const response = await app.request(`/api/demo/sessions/${session}/household-preview`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ memberId: 'a1', household }),
  });
  expect(response.status).toBe(200);
  const { preview } = (await response.json()) as { preview: { throughSeq: number; seen: string } };
  return command(app, session, {
    type: 'updateHousehold',
    household,
    seen: { throughSeq: preview.throughSeq, changes: preview.seen },
  });
}
const example = (app: App, session: string, which?: 'first' | 'change') =>
  app.request(`/api/demo/sessions/${session}/example-notice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ memberId: 'a1', ...(which ? { which } : {}) }),
  });
const weekdays = (memberId: string, out: string, back: string): RoutineDay[] =>
  [1, 2, 3, 4, 5].map((weekday) => ({
    memberId,
    weekday,
    segments: [
      { start: '06:30', end: out, kind: 'home', viaStationIds: [] },
      { start: out, end: back, kind: 'away', viaStationIds: [] },
      { start: back, end: '22:30', kind: 'home', viaStationIds: [] },
    ],
    allDay: true,
  }));

async function open(app: App): Promise<string> {
  const opened = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ start: 'own', adults: ['大人A', '大人B'], child: '子H' }),
  });
  expect(opened.status).toBe(200);
  return ((await opened.json()) as { sessionId: string }).sessionId;
}

/** 一通目の例を入れ、ふだんの週と頼める人を足して、この例の見守りを頼んだと記録する（頼み事の ID は r-sato）。 */
async function asked(app: App): Promise<string> {
  const session = await open(app);
  expect((await example(app, session)).status).toBe(200);
  const first = await view(app, session);
  const routines = [...weekdays('a1', '08:00', '19:00'), ...weekdays('a2', '08:30', '18:00')];
  const withRoutines = await save(app, session, { ...first.household, routines });
  const helper = { id: 'h-sato', kind: 'helper' as const, name: 'サトウさん', active: true };
  const withHelper = await save(app, session, {
    ...withRoutines.household,
    members: [...withRoutines.household.members, helper],
    careOptions: [helperAskOption('ask-sato', 'h-sato', 3)],
  });
  const arrangement = withHelper.plan.arrangements.find((a) => a.kind === 'childCare');
  const option = arrangement?.options.find((o) => o.templateId === 'ask-sato');
  if (!arrangement || !option) throw new Error('頼める手が無い');
  const chosen = await command(app, session, {
    type: 'chooseOption',
    arrangementKey: arrangement.key,
    optionKey: option.key,
    role: 'primary',
    assigneeId: 'a1',
  });
  const task = chosen.plan.tasks.find(
    (t) => t.basis.optionKey === option.key && t.external?.to === 'h-sato',
  );
  if (!task) throw new Error('頼む作業が無い');
  await command(app, session, {
    type: 'recordSent',
    taskKey: task.key,
    requestId: 'r-sato',
    window: { start: arrangement.start, end: arrangement.end },
  });
  return session;
}

describe('例のお知らせの続き（延期の連絡）を試用で試す', () => {
  it('初めの情報に、続きの題と届いた時を出す', async () => {
    const app = createApp();
    const session = await open(app);
    const info = await app.request(`/api/demo/sessions/${session}`);
    expect(info.status).toBe(200);
    const body = (await info.json()) as {
      exampleChange?: { sourceId: string; title: string; at: string };
    };
    expect(body.exampleChange).toEqual({
      sourceId: 'n2',
      title: '学習発表会の延期について',
      at: '2026-12-04T17:52+09:00',
    });
  });

  it('一通目の例の前と、届いた時より前は足さない（時計は動かさない）。届いた時ちょうどからは足せる', async () => {
    const app = createApp();
    const session = await open(app);
    const first = await example(app, session, 'change');
    expect(first.status).toBe(409);
    expect(await first.json()).toEqual({ error: 'needsFirst' });
    expect((await example(app, session)).status).toBe(200);
    await command(app, session, { type: 'advanceClock', to: '2026-12-04T17:51+09:00' });
    const early = await example(app, session, 'change');
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: 'tooEarly' });
    const current = await view(app, session);
    expect(current.now).toBe('2026-12-04T17:51+09:00');
    expect(current.sources.map((s) => s.id)).toEqual(['n1']);
    // 届いた時ちょうどからは足せる。
    await command(app, session, { type: 'advanceClock', to: '2026-12-04T17:52+09:00' });
    const onTime = await example(app, session, 'change');
    expect(onTime.status).toBe(200);
    expect(((await onTime.json()) as { added: boolean }).added).toBe(true);
  });

  it('頼んでいた日が延びると、取り消しの連絡が送った本人に出て、伝えたと記録すれば消える。二度は足さない', async () => {
    const app = createApp();
    const session = await asked(app);
    await command(app, session, { type: 'advanceClock', to: '2026-12-04T18:00+09:00' });

    const added = await example(app, session, 'change');
    expect(added.status).toBe(200);
    const result = (await added.json()) as { added: boolean; view: View };
    expect(result.added).toBe(true);
    const after = await view(app, session);
    expect(after.sources.map((s) => s.id)).toEqual(['n1', 'n2']);
    // 延びた日の分の頼み事は要らなくなり、送った本人に取り消しの連絡が出る。もう一人には出ない。
    const cancel = after.today.main.find(
      (c) => c.kind === 'cancel' && c.request.requestId === 'r-sato',
    );
    expect(cancel).toBeDefined();
    const other = await view(app, session, 'a2');
    expect(other.today.main.some((c) => c.kind === 'cancel')).toBe(false);

    const again = await example(app, session, 'change');
    expect(again.status).toBe(200);
    expect(((await again.json()) as { added: boolean }).added).toBe(false);

    const told = await command(app, session, {
      type: 'recordCancellationSent',
      requestId: 'r-sato',
    });
    expect(told.today.main.some((c) => c.kind === 'cancel')).toBe(false);
    expect(told.plan.requests.find((r) => r.requestId === 'r-sato')?.state).toBe('cancelled');
  });

  it('断られたと記録した頼み事には、続きを足しても取り消しの連絡を出さない', async () => {
    const app = createApp();
    const session = await asked(app);
    await command(app, session, { type: 'recordReply', requestId: 'r-sato', reply: 'no' });
    await command(app, session, { type: 'advanceClock', to: '2026-12-04T18:00+09:00' });
    const added = await example(app, session, 'change');
    expect(added.status).toBe(200);
    expect(((await added.json()) as { added: boolean }).added).toBe(true);
    const after = await view(app, session);
    expect(after.today.main.some((c) => c.kind === 'cancel')).toBe(false);
    expect(after.plan.requests.find((r) => r.requestId === 'r-sato')?.state).toBe('turnedDown');
  });
});
