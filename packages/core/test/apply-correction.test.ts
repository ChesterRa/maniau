// 家族の直しを解釈に重ねる：家族が入れた始まり・終わりの時刻は、読み取りの「読み落としたかもしれない」印を外す
// （直した後も確かめを求め続けない）。名前だけの直しでは外さない。「だれのため」の null は外す。
import { describe, expect, it } from 'vitest';
import { applyCorrection, type Interpretation } from '../src/schema/source';

const read: Interpretation = {
  date: '2026-12-08',
  what: '1年生の発表',
  startTimeUnconfirmed: true,
  endTime: '11:00',
  endTimeUnconfirmed: true,
  forMemberId: 'c1',
};

describe('applyCorrection', () => {
  it('始まりを入れると始まりの印だけを、終わりを入れると終わりの印だけを外す', () => {
    const start = applyCorrection(read, { startTime: '09:20' });
    expect(start.startTime).toBe('09:20');
    expect(start.startTimeUnconfirmed).toBeUndefined();
    expect(start.endTimeUnconfirmed).toBe(true);
    const end = applyCorrection(read, { endTime: '11:30' });
    expect(end.endTime).toBe('11:30');
    expect(end.endTimeUnconfirmed).toBeUndefined();
    expect(end.startTimeUnconfirmed).toBe(true);
  });

  it('名前だけの直しでは印を外さない。「だれのため」の null は外す', () => {
    const renamed = applyCorrection(read, { what: '1年生の発表会' });
    expect(renamed).toMatchObject({ startTimeUnconfirmed: true, endTimeUnconfirmed: true });
    expect('forMemberId' in applyCorrection(read, { forMemberId: null })).toBe(false);
  });
});
