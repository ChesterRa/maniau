// 家の情報を直した後の計画を、前の情報や引き受けの控えから独立に照らす。
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { event, household, plan, requirement, task } from './fixtures';

const codeOf = (result: ReturnType<typeof verifyPlan>, kind: 'violation' | 'undetermined') =>
  result.issues.filter((issue) => issue.kind === kind).map((issue) => issue.code);

const original = () => household();
const editedWeek = () => {
  const value = household();
  const monday = value.routines.find((day) => day.memberId === 'a' && day.weekday === 1);
  if (!monday?.segments[0]) throw new Error('架空の月曜日が無い');
  monday.segments[0].end = '09:00';
  return value;
};
const shown = {
  start: '2026-12-07T10:00+09:00',
  end: '2026-12-07T10:30+09:00',
  titleKey: 'task.t',
  titleParams: { what: '架空の用件' },
  travelBeforeMin: 0,
  travelAfterMin: 0,
};
const accepted = (changes: Record<string, unknown> = {}) =>
  task('t', { commitment: 'accepted', titleParams: shown.titleParams, ...changes });
const events = () => [
  event(1, { type: 'householdSet', household: original() }),
  event(2, { type: 'assignmentProposed', taskKey: 't', assigneeId: 'a' }),
  event(3, { type: 'commitmentChanged', taskKey: 't', assigneeId: 'a', action: 'accept', shown }),
  event(4, { type: 'householdSet', household: editedWeek() }),
];

describe('家の情報を直した後の独立検証', () => {
  it('直した家の情報と追加した事象を使い、古い家の情報とは取り違えない', () => {
    const current = plan({ throughSeq: 4, tasks: [] });
    expect(
      codeOf(verifyPlan({ household: editedWeek(), events: events(), plan: current }), 'violation'),
    ).not.toContain('household_snapshot_mismatch');
    expect(
      codeOf(verifyPlan({ household: original(), events: events(), plan: current }), 'violation'),
    ).toContain('household_snapshot_mismatch');
  });

  it('短くした空き時間の外に、古い時刻の引き受けを置いたままにしない', () => {
    const bad = verifyPlan({
      household: editedWeek(),
      events: events(),
      plan: plan({ throughSeq: 4, tasks: [accepted()] }),
    });
    expect(codeOf(bad, 'violation')).toContain('outside_routine');
  });

  it('新しい空き時間に動かす時は、前の控えと違うことを本人へ確かめる', () => {
    const moved = { start: '2026-12-07T08:20+09:00', end: '2026-12-07T08:50+09:00' };
    const check = (reconfirm: boolean) =>
      verifyPlan({
        household: editedWeek(),
        events: events(),
        plan: plan({ throughSeq: 4, tasks: [accepted({ ...moved, reconfirm })] }),
      });
    expect(codeOf(check(false), 'violation')).toContain('proposal_reconfirm_missing');
    expect(codeOf(check(true), 'violation')).not.toContain('proposal_reconfirm_missing');
    expect(codeOf(check(true), 'violation')).not.toContain('outside_routine');
  });

  it('家族が店の休みを記録した日は、古い営業情報で置けると言わない', () => {
    const edited = household();
    const store = edited.places.find((place) => place.id === 'store');
    if (!store?.hours) throw new Error('架空の店が無い');
    store.hours.closedDates = ['2026-12-07'];
    const buy = task('buy', {
      durationMin: 20,
      start: '2026-12-07T12:15+09:00',
      end: '2026-12-07T12:35+09:00',
      segments: ['away'],
      atPlaceId: 'store',
      placeKind: 'store',
      goods: 'clothing',
      travelBeforeMin: 5,
      travelAfterMin: 5,
      travelSource: 'estimate',
    });
    const nextEvents = [
      event(1, { type: 'householdSet', household: original() }),
      event(2, { type: 'householdSet', household: edited }),
    ];
    const current = plan({ throughSeq: 2, tasks: [buy] });
    expect(
      codeOf(verifyPlan({ household: edited, events: nextEvents, plan: current }), 'violation'),
    ).toContain('place_closed');
    expect(
      codeOf(verifyPlan({ household: original(), events: nextEvents, plan: current }), 'violation'),
    ).toContain('household_snapshot_mismatch');
  });

  it('必須の子の居場所の手配が無いだけでは、不要とも問題なしとも断定しない', () => {
    const result = verifyPlan({
      household: original(),
      events: [event(1, { type: 'householdSet', household: original() })],
      plan: plan({ throughSeq: 1, requirements: [requirement({ date: '2026-12-07' })] }),
    });
    expect(codeOf(result, 'undetermined')).toContain('required_arrangement_missing');
    expect(result.status).not.toBe('pass');
  });
});
