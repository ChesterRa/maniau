// 計画の出力を手書きし、家庭・事項の根拠と独立に照らす（架空の家族）。
import { Household, PlanResult } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { checkChildCareKnowledge } from '../src/child-care-knowledge';
import type { FactState } from '../src/facts';
import type { History } from '../src/history';
import { Collector } from '../src/report';
import { arrangement, household, plan, requirement } from './fixtures';

const date = '2026-12-07';
const range = (start: string, end: string) => ({
  start: `${date}T${start}+09:00`,
  end: `${date}T${end}+09:00`,
});
const fullDay = { start: `${date}T00:00+09:00`, end: '2026-12-08T00:00+09:00' };
const row = (start: string, end: string) => ({ start, end });
const empty = () => Household.parse({ ...household(), routines: [], routineExceptions: [] });
const req = (extra: Record<string, unknown> = {}) =>
  requirement({ date, basis: { itemIds: ['item'] }, ...extra });
const mockFacts = (active: true | false | 'unknown' = true): FactState =>
  ({
    items: new Map([
      ['item', { kind: 'dayChange', interpretation: { dayType: 'noSchool', date } }],
    ]),
    active: new Map([['item', active]]),
    staleItems: new Set(),
  }) as unknown as FactState;
const history = { complete: true } as History;
const check = (
  h: Household,
  requirements: unknown[],
  arrangements: unknown[] = [],
  facts = mockFacts(),
  log = history,
) => {
  const output = PlanResult.parse({ ...plan(), requirements, arrangements });
  const report = new Collector();
  const handled = checkChildCareKnowledge(h, output, facts, log, report);
  return { issues: report.issues, handled };
};
const code = (issues: ReturnType<typeof check>['issues']) => issues.map((issue) => issue.code);

