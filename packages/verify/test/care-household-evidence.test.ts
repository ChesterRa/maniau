// 家庭の架空の記録から、その日だけの例外・回答・占用を独立に照らす。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { householdCareKnowledge } from '../src/care-household-evidence';
import { household } from './fixtures';

const date = '2026-12-07';
const hour = (n: number) => n * 60;
const span = (a: number, b: number) => ({ start: hour(a), end: hour(b) });
const row = (start: string, end: string) => ({ start, end });
const empty = () => Household.parse({ ...household(), routines: [], routineExceptions: [] });

describe('家庭の記録からの見守りの根拠', () => {
  it('以前の記録は、双方の月曜日の外出が重なる区間を読める', () => {
    expect(householdCareKnowledge(household(), date)).toEqual({
      certain: [span(12, 13)],
      possible: [span(12, 13)],
      missing: [],
      missingAdults: [],
    });
  });

  it('両方が未入力なら、要るか分からない時間と人を残す', () => {
    expect(householdCareKnowledge(empty(), date)).toEqual({
      certain: [],
      possible: [span(0, 24)],
      missing: [{ ...span(0, 24), adults: ['a', 'b'] }],
      missingAdults: ['a', 'b'],
    });
  });

  it('二人が別々に見守れる時間を言っても、真ん中の未確認を埋めない', () => {
    const h = {
      ...empty(),
      dayAnswers: [
        { memberId: 'a', date, can: [row('09:00', '12:00')], cannot: [], rest: 'unknown' as const },
        { memberId: 'b', date, can: [row('13:00', '18:00')], cannot: [], rest: 'unknown' as const },
      ],
    };
    expect(householdCareKnowledge(h, date)).toEqual({
      certain: [],
      possible: [span(0, 9), span(12, 13), span(18, 24)],
      missing: [
        { ...span(0, 9), adults: ['a', 'b'] },
        { ...span(12, 13), adults: ['a', 'b'] },
        { ...span(18, 24), adults: ['a', 'b'] },
      ],
      missingAdults: ['a', 'b'],
    });
  });

  it('一日の「分からない」は週の予定を上書きし、前の答えを復活させない', () => {
    const h = {
      ...household(),
      dayAnswers: [{ memberId: 'a', date, can: [], cannot: [], rest: 'unknown' as const }],
    };
    const result = householdCareKnowledge(h, date);
    expect(result?.certain).toEqual([]);
    expect(result?.possible).toEqual([span(12, 13)]);
    expect(result?.missing).toEqual([{ ...span(12, 13), adults: ['a'] }]);
  });

  it('当日例外を週より優先し、手が離せない時間は未入力の人にも効く', () => {
    const h = Household.parse({
      ...household(),
      routineExceptions: [
        {
          memberId: 'a',
          date,
          segments: [{ start: '09:00', end: '10:00', kind: 'work', placeId: 'home' }],
        },
      ],
      unavailable: [{ id: 'u', memberId: 'b', date, start: '09:00', end: '10:00' }],
    });
    expect(householdCareKnowledge(h, date)?.certain).toEqual([span(9, 10)]);
    const noDays = Household.parse({
      ...empty(),
      unavailable: [
        { id: 'a-busy', memberId: 'a', date, start: '09:00', end: '11:00' },
        { id: 'b-busy', memberId: 'b', date, start: '10:00', end: '12:00' },
      ],
    });
    expect(householdCareKnowledge(noDays, date)?.certain).toEqual([span(10, 11)]);
  });

  it('無効の成人と頼める人を、在籍する成人として数えない', () => {
    const h = {
      ...empty(),
      members: empty().members.map((member) =>
        member.id === 'b' ? { ...member, active: false } : member,
      ),
      dayAnswers: [{ memberId: 'helper', date, can: [], cannot: [], rest: 'cannot' as const }],
    };
    expect(householdCareKnowledge(h, date)?.missingAdults).toEqual(['a']);
  });

  it('同じ人・日の回答や日程が重複したら、根拠を一意としない', () => {
    const repeat = { memberId: 'a', date, can: [], cannot: [], rest: 'unknown' as const };
    expect(
      householdCareKnowledge({ ...empty(), dayAnswers: [repeat, repeat] }, date),
    ).toBeUndefined();
    const entry = {
      memberId: 'a',
      date,
      segments: [{ start: '09:00', end: '10:00', kind: 'work' }],
    };
    const h = Household.parse({ ...empty(), routineExceptions: [entry, entry] });
    expect(householdCareKnowledge(h, date)).toBeUndefined();
    expect(householdCareKnowledge(empty(), '2026-02-30')).toBeUndefined();
  });
});
