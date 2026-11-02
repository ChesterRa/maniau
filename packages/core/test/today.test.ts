// 「きょう」の画面に、誰に何を出すか。
import { describe, expect, it } from 'vitest';
import { todayCards } from '../src';
import { computePlan } from '../src/engine';
import { extraction2, notice2, noticeArrived } from './fixtures/demo';

const CARE = 'arr:childCare:i4:c';
const opt = (template: string) => `opt:${CARE}:${template}`;
const ask = `task:${opt('opt-grandma')}:ask`;
const kinds = (cards: { kind: string }[]) => cards.map((c) => c.kind);

const asked = () =>
  noticeArrived()
    .add('answered', '2026-11-25T19:35+09:00', 'b', { unknownId: 'u-atHome:i3', value: 'no' })
    .add('optionChosen', '2026-11-25T19:36+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-grandma'),
      role: 'primary',
    })
    .add('assignmentProposed', '2026-11-25T19:36+09:00', 'b', { taskKey: ask, assigneeId: 'b' })
    .add('commitmentChanged', '2026-11-25T19:37+09:00', 'b', {
      taskKey: ask,
      assigneeId: 'b',
      action: 'accept',
    })
    .add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
      taskKey: ask,
      requestId: 'r-grandma',
    });

describe('きょうの画面', () => {
  it('届いた夜：決める事と、シャツの問いを、二人の大人に出す。比べる候補の作業は出さない', () => {
    const plan = computePlan(noticeArrived().events, '2026-11-25T19:31+09:00');
    for (const member of ['a', 'b']) {
      const { main, quiet } = todayCards(plan, member);
      expect(kinds(main)).toEqual(['decide', 'question']);
      expect(quiet).toEqual([]);
    }
    const decide = todayCards(plan, 'b').main[0];
    expect(decide?.kind === 'decide' && decide.recommended?.key).toBe(opt('opt-gakudo'));
  });

  it('祖母に頼んだ後：頼んだ彩には返事待ち、健太には帰りの買い物を頼む', () => {
    const plan = computePlan(asked().events, '2026-11-26T12:10+09:00');
    const b = todayCards(plan, 'b');
    expect(kinds(b.main)).toEqual([]);
    expect(kinds(b.quiet)).toEqual(['waiting']);
    const a = todayCards(plan, 'a');
    expect(kinds(a.main)).toEqual(['proposal']);
    expect(a.main[0]?.kind === 'proposal' && a.main[0].task.titleKey).toBe('task.buy');
  });

  it('学童の決め時の前の晩：返事を待つ彩にだけ、予備を押さえるかを出す', () => {
    const plan = computePlan(asked().events, '2026-11-29T21:00+09:00');
    const b = todayCards(plan, 'b');
    expect(kinds(b.main)).toContain('backup');
    const backup = b.main.find((c) => c.kind === 'backup');
    expect(backup?.kind === 'backup' && backup.option.key).toBe(opt('opt-gakudo'));
    expect(kinds(todayCards(plan, 'a').main)).not.toContain('backup');
  });

  it('予備の当日の準備（学童の日の弁当）は、本命が生きている間は出さず、本命が断られたら出す', () => {
    const bento = `task:${opt('opt-gakudo')}:bento-shop`;
    const write = `task:${opt('opt-gakudo')}:write`;
    const log = asked()
      .add('optionChosen', '2026-11-29T21:05+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-gakudo'),
        role: 'backup',
      })
      .add('assignmentProposed', '2026-11-29T21:06+09:00', 'b', { taskKey: bento, assigneeId: 'a' })
      .add('assignmentProposed', '2026-11-29T21:06+09:00', 'b', {
        taskKey: write,
        assigneeId: 'a',
      });
    const proposals = (at: string) =>
      todayCards(computePlan(log.events, at), 'a')
        .main.filter((c) => c.kind === 'proposal')
        .map((c) => (c.kind === 'proposal' ? c.task.key : ''));
    const waiting = proposals('2026-11-29T21:10+09:00');
    expect(waiting).toContain(write);
    expect(waiting).not.toContain(bento);

    log.add('externalReplyRecorded', '2026-11-30T08:00+09:00', 'b', {
      requestId: 'r-grandma',
      reply: 'no',
    });
    expect(
      computePlan(log.events, '2026-11-30T08:01+09:00').arrangements.find((a) => a.key === CARE)
        ?.inUseOptionKey,
    ).toBe(opt('opt-gakudo'));
    expect(proposals('2026-11-30T08:01+09:00')).toContain(bento);
  });

  it('自分で持った予備の作業を断ったら、担当のいない作業として二人に出す（誰かが持つまで）', () => {
    const write = `task:${opt('opt-gakudo')}:write`;
    const submit = `task:${opt('opt-gakudo')}:submit`;
    const log = asked().add('optionChosen', '2026-11-29T21:05+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-gakudo'),
      role: 'backup',
    });
    for (const taskKey of [write, submit]) {
      log
        .add('assignmentProposed', '2026-11-29T21:06+09:00', 'b', { taskKey, assigneeId: 'b' })
        .add('commitmentChanged', '2026-11-29T21:07+09:00', 'b', {
          taskKey,
          assigneeId: 'b',
          action: 'decline',
        });
    }
    const plan = computePlan(log.events, '2026-11-29T21:10+09:00');
    for (const member of ['a', 'b']) {
      const unowned = todayCards(plan, member).main.filter((c) => c.kind === 'unowned');
      expect(unowned.map((c) => (c.kind === 'unowned' ? c.task.key : ''))).toEqual([write, submit]);
    }
    // 健太が持つと、健太への提案になり、担当のいない作業ではなくなる。
    log.add('assignmentProposed', '2026-11-29T21:12+09:00', 'b', {
      taskKey: write,
      assigneeId: 'a',
    });
    const after = computePlan(log.events, '2026-11-29T21:13+09:00');
    expect(kinds(todayCards(after, 'a').main)).toEqual(['unowned', 'proposal']);
    // 決め時を過ぎて、まだ始めていない案の作業は、もう出さない。
    const late = computePlan(log.events, '2026-12-02T09:00+09:00');
    expect(kinds(todayCards(late, 'b').main)).not.toContain('unowned');
    // 始めた案（申込書を書き終えた）の残りの手順は、決め時の後も出す。
    log
      .add('commitmentChanged', '2026-11-29T21:14+09:00', 'a', {
        taskKey: write,
        assigneeId: 'a',
        action: 'accept',
      })
      .add('commitmentChanged', '2026-11-29T21:15+09:00', 'a', {
        taskKey: write,
        assigneeId: 'a',
        action: 'done',
      });
    // 祖母に送っていなかったと直しただけ（本命は決まっていない）なら、予備は持てるまま。
    const unsent = asked()
      .add('optionChosen', '2026-11-29T21:05+09:00', 'b', {
        arrangementKey: CARE,
        optionKey: opt('opt-gakudo'),
        role: 'backup',
      })
      .add('requestRecordCorrected', '2026-11-29T21:30+09:00', 'b', { requestId: 'r-grandma' });
    const stillShown = todayCards(computePlan(unsent.events, '2026-11-29T21:31+09:00'), 'a').main;
    expect(
      stillShown.map((c) => (c.kind === 'proposal' || c.kind === 'unowned' ? c.task.key : '')),
    ).toContain(write);
    // 本命（祖母）が引き受けたら、予備の残りは、もう誰にも持たせない。
    const settled = asked().add('optionChosen', '2026-11-29T21:05+09:00', 'b', {
      arrangementKey: CARE,
      optionKey: opt('opt-gakudo'),
      role: 'backup',
    });
    settled.add('externalReplyRecorded', '2026-11-29T22:00+09:00', 'b', {
      requestId: 'r-grandma',
      reply: 'yes',
    });
    for (const member of ['a', 'b']) {
      const cards = todayCards(computePlan(settled.events, '2026-11-29T22:01+09:00'), member);
      expect(kinds(cards.main)).not.toContain('unowned');
    }
    const begun = todayCards(computePlan(log.events, '2026-12-02T09:00+09:00'), 'a');
    expect(
      begun.main.filter((c) => c.kind === 'unowned').map((c) => c.kind === 'unowned' && c.task.key),
    ).toEqual([submit]);
  });

  it('延期の連絡の後：頼んだ人に取り消しを出し、決める事は出さない。シャツはまだ要る', () => {
    const log = asked()
      .add('noticeReceived', '2026-12-04T17:52+09:00', 'b', { source: notice2 })
      .add('modelOutputRecorded', '2026-12-04T17:52+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n2',
        sourceId: 'n2',
        output: extraction2,
      });
    const plan = computePlan(log.events, '2026-12-04T18:10+09:00');
    const b = todayCards(plan, 'b');
    expect(kinds(b.main)).toEqual(['cancel', 'proposal']);
    expect(b.main[0]?.kind === 'cancel' && b.main[0].request.requestId).toBe('r-grandma');
    expect(b.main[1]?.kind === 'proposal' && b.main[1].task.titleKey).toBe('task.buy');
    expect(kinds(b.quiet)).toEqual([]);
  });
});
