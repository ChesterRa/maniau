// 名前だけの家族（空から始めた試用）で、例のお知らせから、足りない事実（大人がその日に子を見られるか）を聞き、
// 答え・平日の型を確かめて入れ、頼める人を足して、選べる手と決め時が出るまで。画面が使う HTTP の口だけを通す。
import { type DayAnswer, type Household, helperAskOption, type RoutineDay } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { View } from '../src/views';

const jsonHeaders = { 'content-type': 'application/json' };
type App = ReturnType<typeof createApp>;
const DAY = '2026-12-07';

async function begin(app: App): Promise<string> {
  const response = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ start: 'own', adults: ['大人A', '大人B'], child: '子H' }),
  });
  const { sessionId } = (await response.json()) as { sessionId: string };
  const added = await app.request(`/api/demo/sessions/${sessionId}/example-notice`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ memberId: 'a1' }),
  });
  expect(added.status).toBe(200);
  return sessionId;
}
async function view(app: App, sid: string, member = 'a1'): Promise<View> {
  const response = await app.request(`/api/demo/sessions/${sid}/view?member=${member}`);
  return (await response.json()) as View;
}
let operation = 0;
/** 見てから、見た物で書く（画面と同じ）。見る所で断られれば、その理由。 */
async function save(app: App, sid: string, household: Household): Promise<string> {
  const looked = await app.request(`/api/demo/sessions/${sid}/household-preview`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ memberId: 'a1', household }),
  });
  if (looked.status !== 200) return ((await looked.json()) as { error: string }).error;
  const { preview } = (await looked.json()) as {
    preview: { throughSeq: number; seen: unknown };
  };
  const response = await app.request(`/api/demo/sessions/${sid}/commands`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      memberId: 'a1',
      operationId: `own-${++operation}`,
      command: {
        type: 'updateHousehold',
        household,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      },
    }),
  });
  const { result } = (await response.json()) as { result: { status: string; reason?: string } };
  return result.reason ?? result.status;
}
/** 平日（月〜金）の型：家 → 外（仕事と行き帰り）→ 家。家族が一日の全部を確かめて記録した印つき。 */
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
// 例のお知らせの子の居場所は一つ（12/7 の振替の休み。子は一人）。
const care = (v: View) => v.plan.requirements.find((r) => r.kind === 'childCare');
const arrangement = (v: View) => v.plan.arrangements.find((a) => a.kind === 'childCare');
const kinds = (v: View) => v.today.main.map((c) => c.kind);

