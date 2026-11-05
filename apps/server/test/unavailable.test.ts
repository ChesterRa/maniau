// 手が離せない時間を、家の情報の直し（見る → 見た物で書く）で記録する。いつにするかの候補と重なれば、計画に事実として
// 出し（答えと数えは変えない）、保存の前の「この変更で変わること」にも書く。
import type { Household, PlanResult } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewHousehold } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = '2026-12-06T10:00+09:00';
const CLUB = 'req:need:f-demo-club:i1';
const KENTA = { id: 'u-kenta', memberId: 'a', date: '2026-12-19', start: '09:30', end: '10:30' };

async function setup() {
  const store = memoryStore(new Map([['demo', demoEvents('club')]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  const household = async (): Promise<Household> => {
    const current = foldEvents(await events()).household;
    if (!current) throw new Error('家族の情報が無い');
    return structuredClone(current);
  };
  let sequence = 0;
  const run = (command: Parameters<typeof runCommand>[3]) =>
    runCommand(
      store,
      'demo',
      { memberId: 'a', now: NOW, operationId: `busy-${++sequence}`, demo: true },
      command,
    );
  const preview = async (edited: Household) =>
    previewHousehold(await events(), { memberId: 'a', now: NOW }, edited);
  /** 見てから、見た物で書く。 */
  const save = async (edited: Household) => {
    const shown = await preview(edited);
    if ('reason' in shown) throw new Error(shown.reason);
    const { throughSeq } = computePlan(await events(), NOW);
    const result = await run({
      type: 'updateHousehold',
      household: edited,
      seen: { throughSeq, changes: shown.seen },
    });
    return { shown, result };
  };
  const plan = async () => computePlan(await events(), NOW);
  return { household, preview, save, plan, run };
}

const when = (plan: PlanResult) => plan.requirements.find((r) => r.key === CLUB)?.when;

describe('手が離せない時間を記録する', () => {
  it('候補と重なる事実を、保存の前に見せ、書いた後は計画に出す。答えと数えは変えない（この例では勧めも同じ）', async () => {
    const app = await setup();
    const before = when(await app.plan());
    expect(before?.candidates.some((c) => c.unavailable !== undefined)).toBe(false);
    const { shown, result } = await app.save({ ...(await app.household()), unavailable: [KENTA] });
    expect(result).toMatchObject({ status: 'ok' });
    expect(shown.changes.overlaps).toEqual([
      {
        requirementKey: CLUB,
        what: expect.any(String),
        candidateId: 'c2',
        candidate: { start: '2026-12-19T09:00+09:00', end: '2026-12-19T12:00+09:00' },
        personId: 'a',
        unavailableId: 'u-kenta',
        busy: { start: '2026-12-19T09:30+09:00', end: '2026-12-19T10:30+09:00' },
        change: 'added',
      },
    ]);
    const after = when(await app.plan());
    expect(after?.candidates.find((c) => c.id === 'c2')?.unavailable).toEqual([
      {
        personId: 'a',
        unavailableId: 'u-kenta',
        start: '2026-12-19T09:30+09:00',
        end: '2026-12-19T10:30+09:00',
      },
    ]);
    expect(after?.candidates.find((c) => c.id === 'c1')?.unavailable).toBeUndefined();
    const counts = (w: typeof after) =>
      w?.candidates.map((c) => [c.id, c.yes, c.possible, c.condition]);
    expect(counts(after)).toEqual(counts(before));
    expect(after?.answers).toEqual(before?.answers);
    expect(after?.recommended).toEqual(before?.recommended);
  });

  it('外せば、重ならなくなると見せ、計画からも消える（記録しない物は戻らない）', async () => {
    const app = await setup();
    await app.save({ ...(await app.household()), unavailable: [KENTA] });
    const { shown, result } = await app.save({ ...(await app.household()), unavailable: [] });
    expect(result).toMatchObject({ status: 'ok' });
    expect(shown.changes.overlaps?.map((o) => [o.candidateId, o.change])).toEqual([
      ['c2', 'removed'],
    ]);
    expect(when(await app.plan())?.candidates.some((c) => c.unavailable !== undefined)).toBe(false);
  });

  it('子ども・頼める人・重なる時間・始まりが終わりより後の物は受けない', async () => {
    const app = await setup();
    const h = await app.household();
    for (const unavailable of [
      [{ ...KENTA, memberId: 'c' }],
      [{ ...KENTA, memberId: 'g' }],
      [KENTA, { ...KENTA, id: 'u-2', start: '10:00', end: '11:00' }],
      [{ ...KENTA, start: '11:00', end: '10:00' }],
    ]) {
      expect(await app.preview({ ...h, unavailable })).toMatchObject({
        status: 'invalid',
        reason: 'householdInvalid',
      });
    }
  });
});
