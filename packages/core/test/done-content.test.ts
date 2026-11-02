// 済んだの記録は、見せた用件に結び付ける。直し・置き換えで作業のキーは同じまま用件が替わったら、前の物の
// 済みを今の作業に当てず、引き受けた所に戻して確かめ直しを出す。用件が戻れば、また済みになる。
import { describe, expect, it } from 'vitest';
import { type Extraction, type Source, splitSentences } from '../src';
import { computePlan, keys, requestSnapshot } from '../src/engine';
import { noticeArrived } from './fixtures/demo';

const AT = '2026-11-25T20:30+09:00';
const BUY = keys.task(keys.option(keys.purchaseArrangement('i3'), 'buy'), 'buy');
const shirt = { titleKey: 'task.buy', titleParams: { what: '白い長袖シャツ' } };

/** 家に無いと答え、a が買い物を持って済ませた（見せた用件を付けるか選ぶ）。 */
const bought = (content?: typeof shirt) =>
  noticeArrived()
    .add('answered', '2026-11-25T19:40+09:00', 'b', {
      unknownId: 'u-atHome:i3',
      value: 'no',
      about: '白い長袖シャツ',
    })
    .add('assignmentProposed', '2026-11-25T19:41+09:00', 'b', { taskKey: BUY, assigneeId: 'a' })
    .add('commitmentChanged', '2026-11-25T20:00+09:00', 'a', {
      taskKey: BUY,
      assigneeId: 'a',
      action: 'done',
      ...(content ? { content } : {}),
    });
const correct = (what: string) => ({ itemId: 'i3', interpretation: { what } });
const buyTask = (events: ReturnType<typeof bought>['events']) =>
  computePlan(events, AT).tasks.find((t) => t.key === BUY);

