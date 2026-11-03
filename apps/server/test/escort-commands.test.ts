// 習い事・クラブの行事の送り迎えを、正式の命令（runCommand）で動かす：「今回は要らない」と言い直し、見せた
// 後に記録が進んだ画面（ほかのお知らせの取り消しと、その取り下げで元に戻った時も）からの言明を断る。言明は、
// 言った時の子・用件・日・時刻・場所を控え、行事そのものの確かさと作用を変えない。
import { type Item, proposalSnapshot, todayCards } from '@maniau/core';
import { computePlan, keys } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { previewCommand, runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

const START = '2026-11-25T20:00+09:00';
const NOW = '2026-11-25T20:05+09:00';
const PRACTICE = '12月5日(土)9:00〜11:00 サッカー練習（若洲グラウンド）';
const TO = 'task:escort:to:k1:e1';
const FROM = 'task:escort:from:k1:e1';

const practice = (sentenceId: string): Item => ({
  id: 'k1:e1',
  sourceId: 'k1',
  sentenceIds: [sentenceId],
  kind: 'event',
  written: PRACTICE,
  interpretation: {
    what: 'サッカー練習',
    date: '2026-12-05',
    writtenWeekday: 6,
    startTime: '09:00',
    endTime: '11:00',
    place: '若洲グラウンド',
  },
  evidence: 'stated',
  effects: [],
});

async function setup() {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  /** 一文のお知らせと、手で書いた読み取り（事項一つ）を足す。 */
  const addNotice = (
    sourceId: string,
    sender: 'club' | 'school',
    text: string,
    itemOf: (sentenceId: string) => Item,
  ) =>
    store.withHousehold('demo', (log) => {
      const first = log.events().find((e) => e.type === 'noticeReceived');
      if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
      const sentenceId = `${sourceId}#1`;
      log.append(
        [
          {
            type: 'noticeReceived',
            source: {
              ...first.source,
              id: sourceId,
              sender,
              title: `（架空）${sourceId}`,
              sentences: [{ id: sentenceId, text }],
            },
          },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId,
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'fixture',
            output: {
              sourceId,
              unknowns: [],
              conditions: [],
              irrelevantSentenceIds: [],
              ambiguities: [],
              items: [itemOf(sentenceId)],
            },
          },
        ],
        'b',
        START,
      );
    });
  await addNotice('k1', 'club', PRACTICE, practice);
  let sequence = 0;
  const run = (memberId: string, command: Parameters<typeof runCommand>[3]) =>
    runCommand(
      store,
      'demo',
      { memberId, now: NOW, operationId: `escort-${++sequence}`, demo: true },
      command,
    );
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  const plan = async () => computePlan(await events(), NOW);
  const seen = async () => ({ throughSeq: (await viewFor(await events(), 'a', NOW)).throughSeq });
  const has = async (key: string) => (await plan()).tasks.some((t) => t.key === key && t.live);
  const frame = async () =>
    (await viewFor(await events(), 'a', NOW)).items.find((l) => l.item.id === 'k1:e1')?.escort;
  return { run, plan, seen, has, frame, events, addNotice };
}

