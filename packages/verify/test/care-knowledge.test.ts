// 家庭の事象を読む口とは分け、手で置いた事実から三値を独立に確かめる。
import { describe, expect, it } from 'vitest';
import { type CarePersonEvidence, careKnowledge } from '../src/care-knowledge';

const h = (n: number) => n * 60;
const interval = (a: number, b: number) => ({ start: h(a), end: h(b) });
const person = (
  id: string,
  known: [number, number][] = [],
  unavailable: [number, number][] = [],
): CarePersonEvidence => ({
  id,
  known: known.map(([a, b]) => interval(a, b)),
  unavailable: unavailable.map(([a, b]) => interval(a, b)),
});

describe('見守りの時間ごとの根拠', () => {
  it('二人とも未入力なら全日未知で、全員が見守れないとは決めない', () => {
    expect(careKnowledge([person('a'), person('b')])).toEqual({
      certain: [],
      possible: [interval(0, 24)],
      missing: [{ ...interval(0, 24), adults: ['a', 'b'] }],
      missingAdults: ['a', 'b'],
    });
  });

  it('一人が仕事中・もう一人が不明なら、仕事の時間は不明として残す', () => {
    expect(careKnowledge([person('a', [[0, 24]], [[9, 12]]), person('b')])).toEqual({
      certain: [],
      possible: [interval(9, 12)],
      missing: [{ ...interval(9, 12), adults: ['b'] }],
      missingAdults: ['b'],
    });
  });

  it('一人が見守れると確認した時間は、もう一人が不明でも空きとしない', () => {
    expect(careKnowledge([person('a', [[0, 24]]), person('b')])).toEqual({
      certain: [],
      possible: [],
      missing: [],
      missingAdults: [],
    });
  });

  it('日程の無い人も、手が離せないと明示した時間だけは見守れない', () => {
    expect(careKnowledge([person('a', [[0, 24]], [[9, 12]]), person('b', [], [[10, 11]])])).toEqual(
      {
        certain: [interval(10, 11)],
        possible: [interval(9, 12)],
        missing: [
          { ...interval(9, 10), adults: ['b'] },
          { ...interval(11, 12), adults: ['b'] },
        ],
        missingAdults: ['b'],
      },
    );
  });

  it('一人の一部だけの確認は、その外を家と決めず、もう一人が働く部分を残す', () => {
    expect(careKnowledge([person('a', [[9, 12]]), person('b', [[0, 24]], [[9, 13]])])).toEqual({
      certain: [],
      possible: [interval(12, 13)],
      missing: [{ ...interval(12, 13), adults: ['a'] }],
      missingAdults: ['a'],
    });
  });

  it('二人の確認がそろったら、両方が見守れない所だけを空きとする', () => {
    expect(
      careKnowledge([person('a', [[0, 24]], [[9, 12]]), person('b', [[0, 24]], [[9, 10]])]),
    ).toEqual({
      certain: [interval(9, 10)],
      possible: [interval(9, 10)],
      missing: [],
      missingAdults: [],
    });
  });

  it('半開の端で二人が交替して見守れるなら、その境目に空きを作らない', () => {
    expect(
      careKnowledge([person('a', [[0, 24]], [[10, 24]]), person('b', [[0, 24]], [[0, 10]])]),
    ).toEqual({ certain: [], possible: [], missing: [], missingAdults: [] });
  });

  it('要る人は household の順、未知の範囲が違えばその境目を残す', () => {
    expect(careKnowledge([person('b', [[10, 24]], [[10, 24]]), person('a', [[12, 24]])])).toEqual({
      certain: [],
      possible: [interval(0, 12)],
      missing: [
        { ...interval(0, 10), adults: ['b', 'a'] },
        { ...interval(10, 12), adults: ['a'] },
      ],
      missingAdults: ['b', 'a'],
    });
  });

  it('成人なし・ID の重複・読めない時刻は、空き無しと確定しない', () => {
    expect(careKnowledge([])).toBeUndefined();
    expect(careKnowledge([person('a'), person('a')])).toBeUndefined();
    expect(careKnowledge([person('a', [[12, 9]])])).toBeUndefined();
    expect(careKnowledge([person('a', [[0, 25]])])).toBeUndefined();
    expect(
      careKnowledge([{ id: 'a', known: [{ start: Number.NaN, end: h(10) }], unavailable: [] }]),
    ).toBeUndefined();
  });

  it('二人二時間の 81 組を、別の一分ごとの真理値表で照らす', () => {
    const states = ['can', 'cannot', 'unknown'] as const;
    type State = (typeof states)[number];
    const make = (id: string, values: [State, State]) =>
      person(
        id,
        values.flatMap((value, i) =>
          value === 'unknown' ? [] : [[9 + i, 10 + i] as [number, number]],
        ),
        values.flatMap((value, i) =>
          value === 'cannot' ? [[9 + i, 10 + i] as [number, number]] : [],
        ),
      );
    let checked = 0;
    for (const a0 of states)
      for (const a1 of states)
        for (const b0 of states)
          for (const b1 of states) {
            const actual = careKnowledge([make('a', [a0, a1]), make('b', [b0, b1])]);
            if (!actual) throw new Error('架空の根拠を読めない');
            for (let minute = h(9); minute < h(11); minute += 1) {
              const pair = minute < h(10) ? [a0, b0] : [a1, b1];
              const includes = (intervals: { start: number; end: number }[]) =>
                intervals.some((value) => value.start <= minute && minute < value.end);
              expect(includes(actual.certain)).toBe(pair.every((value) => value === 'cannot'));
              expect(includes(actual.possible)).toBe(pair.every((value) => value !== 'can'));
              expect(includes(actual.missing)).toBe(
                pair.every((value) => value !== 'can') && pair.includes('unknown'),
              );
            }
            checked += 1;
          }
    expect(checked).toBe(81);
  });
});
