// 案どうしを一緒に置く時の、並べ方の探し方（物差しの比べ方、全部試すか、試しきれない時）。
import { describe, expect, it } from 'vitest';
import { bestOrder, compareScore, JOINT_LIMIT, orders } from '../src/engine/joint';

describe('並べ方の探し方', () => {
  it('物差しは前から比べ、足りない所は小さいとする', () => {
    expect(compareScore([1, 5], [1, 4])).toBe(1);
    expect(compareScore([0, 9], [1, 0])).toBe(-1);
    expect(compareScore([1], [1, 0])).toBe(-1);
    expect(compareScore([2, 3], [2, 3])).toBe(0);
  });

  it('並べ方は、与えた順から始めて全部作る', () => {
    const all = [...orders(['a', 'b', 'c'])];
    expect(all[0]).toEqual(['a', 'b', 'c']);
    expect(all).toHaveLength(6);
    expect(new Set(all.map((o) => o.join(''))).size).toBe(6);
    expect([...orders([])]).toEqual([[]]);
  });

  it('物差しが一番大きい並べ方を選び、同じなら先に試した方にする', () => {
    const tried: string[] = [];
    const { result, complete } = bestOrder(
      ['x', 'y', 'z'],
      (order) => {
        tried.push(order.join(''));
        return order.join('');
      },
      // 最後に z を置く並べ方が良い。同じ物差しの xyz と yxz では、先に試した xyz。
      (r) => [r.endsWith('z') ? 1 : 0],
    );
    expect(result).toBe('xyz');
    expect(complete).toBe(true);
    expect(tried).toHaveLength(6);
  });

  it('与えた順の結果が良ければ、ほかの並べ方を試さない', () => {
    let runs = 0;
    const { result, complete } = bestOrder(
      ['x', 'y', 'z'],
      (order) => {
        runs += 1;
        return order.join('');
      },
      () => [0],
      (r) => r === 'xyz',
    );
    expect([result, complete, runs]).toEqual(['xyz', true, 1]);
  });

  it('数が多ければ与えた順で一度だけ置き、探しきれなかったと返す', () => {
    const items = Array.from({ length: JOINT_LIMIT + 1 }, (_, i) => i);
    let runs = 0;
    const { result, complete } = bestOrder(
      items,
      (order) => {
        runs += 1;
        return order;
      },
      () => [0],
    );
    expect(result).toEqual(items);
    expect(complete).toBe(false);
    expect(runs).toBe(1);
  });
});
