// 買い物の機会（帰り道の寄り道）の試験。docs/design/01-model.md §5。
import { describe, expect, it } from 'vitest';
import { Household, zonedToEpochMinutes } from '../src';
import { purchaseOpportunities } from '../src/engine';
import { household } from './fixtures/demo';

const at = (time: string) => zonedToEpochMinutes('2026-11-26', time, 'Asia/Tokyo');
const thursday = (h: Household) =>
  purchaseOpportunities(h, 'kidsClothing', 15, at('00:00'), at('23:59')).filter(
    (o) => o.memberId === 'a' && o.slotKind === 'commute',
  );

describe('帰り道の寄り道（11/26 木、健太）', () => {
  it('駅に着いてから店へ歩き、買って駅へ戻り、家に着くのが遅れる分を示す', () => {
    // 通勤の終わり（家に着く）19:00、家は駅から10分 → 駅に18:50。店は駅から5分。
    expect(thursday(household)[0]).toMatchObject({
      storeId: 'store-clothing-toyosu',
      start: at('18:55'),
      end: at('19:10'),
      travelBeforeMin: 5,
      travelAfterMin: 5,
      detour: { plannedArrival: at('19:00'), delayedArrival: at('19:25') },
    });
  });

  it('遅れる間、家にいる大人が他にいなければ寄らない', () => {
    // 彩の木曜の夜の家の区間を 19:20 で終える → 19:20〜19:25 に家に大人がいない。
    const alone = Household.parse({
      ...household,
      routines: household.routines.map((r) =>
        r.memberId === 'b' && r.weekday === 4
          ? {
              ...r,
              segments: r.segments.map((s) =>
                s.kind === 'home' && s.start === '18:15' ? { ...s, end: '19:20' } : s,
              ),
            }
          : r,
      ),
    });
    expect(thursday(alone)).toEqual([]);
  });

  it('家の駅からの徒歩が分からなければ、寄り道を作らない', () => {
    const unknownWalk = Household.parse({
      ...household,
      places: household.places.map((p) =>
        p.id === 'home' ? { ...p, walkFromStationMin: undefined } : p,
      ),
    });
    expect(thursday(unknownWalk)).toEqual([]);
  });
});
