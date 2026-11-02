// 変わったこと：後から届いたお知らせで、前から用意していた物のうち、要らなくなった物と日が変わった物を、
// それで要る取り消し（誰が伝えるか・伝えたか）と一緒にまとめる。
import { describe, expect, it } from 'vitest';
import { computePlan, requestSnapshot } from '../src/engine';
import { changeOpen, changeSummary } from '../src/view/changes';
import { type EventLog, extraction2, notice2, noticeArrived } from './fixtures/demo';

const CARE = 'arr:childCare:i4:c';
const GRANDMA = `opt:${CARE}:opt-grandma`;
const ASK = `task:${GRANDMA}:ask`;
const AT = '2026-12-04T18:10+09:00';
const N2 = { id: 'n2', receivedAt: notice2.receivedAt };

/** 祖母に頼んで、送ったと記録した所まで。 */
function asked(): EventLog {
  const log = noticeArrived()
    .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
    })
    .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: ASK, assigneeId: 'b' })
    .add('commitmentChanged', '2026-11-25T19:37+09:00', 'b', {
      taskKey: ASK,
      assigneeId: 'b',
      action: 'accept',
    });
  return log.add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
    taskKey: ASK,
    requestId: 'r-grandma',
    snapshot: requestSnapshot(log.events, '2026-11-25T19:39+09:00', ASK),
  });
}

/** 延期のお知らせ（12/7 は通常授業になり、発表会は 12/8）。 */
function postponed(log: EventLog): EventLog {
  return log
    .add('noticeReceived', '2026-12-04T17:52+09:00', 'b', { source: notice2 })
    .add('modelOutputRecorded', '2026-12-04T17:53+09:00', 'system', {
      call: 'extract',
      model: 'hand-written',
      promptVersion: 'fixture',
      inputHash: 'fixture-n2',
      sourceId: 'n2',
      output: extraction2,
    });
}

describe('変わったこと', () => {
  it('延期：預け先は要らなくなり、頼んでいた祖母への取り消しが要る。シャツは期限が変わる', () => {
    const log = asked();
    const before = computePlan([...log.events], AT);
    const after = computePlan(postponed(log).events, AT);
    const summary = changeSummary(before, after, N2);
    expect(summary?.sourceId).toBe('n2');
    expect(summary?.gone.map((g) => [g.before.kind, g.before.date, g.after])).toEqual([
      ['childCare', '2026-12-07', undefined],
    ]);
    expect(summary?.gone[0]?.undo.map((u) => [u.request.requestId, u.assigneeId, u.done])).toEqual([
      ['r-grandma', 'b', false],
    ]);
    expect(summary?.moved.map((m) => [m.before.kind, m.before.what])).toEqual([
      ['belongings', '白い長袖シャツ'],
    ]);
    const shirt = summary?.moved[0];
    expect(shirt?.before.by).not.toBe(shirt?.after?.by);
    expect(shirt?.undo).toEqual([]);
    // 伝えていない取り消しが残る間は、見せ続ける。
    expect(summary && changeOpen(summary, '2026-12-09T09:00+09:00')).toBe(true);
  });

  it('取り消しを伝えたと記録すれば済みになり、届いてから一日たてば見せない', () => {
    const log = asked();
    const before = computePlan([...log.events], AT);
    postponed(log).add('cancellationSent', '2026-12-04T18:20+09:00', 'b', {
      requestId: 'r-grandma',
    });
    const after = computePlan(log.events, '2026-12-04T18:30+09:00');
    const summary = changeSummary(before, after, N2);
    expect(summary?.gone[0]?.undo.map((u) => [u.assigneeId, u.done])).toEqual([['b', true]]);
    expect(summary && changeOpen(summary, '2026-12-05T17:00+09:00')).toBe(true);
    expect(summary && changeOpen(summary, '2026-12-05T17:53+09:00')).toBe(false);
  });

  it('最初のお知らせ（新しく要る物だけ）では、まとめない', () => {
    const log = noticeArrived();
    const before = computePlan(log.events.slice(0, 1), AT);
    const after = computePlan(log.events, AT);
    expect(changeSummary(before, after, { id: 'n1', receivedAt: '2026-11-25T19:30+09:00' })).toBe(
      undefined,
    );
  });
});
