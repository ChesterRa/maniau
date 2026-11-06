// 架空の名前だけの家庭から、画面と同じ HTTP 命令を通して、返事待ちを追う時刻・対象・知らせを確かめる。
// 計画の関数や通知の実装を直接呼ばず、例のお知らせは録ってある読み取りを使う。外への連絡はしない。
import { type Command, type Household, helperAskOption, type RoutineDay } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { View } from '../src/views';

type App = ReturnType<typeof createApp>;
const headers = { 'content-type': 'application/json' };
const start = '2026-12-07T08:30+09:00';
const end = '2026-12-07T18:00+09:00';
const before = '2026-12-06T06:29+09:00';
const threshold = '2026-12-06T06:30+09:00';
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
    body: JSON.stringify({ memberId, operationId: `chase-own-${++nextOperation}`, command: body }),
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

/** 正式の操作で、必要な二人の日程と頼める人を入れ、手を選ぶ。送った記録は呼ぶ側が行う。 */
async function ready(app: App): Promise<{ session: string; taskKey: string }> {
  const opened = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ start: 'own', adults: ['大人A', '大人B'], child: '子H' }),
  });
  expect(opened.status).toBe(200);
  const { sessionId: session } = (await opened.json()) as { sessionId: string };
  const example = await app.request(`/api/demo/sessions/${session}/example-notice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ memberId: 'a1' }),
  });
  expect(example.status).toBe(200);
  const first = await view(app, session);
  const routines = [...weekdays('a1', '08:00', '19:00'), ...weekdays('a2', '08:30', '18:00')];
  const withRoutines = await save(app, session, { ...first.household, routines });
  const household = withRoutines.household;
  const helper = { id: 'h-sato', kind: 'helper' as const, name: 'サトウさん', active: true };
  const withHelper = await save(app, session, {
    ...household,
    members: [...household.members, helper],
    careOptions: [helperAskOption('ask-sato', 'h-sato', 3)],
  });
  const arrangement = withHelper.plan.arrangements.find((entry) => entry.kind === 'childCare');
  if (!arrangement) throw new Error('子の居場所の手配が無い');
  expect([arrangement.start, arrangement.end]).toEqual([start, end]);
  const option = arrangement.options.find((entry) => entry.templateId === 'ask-sato');
  if (!option) throw new Error('頼める手が無い');
  const chosen = await command(app, session, {
    type: 'chooseOption',
    arrangementKey: arrangement.key,
    optionKey: option.key,
    role: 'primary',
    assigneeId: 'a1',
  });
  const task = chosen.plan.tasks.find(
    (entry) => entry.basis.optionKey === option.key && entry.external?.to === 'h-sato',
  );
  if (!task) throw new Error('頼む作業が無い');
  return { session, taskKey: task.key };
}
const mainKinds = (v: View): string[] => v.today.main.map((card) => card.kind);
const waiting = (v: View, requestId: string) =>
  v.today.quiet.some((card) => card.kind === 'waiting' && card.request.requestId === requestId);
const reminder = (v: View, memberId: string) => {
  const member = v.notificationPreview?.members.find((entry) => entry.memberId === memberId);
  return [...(member?.now ?? []), ...(member?.morning?.titles ?? [])]
    .map(String)
    .includes('notify.noReply');
};

describe('空から始めた家庭の、返事待ちを追う道', () => {
  it('窓の 26 時間前に送った本人だけに上げ、返事を記録すれば札と候補が消える', async () => {
    const app = createApp();
    const { session, taskKey } = await ready(app);
    let current = await command(app, session, {
      type: 'recordSent',
      taskKey,
      requestId: 'early-request',
      window: { start, end },
    });
    expect(waiting(current, 'early-request')).toBe(true);
    current = await command(app, session, { type: 'advanceClock', to: before });
    expect(mainKinds(current)).not.toContain('noReply');
    expect(waiting(current, 'early-request')).toBe(true);
    expect(reminder(current, 'a1')).toBe(false);
    current = await command(app, session, { type: 'advanceClock', to: threshold });
    expect(mainKinds(current)).toContain('noReply');
    const raised = current.today.main.filter(
      (card) => String(card.kind) === 'noReply',
    ) as unknown as {
      request: { requestId: string };
    }[];
    expect(raised).toHaveLength(1);
    expect(raised[0]?.request.requestId).toBe('early-request');
    expect(waiting(current, 'early-request')).toBe(false);
    expect(reminder(current, 'a1')).toBe(true);
    const other = await view(app, session, 'a2');
    expect(mainKinds(other)).not.toContain('noReply');
    expect(reminder(other, 'a2')).toBe(false);
    current = await command(app, session, {
      type: 'recordReply',
      requestId: 'early-request',
      reply: 'yes',
    });
    expect(mainKinds(current)).not.toContain('noReply');
    expect(reminder(current, 'a1')).toBe(false);
    expect(current.plan.requests.find((r) => r.requestId === 'early-request')?.state).toBe(
      'confirmed',
    );
  });

  it('26 時間より 1 分前に送れば知らせの候補になる', async () => {
    const app = createApp();
    const { session, taskKey } = await ready(app);
    await command(app, session, { type: 'advanceClock', to: before });
    await command(app, session, {
      type: 'recordSent',
      taskKey,
      requestId: 'near-early-request',
      window: { start, end },
    });
    const current = await command(app, session, { type: 'advanceClock', to: threshold });
    expect(mainKinds(current)).toContain('noReply');
    expect(reminder(current, 'a1')).toBe(true);
  });

  it('送った窓の変更を確かめ直す必要があれば、追う札も知らせも出さない', async () => {
    const app = createApp();
    const { session, taskKey } = await ready(app);
    await command(app, session, {
      type: 'recordSent',
      taskKey,
      requestId: 'check-request',
      window: { start, end },
    });
    const beforeEdit = await command(app, session, { type: 'advanceClock', to: threshold });
    const changed = await save(app, session, {
      ...beforeEdit.household,
      routines: [...weekdays('a1', '08:00', '19:00'), ...weekdays('a2', '09:00', '17:00')],
    });
    expect(changed.plan.requests.find((r) => r.requestId === 'check-request')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(mainKinds(changed)).not.toContain('noReply');
    expect(reminder(changed, 'a1')).toBe(false);
  });

  it('予備が確保できていれば、もとの依頼に追う札も知らせも出さない', async () => {
    const app = createApp();
    const opened = await app.request('/api/demo/sessions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ stage: 'backup' }),
    });
    expect(opened.status).toBe(200);
    const { sessionId: session } = (await opened.json()) as { sessionId: string };
    const initial = await view(app, session, 'b');
    expect(initial.plan.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      state: 'awaitingReply',
      live: true,
    });
    const backup = initial.plan.requests.find((r) => r.requestId === 'r-gakudo');
    expect(backup).toMatchObject({ state: 'confirmed', live: true });
    const arrangement = initial.plan.arrangements.find((entry) => entry.kind === 'childCare');
    expect(arrangement?.backupOptionKeys).toContain(backup?.basis.optionKey);
    const current = await command(
      app,
      session,
      { type: 'advanceClock', to: '2026-12-06T06:10+09:00' },
      'b',
    );
    expect(mainKinds(current)).not.toContain('noReply');
    expect(waiting(current, 'r-grandma')).toBe(true);
    expect(reminder(current, 'b')).toBe(false);
  });

  it('窓が始まった後は札を残し、新しい知らせを作らず、終われば記録の行に戻す', async () => {
    const app = createApp();
    const { session, taskKey } = await ready(app);
    await command(app, session, {
      type: 'recordSent',
      taskKey,
      requestId: 'started-request',
      window: { start, end },
    });
    let current = await command(app, session, { type: 'advanceClock', to: start });
    expect(mainKinds(current)).toContain('noReply');
    expect(waiting(current, 'started-request')).toBe(false);
    expect(reminder(current, 'a1')).toBe(false);
    current = await command(app, session, { type: 'advanceClock', to: end });
    expect(mainKinds(current)).not.toContain('noReply');
    expect(waiting(current, 'started-request')).toBe(true);
    expect(reminder(current, 'a1')).toBe(false);
  });

  it('実施日が替わり頼んだ見守りが要らなくなったら、追う札・知らせを出さない', async () => {
    const app = createApp();
    const { session, taskKey } = await ready(app);
    await command(app, session, {
      type: 'recordSent',
      taskKey,
      requestId: 'changed-request',
      window: { start, end },
    });
    await command(app, session, { type: 'advanceClock', to: threshold });
    const current = await command(app, session, {
      type: 'answer',
      unknownId: 'n1:u1',
      value: '2026-12-08',
    });
    expect(current.plan.requests.find((r) => r.requestId === 'changed-request')?.live).toBe(false);
    expect(mainKinds(current)).not.toContain('noReply');
    expect(reminder(current, 'a1')).toBe(false);
  });

  it('断られた返事を記録したら、その依頼の未回答を追わない', async () => {
    const app = createApp();
    const { session, taskKey } = await ready(app);
    await command(app, session, {
      type: 'recordSent',
      taskKey,
      requestId: 'declined-request',
      window: { start, end },
    });
    await command(app, session, { type: 'advanceClock', to: threshold });
    const current = await command(app, session, {
      type: 'recordReply',
      requestId: 'declined-request',
      reply: 'no',
    });
    expect(current.plan.requests.find((r) => r.requestId === 'declined-request')?.state).toBe(
      'turnedDown',
    );
    expect(mainKinds(current)).not.toContain('noReply');
    expect(reminder(current, 'a1')).toBe(false);
  });

  it('送っていなかったと訂正したら、誤った送信記録を追わない', async () => {
    const app = createApp();
    const { session, taskKey } = await ready(app);
    await command(app, session, {
      type: 'recordSent',
      taskKey,
      requestId: 'corrected-request',
      window: { start, end },
    });
    await command(app, session, { type: 'advanceClock', to: threshold });
    const current = await command(app, session, {
      type: 'correctSentRecord',
      requestId: 'corrected-request',
    });
    expect(current.plan.requests.some((r) => r.requestId === 'corrected-request')).toBe(false);
    expect(mainKinds(current)).not.toContain('noReply');
    expect(reminder(current, 'a1')).toBe(false);
  });

  it('遅く送った記録は上げるが再読後も知らせず、窓が終わった後は返事待ちの記録を残す', async () => {
    const app = createApp();
    const { session, taskKey } = await ready(app);
    await command(app, session, { type: 'advanceClock', to: threshold });
    let current = await command(app, session, {
      type: 'recordSent',
      taskKey,
      requestId: 'late-request',
      window: { start, end },
    });
    expect(mainKinds(current)).toContain('noReply');
    expect(reminder(current, 'a1')).toBe(false);
    current = await view(app, session);
    expect(mainKinds(current)).toContain('noReply');
    expect(reminder(current, 'a1')).toBe(false);
    current = await command(app, session, { type: 'advanceClock', to: '2026-12-06T06:31+09:00' });
    expect(mainKinds(current)).toContain('noReply');
    expect(reminder(current, 'a1')).toBe(false);
    current = await command(app, session, { type: 'advanceClock', to: end });
    expect(mainKinds(current)).not.toContain('noReply');
    expect(reminder(current, 'a1')).toBe(false);
    expect(waiting(current, 'late-request')).toBe(true);
    current = await command(app, session, {
      type: 'recordReply',
      requestId: 'late-request',
      reply: 'yes',
    });
    expect(current.plan.requests.find((r) => r.requestId === 'late-request')?.state).toBe(
      'confirmed',
    );
  });
});
