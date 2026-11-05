// 分割の印の形を手書きし、家庭の時間から計画と別に確かめる。
import { Household, type PlanResult } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { checkSplitCareClaims } from '../src/child-care-split';
import type { FactState } from '../src/facts';
import type { History } from '../src/history';
import { Collector } from '../src/report';
import { arrangement, household, plan, requirement } from './fixtures';

const date = '2026-12-07';
const gap = (start: string, end: string) => `${date}T${start}+09:00/${date}T${end}+09:00`;
const refs = [gap('09:00', '10:00'), gap('15:00', '17:00')];
const days = (memberId: string) => ({
  memberId,
  date,
  segments: [
    { start: '09:00', end: '10:00', kind: 'work' },
    { start: '10:00', end: '15:00', kind: 'home', placeId: 'home' },
    { start: '15:00', end: '17:00', kind: 'work' },
  ],
});
const family = () => Household.parse({ ...household(), routineExceptions: [days('a'), days('b')] });
const req = () => requirement({ date, basis: { itemIds: ['item'] } });
const arr = (overrides: Record<string, unknown> = {}) =>
  arrangement({
    start: `${date}T15:00+09:00`,
    end: `${date}T17:00+09:00`,
    reasons: [{ code: 'splitGaps', refs }],
    ...overrides,
  });
const sample = (arrangements = [arr()], requirements = [req()]) =>
  ({ ...plan(), arrangements, requirements }) as unknown as PlanResult;
const factState = () =>
  ({
    items: new Map([
      ['item', { kind: 'dayChange', interpretation: { dayType: 'noSchool', date } }],
    ]),
    active: new Map([['item', true]]),
    staleItems: new Set(),
  }) as unknown as FactState;
const history = { complete: true } as History;
const issues = (value: PlanResult, h = family(), facts = factState(), log = history) => {
  const report = new Collector();
  checkSplitCareClaims(h, value, facts, log, report);
  return report.issues;
};
const codes = (value: PlanResult, h = family()) => issues(value, h).map((issue) => issue.code);

describe('計画に示した分かれた空き', () => {
  it('正しい二段と現在の依頼窓は、選択後でも違反としない', () => {
    expect(issues(sample())).toEqual([]);
    expect(
      issues(sample([arr({ chosenOptionKey: 'selected', status: 'dependsOnReply' })])),
    ).toEqual([]);
  });

  it('印ごと落とす、短い一段を落とす、順序を替える、端を一分ずらす場合を見つける', () => {
    expect(codes(sample([arr({ reasons: [] })]))).toContain('child_care_split_missing');
    for (const wrong of [[refs[1]], [refs[1], refs[0]], [gap('09:00', '09:59'), refs[1]]]) {
      expect(codes(sample([arr({ reasons: [{ code: 'splitGaps', refs: wrong }] })]))).toContain(
        'child_care_split_mismatch',
      );
    }
  });

  it('窓が長い方と違う、または勧めが残る場合を見つける', () => {
    expect(
      codes(sample([arr({ start: `${date}T09:00+09:00`, end: `${date}T10:00+09:00` })])),
    ).toContain('child_care_split_window_mismatch');
    expect(codes(sample([arr({ recommendedOptionKey: 'option' })]))).toContain(
      'child_care_split_recommended',
    );
    expect(codes(sample([arr({ recommendedReason: 'onlyOption' })]))).toContain(
      'child_care_split_recommended',
    );
  });

  it('時差表記が違う同じ瞬間は同じ時間とし、別の日や読めない印は違反とする', () => {
    const utc = [
      '2026-12-07T00:00+00:00/2026-12-07T01:00+00:00',
      '2026-12-07T06:00+00:00/2026-12-07T08:00+00:00',
    ];
    expect(issues(sample([arr({ reasons: [{ code: 'splitGaps', refs: utc }] })]))).toEqual([]);
    expect(codes(sample([arr({ reasons: [{ code: 'splitGaps', refs: ['bad'] }] })]))).toContain(
      'child_care_split_invalid',
    );
    expect(codes(sample([arr({ start: '2026-12-08T15:00+09:00' })]))).toContain(
      'child_care_split_window_mismatch',
    );
  });

  it('二重の印、子の居場所でない手配の印、分割対象の手配の欠落を見つける', () => {
    expect(
      codes(
        sample([
          arr({
            reasons: [
              { code: 'splitGaps', refs },
              { code: 'splitGaps', refs },
            ],
          }),
        ]),
      ),
    ).toContain('child_care_split_duplicate');
    expect(codes(sample([arr({ kind: 'need' })]))).toContain('child_care_split_kind');
    expect(codes(sample([]))).toContain('child_care_split_missing');
  });

  it('要件や日程を照らせない時は、不明を違反と決めない', () => {
    const missing = issues(sample([arr()], []));
    expect(missing).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_split_unverified' }),
    );
    const repeated = Household.parse({
      ...family(),
      routineExceptions: [days('a'), days('a'), days('b')],
    });
    const result = issues(sample(), repeated);
    expect(result).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_split_unverified' }),
    );
    expect(result.some((entry) => entry.kind === 'violation')).toBe(false);
    const lostBasis = factState();
    lostBasis.active.set('item', 'unknown');
    expect(issues(sample([arr({ reasons: [] })]), family(), lostBasis)).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_split_unverified' }),
    );
    expect(
      issues(sample([arr({ reasons: [] })]), family(), factState(), {
        ...history,
        complete: false,
      }),
    ).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_split_unverified' }),
    );
    const stale = factState();
    stale.staleItems.add('item');
    expect(issues(sample([arr({ reasons: [] })]), family(), stale)).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_split_unverified' }),
    );
    const wrongDate = factState();
    const item = wrongDate.items.get('item');
    if (item?.kind !== 'dayChange') throw new Error('架空の事項が無い');
    wrongDate.items.set('item', {
      ...item,
      interpretation: { ...item.interpretation, date: '2026-12-08' },
    });
    expect(issues(sample([arr({ reasons: [] })]), family(), wrongDate)).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_split_unverified' }),
    );
  });

  it('条件付きで事項の適用が分からない時、手配の内容は照らすが、欠落を確定と決めつけない', () => {
    const conditional = requirement({ date, basis: { itemIds: ['item'] }, conditional: true });
    const facts = factState();
    facts.active.set('item', 'unknown');
    expect(issues(sample([arr()], [conditional]), family(), facts)).toEqual([]);
    expect(issues(sample([], [conditional]), family(), facts)).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_split_unverified' }),
    );
  });

  it('成人の記録が一部無い時は、計算上の空きを現実の確定と呼ばず、表示の整合を照らす', () => {
    const h = Household.parse({
      ...household(),
      routines: household().routines.filter((day) => day.memberId !== 'b'),
      routineExceptions: [days('a')],
    });
    expect(issues(sample(), h)).toEqual([]);
    expect(codes(sample([arr({ reasons: [] })]), h)).toContain('child_care_split_missing');
  });
});