describe('済んだの用件', () => {
  it('買い物：別の物に直されたら済みを当てず、戻せばまた済み', () => {
    expect(buyTask(bought(shirt).events)?.commitment).toBe('done');
    const hat = bought(shirt).add(
      'itemCorrected',
      '2026-11-25T20:10+09:00',
      'b',
      correct('赤い帽子'),
    );
    const plan = computePlan(hat.events, AT);
    expect(plan.tasks.find((t) => t.key === BUY)).toMatchObject({
      titleParams: { what: '赤い帽子' },
      commitment: 'accepted',
      reconfirm: true,
    });
    // 前の品物への「無い」の答えも使わないので、まず家にあるかを聞く。
    expect(plan.arrangements.find((a) => a.key === 'arr:purchase:i3')?.status).toBe('askFirst');
    const back = hat.add('itemCorrected', '2026-11-25T20:20+09:00', 'b', correct('白い長袖シャツ'));
    expect(buyTask(back.events)?.commitment).toBe('done');
  });

  it('用件の控えの無い前の済みは、これまでどおり当てる', () => {
    const old = bought().add('itemCorrected', '2026-11-25T20:10+09:00', 'b', correct('赤い帽子'));
    expect(buyTask(old.events)?.commitment).toBe('done');
  });

  it('手配の手順：預ける日が直されたら、前の日の申込書を書いた済みを当てない', () => {
    const care = 'arr:childCare:i4:c';
    const gakudo = keys.option(care, 'opt-gakudo');
    const write = keys.task(gakudo, 'write');
    const done = noticeArrived()
      .add('optionChosen', '2026-11-25T20:00+09:00', 'b', {
        arrangementKey: care,
        optionKey: gakudo,
        role: 'primary',
      })
      .add('assignmentProposed', '2026-11-25T20:01+09:00', 'b', { taskKey: write, assigneeId: 'a' })
      .add('commitmentChanged', '2026-11-25T20:02+09:00', 'a', {
        taskKey: write,
        assigneeId: 'a',
        action: 'done',
        content: { titleKey: 'task.gakudoForm.write', titleParams: { date: '2026-12-07' } },
      });
    const task = (events: typeof done.events) =>
      computePlan(events, AT).tasks.find((t) => t.key === write);
    expect(task(done.events)).toMatchObject({
      titleParams: { date: '2026-12-07' },
      commitment: 'done',
    });
    const moved = done.add('itemCorrected', '2026-11-25T20:10+09:00', 'b', {
      itemId: 'i4',
      interpretation: { date: '2026-12-14', writtenWeekday: 1 },
    });
    expect(task(moved.events)).toMatchObject({
      titleParams: { date: '2026-12-14' },
      commitment: 'accepted',
      reconfirm: true,
    });
  });

  it('決め時を過ぎた案を始めたかは、今の日の分で見る（前の日の申込書の済みで、新しい日を始めたことにしない）', () => {
    const care = 'arr:childCare:i4:c';
    const gakudo = keys.option(care, 'opt-gakudo');
    const write = keys.task(gakudo, 'write');
    const wrote = noticeArrived()
      .add('optionChosen', '2026-11-25T20:00+09:00', 'b', {
        arrangementKey: care,
        optionKey: gakudo,
        role: 'primary',
      })
      .add('assignmentProposed', '2026-11-25T20:01+09:00', 'b', { taskKey: write, assigneeId: 'a' })
      .add('commitmentChanged', '2026-11-25T20:02+09:00', 'a', {
        taskKey: write,
        assigneeId: 'a',
        action: 'done',
        content: { titleKey: 'task.gakudoForm.write', titleParams: { date: '2026-12-07' } },
      });
    // 同じ日のまま決め時（11/30 18:30）を過ぎた：書き始めているので、学童を使い続ける。
    const same = computePlan(wrote.events, '2026-12-01T09:00+09:00').arrangements.find(
      (a) => a.key === care,
    );
    expect(same?.inUseOptionKey).toBe(gakudo);
    expect(same?.reasons.some((r) => r.code === 'missedDeadline')).toBe(false);
    // 12/14 に直され、その決め時（12/7 18:30）も過ぎた：前の日の済みでは始めたことにしない。
    const moved = wrote.add('itemCorrected', '2026-11-25T20:10+09:00', 'b', {
      itemId: 'i4',
      interpretation: { date: '2026-12-14', writtenWeekday: 1 },
    });
    const later = computePlan(moved.events, '2026-12-08T09:00+09:00').arrangements.find(
      (a) => a.key === care,
    );
    expect(later?.inUseOptionKey).not.toBe(gakudo);
    expect(later?.reasons).toContainEqual({ code: 'missedDeadline', refs: [gakudo] });
  });

  it('依頼も、頼んだ日が今の日と同じ時だけ、案を始めたことにする', () => {
    const care = 'arr:childCare:i4:c';
    const grandma = keys.option(care, 'opt-grandma');
    const ask = keys.task(grandma, 'ask');
    const chosen = noticeArrived()
      .add('optionChosen', '2026-11-25T20:00+09:00', 'b', {
        arrangementKey: care,
        optionKey: grandma,
        role: 'primary',
      })
      .add('assignmentProposed', '2026-11-25T20:01+09:00', 'b', { taskKey: ask, assigneeId: 'b' });
    const sent = chosen.add('externalRequestSent', '2026-11-25T20:02+09:00', 'b', {
      taskKey: ask,
      requestId: 'r-1',
      snapshot: requestSnapshot(chosen.events, '2026-11-25T20:02+09:00', ask),
    });
    // 12/7 の分を頼んで返事待ちのまま、12/7 の決め時（12/4 21:00）を過ぎた：始めているので使い続ける。
    const same = computePlan(sent.events, '2026-12-05T09:00+09:00').arrangements.find(
      (a) => a.key === care,
    );
    expect(same).toMatchObject({ status: 'dependsOnReply', inUseOptionKey: grandma });
    // 12/14 に直され、その決め時（12/11 21:00）も過ぎた：12/7 の分の依頼では始めたことにしない。
    const moved = sent.add('itemCorrected', '2026-11-25T20:10+09:00', 'b', {
      itemId: 'i4',
      interpretation: { date: '2026-12-14', writtenWeekday: 1 },
    });
    const later = computePlan(moved.events, '2026-12-12T09:00+09:00').arrangements.find(
      (a) => a.key === care,
    );
    expect(later?.reasons).toContainEqual({ code: 'missedDeadline', refs: [grandma] });
    expect(later?.inUseOptionKey).not.toBe(grandma);
  });

  it('提出物：出す物が直されたら済みを当てず、持った人の家の時間に置き直す', () => {
    const text = '個人面談の出欠票を、11月27日(金)までに担任に提出してください。';
    const notice3: Source = {
      id: 'n3',
      version: 1,
      receivedAt: '2026-11-25T20:00+09:00',
      sender: 'school',
      language: 'ja',
      medium: 'text',
      title: '個人面談',
      sentences: splitSentences(text, 'n3'),
    };
    const extraction3: Extraction = {
      sourceId: 'n3',
      unknowns: [],
      conditions: [],
      items: [
        {
          id: 's1',
          sourceId: 'n3',
          sentenceIds: ['n3#1'],
          kind: 'submission',
          written: text,
          interpretation: { what: '個人面談の出欠票', date: '2026-11-27', writtenWeekday: 5 },
          evidence: 'stated',
          effects: [],
        },
      ],
      ambiguities: [],
      irrelevantSentenceIds: [],
    };
    const TASK = 'task:submit:s1';
    const done = noticeArrived()
      .add('noticeReceived', '2026-11-25T20:00+09:00', 'b', { source: notice3 })
      .add('modelOutputRecorded', '2026-11-25T20:00+09:00', 'system', {
        call: 'extract',
        model: 'hand-written',
        promptVersion: 'fixture',
        inputHash: 'fixture-n3',
        sourceId: 'n3',
        output: extraction3,
      })
      .add('assignmentProposed', '2026-11-25T20:01+09:00', 'b', { taskKey: TASK, assigneeId: 'b' })
      .add('commitmentChanged', '2026-11-25T20:02+09:00', 'b', {
        taskKey: TASK,
        assigneeId: 'b',
        action: 'done',
        content: { titleKey: 'task.submit', titleParams: { what: '個人面談の出欠票' } },
      });
    const task = (events: typeof done.events) =>
      computePlan(events, AT).tasks.find((t) => t.key === TASK);
    expect(task(done.events)?.commitment).toBe('done');
    const corrected = done.add('itemCorrected', '2026-11-25T20:10+09:00', 'b', {
      itemId: 's1',
      interpretation: { what: '面談の希望日の用紙' },
    });
    const now = task(corrected.events);
    expect(now).toMatchObject({ commitment: 'accepted', reconfirm: true });
    expect(now?.start).toBeDefined();
  });
});