describe('名前だけの家族で、子の居場所の足りない事実を聞く', () => {
  it('だれの予定も無いうちは、手配も「何もない」も出さず、大人の二人に聞く札を出す', async () => {
    const app = createApp();
    const sid = await begin(app);
    const v = await view(app, sid);
    expect(v.household.confirmDays).toBe(true);
    expect(care(v)?.date).toBe(DAY);
    expect(care(v)?.missingAdults).toEqual(['a1', 'a2']);
    expect(care(v)?.unsure).toEqual([
      { start: `${DAY}T00:00+09:00`, end: '2026-12-08T00:00+09:00' },
    ]);
    expect(arrangement(v)).toBeUndefined();
    expect(kinds(v)).toContain('facts');
    expect(kinds(await view(app, sid, 'a2'))).toContain('facts');
  });

  it('日の記録は、家族が一日の全部を確かめて記録した印が無いと足せない', async () => {
    const app = createApp();
    const sid = await begin(app);
    const household = (await view(app, sid)).household;
    const [first] = weekdays('a1', '08:00', '19:00');
    if (!first) throw new Error('平日が無い');
    const { allDay: _mark, ...unconfirmed } = first;
    expect(await save(app, sid, { ...household, routines: [unconfirmed] })).toBe('dayNotConfirmed');
    expect(
      await save(app, sid, {
        ...household,
        routineExceptions: [{ memberId: 'a1', date: DAY, segments: first.segments }],
      }),
    ).toBe('dayNotConfirmed');
    // 空から始めた印は、外せない。
    const { confirmDays: _confirm, ...plain } = household;
    expect(await save(app, sid, plain)).toBe('householdIdentity');
  });

  it('平日の型を確かめて入れると、二人とも見られない時間に手配を置き、聞く札を閉じる。手が無ければ、手が無いと出す', async () => {
    const app = createApp();
    const sid = await begin(app);
    const household = (await view(app, sid)).household;
    const routines = [...weekdays('a1', '08:00', '19:00'), ...weekdays('a2', '08:30', '18:00')];
    expect(await save(app, sid, { ...household, routines })).toBe('ok');
    const v = await view(app, sid);
    expect(care(v)?.missingAdults).toBeUndefined();
    expect(arrangement(v)?.start).toBe(`${DAY}T08:30+09:00`);
    expect(arrangement(v)?.end).toBe(`${DAY}T18:00+09:00`);
    expect(arrangement(v)?.options).toEqual([]);
    expect(kinds(v)).not.toContain('facts');
  });

  it('頼める人を足すと、その人に頼む手と決め時が出る。決まった形でない手は足せない', async () => {
    const app = createApp();
    const sid = await begin(app);
    const base = (await view(app, sid)).household;
    const routines = [...weekdays('a1', '08:00', '19:00'), ...weekdays('a2', '08:30', '18:00')];
    expect(await save(app, sid, { ...base, routines })).toBe('ok');
    const household = (await view(app, sid)).household;
    const helper = { id: 'h-sato', kind: 'helper' as const, name: 'サトウさん', active: true };
    const ask = helperAskOption('opt-h-sato', 'h-sato', 3);
    const members = [...household.members, helper];
    // 決まった形でない：締切の日数・手順・頼む相手が違う、ほかの種類の手。
    for (const option of [
      { ...ask, deadline: { type: 'daysBefore' as const, days: 2, at: '21:00' } },
      { ...ask, steps: ask.steps.map((s) => ({ ...s, durationMin: 1 })) },
      { ...ask, providerId: 'a1' },
      { ...ask, kind: 'paidLeave' as const },
    ]) {
      expect(await save(app, sid, { ...household, members, careOptions: [option] })).toBe(
        'careOptionsLocked',
      );
    }
    expect(await save(app, sid, { ...household, members, careOptions: [ask] })).toBe('ok');
    const v = await view(app, sid);
    const options = arrangement(v)?.options ?? [];
    expect(options.map((o) => o.templateId)).toEqual(['opt-h-sato']);
    expect(options[0]?.decisionDeadline).toBeDefined();
    expect(options[0]?.noSlot).toBeUndefined();
    // 同じ人に頼む手は二つ足せない。
    expect(
      await save(app, sid, {
        ...v.household,
        careOptions: [...v.household.careOptions, helperAskOption('opt-h-sato-2', 'h-sato', 1)],
      }),
    ).toBe('careOptionsLocked');
  });
});

describe('その日の答え', () => {
  const answer = (memberId: string, rest: DayAnswer['rest']): DayAnswer => ({
    memberId,
    date: DAY,
    can: [],
    cannot: [],
    rest,
  });

  it('一人が一日見られると答えると、手配は要らない。「分からない」と答え直すと、平日の型には戻らず聞き直す', async () => {
    const app = createApp();
    const sid = await begin(app);
    const base = (await view(app, sid)).household;
    const routines = [...weekdays('a1', '08:00', '19:00'), ...weekdays('a2', '08:30', '18:00')];
    expect(await save(app, sid, { ...base, routines })).toBe('ok');
    const household = (await view(app, sid)).household;
    expect(await save(app, sid, { ...household, dayAnswers: [answer('a1', 'can')] })).toBe('ok');
    let v = await view(app, sid);
    expect(arrangement(v)).toBeUndefined();
    expect(care(v)?.missingAdults).toBeUndefined();
    expect(await save(app, sid, { ...v.household, dayAnswers: [answer('a1', 'unknown')] })).toBe(
      'ok',
    );
    v = await view(app, sid);
    expect(arrangement(v)).toBeUndefined();
    expect(care(v)?.missingAdults).toEqual(['a1']);
    expect(kinds(v)).toContain('facts');
  });

  it('答えは今いる大人の物だけ（子の答えは断る）', async () => {
    const app = createApp();
    const sid = await begin(app);
    const household = (await view(app, sid)).household;
    expect(await save(app, sid, { ...household, dayAnswers: [answer('c1', 'can')] })).not.toBe(
      'ok',
    );
  });
});
