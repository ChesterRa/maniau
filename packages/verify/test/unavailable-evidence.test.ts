import { Way } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import {
  type CandidateUnavailable,
  checkCandidateUnavailable,
  fixedFamilyCoverBusy,
  type RecordedUnavailable,
} from '../src/unavailable-evidence';
import { household } from './fixtures';

const date = '2026-12-07';
const day = (time: string) => `${date}T${time}+09:00`;
const candidate = { date, startTime: '09:30', endTime: '11:00' };
const people = [
  { id: 'b', kind: 'member' as const },
  { id: 'a', kind: 'member' as const },
  { id: 'helper', kind: 'guest' as const },
] as const;
const row = (
  id: string,
  memberId: string,
  start: string,
  end: string,
  on = date,
): RecordedUnavailable => ({ id, memberId, date: on, start, end });
const recorded = [
  row('a1', 'a', '09:00', '10:00'),
  row('b2', 'b', '10:30', '11:30'),
  row('b1', 'b', '08:00', '09:45'),
] as const;
const shown = [
  { personId: 'b', unavailableId: 'b1', start: day('08:00'), end: day('09:45') },
  { personId: 'b', unavailableId: 'b2', start: day('10:30'), end: day('11:30') },
  { personId: 'a', unavailableId: 'a1', start: day('09:00'), end: day('10:00') },
] as const;
const check = (actual: readonly CandidateUnavailable[] = shown) =>
  checkCandidateUnavailable(household(), people, candidate, recorded, actual);

describe('日時の候補と記録した手が離せない時間', () => {
  it('重なりだけでなく、記録の ID と元の全区間を名簿順・時刻順で照らす', () => {
    expect(check()).toBe('match');
    expect(check(shown.slice(1))).toBe('mismatch');
    expect(check([shown[1], shown[0], shown[2]])).toBe('mismatch');
    expect(check([{ ...shown[0], start: day('09:30') }, ...shown.slice(1)])).toBe('mismatch');
    expect(check([{ ...shown[0], personId: 'a' }, ...shown.slice(1)])).toBe('mismatch');
    expect(check([{ ...shown[0], unavailableId: 'wrong' }, ...shown.slice(1)])).toBe('mismatch');
  });

  it('時差の異なる書き方でも、同じ瞬間なら同じ記録とする', () => {
    const utc = [
      { ...shown[0], start: '2026-12-06T23:00+00:00', end: '2026-12-07T00:45+00:00' },
      shown[1],
      shown[2],
    ];
    expect(check(utc)).toBe('match');
  });

  it('端が接するだけ、別の日、名簿外の人、guest は重なりにしない', () => {
    const rows = [
      row('before', 'a', '08:00', '09:30'),
      row('after', 'b', '11:00', '12:00'),
      row('other-day', 'a', '09:45', '10:15', '2026-12-08'),
      row('guest', 'helper', '09:45', '10:15'),
    ];
    expect(checkCandidateUnavailable(household(), people, candidate, rows, undefined)).toBe(
      'match',
    );
    expect(checkCandidateUnavailable(household(), people, candidate, rows, [])).toBe('mismatch');
    expect(checkCandidateUnavailable(household(), people, candidate, rows, shown)).toBe('mismatch');
  });

  it('家庭に登録した頼める人は member 名簿に入っていても、成人の占用は無い', () => {
    const withHelper = [...people, { id: 'helper', kind: 'member' as const }].filter(
      (person) => person.kind !== 'guest',
    );
    expect(checkCandidateUnavailable(household(), withHelper, candidate, recorded, shown)).toBe(
      'match',
    );
  });

  it('一方の区間だけを落とさず、余分・重複した表示も許さない', () => {
    expect(check([...shown, shown[0]])).toBe('mismatch');
    expect(check([shown[0], shown[0], shown[2]])).toBe('mismatch');
  });

  it('元の窓・日付・名簿・占用を照らせない時は未判定にする', () => {
    expect(
      checkCandidateUnavailable(
        household(),
        people,
        { ...candidate, endTime: '09:30' },
        recorded,
        shown,
      ),
    ).toBe('undetermined');
    expect(
      checkCandidateUnavailable(
        household(),
        people,
        { ...candidate, date: '2026-02-30' },
        recorded,
        shown,
      ),
    ).toBe('undetermined');
    expect(
      checkCandidateUnavailable(household(), [...people, people[0]], candidate, recorded, shown),
    ).toBe('undetermined');
    expect(
      checkCandidateUnavailable(
        household(),
        [{ id: 'missing', kind: 'member' }],
        candidate,
        recorded,
        shown,
      ),
    ).toBe('undetermined');
    expect(
      checkCandidateUnavailable(
        household(),
        people,
        candidate,
        [{ ...recorded[0], start: '09:99' }],
        shown,
      ),
    ).toBe('undetermined');
    expect(check([{ ...shown[0], start: 'not-a-date' }, ...shown.slice(1)])).toBe('undetermined');
  });
});

describe('候補日に家族が受け持つやり方', () => {
  const cover = (extra: Record<string, unknown> = {}) =>
    Way.parse({
      id: 'family',
      name: '受け持つ',
      steps: [
        {
          id: 'hold',
          name: '見守る',
          durationMin: 10,
          segments: ['home'],
          cover: true,
          assigneeId: 'a',
          ...extra,
        },
      ],
      cost: {},
    });
  it('担当の明示の占用が窓と重なる時だけ、窓全体を受け持てないと分かる', () => {
    const occupied = [row('u', 'a', '09:00', '10:00')];
    expect(fixedFamilyCoverBusy(cover(), candidate, occupied)).toBe('blocked');
    expect(fixedFamilyCoverBusy(cover(), candidate, [row('u', 'a', '08:00', '09:30')])).toBe(
      'clear',
    );
    expect(fixedFamilyCoverBusy(cover(), candidate, [row('u', 'b', '09:00', '10:00')])).toBe(
      'clear',
    );
  });
  it('外の相手への頼みと担当が未定の家族を、固定の家族の受け持ちとはしない', () => {
    const occupied = [row('u', 'a', '09:00', '10:00')];
    expect(
      fixedFamilyCoverBusy(
        cover({ external: { to: 'helper', kind: 'reply' } }),
        candidate,
        occupied,
      ),
    ).toBe('clear');
    expect(fixedFamilyCoverBusy(cover({ assigneeId: undefined }), candidate, occupied)).toBe(
      'clear',
    );
    expect(fixedFamilyCoverBusy(cover(), candidate, [row('u', 'a', '09:99', '10:00')])).toBe(
      'undetermined',
    );
  });
});
