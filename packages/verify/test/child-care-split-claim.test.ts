import { describe, expect, it } from 'vitest';
import {
  type CareSplitClaim,
  checkModeledCareSplit,
  type ModeledCareGaps,
} from '../src/child-care-gap-evidence';

const first = { start: 9 * 60, end: 10 * 60 };
const last = { start: 15 * 60, end: 17 * 60 };
const model: ModeledCareGaps = { gaps: [first, last], complete: true };
const valid: CareSplitClaim = { reported: [first, last], window: last, recommended: false };

describe('分かれた子の居場所の空きの表現', () => {
  it('全ての区間と長い方の窓を示し、勧めなければ違反にしない', () => {
    expect(checkModeledCareSplit(model, valid)).toEqual({ violations: [], undetermined: false });
  });

  it('印ごとの欠落、一段の欠落、順序違い、時刻違いを見つける', () => {
    expect(checkModeledCareSplit(model, { ...valid, reported: undefined }).violations).toEqual([
      'missing',
    ]);
    for (const reported of [[last], [last, first], [first, { ...last, end: last.end - 1 }]]) {
      expect(checkModeledCareSplit(model, { ...valid, reported }).violations).toEqual(['mismatch']);
    }
  });

  it('依頼の窓が最長の区間でない時、または案を勧めた時を見つける', () => {
    expect(checkModeledCareSplit(model, { ...valid, window: first }).violations).toEqual([
      'window',
    ]);
    expect(checkModeledCareSplit(model, { ...valid, recommended: true }).violations).toEqual([
      'recommended',
    ]);
  });

  it('同じ長さなら早い区間を使う', () => {
    const later = { start: 15 * 60, end: 16 * 60 };
    const tie: ModeledCareGaps = { gaps: [first, later], complete: true };
    expect(
      checkModeledCareSplit(tie, { reported: tie.gaps, window: first, recommended: false })
        .violations,
    ).toEqual([]);
    expect(
      checkModeledCareSplit(tie, { reported: tie.gaps, window: later, recommended: false })
        .violations,
    ).toEqual(['window']);
  });

  it('零段・一段に分割の印があれば違反、印が無い以前の表現には触れない', () => {
    for (const gaps of [[], [first]]) {
      const short = { gaps, complete: true };
      expect(checkModeledCareSplit(short, { window: first, recommended: true }).violations).toEqual(
        [],
      );
      expect(checkModeledCareSplit(short, { ...valid, reported: gaps }).violations).toEqual([
        'mismatch',
      ]);
    }
  });

  it('根拠が重複・不正で独立に決められない時は、違反ではなく未判定', () => {
    expect(
      checkModeledCareSplit(
        { ...model, complete: false },
        { ...valid, reported: undefined, recommended: true },
      ),
    ).toEqual({ violations: [], undetermined: true });
  });
});
