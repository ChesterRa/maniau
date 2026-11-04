// 一度だけ済ませておく前提（事前の登録など。家の情報の preparations）を、やり方（requires）から計算に使う。
// デモの家族の病児保育は、陽菜の事前登録が要り、済んだか分からない（unknown）。済んだと確かめるまで、その案に印を
// 付けて勧めない（家族は選べる）。家族が「済んだ」にすれば印は消え、ほかの人の「すること」には借りない。前提の
// 種類で分けない（データの requires だけで決まる）。家の情報の直しで替えられるのは、資源の扱いと前提の状態・
// 有効な最後の日だけで、直した時刻はサーバーが付ける。Claude の API は呼ばない。
import { type Command, type Household, preparationGaps, type SaveablePreview } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = '2026-11-26T20:00+09:00';

function formal(now = NOW) {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let n = 0;
  const run = (command: Command, memberId = 'b') =>
    runCommand(store, 'demo', { memberId, now, operationId: `p-${++n}`, demo: true }, command);
  const write = async (command: SaveablePreview) => {
    const shown = previewChange(await events(), { memberId: 'b', now }, command);
    // 見る口が断れば、記録の命令も同じ訳で断る（ここでは見る口の訳を返す）。
    if ('reason' in shown) return { status: 'invalid', reason: shown.reason };
    return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
  };
  const household = async () => {
    const found = foldEvents(await events()).household;
    if (!found) throw new Error('家庭が無い');
    return found;
  };
  /** 言って、やり方を選ぶ。 */
  const need = async (interpretation: Record<string, unknown>, wayIds: string[]) => {
    expect(
      await write({ type: 'stateNeed', text: '（試験）', interpretation } as SaveablePreview),
    ).toMatchObject({ status: 'ok' });
    const itemId = computePlan(await events(), now).requirements.find(
      (r) => r.kind === 'need' && r.live,
    )?.basis.itemIds[0];
    if (!itemId) throw new Error('「すること」が無い');
    expect(await write({ type: 'setNeedWays', itemId, wayIds })).toMatchObject({ status: 'ok' });
  };
  /** 今の計画の「すること」の手配（検証の違反が無いことも確かめる）。 */
  const arrangement = async () => {
    const all = await events();
    const plan = computePlan(all, now);
    expect(
      verifyPlan({ household: await household(), plan, events: all })
        .issues.filter((i) => i.kind === 'violation')
        .map((i) => i.code),
    ).toEqual([]);
    return plan.arrangements.find((a) => a.kind === 'need' && a.live);
  };
  const edit = (next: Household) =>
    write({ type: 'updateHousehold', household: next } as SaveablePreview);
  /** 書かずに見る（家の情報の直しの「この変更で変わること」）。 */
  const preview = async (next: Household) => {
    const shown = previewChange(await events(), { memberId: 'b', now }, {
      type: 'updateHousehold',
      household: next,
    } as SaveablePreview);
    if ('reason' in shown) throw new Error(shown.reason);
    return shown;
  };
  return { need, arrangement, household, edit, preview };
}

const watch = (forMemberId?: string) => ({
  what: '家で見る',
  shape: 'window',
  date: '2026-12-02',
  startTime: '09:00',
  endTime: '17:00',
  ...(forMemberId === undefined ? {} : { forMemberId }),
});
const sickCare = (a: Awaited<ReturnType<ReturnType<typeof formal>['arrangement']>>) =>
  a?.options.find((o) => o.templateId === 'way-sick-care');
const grandma = (a: Awaited<ReturnType<ReturnType<typeof formal>['arrangement']>>) =>
  a?.options.find((o) => o.templateId === 'way-grandma');
/** 前提の状態・資源の扱いを替えた家の情報。 */
const withState = (h: Household, state: Household['preparations'][number]['state']): Household => ({
  ...h,
  preparations: h.preparations.map((p) => ({ ...p, state })),
});
const withUse = (h: Household, use: Household['resources'][number]['use']): Household => ({
  ...h,
  resources: h.resources.map((r) => ({ ...r, use })),
});