describe('未確認と、確かな範囲だけの子の手配', () => {
  it('全員未入力を、全日未確認として出す。丸ごと消すと違反', () => {
    const good = check(empty(), [req({ missingAdults: ['a', 'b'], unsure: [fullDay] })]);
    expect(good.issues).toEqual([]);
    expect([...good.handled]).toEqual(['requirement']);
    const bad = check(empty(), [req()]);
    expect(code(bad.issues)).toContain('child_care_missing_adults');
    expect(code(bad.issues)).toContain('child_care_unsure_mismatch');
  });

  it('別々の時間に二人が見られても、中間を消さない', () => {
    const h = Household.parse({
      ...empty(),
      dayAnswers: [
        { memberId: 'a', date, can: [row('09:00', '12:00')], cannot: [], rest: 'unknown' },
        { memberId: 'b', date, can: [row('13:00', '18:00')], cannot: [], rest: 'unknown' },
      ],
    });
    const expected = [
      range('00:00', '09:00'),
      range('12:00', '13:00'),
      {
        start: `${date}T18:00+09:00`,
        end: '2026-12-08T00:00+09:00',
      },
    ];
    expect(check(h, [req({ missingAdults: ['a', 'b'], unsure: expected })]).issues).toEqual([]);
    expect(
      code(
        check(h, [req({ missingAdults: ['a', 'b'], unsure: [expected[0], expected[2]] })]).issues,
      ),
    ).toContain('child_care_unsure_mismatch');
  });

  it('未知と確かな不能が混ざれば、確かな 10–11 だけを手配できる', () => {
    const h = Household.parse({
      ...empty(),
      dayAnswers: [
        { memberId: 'a', date, can: [], cannot: [row('09:00', '12:00')], rest: 'can' },
        { memberId: 'b', date, can: [], cannot: [row('10:00', '11:00')], rest: 'unknown' },
      ],
    });
    const requirement = req({
      missingAdults: ['b'],
      unsure: [range('09:00', '10:00'), range('11:00', '12:00')],
    });
    const valid = arrangement({
      start: range('10:00', '11:00').start,
      end: range('10:00', '11:00').end,
    });
    expect(check(h, [requirement], [valid]).issues).toEqual([]);
    const bad = arrangement({
      start: range('09:00', '10:00').start,
      end: range('09:00', '10:00').end,
    });
    expect(code(check(h, [requirement], [bad]).issues)).toContain('child_care_knowledge_window');
    const shortened = arrangement({ ...range('10:00', '10:30') });
    expect(code(check(h, [requirement], [shortened]).issues)).toContain(
      'child_care_knowledge_window',
    );
    expect(code(check(h, [requirement]).issues)).toContain('child_care_arrangement_missing');
  });

  it('二つの確かな空きを、両方記し、最長だけを手配し、勧めない', () => {
    const blocked = [row('09:00', '10:00'), row('15:00', '17:00')];
    const h = Household.parse({
      ...empty(),
      dayAnswers: ['a', 'b'].map((memberId) => ({
        memberId,
        date,
        can: [],
        cannot: blocked,
        rest: 'can',
      })),
    });
    const refs = [range('09:00', '10:00'), range('15:00', '17:00')].map(
      (v) => `${v.start}/${v.end}`,
    );
    const arr = arrangement({ ...range('15:00', '17:00'), reasons: [{ code: 'splitGaps', refs }] });
    expect(check(h, [req()], [arr]).issues).toEqual([]);
    expect(code(check(h, [req()], [{ ...arr, reasons: [] }]).issues)).toContain(
      'child_care_split_missing',
    );
    expect(code(check(h, [req()], [{ ...arr, recommendedOptionKey: 'x' }]).issues)).toContain(
      'child_care_split_recommended',
    );
  });

  it('同じ瞬間の UTC 表記と翌日午前零時を正しく照らす', () => {
    const utcFullDay = { start: '2026-12-06T15:00+00:00', end: '2026-12-07T15:00+00:00' };
    expect(
      check(empty(), [req({ missingAdults: ['a', 'b'], unsure: [utcFullDay] })]).issues,
    ).toEqual([]);
    const wrong = { start: `${date}T00:00+09:00`, end: '2026-12-08T00:01+09:00' };
    expect(
      code(check(empty(), [req({ missingAdults: ['a', 'b'], unsure: [wrong] })]).issues),
    ).toContain('child_care_unsure_invalid');
  });

  it('子が一人なら、別人の手配は違反、対象不明は未判定', () => {
    const h = Household.parse({
      ...empty(),
      members: [...empty().members, { id: 'c', kind: 'child', name: '子' }],
      dayAnswers: ['a', 'b'].map((memberId) => ({
        memberId,
        date,
        can: [],
        cannot: [row('09:00', '10:00')],
        rest: 'can',
      })),
    });
    const facts = mockFacts();
    const item = facts.items.get('item');
    if (!item) throw new Error('架空の事項が無い');
    facts.items.set('item', { ...item, sourceId: 'notice' });
    facts.sourceSenders = new Map([['notice', 'school']]);
    const base = arrangement({ ...range('09:00', '10:00') });
    expect(check(h, [req()], [{ ...base, childId: 'c' }], facts).issues).toEqual([]);
    expect(code(check(h, [req()], [{ ...base, childId: 'other' }], facts).issues)).toContain(
      'child_care_child_mismatch',
    );
    const missing = check(h, [req()], [base], facts).issues;
    expect(missing).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_child_unverified' }),
    );
    expect(missing.some((issue) => issue.kind === 'violation')).toBe(false);
  });

  it('事項の条件や家庭の記録を確かめられない時は、偽の確実性を作らない', () => {
    const absentHistory = check(
      empty(),
      [req({ missingAdults: ['a', 'b'], unsure: [fullDay] })],
      [],
      mockFacts(),
      { ...history, complete: false },
    );
    expect(absentHistory.issues).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_knowledge_unverified' }),
    );
    expect(absentHistory.issues.some((issue) => issue.kind === 'violation')).toBe(false);
    const invalid = Household.parse({
      ...empty(),
      dayAnswers: [
        { memberId: 'a', date, can: [], cannot: [], rest: 'unknown' },
        { memberId: 'a', date, can: [], cannot: [], rest: 'unknown' },
      ],
    });
    expect(check(invalid, [req()]).issues).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_knowledge_unverified' }),
    );
  });

  it('有効な学校の休みで子が一人なら、手配だけでなく要件ごと消えた場合も見つける', () => {
    const h = Household.parse({
      ...empty(),
      members: [...empty().members, { id: 'c', kind: 'child', name: '子' }],
    });
    const facts = mockFacts();
    const item = facts.items.get('item');
    if (!item) throw new Error('架空の事項が無い');
    facts.items.set('item', { ...item, sourceId: 'notice' });
    facts.sourceSenders = new Map([['notice', 'school']]);
    expect(code(check(h, [], [], facts).issues)).toContain('child_care_requirement_missing');
    facts.active.set('item', 'unknown');
    const conditional = check(h, [], [], facts).issues;
    expect(conditional).toContainEqual(
      expect.objectContaining({ kind: 'undetermined', code: 'child_care_knowledge_unverified' }),
    );
    expect(conditional.some((issue) => issue.kind === 'violation')).toBe(false);
    facts.active.set('item', false);
    expect(check(h, [], [], facts).issues).toEqual([]);
  });
});
