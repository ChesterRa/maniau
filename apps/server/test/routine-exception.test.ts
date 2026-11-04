// その日だけの一日（routineExceptions）：ある大人のある日の区間を、ふだんの曜日の一日の代わりに使う。書かない
// 計算で何が変わるかを見せ（何も書かない）、記録すると、その日だけが変わる（前後の同じ曜日は変わらない）。
// 架空のデモの家で確かめる。
import type { Household, RoutineSegment } from '@maniau/core';
import { computePlan, foldEvents, slotsOn } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { DEMO_STAGES, type DemoStageId, demoEvents } from '../src/demo';
import { demoSessions } from '../src/demo-sessions';
import { previewChange } from '../src/preview';

const CARE = 'arr:childCare:n1:i6:c';
const nowOf = (stage: string) => DEMO_STAGES.find((s) => s.id === stage)?.now ?? '';
const home = (start: string, end: string): RoutineSegment => ({
  start,
  end,
  kind: 'home',
  placeId: 'home',
  viaStationIds: [],
});
/** 彩（b）が 12/7（月）を休み、ふだんの仕事と通勤の時間も家にいる一日。 */
const offDay = [home('06:30', '22:30')];

function householdOf(stage: DemoStageId): Household {
  const household = foldEvents(demoEvents(stage)).household;
  if (!household) throw new Error('家の情報が無い');
  return household;
}

const withException = (
  h: Household,
  segments: RoutineSegment[] = offDay,
  memberId = 'b',
  date = '2026-12-07',
): Household => ({ ...structuredClone(h), routineExceptions: [{ memberId, date, segments }] });

describe('その日だけの一日', () => {
  it('その人のその日だけ区間が替わり、前後の同じ曜日とほかの人は変わらない', () => {
    const h = withException(householdOf('chase'));
    expect(slotsOn(h, 'b', '2026-12-07').map((s) => s.kind)).toEqual(['home']);
    for (const date of ['2026-11-30', '2026-12-14']) {
      expect(slotsOn(h, 'b', date).map((s) => s.kind)).toEqual([
        'home',
        'commute',
        'work',
        'commute',
        'home',
      ]);
    }
    expect(slotsOn(h, 'a', '2026-12-07').some((s) => s.kind === 'work')).toBe(true);
  });

  it('書かない計算：12/7 に彩が家にいれば、子の居場所の手配が要らなくなり、祖母への取り消しの連絡が出る', () => {
    const events = demoEvents('chase');
    const before = structuredClone(events);
    const shown = previewChange(
      events,
      { memberId: 'b', now: nowOf('chase') },
      { type: 'updateHousehold', household: withException(householdOf('chase')) },
    );
    if ('reason' in shown) throw new Error(`計算できない：${shown.reason}`);
    expect(events).toEqual(before);
    expect(shown.changes.cancels.map((c) => c.requestId)).toEqual(['r-grandma']);
    // 今の計画は変わっていない（仮の計算は書いていない）。
    const real = computePlan(events, nowOf('chase'));
    expect(real.arrangements.find((a) => a.key === CARE)?.live).toBe(true);
  });

  it('記録すると、その日の子の居場所の手配が消え、祖母への取り消しの作業が出る', async () => {
    const sessions = demoSessions();
    const id = sessions.create('chase');
    const household = withException(householdOf('chase'));
    const preview = await sessions.householdPreview(id, 'b', household);
    if (!preview || 'reason' in preview) throw new Error('見られない');
    const saved = await sessions.command(id, 'b', 'op-day', {
      type: 'updateHousehold',
      household,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    });
    expect(saved?.result.status).toBe('ok');
    const plan = saved?.view.plan;
    expect(plan?.arrangements.some((a) => a.key === CARE && a.live)).toBe(false);
    expect(plan?.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(true);
    expect(saved?.view.household.routineExceptions).toEqual(household.routineExceptions);
  });

  it.each([
    [
      '区間に切れ目がある',
      withException(householdOf('chase'), [home('06:30', '12:00'), home('13:00', '22:30')]),
      'routineGap',
    ],
    [
      '家の区間が家の場所でない',
      withException(householdOf('chase'), [{ ...home('06:30', '22:30'), placeId: 'work-b' }]),
      'routinePlace',
    ],
    ['大人でない人', withException(householdOf('chase'), offDay, 'c'), 'routineExceptionMember'],
  ])('%s一日は受けない', (_, household, reason) => {
    const shown = previewChange(
      demoEvents('chase'),
      { memberId: 'b', now: nowOf('chase') },
      { type: 'updateHousehold', household },
    );
    expect(shown).toMatchObject({ reason });
  });

  it('同じ人・同じ日の一日は一つだけ', () => {
    const h = withException(householdOf('chase'));
    const twice = { ...h, routineExceptions: [...h.routineExceptions, ...h.routineExceptions] };
    const shown = previewChange(
      demoEvents('chase'),
      { memberId: 'b', now: nowOf('chase') },
      { type: 'updateHousehold', household: twice },
    );
    expect(shown).toMatchObject({ reason: 'householdInvalid' });
  });
});
