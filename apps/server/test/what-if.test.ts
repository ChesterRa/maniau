// 「断られたら？」（W5）：返事を待っている頼み事を、断られたと仮に置いて計算する。何も書かず（事象・返事・
// 送信）、その依頼の手配の仮定の後の姿（予備に進むか・選び直しか、残る手と決め時）を返す。架空のデモの家で確かめる。
import type { Arrangement, HouseholdPreview, PlanResult } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { DEMO_STAGES, demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';

const CARE = 'arr:childCare:n1:i6:c';
const option = (name: string) => `opt:${CARE}:${name}`;
const nowOf = (stage: string) => DEMO_STAGES.find((s) => s.id === stage)?.now ?? '';
const no = { type: 'recordReply', requestId: 'r-grandma', reply: 'no' } as const;

function whatIf(stage: 'asked' | 'backup') {
  const events = demoEvents(stage);
  const before = structuredClone(events);
  const shown = previewChange(events, { memberId: 'b', now: nowOf(stage) }, no);
  if ('reason' in shown) throw new Error(`計算できない：${shown.reason}`);
  return { events, before, shown };
}

describe('断られたら？（返事の仮定）', () => {
  it('祖母の返事待ちで断られたら、選び直しになり、学童を勧める。何も書かない', () => {
    const { events, before, shown } = whatIf('asked');
    expect(events).toEqual(before);
    const real = computePlan(events, nowOf('asked'));
    expect(real.requests.find((r) => r.requestId === 'r-grandma')?.state).toBe('awaitingReply');
    expect(real.arrangements.find((a) => a.key === CARE)?.inUseOptionKey).toBe(
      option('opt-grandma'),
    );
    const after = shown.arrangement as Arrangement;
    expect(after.key).toBe(CARE);
    expect(after.inUseOptionKey).toBeUndefined();
    expect(after.reasons).toContainEqual({ code: 'turnedDown', refs: ['r-grandma'] });
    expect(after.recommendedOptionKey).toBe(option('opt-gakudo'));
    // 残る手と決め時は、今の計画と同じ計算の物（断られても、ほかの手の決め時は動かない）。
    const gakudo = after.options.find((o) => o.key === option('opt-gakudo'));
    expect(gakudo).toMatchObject({ decisionDeadline: '2026-11-30T17:20+09:00', expired: false });
    expect(shown.issues).toEqual([]);
  });

  it('予備を押さえた後なら、予備の学童に進み、当日の弁当の作業が増える', () => {
    const { shown } = whatIf('backup');
    expect(shown.arrangement?.inUseOptionKey).toBe(option('opt-gakudo'));
    expect(shown.changes.added.map((s) => s.titleKey)).toEqual([
      'task.bento.shop',
      'task.bento.make',
    ]);
  });

  it('家と暮らしの情報の直しなどでは、手配の姿を返さない（今までどおり）', () => {
    const events = demoEvents('asked');
    const household = events.find((e) => e.type === 'householdSet');
    if (household?.type !== 'householdSet') throw new Error('家が無い');
    const shown = previewChange(
      events,
      { memberId: 'b', now: nowOf('asked') },
      { type: 'updateHousehold', household: household.household },
    );
    expect('reason' in shown ? shown.reason : shown.arrangement).toBeUndefined();
  });

  it('デモの見る口で計算でき、そのあとの計画は変わらない', async () => {
    const app = createApp({});
    const json = (body: unknown) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const made = await app.request('/api/demo/sessions', json({ stage: 'asked' }));
    const { sessionId } = (await made.json()) as { sessionId: string };
    const view = async () =>
      (
        (await (await app.request(`/api/demo/sessions/${sessionId}/view?member=b`)).json()) as {
          plan: PlanResult;
        }
      ).plan;
    const plan = await view();
    const response = await app.request(
      `/api/demo/sessions/${sessionId}/change-preview`,
      json({ memberId: 'b', command: no }),
    );
    expect(response.status).toBe(200);
    const { preview } = (await response.json()) as { preview: HouseholdPreview };
    expect(preview.arrangement?.reasons).toContainEqual({
      code: 'turnedDown',
      refs: ['r-grandma'],
    });
    const later = await view();
    expect(later.throughSeq).toBe(plan.throughSeq);
    expect(later.requests.find((r) => r.requestId === 'r-grandma')?.state).toBe('awaitingReply');
  });
});
