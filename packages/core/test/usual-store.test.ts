// 家族の好み（いつもの店）で買い物を置く試験（02-foundation §3.5）。デモの家の、同じ品物を扱う二つの店（衣料品店 A
// と、駅から近く先に寄れる架空の子ども服の店 B）で、A を「いつも使う」にすると A に置き、A に寄れる時が無ければ B に
// 黙って移さず決めない。「使わない」の店は外す。地図の応答は使わない（家庭の目安の道のりと営業時間）。
import { describe, expect, it } from 'vitest';
import { Household } from '../src';
import { computePlan, purchaseGoods, purchaseStores } from '../src/engine';
import { household, noticeArrived } from './fixtures/demo';

const SHIRT = 'arr:purchase:i3';
const UNKNOWN = 'u-atHome:i3';
const AT = '2026-11-25T19:40+09:00';
const A = 'store-clothing-toyosu';
const B = 'store-kids-toyosu';
const storeA = household.places.find((p) => p.id === A);
const storeB = household.places.find((p) => p.id === B);
if (!storeA?.hours || !storeB) throw new Error('デモの店 A・B が無い');
const hours = storeA.hours;
// デモの家は A を「いつも使う」にしてある。試験は、店の資源を外した家から、店ごとの扱いを入れて組む。
const base = { ...household, resources: household.resources.filter((r) => r.kind !== 'store') };

type Use = 'usual' | 'candidate' | 'notUsed';
/** 店ごとの家族の扱い（資源の use）を入れた家。A の営業時間・扱う物を替え、B を外せる。 */
function withStores(
  uses: { a?: Use; b?: Use },
  options: { aHours?: typeof hours; aGoods?: string[]; noB?: boolean } = {},
) {
  const store = (id: string, name: string, use: Use) => ({
    id: `res-store-${id}`,
    kind: 'store',
    name,
    placeId: id,
    notes: [],
    use,
  });
  return Household.parse({
    ...base,
    places: base.places
      .filter((p) => !(options.noB && p.id === B))
      .map((p) =>
        p.id === A
          ? {
              ...p,
              hours: options.aHours ?? p.hours,
              ...(options.aGoods ? { goods: options.aGoods } : {}),
            }
          : p,
      ),
    resources: [
      ...base.resources,
      ...(uses.a ? [store(A, storeA?.name ?? '', uses.a)] : []),
      ...(uses.b ? [store(B, storeB?.name ?? '', uses.b)] : []),
    ],
  });
}

/** シャツは家に無いと答えた後の計画。 */
function planWith(h: Household, at = AT) {
  const events = noticeArrived()
    .add('householdSet', '2026-11-25T19:35+09:00', 'a', { household: h })
    .add('answered', '2026-11-25T19:36+09:00', 'b', { unknownId: UNKNOWN, value: 'no' }).events;
  const plan = computePlan(events, at);
  const arrangement = plan.arrangements.find((a) => a.key === SHIRT);
  const task = plan.tasks.find((t) => t.basis.arrangementKey === SHIRT && t.live);
  return { plan, arrangement, task };
}

