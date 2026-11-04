// 家族の好み（いつもの店）を家の情報の直しで入れる（02-foundation §3.5）。店の扱いは、店の場所を指す資源の use で
// 持つ。資源の無い店は、家族が扱いを選んだ時に資源を作る（ID は店から決め、名前は店の名前、分かった事は無し、一つの店に
// 一つ）。時刻はサーバーが付ける。扱いを替えると、買い物を置く店が替わり、保存の前に「この変更で変わること」に出る。
// 架空のデモの家。API・地図は呼ばない。
import type { Command, Household, SaveablePreview } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = '2026-11-25T20:00+09:00';
const A = 'store-clothing-toyosu';
const B = 'store-kids-toyosu';

function formal(now = NOW) {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let n = 0;
  const run = (command: Command, memberId = 'b') =>
    runCommand(store, 'demo', { memberId, now, operationId: `s-${++n}`, demo: true }, command);
  const write = async (command: SaveablePreview) => {
    const shown = previewChange(await events(), { memberId: 'b', now }, command);
    if ('reason' in shown) return { status: 'invalid', reason: shown.reason, shown };
    const result = await run({
      ...command,
      seen: { throughSeq: shown.throughSeq, changes: shown.seen },
    });
    return { ...result, shown };
  };
  const household = async () => {
    const found = foldEvents(await events()).household;
    if (!found) throw new Error('家庭が無い');
    return structuredClone(found);
  };
  const edit = (next: Household) =>
    write({ type: 'updateHousehold', household: next } as SaveablePreview);
  const plan = async () => {
    const all = await events();
    const computed = computePlan(all, now);
    expect(
      verifyPlan({ household: await household(), plan: computed, events: all })
        .issues.filter((i) => i.kind === 'violation')
        .map((i) => i.code),
    ).toEqual([]);
    return computed;
  };
  return { events, run, household, edit, plan };
}

/** 店 B の資源（家族が扱いを選んだ時に画面が作る形）。 */
function storeB(h: Household, use: 'usual' | 'candidate' | 'notUsed') {
  const place = h.places.find((p) => p.id === B);
  if (!place) throw new Error('デモの店 B が無い');
  return { id: `res-store-${B}`, kind: 'store', name: place.name, placeId: B, notes: [], use };
}

describe('店の扱い（家族の好み）', () => {
  it('資源の無い店に扱いを選ぶと、店の資源ができ、時刻はサーバーが付ける', async () => {
    const f = formal();
    const h = await f.household();
    expect(h.resources.some((r) => r.placeId === B)).toBe(false);
    const sent = { ...storeB(h, 'candidate'), decidedAt: '2020-01-01T00:00+09:00' };
    expect(await f.edit({ ...h, resources: [...h.resources, sent] })).toMatchObject({
      status: 'ok',
    });
    expect((await f.household()).resources.find((r) => r.placeId === B)).toEqual({
      ...storeB(h, 'candidate'),
      decidedAt: NOW,
    });
  });

  it('店の資源は、店から決めた ID・店の名前・分かった事無しで、一つの店に一つだけ', async () => {
    const f = formal();
    const h = await f.household();
    const made = storeB(h, 'usual');
    const refused: Household['resources'][number][][] = [
      [{ ...made, id: 'res-made-up' }],
      [{ ...made, name: '別の名前' }],
      [
        {
          ...made,
          notes: [{ text: '作った事', source: { kind: 'family' } }],
        } as Household['resources'][number],
      ],
      [made, { ...made, id: 'res-store-twice' }],
    ];
    for (const added of refused) {
      expect(await f.edit({ ...h, resources: [...h.resources, ...added] })).toMatchObject({
        status: 'invalid',
        reason: expect.stringMatching(/^(resourcesLocked|householdInvalid)$/),
      });
    }
    expect((await f.household()).resources.some((r) => r.placeId === B)).toBe(false);
  });

  it('いつもの店 A を「使わない」にすると、買う店が B に替わり、保存の前の「変わること」に出る', async () => {
    const f = formal();
    // シャツは家に無いと答える（買い物の作業が、家族が進める作業になる）。
    expect(
      await f.run({
        type: 'answer',
        unknownId: 'u-atHome:n1:i5',
        value: 'no',
        seen: { what: '白い長袖シャツ', throughSeq: computePlan(await f.events(), NOW).throughSeq },
      } as Command),
    ).toMatchObject({ status: 'ok' });
    const shirt = (plan: Awaited<ReturnType<typeof f.plan>>) =>
      plan.tasks.find((t) => t.live && t.titleKey === 'task.buy' && t.goods !== undefined);
    const before = shirt(await f.plan());
    expect(before?.atPlaceId).toBe(A);
    const h = await f.household();
    const edited = {
      ...h,
      resources: h.resources.map((r) => (r.placeId === A ? { ...r, use: 'notUsed' as const } : r)),
    };
    const saved = await f.edit(edited);
    expect(saved).toMatchObject({ status: 'ok' });
    if (!('shown' in saved) || 'reason' in saved.shown) throw new Error('見せた物が無い');
    expect(saved.shown.changes.relocated).toContainEqual({
      taskKey: before?.key,
      before: A,
      after: B,
    });
    expect(shirt(await f.plan())?.atPlaceId).toBe(B);
  });
});
