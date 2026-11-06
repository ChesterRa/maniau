// 返事待ちを追う：子の居場所の頼み事の返事が、頼んだ時間の始まりの 26 時間前になっても記録されていなければ、送った
// 本人の「今やること」に上げ、一度だけ知らせる（名前を入れない）。予備の札が同じ返事を追う間と、確保できた予備が
// ある間は上げない。
import { describe, expect, it } from 'vitest';
import {
  type DomainEvent,
  notificationHistory,
  notificationIntents,
  type PlanResult,
  todayCards,
} from '../src';
import { computePlan, requestSnapshot } from '../src/engine';
import { household, noticeArrived } from './fixtures/demo';

const CARE = 'arr:childCare:i4:c';
const opt = (template: string) => `opt:${CARE}:${template}`;
const ask = `task:${opt('opt-grandma')}:ask`;
const write = `task:${opt('opt-gakudo')}:write`;
const submit = `task:${opt('opt-gakudo')}:submit`;
const kinds = (cards: { kind: string }[]) => cards.map((c) => c.kind);
/** 頼んだ時間（送った時の控え）は 12/7 8:10–18:15。上げ始めるのは、その 26 時間前の 12/6 6:10。 */
const START = '2026-12-07T08:10+09:00';

const chosen = () =>
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
    });

/** 彩が祖母に頼み、送った時の控えを残した（画面の「送ったことを記録」と同じ）。 */
const sent = (at = '2026-11-25T19:40+09:00') => {
  const log = chosen();
  return log.add('externalRequestSent', at, 'b', {
    taskKey: ask,
    requestId: 'r-grandma',
    snapshot: requestSnapshot(log.events, at, ask),
  });
};

const cardsAt = (events: readonly DomainEvent[], at: string, member = 'b') =>
  todayCards(computePlan(events, at), member);
const raised = (cards: ReturnType<typeof todayCards>) =>
  cards.main.flatMap((c) => (c.kind === 'noReply' ? [c.request.requestId] : []));
const waitingRows = (cards: ReturnType<typeof todayCards>) =>
  cards.quiet.flatMap((c) => (c.kind === 'waiting' ? [c.request.requestId] : []));
const intentsAt = (events: readonly DomainEvent[], at: string) =>
  notificationIntents(computePlan(events, at), household, notificationHistory(events)).filter(
    (i) => i.titleKey === 'notify.noReply',
  );

