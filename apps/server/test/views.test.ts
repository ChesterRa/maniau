// 見せる物：後から届いたお知らせで変わったことを、二人の大人に同じ物として添える。
import { describe, expect, it } from 'vitest';
import { DEMO_STAGES, type DemoStageId, demoEvents } from '../src/demo';
import { viewFor } from '../src/views';

const nowOf = (stage: DemoStageId) => {
  const found = DEMO_STAGES.find((s) => s.id === stage);
  if (!found) throw new Error(stage);
  return found.now;
};

describe('変わったこと', () => {
  it('延期のお知らせの後：要らなくなった預け先と、二人それぞれの取り消し、期限の変わったシャツ', () => {
    const events = demoEvents('postponed');
    for (const member of ['a', 'b']) {
      const view = viewFor(events, member, nowOf('postponed'));
      expect(view.changes?.sourceId, member).toBe('n2');
      expect(view.changes?.gone.map((g) => [g.before.kind, g.before.date])).toEqual([
        ['childCare', '2026-12-07'],
      ]);
      const undo = view.changes?.gone[0]?.undo.map((u) => [u.request.requestId, u.assigneeId]);
      expect(undo?.sort()).toEqual([
        ['r-gakudo', 'a'],
        ['r-grandma', 'b'],
      ]);
      expect(view.changes?.gone[0]?.undo.every((u) => !u.done)).toBe(true);
      // シャツは要るまま、期限だけ変わった（もう買ってある）。
      expect(view.changes?.moved.map((m) => [m.before.what, m.ready])).toEqual([
        ['白い長袖シャツ', true],
      ]);
    }
  });

  it('延期の前（最初のお知らせだけ）の段では出さない', () => {
    for (const stage of ['arrived', 'asked', 'chase', 'backup'] as const) {
      expect(viewFor(demoEvents(stage), 'b', nowOf(stage)).changes, stage).toBeUndefined();
    }
  });
});
