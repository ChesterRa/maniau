// 家族の店の好みは、架空の事象と家庭を使い、計画エンジンを呼ばずに検証する。
import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { verifyPlan } from '../src';
import { arrangement, event, household, option, plan, requirement, task } from './fixtures';

const ITEM = 'source-1:i1';
const WORD = '白い長袖シャツ';

function materials(what = WORD) {
  const family = Household.parse({
    ...household(),
    places: [
      ...household().places.map((p) =>
        p.id === 'store' ? { ...p, goods: ['kidsClothing', 'groceries'] } : p,
      ),
      {
        id: 'store-b',
        kind: 'store',
        name: 'もう一つの店',
        nearStationId: 'station',
        walkFromStationMin: 3,
        goods: ['kidsClothing', 'groceries'],
      },
    ],
    resources: [
      { id: 'res-a', kind: 'store', name: '店', placeId: 'store', notes: [], use: 'usual' },
      {
        id: 'res-b',
        kind: 'store',
        name: 'もう一つの店',
        placeId: 'store-b',
        notes: [],
        use: 'candidate',
      },
    ],
  });
  const source = {
    id: 'source-1',
    version: 1,
    receivedAt: '2026-11-30T10:00+09:00',
    sender: 'family',
    language: 'ja',
    sentences: [{ id: 'source-1#1', text: `${what}を用意する。` }],
  };
  const item = {
    id: ITEM,
    sourceId: source.id,
    sentenceIds: ['source-1#1'],
    kind: 'belongings',
    written: `${what}を用意する。`,
    interpretation: { what, date: '2026-12-07' },
    evidence: 'stated',
    effects: [],
  };
  const events = [
    event(1, { type: 'householdSet', household: family }),
    event(2, { type: 'noticeReceived', source }),
    event(3, { type: 'itemsStated', sourceId: source.id, items: [item] }),
  ];
  const current = plan({
    throughSeq: events.length,
    requirements: [requirement({ kind: 'belongings', what, basis: { itemIds: [ITEM] } })],
    arrangements: [
      arrangement({
        kind: 'purchase',
        options: [option('buy', { taskKeys: ['buy-task'] })],
        recommendedOptionKey: 'buy',
      }),
    ],
    tasks: [
      task('buy-task', {
        titleKey: 'task.buy',
        titleParams: { what },
        basis: {
          itemIds: [ITEM],
          requirementKey: 'requirement',
          arrangementKey: 'arrangement',
          optionKey: 'buy',
        },
        atPlaceId: 'store-b',
        placeKind: 'store',
        goods: 'kidsClothing',
      }),
    ],
  });
  return { family, events, current };
}

function preferenceIssues(m: ReturnType<typeof materials>) {
  m.events[0] = event(1, { type: 'householdSet', household: m.family });
  return verifyPlan({ household: m.family, events: m.events, plan: m.current }).issues.filter(
    (entry) =>
      entry.code === 'store_not_used' ||
      entry.code === 'store_choice_bypassed' ||
      entry.code === 'usual_store_bypassed' ||
      entry.code === 'store_preference_unverified',
  );
}

describe('買い物の店と、家族の扱い', () => {
  it('いつもの店を扱う品なら、別の店への黙った配置を見つける', () => {
    const m = materials();
    expect(preferenceIssues(m)).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'usual_store_bypassed',
        related: 'store',
      }),
    );
    const t = m.current.tasks[0];
    if (!t) throw new Error('作業がない');
    t.atPlaceId = 'store';
    expect(preferenceIssues(m)).toEqual([]);
  });

  it('いつもの店が二つなら、そのどちらも使える。使わない店は使わない', () => {
    const m = materials();
    const b = m.family.resources.find((r) => r.id === 'res-b');
    if (!b) throw new Error('資源がない');
    b.use = 'usual';
    expect(preferenceIssues(m)).toEqual([]);
    b.use = 'notUsed';
    expect(preferenceIssues(m)).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'store_not_used',
        related: 'store-b',
      }),
    );
  });

  it('この品物に選んだ店はいつもの店より先。ただし別の店には移さない', () => {
    const m = materials();
    const b = m.family.places.find((p) => p.id === 'store-b');
    const t = m.current.tasks[0];
    if (!b || !t) throw new Error('店または作業がない');
    b.goods.push(WORD);
    expect(preferenceIssues(m)).toEqual([]);
    t.atPlaceId = 'store';
    expect(preferenceIssues(m)).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'store_choice_bypassed',
        related: 'store-b',
      }),
    );
  });

  it('品物名と種類名が同じ時、単品の選択と取り違えない', () => {
    const m = materials('groceries');
    expect(preferenceIssues(m)).toContainEqual(
      expect.objectContaining({
        kind: 'violation',
        code: 'usual_store_bypassed',
      }),
    );
  });

  it('同じ品物の店が二つ、または同じ店の扱いが二つある時は決めつけない', () => {
    const m = materials();
    for (const p of m.family.places.filter((p) => p.kind === 'store')) p.goods.push(WORD);
    expect(preferenceIssues(m)).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'store_preference_unverified',
      }),
    );
    const other = materials();
    other.family.resources.push({
      id: 'res-duplicate',
      kind: 'store',
      name: '店',
      placeId: 'store',
      notes: [],
      use: 'notUsed',
    });
    expect(preferenceIssues(other)).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'store_preference_unverified',
      }),
    );
    expect(preferenceIssues(other).some((i) => i.code === 'usual_store_bypassed')).toBe(false);
  });

  it('事項を確認できない時や品の種類を独立に分からない時は未判定にする', () => {
    const m = materials();
    m.events.splice(2, 1);
    expect(preferenceIssues(m)).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'store_preference_unverified',
      }),
    );
    const other = materials('何を買うか分からない品');
    expect(preferenceIssues(other)).toContainEqual(
      expect.objectContaining({
        kind: 'undetermined',
        code: 'store_preference_unverified',
      }),
    );
  });

  it('済んだ過去の買い物は、後から変えた好みで違反にしない', () => {
    const m = materials();
    const t = m.current.tasks[0];
    const b = m.family.resources.find((r) => r.id === 'res-b');
    if (!t || !b) throw new Error('作業または資源がない');
    t.commitment = 'done';
    b.use = 'notUsed';
    expect(preferenceIssues(m)).toEqual([]);
  });

  it('店の好みがまだ無い家には、好みの未判定を新しく出さない', () => {
    const m = materials();
    m.family.resources = [];
    m.events.splice(2, 1);
    expect(preferenceIssues(m)).toEqual([]);
  });

  it('いつもの店がなくても、品物のために明示した一つの店を外してはならない', () => {
    const m = materials();
    m.family.resources = [];
    const b = m.family.places.find((p) => p.id === 'store-b');
    const t = m.current.tasks[0];
    if (!b || !t) throw new Error('店または作業がない');
    b.goods.push(WORD);
    t.atPlaceId = 'store';
    expect(preferenceIssues(m)).toContainEqual(
      expect.objectContaining({ kind: 'violation', code: 'store_choice_bypassed' }),
    );
  });

  it('計画が別の品の種類を付けても、元の事項でいつもの店を照らす', () => {
    const m = materials();
    const t = m.current.tasks[0];
    if (!t) throw new Error('作業がない');
    t.goods = 'groceries';
    expect(preferenceIssues(m)).toContainEqual(
      expect.objectContaining({ kind: 'violation', code: 'usual_store_bypassed' }),
    );
  });
});