describe('一度だけ済ませておく前提（事前の登録）', () => {
  it('済んだか分からない前提の案は、印を付けて勧めない。家族が「済んだ」にすると印は消える', async () => {
    const f = formal();
    await f.need(watch('c'), ['way-sick-care', 'way-grandma']);
    const before = await f.arrangement();
    expect(sickCare(before)?.needsPreparation).toEqual([
      { preparationId: 'prep-sick-care', state: 'unknown' },
    ]);
    expect(before?.recommendedOptionKey).toBeUndefined();
    // 祖母の案には前提が無い（印を付けない）。
    expect(
      before?.options.find((o) => o.templateId === 'way-grandma')?.needsPreparation,
    ).toBeUndefined();

    const household = await f.household();
    expect(
      await f.edit({
        ...household,
        preparations: household.preparations.map((p) => ({ ...p, state: 'done' as const })),
      }),
    ).toMatchObject({ status: 'ok' });
    const saved = (await f.household()).preparations[0];
    expect(saved).toMatchObject({ state: 'done', stateCheckedAt: NOW });
    expect(sickCare(await f.arrangement())?.needsPreparation).toBeUndefined();
  });

  it('人ごとの前提は、だれのためか分からない・ほかの人の「すること」には借りない', async () => {
    const f = formal();
    const household = await f.household();
    await f.edit({
      ...household,
      preparations: household.preparations.map((p) => ({ ...p, state: 'done' as const })),
    });
    await f.need(watch(), ['way-sick-care', 'way-grandma']);
    expect(sickCare(await f.arrangement())?.needsPreparation).toEqual([
      { preparationId: 'prep-sick-care', state: 'personUnknown' },
    ]);
  });

  it('だれの前提か分からない登録は、済んでも借りない（欄の無さを家全体と読まない）', async () => {
    const f = formal();
    const household = await f.household();
    // 試験のために、家の情報を直接置く（家族の直しでは、だれの前提かを替えられない）。
    const unknownScope: Household = {
      ...household,
      preparations: household.preparations.map((p) => ({
        ...p,
        state: 'done' as const,
        appliesTo: { kind: 'unknown' as const },
      })),
    };
    expect(
      preparationGaps(unknownScope, { requires: ['prep-sick-care'] }, '2026-12-02', 'c'),
    ).toEqual([{ preparationId: 'prep-sick-care', state: 'appliesUnknown' }]);
    const wholeHousehold: Household = {
      ...unknownScope,
      preparations: unknownScope.preparations.map((p) => ({
        ...p,
        appliesTo: { kind: 'household' as const },
      })),
    };
    expect(
      preparationGaps(wholeHousehold, { requires: ['prep-sick-care'] }, '2026-12-02', undefined),
    ).toEqual([]);
  });

  it('有効な最後の日を過ぎた登録は、済んだとして使わない', async () => {
    const f = formal();
    const household = await f.household();
    await f.edit({
      ...household,
      preparations: household.preparations.map((p) => ({
        ...p,
        state: 'done' as const,
        validUntil: '2026-11-30',
      })),
    });
    await f.need(watch('c'), ['way-sick-care', 'way-grandma']);
    expect(sickCare(await f.arrangement())?.needsPreparation).toEqual([
      { preparationId: 'prep-sick-care', state: 'expired' },
    ]);
  });

  it('家の情報の直しで替えられるのは、資源の扱いと前提のだれの分・状態・有効な最後の日と、やり方との結び付きだけ（時刻はサーバーが付ける）', async () => {
    const f = formal();
    const household = await f.household();
    // 名前・出典は替えない。消さない。調べて見せていない資源は足せない。やり方は、家にある前提・資源だけを指せる。
    // だれの分の人は、家の成員だけ。
    const refused: [Household, string][] = [
      [
        { ...household, preparations: household.preparations.map((p) => ({ ...p, name: '別' })) },
        'resourcesLocked',
      ],
      [
        {
          ...household,
          preparations: household.preparations.map((p) => ({
            ...p,
            appliesTo: { kind: 'members' as const, memberIds: ['nobody'] },
          })),
        },
        'householdInvalid',
      ],
      [
        { ...household, resources: household.resources.map((r) => ({ ...r, notes: [] })) },
        'resourcesLocked',
      ],
      // 資源を消すと、前提の参照が切れる（家の情報の検査で断る）。
      [{ ...household, resources: [] }, 'householdInvalid'],
      [
        {
          ...household,
          resources: [
            ...household.resources,
            {
              id: 'res-made-up',
              kind: 'sickChildCare',
              name: '作った資源',
              notes: [],
              use: 'candidate',
            },
          ],
        },
        'resourcesLocked',
      ],
      [
        {
          ...household,
          ways: household.ways.map((w) =>
            w.id === 'way-sick-care' ? { ...w, requires: ['prep-missing'] } : w,
          ),
        },
        'householdInvalid',
      ],
    ];
    for (const [next, reason] of refused) {
      expect({ reason, got: await f.edit(next) }).toEqual({
        reason,
        got: { status: 'invalid', reason },
      });
      // 記録の命令も、見る口と同じ訳で断る。
      expect(
        await runCommand(
          memoryStore(new Map([['demo', demoEvents('arrived')]])),
          'demo',
          { memberId: 'b', now: NOW, operationId: 'direct', demo: true },
          { type: 'updateHousehold', household: next } as Command,
        ),
      ).toMatchObject({ status: 'invalid', reason });
    }
    // 送られた時刻は採らない。
    expect(
      await f.edit({
        ...household,
        resources: household.resources.map((r) => ({
          ...r,
          use: 'usual' as const,
          decidedAt: '2020-01-01T00:00+09:00',
        })),
      }),
    ).toMatchObject({ status: 'ok' });
    expect((await f.household()).resources[0]).toMatchObject({ use: 'usual', decidedAt: NOW });
    // やり方から前提と資源を外せる（空の欄は書かない）。
    expect(
      await f.edit({
        ...(await f.household()),
        ways: (await f.household()).ways.map((w) =>
          w.id === 'way-sick-care' ? { ...w, requires: [], resourceIds: [] } : w,
        ),
      }),
    ).toMatchObject({ status: 'ok' });
    const unlinked = (await f.household()).ways.find((w) => w.id === 'way-sick-care');
    expect(unlinked).not.toHaveProperty('requires');
    expect(unlinked).not.toHaveProperty('resourceIds');
    // だれの分は家族が直せる。だれの分だけの直しでは、状態を確かめた時刻を付けない。
    const now = await f.household();
    expect(
      await f.edit({
        ...now,
        preparations: now.preparations.map((p) => ({
          ...p,
          appliesTo: { kind: 'household' as const },
        })),
      }),
    ).toMatchObject({ status: 'ok' });
    const whole = (await f.household()).preparations[0];
    expect(whole?.appliesTo).toEqual({ kind: 'household' });
    expect(whole).not.toHaveProperty('stateCheckedAt');
  });

  it('「この変更で変わること」：前提を済んだにすると、印が消えて勧める手が出る。戻すと逆になる', async () => {
    const f = formal();
    await f.need(watch('c'), ['way-sick-care', 'way-grandma']);
    const before = await f.arrangement();
    const option = sickCare(before)?.key;
    const shown = await f.preview(withState(await f.household(), 'done'));
    expect(shown.changes.preparations).toEqual([
      {
        arrangementKey: before?.key,
        optionKey: option,
        templateId: 'way-sick-care',
        before: [{ preparationId: 'prep-sick-care', state: 'unknown' }],
        after: [],
      },
    ]);
    expect(shown.changes.recommendations).toHaveLength(1);
    expect(shown.changes.recommendations[0]).toMatchObject({ kind: 'need', what: '家で見る' });
    expect(shown.changes.recommendations[0]?.before).toBeUndefined();
    // 勧めるようになる手は、手の決まりの ID も持つ（画面が名前を引ける）。
    expect(shown.changes.recommendations[0]?.after?.templateId).toBe('way-grandma');
    // 保存すると、見た通りに勧める手が出る。
    expect(await f.edit(withState(await f.household(), 'done'))).toMatchObject({ status: 'ok' });
    const done = await f.arrangement();
    expect(done?.recommendedOptionKey).toBe(shown.changes.recommendations[0]?.after?.optionKey);
    // 「まだ」に戻すと、印が付いて勧める手が無くなる。
    const back = await f.preview(withState(await f.household(), 'notDone'));
    expect(back.changes.preparations[0]?.after).toEqual([
      { preparationId: 'prep-sick-care', state: 'notDone' },
    ]);
    expect(back.changes.recommendations[0]?.before?.optionKey).toBe(done?.recommendedOptionKey);
    expect(back.changes.recommendations[0]?.after).toBeUndefined();
  });

  it('「使わない」とした資源を使う手は勧めず、ほかの手を比べて勧める。全部なら勧めないが、選べる手は残る', async () => {
    const f = formal();
    // 登録は済んだとする（前提の印ではなく、「使わない」の効きを見る）。
    await f.edit(withState(await f.household(), 'done'));
    await f.need(watch('c'), ['way-sick-care', 'way-grandma']);
    const usable = await f.arrangement();
    expect(usable?.recommendedOptionKey).toBeDefined();
    const shown = await f.preview(withUse(await f.household(), 'notUsed'));
    expect(shown.changes.unusedResources).toEqual([
      {
        arrangementKey: usable?.key,
        optionKey: sickCare(usable)?.key,
        templateId: 'way-sick-care',
        before: [],
        after: ['res-sick-care'],
      },
    ]);
    expect(await f.edit(withUse(await f.household(), 'notUsed'))).toMatchObject({ status: 'ok' });
    const excluded = await f.arrangement();
    expect(sickCare(excluded)?.unusedResources).toEqual(['res-sick-care']);
    expect(excluded?.recommendedOptionKey).toBe(grandma(excluded)?.key);
    // 使うに戻すと、印が消える（見る口に出る）。
    const restored = await f.preview(withUse(await f.household(), 'candidate'));
    expect(restored.changes.unusedResources[0]).toMatchObject({
      before: ['res-sick-care'],
      after: [],
    });

    // 病児保育だけを選んだ「すること」：勧めないが、選べる手は残る（できないとは言わない）。
    const g = formal();
    await g.edit(withUse(withState(await g.household(), 'done'), 'notUsed'));
    await g.need(watch('c'), ['way-sick-care']);
    const only = await g.arrangement();
    expect(only?.status).toBe('decidable');
    expect(only?.recommendedOptionKey).toBeUndefined();
    expect(only?.reasons.map((r) => r.code)).not.toContain('noOptionLeft');
    expect(sickCare(only)?.unusedResources).toEqual(['res-sick-care']);
  });
});