describe('送り迎えの言明を命令で動かす', () => {
  it('「今回は要らない」で迎えを外し、出典の画面から言い直せる。控えは言った時の中身', async () => {
    const h = await setup();
    expect(await h.has(TO)).toBe(true);
    expect(await h.has(FROM)).toBe(true);
    const off = await h.run('a', {
      type: 'stateEscort',
      itemId: 'k1:e1',
      leg: 'from',
      needed: false,
      seen: await h.seen(),
    });
    expect(off.status).toBe('ok');
    expect(await h.has(FROM)).toBe(false);
    expect(await h.has(TO)).toBe(true);
    expect((await h.frame())?.legs[1]).toMatchObject({ leg: 'from', needed: false, stated: true });
    expect((await h.events()).at(-1)).toMatchObject({
      type: 'escortStated',
      itemId: 'k1:e1',
      leg: 'from',
      needed: false,
      childId: 'c',
      what: 'サッカー練習',
      date: '2026-12-05',
      at: '11:00',
      place: '若洲グラウンド',
      actorId: 'a',
    });
    // 同じことの言い直しは、何も足さない。
    const again = await h.run('b', {
      type: 'stateEscort',
      itemId: 'k1:e1',
      leg: 'from',
      needed: false,
      seen: await h.seen(),
    });
    expect(again.status).toBe('noop');
    const back = await h.run('b', {
      type: 'stateEscort',
      itemId: 'k1:e1',
      leg: 'from',
      needed: true,
      seen: await h.seen(),
    });
    expect(back.status).toBe('ok');
    expect(await h.has(FROM)).toBe(true);
  });

  it('見せた後に記録が進んでいれば（もう一人の別の操作でも）、古い画面からの言明を断る', async () => {
    const h = await setup();
    const old = await h.seen();
    await h.run('b', { type: 'proposeAssignment', taskKey: TO, assigneeId: 'b' });
    const stale = await h.run('a', {
      type: 'stateEscort',
      itemId: 'k1:e1',
      leg: 'from',
      needed: false,
      seen: old,
    });
    expect(stale).toMatchObject({ status: 'conflict', reason: 'itemChanged' });
    expect(await h.has(FROM)).toBe(true);
  });

  it('ほかのお知らせが取り消して、その取り下げで元に戻っても、その前の画面からの言明を断る', async () => {
    const h = await setup();
    const old = await h.seen();
    await h.addNotice('k2', 'club', '12月5日(土)の練習は中止です。', (sentenceId) => ({
      id: 'k2:x1',
      sourceId: 'k2',
      sentenceIds: [sentenceId],
      kind: 'event',
      written: '12月5日(土)の練習は中止です。',
      interpretation: { what: 'サッカー練習の中止', date: '2026-12-05', writtenWeekday: 6 },
      evidence: 'stated',
      effects: [{ type: 'cancel', itemId: 'k1:e1' }],
    }));
    expect(await h.has(FROM)).toBe(false);
    // 取り消された間は、新しい画面からも言えない（もう要らない送り迎え）。
    const gone = await h.run('a', {
      type: 'stateEscort',
      itemId: 'k1:e1',
      leg: 'from',
      needed: false,
      seen: await h.seen(),
    });
    expect(gone.status).toBe('conflict');
    expect((await h.run('b', { type: 'withdrawSource', sourceId: 'k2' })).status).toBe('ok');
    expect(await h.has(FROM)).toBe(true);
    const stale = await h.run('a', {
      type: 'stateEscort',
      itemId: 'k1:e1',
      leg: 'from',
      needed: false,
      seen: old,
    });
    expect(stale).toMatchObject({ status: 'conflict', reason: 'itemChanged' });
    expect(await h.has(FROM)).toBe(true);
  });

  it('見せた番号が今と違えば（今より先の番号でも）断る', async () => {
    const h = await setup();
    const now = await h.seen();
    const ahead = await h.run('a', {
      type: 'stateEscort',
      itemId: 'k1:e1',
      leg: 'from',
      needed: false,
      seen: { throughSeq: now.throughSeq + 5 },
    });
    expect(ahead).toMatchObject({ status: 'conflict', reason: 'itemChanged' });
    expect(await h.has(FROM)).toBe(true);
  });

  it('もう一人が引き受けた送りは、「今回は要らない」で黙って消さない（持った人が言う）', async () => {
    const h = await setup();
    await h.run('a', { type: 'proposeAssignment', taskKey: TO, assigneeId: 'a' });
    const proposed = (await h.plan()).tasks.find((t) => t.key === TO);
    const shown = proposed ? proposalSnapshot(proposed) : undefined;
    if (!shown) throw new Error('控えが無い');
    expect((await h.run('a', { type: 'accept', taskKey: TO, shown })).status).toBe('ok');
    const refused = await h.run('b', {
      type: 'stateEscort',
      itemId: 'k1:e1',
      leg: 'to',
      needed: false,
      seen: await h.seen(),
    });
    expect(refused).toMatchObject({ status: 'conflict', reason: 'heldByOther' });
    expect((await h.plan()).tasks.find((t) => t.key === TO)?.commitment).toBe('accepted');
    // 持った本人が言えば外れ、引き受けも取り下げる。言い直して戻った送りは、だれも持っていない札になる。
    const own = await h.run('a', {
      type: 'stateEscort',
      itemId: 'k1:e1',
      leg: 'to',
      needed: false,
      seen: await h.seen(),
    });
    expect(own.status).toBe('ok');
    expect((await h.events()).slice(-2)).toMatchObject([
      { type: 'commitmentChanged', taskKey: TO, assigneeId: 'a', action: 'withdraw' },
      { type: 'escortStated', leg: 'to', needed: false },
    ]);
    expect(await h.has(TO)).toBe(false);
    await h.run('b', {
      type: 'stateEscort',
      itemId: 'k1:e1',
      leg: 'to',
      needed: true,
      seen: await h.seen(),
    });
    const back = await h.plan();
    expect(back.tasks.find((t) => t.key === TO)?.commitment).not.toBe('accepted');
    for (const member of ['a', 'b']) {
      expect(
        todayCards(back, member).main.some((c) => c.kind === 'unowned' && c.task.key === TO),
      ).toBe(true);
    }
  });

  it('中止のお知らせで要らなくなった送りは、持った本人に出し、本人が分かったと言える', async () => {
    const h = await setup();
    await h.run('a', { type: 'proposeAssignment', taskKey: TO, assigneeId: 'a' });
    const proposed = (await h.plan()).tasks.find((t) => t.key === TO);
    const shown = proposed ? proposalSnapshot(proposed) : undefined;
    if (!shown) throw new Error('控えが無い');
    expect((await h.run('a', { type: 'accept', taskKey: TO, shown })).status).toBe('ok');
    // 引き受けに、根拠のお知らせを控える（後で無くなった時に、はっきり要らないのかを分ける）。
    expect((await h.events()).at(-1)).toMatchObject({
      type: 'commitmentChanged',
      action: 'accept',
      basisItemIds: ['k1:e1'],
      basisSourceIds: ['k1'],
    });
    const text = '雨のため、12月5日(土)の練習は中止します。';
    await h.addNotice('k2', 'club', text, (sentenceId) => ({
      id: 'k2:x1',
      sourceId: 'k2',
      sentenceIds: [sentenceId],
      kind: 'event',
      written: text,
      interpretation: { what: 'サッカー練習の中止', date: '2026-12-05', writtenWeekday: 6 },
      evidence: 'stated',
      effects: [{ type: 'cancel', itemId: 'k1:e1' }],
    }));
    const plan = await h.plan();
    expect(plan.tasks.some((t) => t.key === TO)).toBe(false);
    expect(plan.released).toMatchObject([{ taskKey: TO, assigneeId: 'a', reason: 'gone' }]);
    expect(todayCards(plan, 'a').main[0]).toMatchObject({ kind: 'released' });
    // 持っていない人は、分かったと言えない。計画に無い作業を、ふつうの取り下げ・済みでは記録しない。
    expect(
      await h.run('b', { type: 'acknowledgeReleased', taskKey: TO, seen: await h.seen() }),
    ).toMatchObject({ status: 'conflict', reason: 'releasedGone' });
    expect(await h.run('a', { type: 'commitment', taskKey: TO, action: 'withdraw' })).toMatchObject(
      {
        status: 'conflict',
        reason: 'taskGone',
      },
    );
    // 見せた後に記録が進んだ札（今より先の番号も）からは断る。
    const shownAt = await h.seen();
    expect(
      await h.run('a', {
        type: 'acknowledgeReleased',
        taskKey: TO,
        seen: { throughSeq: shownAt.throughSeq + 1 },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'itemChanged' });
    expect(
      (await h.run('a', { type: 'acknowledgeReleased', taskKey: TO, seen: shownAt })).status,
    ).toBe('ok');
    expect((await h.plan()).released).toBeUndefined();
  });

  it('「もう要りません」を見た後に中止が取り下げられたら、もう一度頼み、古い札の「分かりました」は断る', async () => {
    const h = await setup();
    await h.run('a', { type: 'proposeAssignment', taskKey: TO, assigneeId: 'a' });
    const proposed = (await h.plan()).tasks.find((t) => t.key === TO);
    const shown = proposed ? proposalSnapshot(proposed) : undefined;
    if (!shown) throw new Error('控えが無い');
    await h.run('a', { type: 'accept', taskKey: TO, shown });
    const text = '雨のため、12月5日(土)の練習は中止します。';
    await h.addNotice('k2', 'club', text, (sentenceId) => ({
      id: 'k2:x1',
      sourceId: 'k2',
      sentenceIds: [sentenceId],
      kind: 'event',
      written: text,
      interpretation: { what: 'サッカー練習の中止', date: '2026-12-05', writtenWeekday: 6 },
      evidence: 'stated',
      effects: [{ type: 'cancel', itemId: 'k1:e1' }],
    }));
    // a は「もう要りません」の札を見た（知らせは届いていない）。
    const seenByA = await h.seen();
    expect((await h.plan()).released).toMatchObject([{ taskKey: TO, assigneeId: 'a' }]);
    expect((await h.run('b', { type: 'withdrawSource', sourceId: 'k2' })).status).toBe('ok');
    // 戻った送りは、前の引き受けのまま当てず、a にもう一度頼む。
    const back = await h.plan();
    expect(back.tasks.find((t) => t.key === TO)).toMatchObject({
      assigneeId: 'a',
      commitment: 'proposed',
    });
    expect(todayCards(back, 'a').main.some((c) => c.kind === 'proposal' && c.task.key === TO)).toBe(
      true,
    );
    // 古い札の「分かりました」は、戻った頼みを取り下げない。
    expect(
      await h.run('a', { type: 'acknowledgeReleased', taskKey: TO, seen: seenByA }),
    ).toMatchObject({ status: 'conflict' });
    expect((await h.plan()).tasks.find((t) => t.key === TO)?.commitment).toBe('proposed');
  });

  it('習い事・クラブの行事でない事項と、無い事項には言えない', async () => {
    const h = await setup();
    await h.addNotice('s1', 'school', '12月6日(日)10:00 学校公開', (sentenceId) => ({
      ...practice(sentenceId),
      id: 's1:e1',
      sourceId: 's1',
      written: '12月6日(日)10:00 学校公開',
      interpretation: { what: '学校公開', date: '2026-12-06', startTime: '10:00' },
    }));
    expect(
      await h.run('a', {
        type: 'stateEscort',
        itemId: 's1:e1',
        leg: 'to',
        needed: false,
        seen: await h.seen(),
      }),
    ).toMatchObject({ status: 'invalid', reason: 'notAnEscort' });
    expect(
      await h.run('a', {
        type: 'stateEscort',
        itemId: 'nope',
        leg: 'to',
        needed: false,
        seen: await h.seen(),
      }),
    ).toMatchObject({ status: 'conflict', reason: 'itemGone' });
  });

  it('言明は、行事の確かさも、よていの事項も変えない', async () => {
    const h = await setup();
    for (const leg of ['to', 'from'] as const) {
      await h.run('a', {
        type: 'stateEscort',
        itemId: 'k1:e1',
        leg,
        needed: false,
        seen: await h.seen(),
      });
    }
    const plan = await h.plan();
    expect(plan.requirements.some((r) => r.kind === 'escort')).toBe(false);
    const item = (await viewFor(await h.events(), 'a', NOW)).items.find(
      (l) => l.item.id === 'k1:e1',
    );
    expect(item).toMatchObject({ live: true, trusted: true });
    expect(item?.item.evidence).toBe('stated');
  });
});

describe('戻った引き受けの頼み直しを、選ぶ前の「選んだら」にも入れる', () => {
  it('前の案へ選び直す時、「選んだら」で足す事象と後の計画が、書いた後と同じになる', async () => {
    const app = await setup();
    const care = 'arr:childCare:n1:i6:c';
    const school = keys.option(care, 'opt-gakudo');
    const grandma = keys.option(care, 'opt-grandma');
    const choose = (optionKey: string, assigneeId: string) => ({
      type: 'chooseOption' as const,
      arrangementKey: care,
      optionKey,
      role: 'primary' as const,
      assigneeId,
    });
    expect(
      (await app.run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' })).status,
    ).toBe('ok');
    expect((await app.run('b', choose(school, 'a'))).status).toBe('ok');
    const write = (await app.plan()).tasks.find(
      (t) => t.basis.optionKey === school && t.step?.stepId === 'write',
    );
    const shown = write && proposalSnapshot(write);
    if (!write || !shown) throw new Error('控えが無い');
    expect((await app.run('a', { type: 'accept', taskKey: write.key, shown })).status).toBe('ok');
    // 祖母に選び直すと、a の申込書の作業は「もう要りません」になる。
    expect((await app.run('b', choose(grandma, 'b'))).status).toBe('ok');
    const before = await app.events();
    expect(computePlan(before, NOW).released?.map((r) => r.taskKey)).toContain(write.key);
    // 学童に戻す。選ぶ前の計算にも、書いた時にも、a へもう一度頼む事象が入る。
    const back = choose(school, 'a');
    const simulated = previewCommand(before, { memberId: 'a', now: NOW }, back);
    if (simulated.status !== 'ok') throw new Error('選んだらが無い');
    expect((await app.run('a', back)).status).toBe('ok');
    const written = (await app.events()).slice(before.length);
    const shape = (list: readonly { type: string }[]) =>
      list.map((e) => {
        const { id: _id, occurredAt: _o, recordedAt: _r, ...rest } = e as Record<string, unknown>;
        return rest;
      });
    expect(shape(simulated.added)).toEqual(shape(written));
    expect(written).toContainEqual(
      expect.objectContaining({ type: 'assignmentProposed', taskKey: write.key, assigneeId: 'a' }),
    );
    expect(simulated.after.tasks.find((t) => t.key === write.key)?.commitment).toBe('proposed');
    expect((await app.plan()).tasks.find((t) => t.key === write.key)?.commitment).toBe('proposed');
  });
});
