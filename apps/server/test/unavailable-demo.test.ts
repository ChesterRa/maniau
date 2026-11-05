// デモの段「busy」（club の後に、健太の手が離せない時間を足しただけ）と、前の段で画面から試せること（段の案内に
// 書いた時刻を、ここで固定する）。
import type { PlanResult } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { DEMO_STAGES, demoEvents } from '../src/demo';
import { previewHousehold } from '../src/preview';

const CLUB = 'req:need:f-demo-club:i1';
const when = (plan: PlanResult) => plan.requirements.find((r) => r.key === CLUB)?.when;

describe('デモの段「busy」と、前の段で試せること', () => {
  const nowOf = (id: string) => DEMO_STAGES.find((s) => s.id === id)?.now ?? '';

  it('club の事象をそのまま前に持ち、健太の手が離せない時間を足しただけ。12/19 の候補に重なりが出て、答えと数えは同じ', () => {
    const club = demoEvents('club');
    const busy = demoEvents('busy');
    expect(busy.slice(0, club.length)).toEqual(club);
    expect(busy.slice(club.length).map((e) => e.type)).toEqual(['householdSet']);
    const before = when(computePlan(club, nowOf('busy')));
    const after = when(computePlan(busy, nowOf('busy')));
    expect(after?.candidates.find((c) => c.id === 'c2')?.unavailable).toEqual([
      {
        personId: 'a',
        unavailableId: 'u-demo-meeting',
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

  it('「11/26 帰りの買い物」の段で、健太の 11/26 18:30–19:30 を足して見ると、シャツを買う作業が 11/27 19:05 に動く', async () => {
    const events = demoEvents('asked');
    const current = foldEvents(events).household;
    if (!current) throw new Error('家族の情報が無い');
    const shown = await previewHousehold(
      events,
      { memberId: 'a', now: nowOf('asked') },
      {
        ...structuredClone(current),
        unavailable: [
          { id: 'u-1', memberId: 'a', date: '2026-11-26', start: '18:30', end: '19:30' },
        ],
      },
    );
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.moved).toEqual([
      {
        taskKey: 'task:opt:arr:purchase:n1:i5:buy:buy',
        before: { start: '2026-11-26T18:55+09:00', end: '2026-11-26T19:10+09:00' },
        after: { start: '2026-11-27T19:05+09:00', end: '2026-11-27T19:20+09:00' },
      },
    ]);
    expect(shown.changes.reconfirm).toEqual([]);
  });
});