describe('いつもの店', () => {
  it('デモの家は A を「いつも使う」にしてあり、B が先に寄れても A に置く', () => {
    const { arrangement, task } = planWith(household);
    expect(arrangement?.status).toBe('decidable');
    expect(task?.atPlaceId).toBe(A);
  });

  it('好みが無ければ、使える店のいちばん早い機会（駅から近い B）', () => {
    const { arrangement, task } = planWith(withStores({}));
    expect(arrangement?.status).toBe('decidable');
    expect(task?.atPlaceId).toBe(B);
  });

  it('A を「いつも使う」にすると、B が先に寄れても A に置き、決め時も A の機会から求める', () => {
    const usualA = planWith(withStores({ a: 'usual', b: 'candidate' }));
    expect(usualA.arrangement?.status).toBe('decidable');
    expect(usualA.task?.atPlaceId).toBe(A);
    // B を「いつも使う」にすると、決め時は B の最後の機会（A の機会からは求めない）。
    const usualB = planWith(withStores({ a: 'candidate', b: 'usual' }));
    expect(usualB.task?.atPlaceId).toBe(B);
    const deadline = (p: typeof usualA) => p.arrangement?.options[0]?.decisionDeadline;
    expect(deadline(usualA)).not.toBe(deadline(usualB));
    expect(deadline(usualB)).toBe(
      planWith(withStores({}, { noB: false, aGoods: ['clothing'] })).arrangement?.options[0]
        ?.decisionDeadline,
    );
  });

  it('いつもの店 A に寄れる時が無ければ、B に黙って移さず、決めない（A を理由に出し、過ぎたとは言わない）', () => {
    // A は持って行く時まで、どの日も開いていない（家族が入れた営業時間で）。
    const closedEvenings = { ...hours, periods: [] };
    const { arrangement, task } = planWith(
      withStores({ a: 'usual', b: 'candidate' }, { aHours: closedEvenings }),
    );
    expect(arrangement?.status).toBe('undetermined');
    expect(arrangement?.reasons).toContainEqual({ code: 'usualStoreUnavailable', refs: [A] });
    expect(arrangement?.reasons.some((r) => r.code === 'noOptionLeft')).toBe(false);
    expect(arrangement?.options[0]?.expired).toBe(false);
    expect(task).toBeUndefined();
  });

  it('いつもの店の機会が過ぎただけでも、ほかの店にまだ寄れるなら、無理とは言わず決めない。どの店にも寄れなければ過ぎた', () => {
    // A は水曜（11/25）だけ開き、次の水曜（12/2）は休み。今は 11/26 の夜：A にはもう寄れず、B には 11/27 に寄れる。
    const wednesday = {
      ...hours,
      periods: hours.periods.filter((p) => p.weekday === 3),
      closedDates: ['2026-12-02'],
    };
    const later = '2026-11-26T20:00+09:00';
    const held = planWith(withStores({ a: 'usual', b: 'candidate' }, { aHours: wednesday }), later);
    expect(held.arrangement?.status).toBe('undetermined');
    expect(held.arrangement?.reasons).toContainEqual({ code: 'usualStoreUnavailable', refs: [A] });
    expect(held.arrangement?.reasons.some((r) => r.code === 'noOptionLeft')).toBe(false);
    expect(held.arrangement?.options[0]?.expired).toBe(false);
    expect(held.task).toBeUndefined();
    // 家族が B を「いつも使う」にすれば、B の 11/27 の機会に置く。
    const usualB = planWith(
      withStores({ a: 'candidate', b: 'usual' }, { aHours: wednesday }),
      later,
    );
    expect(usualB.task?.atPlaceId).toBe(B);
    expect(usualB.task?.start?.startsWith('2026-11-27')).toBe(true);
    // B が無く、A の機会が過ぎただけなら、今までどおり過ぎた（過ぎた最後の機会を決め時として示す）。
    const late = planWith(withStores({ a: 'usual' }, { aHours: wednesday, noB: true }), later);
    expect(late.arrangement?.reasons.some((r) => r.code === 'noOptionLeft')).toBe(true);
    expect(late.arrangement?.options[0]?.expired).toBe(true);
    expect(late.arrangement?.options[0]?.decisionDeadline?.startsWith('2026-11-25')).toBe(true);
  });

  it('いつもの店が二つあれば、寄れる方に置く（一つに寄れないだけでは止めない）', () => {
    // A は持って行く時まで、どの日も開いていない（家族が入れた営業時間で）。
    const closedEvenings = { ...hours, periods: [] };
    const { arrangement, task } = planWith(
      withStores({ a: 'usual', b: 'usual' }, { aHours: closedEvenings }),
    );
    expect(arrangement?.status).toBe('decidable');
    expect(task?.atPlaceId).toBe(B);
  });

  it('「使わない」の店は外す。A を使わないにすれば、いつもの店は無いので B。扱う店が使わない店だけなら、決めない', () => {
    expect(planWith(withStores({ a: 'notUsed' })).task?.atPlaceId).toBe(B);
    const only = planWith(withStores({ a: 'notUsed' }, { noB: true }));
    expect(only.arrangement?.status).toBe('undetermined');
    expect(only.arrangement?.reasons).toContainEqual({ code: 'storeNotUsed', refs: [A] });
    expect(only.arrangement?.reasons.some((r) => r.code === 'noOptionLeft')).toBe(false);
    expect(only.task).toBeUndefined();
    expect(purchaseStores(withStores({ a: 'notUsed' }), 'kidsClothing')).toMatchObject({
      usual: false,
      notUsed: [{ id: A }],
    });
  });

  it('品物のために家族が選んだ店が先。その店が「使わない」なら、ほかの店に移さず決めない', () => {
    const chosenB = withStores({ a: 'usual' }, { aGoods: ['clothing', 'kidsClothing'] });
    const pick = Household.parse({
      ...chosenB,
      places: chosenB.places.map((p) =>
        p.id === B ? { ...p, goods: [...p.goods, '白い長袖シャツ'] } : p,
      ),
    });
    // いつもの店 A より、品物のために選んだ B が先。
    expect(planWith(pick).task?.atPlaceId).toBe(B);
    const notUsedPick = Household.parse({
      ...pick,
      resources: [
        ...pick.resources,
        {
          id: `res-store-${B}`,
          kind: 'store',
          name: storeB.name,
          placeId: B,
          notes: [],
          use: 'notUsed',
        },
      ],
    });
    const conflict = planWith(notUsedPick);
    expect(conflict.arrangement?.status).toBe('undetermined');
    expect(conflict.arrangement?.reasons).toContainEqual({ code: 'storeNotUsed', refs: [B] });
    expect(conflict.task).toBeUndefined();
  });

  it('品物の名前が種類の名前と同じ字なら、その種類として扱う（家族が選んだ店とは見なさない）', () => {
    const h = withStores({});
    // 種類の名前そのものの品物は、その種類（品物のために選んだ店とは見なさず、種類が分からないにもしない）。
    expect(purchaseGoods(h, 'kidsClothing')).toBe('kidsClothing');
    expect(purchaseGoods(h, 'groceries')).toBe('groceries');
    expect(purchaseGoods(h, '白い長袖シャツ')).toBe('kidsClothing');
    const named = Household.parse({
      ...h,
      places: h.places.map((p) =>
        p.id === B ? { ...p, goods: [...p.goods, '白い長袖シャツ'] } : p,
      ),
    });
    expect(purchaseGoods(named, '白い長袖シャツ')).toBe('白い長袖シャツ');
  });
});
