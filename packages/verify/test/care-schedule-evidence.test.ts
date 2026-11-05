// 日程に書いた範囲とその前後、書いていない中間を別々に数える。
import { describe, expect, it } from 'vitest';
import { careKnowledge } from '../src/care-knowledge';
import { recordedCareSchedule } from '../src/care-schedule-evidence';

const hour = (n: number) => n * 60;
const span = (a: number, b: number) => ({ start: hour(a), end: hour(b) });

describe('一日の確認済み日程からの根拠', () => {
  it('全日を確認した日程は、首尾も家とし、仕事の区間を見守れないとする', () => {
    const person = recordedCareSchedule('a', [
      { start: '09:00', end: '12:00', kind: 'home' },
      { start: '12:00', end: '18:00', kind: 'work' },
    ]);
    if (!person) throw new Error('日程を読めない');
    expect(careKnowledge([person])).toEqual({
      certain: [span(12, 18)],
      possible: [span(12, 18)],
      missing: [],
      missingAdults: [],
    });
  });

  it('区間の間を家と決めず、未知として残す', () => {
    const person = recordedCareSchedule('a', [
      { start: '09:00', end: '12:00', kind: 'home' },
      { start: '13:00', end: '18:00', kind: 'work' },
    ]);
    if (!person) throw new Error('日程を読めない');
    expect(careKnowledge([person])).toEqual({
      certain: [span(13, 18)],
      possible: [span(12, 18)],
      missing: [{ ...span(12, 13), adults: ['a'] }],
      missingAdults: ['a'],
    });
  });

  it('家で仕事をしていても、仕事の区間は見守れない', () => {
    const person = recordedCareSchedule('a', [{ start: '09:00', end: '12:00', kind: 'work' }]);
    if (!person) throw new Error('日程を読めない');
    expect(careKnowledge([person])?.certain).toEqual([span(9, 12)]);
  });

  it('日程の無い人は、手が離せない時間以外を不明にする', () => {
    const person = recordedCareSchedule('a', [], [{ start: '09:00', end: '10:00' }]);
    if (!person) throw new Error('日程を読めない');
    expect(careKnowledge([person])).toEqual({
      certain: [span(9, 10)],
      possible: [span(0, 24)],
      missing: [
        { ...span(0, 9), adults: ['a'] },
        { ...span(10, 24), adults: ['a'] },
      ],
      missingAdults: ['a'],
    });
  });

  it('日程や手が離せない時間に重なり・不正があれば根拠にしない', () => {
    expect(
      recordedCareSchedule('a', [
        { start: '09:00', end: '11:00', kind: 'home' },
        { start: '10:00', end: '12:00', kind: 'work' },
      ]),
    ).toBeUndefined();
    expect(
      recordedCareSchedule('a', [{ start: '09:99', end: '12:00', kind: 'home' }]),
    ).toBeUndefined();
    expect(recordedCareSchedule('a', [], [{ start: '12:00', end: '10:00' }])).toBeUndefined();
  });
});
