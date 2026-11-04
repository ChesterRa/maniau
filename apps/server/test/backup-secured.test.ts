// 確保できた予備（02-foundation の予備・断られた時）：予備の手順が全部済み、外の相手の受け付けが今の日の分として
// あれば、次の予備は勧めない。決め時（申し込みの締切）が過ぎていても、その前に済ませて受け付けられた予備は確保
// できている。引き受けただけ・返事待ち・確かめ待ち・取り消し・別の日の受け付けは、確保と言わない。架空のデモの家。
import { type PlanResult, securedBackup } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { demoEvents } from '../src/demo';
import { viewFor } from '../src/views';

const care = 'arr:childCare:n1:i6:c';
const gakudo = `opt:${care}:opt-gakudo`;
const DEC1 = '2026-12-01T18:10+09:00';

function at(events: ReturnType<typeof demoEvents>, now: string) {
  const view = viewFor(events, 'b', now);
  const arrangement = view.plan.arrangements.find((a) => a.key === care);
  if (!arrangement) throw new Error('手配が無い');
  return { view, plan: view.plan, arrangement };
}

/** 計画の写しで、作業・依頼を一つだけ替える（判定の境を一つずつ試す）。 */
function edited(plan: PlanResult, change: (p: PlanResult) => void): PlanResult {
  const copy = structuredClone(plan);
  change(copy);
  return copy;
}

describe('確保できた予備', () => {
  it('学童を予備に押さえ、書いて出し、受け付けられた後は、決め時が過ぎても確保できていて、次の予備を勧めない', () => {
    const { view, plan, arrangement } = at(demoEvents('backup'), DEC1);
    const option = arrangement.options.find((o) => o.key === gakudo);
    expect(option?.expired).toBe(true);
    expect(securedBackup(plan, arrangement)?.key).toBe(gakudo);
    expect(view.today.main.map((c) => c.kind)).not.toContain('backup');
  });

  it('学童の受け付けがまだなら確保とは言わず、次の予備の決め時が近ければ勧める', () => {
    const events = demoEvents('backup');
    expect(events.at(-1)?.type).toBe('externalReplyRecorded');
    const { view, plan, arrangement } = at(events.slice(0, -1), DEC1);
    expect(securedBackup(plan, arrangement)).toBeUndefined();
    expect(view.today.main.map((c) => c.kind)).toContain('backup');
  });

  it('引き受けただけの手順・確かめ待ち・取り消し・別の日の受け付けは、確保と言わない', () => {
    const { plan, arrangement } = at(demoEvents('backup'), DEC1);
    const write = plan.tasks.find((t) => t.key.endsWith('opt-gakudo:write'));
    const submit = plan.tasks.find((t) => t.key.endsWith('opt-gakudo:submit'));
    expect(write?.external).toBeUndefined();
    expect(submit?.external).toBeDefined();
    const request = (p: PlanResult) => {
      const found = p.requests.find((r) => r.taskKey === submit?.key);
      if (!found) throw new Error('学童への依頼が無い');
      return found;
    };
    const accepted = edited(plan, (p) => {
      const task = p.tasks.find((t) => t.key === write?.key);
      if (task) task.commitment = 'accepted';
    });
    expect(securedBackup(accepted, arrangement)).toBeUndefined();
    const needsCheck = edited(plan, (p) => {
      request(p).needsCheck = true;
    });
    expect(securedBackup(needsCheck, arrangement)).toBeUndefined();
    const cancelled = edited(plan, (p) => {
      request(p).state = 'cancelled';
    });
    expect(securedBackup(cancelled, arrangement)).toBeUndefined();
    const otherDay = edited(plan, (p) => {
      const r = request(p);
      if (!r.window) throw new Error('依頼の控えに時間が無い');
      r.window = { ...r.window, start: '2026-12-08T08:10+09:00' };
    });
    expect(securedBackup(otherDay, arrangement)).toBeUndefined();
  });

  it('通用の「すること」の窓は判定しない（承認が済んでも、だれかが受け持つとは限らない）', () => {
    const { plan, arrangement } = at(demoEvents('backup'), DEC1);
    // 同じ手順・同じ受け付けのまま、手配の種類だけを「すること」にする。
    expect(securedBackup(plan, { ...arrangement, kind: 'need' })).toBeUndefined();
  });
});
