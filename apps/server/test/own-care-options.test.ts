// 名前だけの家族（空から始めた試用）で、家族が学童と休みの手を足す。決まった形の手だけを受け、足すと、頼める人に
// 頼む手と並んで、手ごとに違う決め時が出る（いくつかの手の、それぞれの消える時を比べられる）。画面が使う HTTP の
// 口だけを通す。
import {
  afterSchoolOption,
  type CareOptionTemplate,
  type Household,
  helperAskOption,
  leaveOption,
  type Place,
  type RoutineDay,
} from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DEMO_STAGES, demoEvents } from '../src/demo';
import type { View } from '../src/views';

const jsonHeaders = { 'content-type': 'application/json' };
type App = ReturnType<typeof createApp>;

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
async function view(app: App, sid: string): Promise<View> {
  const response = await app.request(`/api/demo/sessions/${sid}/view?member=a1`);
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
      operationId: `care-${++operation}`,
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
/** 平日（月〜金）の型：家 → 仕事 → 家。家族が一日の全部を確かめて記録した印つき。 */
const weekdays = (memberId: string, out: string, back: string): RoutineDay[] =>
  [1, 2, 3, 4, 5].map((weekday) => ({
    memberId,
    weekday,
    segments: [
      { start: '06:30', end: out, kind: 'home', viaStationIds: [] },
      { start: out, end: back, kind: 'work', viaStationIds: [] },
      { start: back, end: '22:30', kind: 'home', viaStationIds: [] },
    ],
    allDay: true,
  }));
const arrangement = (v: View) => v.plan.arrangements.find((a) => a.kind === 'childCare');

const GAKUDO: Place = { id: 'p-gakudo', kind: 'afterSchoolCare', name: 'ひかり学童', goods: [] };
const WORK: Place = { id: 'p-work-a1', kind: 'workplace', name: '大人Aの職場', goods: [] };
/** 一日利用で見てもらえる時間（この家の平日の手配の時間 08:30–18:00 を全部含む）。 */
const FULL_DAY = { start: '08:00', end: '19:00' };
const gakudo = afterSchoolOption(
  'opt-p-gakudo',
  GAKUDO.id,
  { type: 'weekdayOfPreviousWeek', weekday: 1, at: '18:30' },
  1000,
  true,
  FULL_DAY,
);
const leave = leaveOption('opt-leave-a1', 'a1', WORK.id, 3, '18:00');
const helper = { id: 'h-sato', kind: 'helper' as const, name: 'サトウさん', active: true };
const ask = helperAskOption('opt-h-sato', 'h-sato', 3);

/** 平日の型を入れた家（手はまだ無い）。 */
async function ready(app: App) {
  const sid = await begin(app);
  const base = (await view(app, sid)).household;
  const routines = [...weekdays('a1', '08:00', '19:00'), ...weekdays('a2', '08:30', '18:00')];
  expect(await save(app, sid, { ...base, routines })).toBe('ok');
  return { sid, household: (await view(app, sid)).household };
}

describe('家族が学童と休みの手を足す', () => {
  it('頼める人・学童・休みを足すと、三つの手が、それぞれ違う決め時で並ぶ', async () => {
    const app = createApp();
    const { sid, household } = await ready(app);
    expect(
      await save(app, sid, {
        ...household,
        members: [...household.members, helper],
        places: [...household.places, GAKUDO, WORK],
        careOptions: [ask, gakudo, leave],
      }),
    ).toBe('ok');
    const options = arrangement(await view(app, sid))?.options ?? [];
    expect(options.map((o) => o.templateId).sort()).toEqual(
      ['opt-h-sato', 'opt-leave-a1', 'opt-p-gakudo'].sort(),
    );
    for (const option of options) {
      expect(option.decisionDeadline).toBeDefined();
      expect(option.noSlot).toBeUndefined();
    }
    const deadlines = new Map(options.map((o) => [o.templateId, o.decisionDeadline]));
    // 学童：前の週の月曜 18:30（12/7 の前の週の月曜は 11/30）。休み：3 営業日前の 18:00（12/2 の水曜）。
    // 頼める人：3 日前の 21:00（12/4）。どれも、その時刻より前に始める作業の時刻が決め時になる。
    const at = (id: string) => String(deadlines.get(id)).slice(0, 10);
    expect(at('opt-p-gakudo')).toBe('2026-11-30');
    expect(at('opt-leave-a1')).toBe('2026-12-02');
    expect(at('opt-h-sato')).toBe('2026-12-04');
    expect(new Set(deadlines.values()).size).toBe(3);
  });

  it('お弁当が要る学童は、その日の朝に家で作る作業が増え、要らなければ増えない', async () => {
    const app = createApp();
    const { sid, household } = await ready(app);
    const plain = afterSchoolOption(
      'opt-p-gakudo',
      GAKUDO.id,
      { type: 'daysBefore', days: 7, at: '17:00' },
      0,
      false,
      FULL_DAY,
    );
    expect(plain.extraSteps).toEqual([]);
    expect(plain.cost.extraTasks).toBe(0);
    expect(gakudo.extraSteps.map((s) => s.id)).toEqual(['bento-make']);
    expect(gakudo.cost.extraTasks).toBe(1);
    expect(
      await save(app, sid, {
        ...household,
        places: [...household.places, GAKUDO],
        careOptions: [plain],
      }),
    ).toBe('ok');
    const option = arrangement(await view(app, sid))?.options[0];
    expect(String(option?.decisionDeadline).slice(0, 10)).toBe('2026-11-30');
  });

  it('決まった形でない学童・休みの手と、手の無い学童・職場は足せない', async () => {
    const app = createApp();
    const { sid, household } = await ready(app);
    // 足す場所は、その手が指す物だけ（相手・手順の外の相手。指さない場所は、場所の決まりで先に断られ、指すのに
    // 無い場所は、家の情報の誤りになる）。
    const withPlaces = (o: CareOptionTemplate) => {
      const used = new Set([o.providerId, ...o.steps.map((s) => s.external?.to)]);
      return {
        ...household,
        places: [...household.places, ...[GAKUDO, WORK].filter((p) => used.has(p.id))],
      };
    };
    for (const option of [
      // 学童：締切の曜日が日曜、日数が 30 日を超える、見てもらえる時間が無い・逆さま・一日の全部、手順の時間・
      // 相手が違う、費用が上限を超える。
      { ...gakudo, deadline: { type: 'weekdayOfPreviousWeek' as const, weekday: 7, at: '18:30' } },
      { ...gakudo, deadline: { type: 'daysBefore' as const, days: 31, at: '18:30' } },
      { ...gakudo, covers: undefined },
      { ...gakudo, covers: { start: '19:00', end: '08:00' } },
      { ...gakudo, covers: 'whole' as const },
      { ...gakudo, steps: gakudo.steps.map((s) => ({ ...s, durationMin: 1 })) },
      { ...gakudo, providerId: WORK.id },
      { ...gakudo, cost: { ...gakudo.cost, yen: 100_001 } },
      { ...gakudo, cost: { ...gakudo.cost, leaveMinutes: 60 } },
      // 休み：日数が 10 営業日を超える、担当が子・いない人、相手が学童、休む時間が違う、締切の種類が違う、
      // 子を見る人が無い・別の人、見てもらえる時間が一日の全部でない。
      { ...leave, deadline: { type: 'businessDaysBefore' as const, days: 11, at: '18:00' } },
      { ...leave, steps: leave.steps.map((s) => ({ ...s, assigneeId: 'c1' })) },
      { ...leave, providerId: GAKUDO.id },
      { ...leave, cost: { ...leave.cost, leaveMinutes: 240 } },
      { ...leave, deadline: { type: 'daysBefore' as const, days: 3, at: '18:00' } },
      { ...leave, watcherId: undefined },
      { ...leave, watcherId: 'a2' },
      { ...leave, covers: { start: '09:00', end: '17:00' } },
    ]) {
      // 相手を別の場所に替えた手は、手順の相手の場所が手の相手でなくなるので、場所の決まりでも断られる。
      expect(['careOptionsLocked', 'placesLocked']).toContain(
        await save(app, sid, { ...withPlaces(option), careOptions: [option] }),
      );
    }
    // いない人が休む手は、家の情報として成り立たない（参照の誤り）。
    const ghost = { ...leave, steps: leave.steps.map((s) => ({ ...s, assigneeId: 'zz' })) };
    expect(await save(app, sid, { ...withPlaces(ghost), careOptions: [ghost] })).toBe(
      'householdInvalid',
    );
    // 手の相手にならない学童・職場は、場所だけを足せない。
    expect(await save(app, sid, { ...household, places: [...household.places, GAKUDO] })).toBe(
      'placesLocked',
    );
    expect(
      await save(app, sid, {
        ...household,
        places: [...household.places, GAKUDO, WORK],
        careOptions: [gakudo],
      }),
    ).toBe('placesLocked');
  });

  it('締切は日数（学童 1〜30 日・休み 1〜10 営業日）と分までの時刻で、家族の決まりのとおりに入れられる', async () => {
    const app = createApp();
    const { sid, household } = await ready(app);
    const exact = afterSchoolOption(
      'opt-p-gakudo',
      GAKUDO.id,
      { type: 'daysBefore', days: 2, at: '18:15' },
      800,
      false,
      FULL_DAY,
    );
    const odd = leaveOption('opt-leave-a1', 'a1', WORK.id, 4, '17:45');
    expect(
      await save(app, sid, {
        ...household,
        places: [...household.places, GAKUDO, WORK],
        careOptions: [exact, odd],
      }),
    ).toBe('ok');
    const options = arrangement(await view(app, sid))?.options ?? [];
    // 学童：12/7 の 2 日前の 18:15（12/5）より前に、申し込む作業を置く。休み：4 営業日前の 17:45（12/1）より前。
    const day = (id: string) =>
      String(options.find((o) => o.templateId === id)?.decisionDeadline).slice(0, 10);
    expect(day('opt-p-gakudo') <= '2026-12-05').toBe(true);
    expect(day('opt-leave-a1') <= '2026-12-01').toBe(true);
    // 土曜を締切の曜日にした学童も足せる。
    const saturday = afterSchoolOption(
      'opt-p-gakudo-sat',
      'p-gakudo-sat',
      { type: 'weekdayOfPreviousWeek', weekday: 6, at: '12:00' },
      0,
      false,
      FULL_DAY,
    );
    const v = (await view(app, sid)).household;
    expect(
      await save(app, sid, {
        ...v,
        places: [...v.places, { ...GAKUDO, id: 'p-gakudo-sat', name: '土曜の学童' }],
        careOptions: [...v.careOptions, saturday],
      }),
    ).toBe('ok');
  });

  it('同じ学童に預ける手・同じ大人が休む手は、二つ足せない', async () => {
    const app = createApp();
    const { sid, household } = await ready(app);
    expect(
      await save(app, sid, {
        ...household,
        places: [...household.places, GAKUDO, WORK],
        careOptions: [gakudo, leave],
      }),
    ).toBe('ok');
    const v = (await view(app, sid)).household;
    const twin = afterSchoolOption(
      'opt-p-gakudo-2',
      GAKUDO.id,
      { type: 'daysBefore', days: 3, at: '18:00' },
      500,
      false,
      FULL_DAY,
    );
    expect(await save(app, sid, { ...v, careOptions: [...v.careOptions, twin] })).toBe(
      'careOptionsLocked',
    );
    const again = leaveOption('opt-leave-a1-2', 'a1', WORK.id, 1, '18:00');
    expect(await save(app, sid, { ...v, careOptions: [...v.careOptions, again] })).toBe(
      'careOptionsLocked',
    );
    // もう一人の大人の休みは足せる（職場は別の場所）。
    const workB: Place = { id: 'p-work-a2', kind: 'workplace', name: '大人Bの職場', goods: [] };
    const leaveB = leaveOption('opt-leave-a2', 'a2', workB.id, 5, '12:00');
    expect(
      await save(app, sid, {
        ...v,
        places: [...v.places, workB],
        careOptions: [...v.careOptions, leaveB],
      }),
    ).toBe('ok');
  });
});

describe('家族が足した形の学童・休みの手の計画を、検証器にかける', () => {
  it('見本の家族の手を、決まった形の学童・休み・頼める人に替えても、違反が無い', () => {
    const stage = DEMO_STAGES.find((d) => d.id === 'arrived');
    if (!stage) throw new Error('段が無い');
    const events = demoEvents('arrived').map((event) =>
      event.type === 'householdSet'
        ? {
            ...event,
            household: {
              ...event.household,
              careOptions: [
                afterSchoolOption(
                  'opt-gakudo',
                  'gakudo',
                  { type: 'weekdayOfPreviousWeek', weekday: 1, at: '18:30' },
                  1000,
                  true,
                  { start: '08:00', end: '19:00' },
                ),
                leaveOption('opt-leave-a', 'a', 'work-a', 3, '18:00'),
                helperAskOption('opt-grandma', 'g', 3),
              ],
            },
          }
        : event,
    );
    const plan = computePlan(events, stage.now);
    const household = events.find((e) => e.type === 'householdSet');
    if (household?.type !== 'householdSet') throw new Error('家族の情報が無い');
    const care = plan.arrangements.find((a) => a.kind === 'childCare');
    expect(care?.options.map((o) => o.templateId).sort()).toEqual(
      ['opt-gakudo', 'opt-grandma', 'opt-leave-a'].sort(),
    );
    const report = verifyPlan({ household: household.household, plan, events });
    expect(report.issues.filter((i) => i.kind === 'violation')).toEqual([]);
    expect(report.status).not.toBe('violation');
  });
});
