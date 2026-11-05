// 回答の区間と「それ以外」を、求解を使わず手計算と照らす。
import { describe, expect, it } from 'vitest';
import { type RecordedCareDay, recordedCareDay } from '../src/care-day-evidence';
import { careKnowledge } from '../src/care-knowledge';

const row = (start: string, end: string) => ({ start, end });
const hour = (n: number) => n * 60;
const span = (a: number, b: number) => ({ start: hour(a), end: hour(b) });
const answer = (overrides: Partial<RecordedCareDay> = {}): RecordedCareDay => ({
  memberId: 'a',
  can: [],
  cannot: [],
  rest: 'unknown',
  ...overrides,
});

describe('一日の見守り回答の根拠', () => {
  it('答えた所だけが有効で、それ以外は未確認', () => {
    expect(
      recordedCareDay(answer({ can: [row('09:00', '12:00')], cannot: [row('13:00', '18:00')] })),
    ).toEqual({
      id: 'a',
      known: [span(9, 12)],
      unavailable: [span(13, 18)],
    });
  });

  it('それ以外を見守れると確かめた時だけ、明示の不能以外を既知にする', () => {
    expect(recordedCareDay(answer({ rest: 'can', cannot: [row('09:00', '12:00')] }))).toEqual({
      id: 'a',
      known: [span(0, 24)],
      unavailable: [span(9, 12)],
    });
  });

  it('それ以外を見守れないと確かめた時だけ、明示の可能以外を不能にする', () => {
    expect(recordedCareDay(answer({ rest: 'cannot', can: [row('09:00', '12:00')] }))).toEqual({
      id: 'a',
      known: [span(0, 24)],
      unavailable: [span(0, 9), span(12, 24)],
    });
  });

  it('手が離せない時間は、可能・不明のどちらに重なっても不能として数える', () => {
    const a = recordedCareDay(answer({ can: [row('09:00', '12:00')] }), [row('10:00', '13:00')]);
    if (!a) throw new Error('回答を読めない');
    expect(a).toEqual({ id: 'a', known: [span(9, 12)], unavailable: [span(10, 13)] });
    const knowledge = careKnowledge([a]);
    expect(knowledge?.certain).toEqual([span(10, 13)]);
    expect(knowledge?.missing).toEqual([
      { ...span(0, 9), adults: ['a'] },
      { ...span(13, 24), adults: ['a'] },
    ]);
  });

  it('全日「分からない」は、前の週の予定に戻すのではなく全日不明', () => {
    const record = recordedCareDay(answer());
    if (!record) throw new Error('回答を読めない');
    expect(careKnowledge([record])).toEqual({
      certain: [],
      possible: [span(0, 24)],
      missing: [{ ...span(0, 24), adults: ['a'] }],
      missingAdults: ['a'],
    });
  });

  it('前後が接する区間は認め、順序の違いは正しく並べて読む', () => {
    expect(
      recordedCareDay(
        answer({
          rest: 'cannot',
          can: [row('10:00', '11:00'), row('09:00', '10:00')],
        }),
      ),
    ).toEqual({
      id: 'a',
      known: [span(0, 24)],
      unavailable: [span(0, 9), span(11, 24)],
    });
  });

  it('相反する回答、同種の重複、逆順や読めない時間から根拠を作らない', () => {
    expect(
      recordedCareDay(answer({ can: [row('09:00', '11:00')], cannot: [row('10:00', '12:00')] })),
    ).toBeUndefined();
    expect(
      recordedCareDay(answer({ can: [row('09:00', '11:00'), row('10:00', '12:00')] })),
    ).toBeUndefined();
    expect(recordedCareDay(answer({ can: [row('11:00', '09:00')] }))).toBeUndefined();
    expect(recordedCareDay(answer({ can: [row('09:60', '10:00')] }))).toBeUndefined();
    expect(
      recordedCareDay(answer(), [row('09:00', '10:00'), row('09:59', '11:00')]),
    ).toBeUndefined();
  });
});
