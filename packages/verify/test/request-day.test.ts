// 送信の控えと現在の子の居場所は、家庭の時区の日で照らす。時刻の変更は別途確かめる。
import { describe, expect, it } from 'vitest';
import { matchesArrangementDay, matchesArrangementWindow } from '../src/time';

const care = { kind: 'childCare', start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' };
const interval = (start: string, end: string) => ({ start, end });

describe('依頼の当期と、送った時刻の照合', () => {
  it('時差の表記が違っても、家庭の時区で同じ日かを判定する', () => {
    const sameDay = interval('2026-12-06T15:30+00:00', '2026-12-07T09:15+00:00');
    const oldDay = interval('2026-12-06T14:30+00:00', '2026-12-07T09:15+00:00');
    expect(matchesArrangementDay(sameDay, care, 'Asia/Tokyo')).toBe(true);
    expect(matchesArrangementDay(oldDay, care, 'Asia/Tokyo')).toBe(false);
    expect(matchesArrangementWindow(sameDay, care)).toBe(false);
  });
  it('同じ日に時刻だけ変われば当期だが、送信時刻の差は残る', () => {
    const changed = interval('2026-12-07T09:10+09:00', care.end);
    expect(matchesArrangementDay(changed, care, 'Asia/Tokyo')).toBe(true);
    expect(matchesArrangementWindow(changed, care)).toBe(false);
  });
  it('日を証明できない古い子の居場所の依頼は未判定、それ以外の依頼は窓を要求しない', () => {
    expect(matchesArrangementDay(undefined, care, 'Asia/Tokyo')).toBeUndefined();
    expect(matchesArrangementDay(undefined, { ...care, kind: 'purchase' }, 'Asia/Tokyo')).toBe(
      true,
    );
  });
});