describe('返事待ちを追う札', () => {
  it('頼んだ時間の始まりの 26 時間前から、送った本人にだけ上げ、頼んだことに二度並べない', () => {
    const events = sent().events;
    const before = cardsAt(events, '2026-12-06T06:09+09:00');
    expect(raised(before)).toEqual([]);
    expect(waitingRows(before)).toEqual(['r-grandma']);
    const from = cardsAt(events, '2026-12-06T06:10+09:00');
    expect(raised(from)).toEqual(['r-grandma']);
    expect(waitingRows(from)).toEqual([]);
    const card = from.main.find((c) => c.kind === 'noReply');
    expect(card?.kind === 'noReply' && card.arrangement.key).toBe(CARE);
    expect(raised(cardsAt(events, '2026-12-06T06:10+09:00', 'a'))).toEqual([]);
  });

  it('頼んだ時間が終わるまで残し、終われば頼んだことの行に戻す（隠さない）', () => {
    const events = sent().events;
    expect(raised(cardsAt(events, START))).toEqual(['r-grandma']);
    expect(raised(cardsAt(events, '2026-12-07T18:14+09:00'))).toEqual(['r-grandma']);
    const after = cardsAt(events, '2026-12-07T18:15+09:00');
    expect(raised(after)).toEqual([]);
    expect(waitingRows(after)).toEqual(['r-grandma']);
  });

  it('返事（OK・断られた）や押し間違いの訂正を記録したら、すぐ消える', () => {
    for (const add of [
      (log: ReturnType<typeof sent>) =>
        log.add('externalReplyRecorded', '2026-12-06T09:00+09:00', 'b', {
          requestId: 'r-grandma',
          reply: 'yes',
        }),
      (log: ReturnType<typeof sent>) =>
        log.add('externalReplyRecorded', '2026-12-06T09:00+09:00', 'b', {
          requestId: 'r-grandma',
          reply: 'no',
        }),
      (log: ReturnType<typeof sent>) =>
        log.add('requestRecordCorrected', '2026-12-06T09:00+09:00', 'b', {
          requestId: 'r-grandma',
        }),
    ]) {
      const cards = cardsAt(add(sent()).events, '2026-12-06T09:01+09:00');
      expect(raised(cards)).toEqual([]);
      expect(waitingRows(cards)).toEqual([]);
    }
  });

  it('確保できた予備（学童の申込みに「はい」）があれば上げない', () => {
    const log = sent().add('optionChosen', '2026-11-29T21:05+09:00', 'b', {
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
          action: 'accept',
        })
        .add('commitmentChanged', '2026-11-30T08:00+09:00', 'b', {
          taskKey,
          assigneeId: 'b',
          action: 'done',
        });
    }
    log.add('externalRequestSent', '2026-11-30T08:00+09:00', 'b', {
      taskKey: submit,
      requestId: 'r-gakudo',
      snapshot: requestSnapshot(log.events, '2026-11-30T08:00+09:00', submit),
    });
    // 学童の返事がまだなら、予備は確保できていないので上げる。
    expect(raised(cardsAt(log.events, '2026-12-06T08:10+09:00'))).toEqual(['r-grandma']);
    log.add('externalReplyRecorded', '2026-11-30T18:00+09:00', 'b', {
      requestId: 'r-gakudo',
      reply: 'yes',
    });
    const cards = cardsAt(log.events, '2026-12-06T08:10+09:00');
    expect(raised(cards)).toEqual([]);
    expect(waitingRows(cards)).toContain('r-grandma');
  });

  it('予備を押さえるかの札が同じ返事を追う間（次の手の決め時が 26 時間以内）は上げない', () => {
    const plan = computePlan(sent().events, '2026-12-06T08:10+09:00');
    const care = plan.arrangements.find((a) => a.key === CARE);
    const template = care?.options.find((o) => o.key !== care.chosenOptionKey);
    if (!care || !template) throw new Error('fixture');
    // 当日の朝まで頼める次の手がある（決め時が 26 時間以内）と置く。
    const next = { ...template, key: 'opt:late', expired: false, decisionDeadline: START };
    const withNext: PlanResult = {
      ...plan,
      arrangements: plan.arrangements.map((a) =>
        a.key === CARE ? { ...a, options: [...a.options, next] } : a,
      ),
    };
    const cards = todayCards(withNext, 'b');
    expect(kinds(cards.main)).toContain('backup');
    expect(raised(cards)).toEqual([]);
    expect(waitingRows(cards)).toEqual(['r-grandma']);
  });

  it('確かめの要る頼み事・返事を待っていない手配には上げない', () => {
    const plan = computePlan(sent().events, '2026-12-06T08:10+09:00');
    const check: PlanResult = {
      ...plan,
      requests: plan.requests.map((r) => ({ ...r, needsCheck: true })),
    };
    expect(kinds(todayCards(check, 'b').main)).toContain('check');
    expect(raised(todayCards(check, 'b'))).toEqual([]);
    const decided: PlanResult = {
      ...plan,
      arrangements: plan.arrangements.map((a) =>
        a.key === CARE ? { ...a, status: 'decidable', reasons: [] } : a,
      ),
    };
    expect(raised(todayCards(decided, 'b'))).toEqual([]);
    // 控えの窓が無い古い記録は、上げない（いつまで待つかを言えない）。
    expect(
      raised(
        cardsAt(
          chosen().add('externalRequestSent', '2026-11-25T19:40+09:00', 'b', {
            taskKey: ask,
            requestId: 'r-grandma',
          }).events,
          '2026-12-06T08:10+09:00',
        ),
      ),
    ).toEqual([]);
  });
});

describe('返事待ちを追う知らせ', () => {
  it('上げた時に、送った本人へ一度。期限は頼んだ時間の始まり、キーと文に名前を入れない', () => {
    const events = sent().events;
    expect(intentsAt(events, '2026-12-06T06:09+09:00')).toEqual([]);
    expect(intentsAt(events, '2026-12-06T06:10+09:00')).toEqual([
      {
        key: 'noReply:r-grandma:b',
        toMemberId: 'b',
        subject: { type: 'request', id: 'r-grandma' },
        kind: 'decisionApproaching',
        titleKey: 'notify.noReply',
        until: START,
      },
    ]);
    // 頼んだ時間が始まったら、もう知らせない（札は終わりまで残る）。
    expect(intentsAt(events, START)).toEqual([]);
    expect(raised(cardsAt(events, START))).toEqual(['r-grandma']);
  });

  it('上げ始める時以降に送った頼み事は、いつ計算し直しても知らせない（札は出す）', () => {
    const late = sent('2026-12-06T06:10+09:00').events;
    for (const at of [
      '2026-12-06T06:10+09:00',
      '2026-12-06T12:00+09:00',
      '2026-12-07T08:09+09:00',
    ]) {
      expect(raised(cardsAt(late, at))).toEqual(['r-grandma']);
      expect(intentsAt(late, at)).toEqual([]);
    }
    const justBefore = sent('2026-12-06T06:09+09:00').events;
    expect(intentsAt(justBefore, '2026-12-06T06:10+09:00').map((i) => i.key)).toEqual([
      'noReply:r-grandma:b',
    ]);
  });
});
