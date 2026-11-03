// 当番と家の人がすることを、正式の命令（runCommand）で動かす：日を直した後に前の日の済みを当てない、前の日を
// 見た画面から済んだと記録させない、日をまたぐ時間を一時間に縮めない、学校での当番を家に置かない、日の
// 書かれていないサインも「きょう」に出て、時刻なしで引き受けられる。うちの番かの言明は、読み取りの確かさも、
// ほかのお知らせの置き換えも変えない。
import { type Item, proposalSnapshot, todayCards } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

const DUTY = 'task:duty:n3:d1';
const SIGN = 'task:submit:n3:h1';
const START = '2026-11-25T20:00+09:00';

async function setup() {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  await store.withHousehold('demo', (log) => {
    const first = log.events().find((e) => e.type === 'noticeReceived');
    if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
    const dutyText = '12月13日(日)8:30〜10:00 お茶当番：陽菜さんのおうち';
    const signText = '音読カードにおうちの人のはんこをもらいます。';
    const otherText = '12月20日(日) お茶当番：さくらさんのおうち';
    log.append(
      [
        {
          type: 'noticeReceived',
          source: {
            ...first.source,
            id: 'n3',
            title: '（架空）連絡帳',
            sentences: [
              { id: 'n3#1', text: dutyText },
              { id: 'n3#2', text: signText },
              { id: 'n3#3', text: otherText },
            ],
          },
        },
        {
          type: 'modelOutputRecorded',
          call: 'extract',
          sourceId: 'n3',
          model: 'fixture',
          promptVersion: 'fixture',
          inputHash: 'fixture',
          output: {
            sourceId: 'n3',
            unknowns: [],
            conditions: [],
            irrelevantSentenceIds: [],
            ambiguities: [],
            items: [
              {
                id: 'n3:d1',
                sourceId: 'n3',
                sentenceIds: ['n3#1'],
                kind: 'duty',
                written: dutyText,
                interpretation: {
                  what: 'お茶当番',
                  date: '2026-12-13',
                  writtenWeekday: 7,
                  startTime: '08:30',
                  endTime: '10:00',
                  audience: '陽菜さんのおうち',
                  familyAction: true,
                },
                evidence: 'stated',
                effects: [],
              },
              {
                id: 'n3:h1',
                sourceId: 'n3',
                sentenceIds: ['n3#2'],
                kind: 'homework',
                written: signText,
                interpretation: { what: '音読カードのはんこ', familyAction: true },
                evidence: 'stated',
                effects: [],
              },
              {
                id: 'n3:d2',
                sourceId: 'n3',
                sentenceIds: ['n3#3'],
                kind: 'duty',
                written: otherText,
                interpretation: {
                  what: 'お茶当番',
                  date: '2026-12-20',
                  writtenWeekday: 7,
                  audience: 'さくらさんのおうち',
                  familyAction: true,
                },
                evidence: 'stated',
                effects: [],
              },
            ],
          },
        },
      ],
      'b',
      START,
    );
  });
  let sequence = 0;
  const run = (memberId: string, now: string, command: Parameters<typeof runCommand>[3]) =>
    runCommand(
      store,
      'demo',
      { memberId, now, operationId: `family-${++sequence}`, demo: true },
      command,
    );
  const plan = async (now: string) =>
    computePlan(await store.withHousehold('demo', (log) => [...log.events()]), now);
  const view = async (memberId: string, now: string) =>
    viewFor(await store.withHousehold('demo', (log) => [...log.events()]), memberId, now);
  const task = async (key: string, now: string) => {
    const found = (await plan(now)).tasks.find((t) => t.key === key);
    if (!found) throw new Error(`${key} が無い`);
    return found;
  };
  /** 一文のお知らせと、手で書いた読み取り（事項一つ）を足す。 */
  const addNotice = (
    sourceId: string,
    text: string,
    itemOf: (sentenceId: string, written: string) => Item,
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
              items: [itemOf(sentenceId, text)],
            },
          },
        ],
        'b',
        START,
      );
    });
  return { run, plan, task, view, addNotice };
}

describe('当番を命令で動かす', () => {
  it('日を直した後は、前の日に済ませた記録を当てない', async () => {
    const h = await setup();
    expect(
      (await h.run('b', START, { type: 'proposeAssignment', taskKey: DUTY, assigneeId: 'b' }))
        .status,
    ).toBe('ok');
    const now = '2026-12-13T10:05+09:00';
    const old = await h.task(DUTY, now);
    const seen = { titleKey: old.titleKey, titleParams: old.titleParams };
    expect(
      (await h.run('b', now, { type: 'commitment', taskKey: DUTY, action: 'done', seen })).status,
    ).toBe('ok');
    expect((await h.task(DUTY, now)).commitment).toBe('done');
    const moved = await h.run('a', now, {
      type: 'correctItem',
      itemId: 'n3:d1',
      interpretation: { date: '2026-12-20', writtenWeekday: 7 },
    });
    expect(moved.status).toBe('ok');
    expect((await h.task(DUTY, now)).commitment).not.toBe('done');
  });

  it('前の日を見た画面からは、直した後の当番を済んだと記録しない', async () => {
    const h = await setup();
    expect(
      (await h.run('b', START, { type: 'proposeAssignment', taskKey: DUTY, assigneeId: 'b' }))
        .status,
    ).toBe('ok');
    const now = '2026-12-13T10:05+09:00';
    const old = await h.task(DUTY, now);
    const seen = { titleKey: old.titleKey, titleParams: old.titleParams };
    await h.run('a', now, {
      type: 'correctItem',
      itemId: 'n3:d1',
      interpretation: { date: '2026-12-20', writtenWeekday: 7 },
    });
    const stale = await h.run('b', now, {
      type: 'commitment',
      taskKey: DUTY,
      action: 'done',
      seen,
    });
    expect(stale.status).not.toBe('ok');
  });

  it('日をまたぐ時間を一時間に縮めない。学校での当番を、家にいる作業として置かない', async () => {
    const h = await setup();
    const now = '2026-11-25T20:01+09:00';
    await h.run('a', now, {
      type: 'correctItem',
      itemId: 'n3:d1',
      interpretation: { startTime: '23:00', endTime: '01:00', place: 'みらい橋小学校（架空）' },
    });
    await h.run('b', now, { type: 'proposeAssignment', taskKey: DUTY, assigneeId: 'b' });
    const current = await h.task(DUTY, now);
    expect(current.deadline).toBe('2026-12-14T01:00+09:00');
    expect(current.titleParams.place).toBe('みらい橋小学校（架空）');
    expect(current.atPlaceId).toBeUndefined();
  });
});

describe('日の書かれていないサイン', () => {
  it('二人の「きょう」に出て、持った人は時刻なしで引き受けられる', async () => {
    const h = await setup();
    const now = '2026-11-25T20:01+09:00';
    const plan = await h.plan(now);
    for (const member of ['a', 'b']) {
      expect(
        todayCards(plan, member).main.some((c) => c.kind === 'unowned' && c.task.key === SIGN),
      ).toBe(true);
    }
    expect(
      (await h.run('a', now, { type: 'proposeAssignment', taskKey: SIGN, assigneeId: 'a' })).status,
    ).toBe('ok');
    const proposed = await h.task(SIGN, now);
    const shown = proposalSnapshot(proposed);
    if (!shown) throw new Error('控えが無い');
    expect(shown.start).toBeUndefined();
    expect((await h.run('a', now, { type: 'accept', taskKey: SIGN, shown })).status).toBe('ok');
    expect((await h.task(SIGN, now)).commitment).toBe('accepted');
  });
});

describe('うちの番の言明を命令で動かす', () => {
  const OTHER = 'task:duty:n3:d2';
  const NOW = '2026-11-25T20:05+09:00';
  const item = async (h: Awaited<ReturnType<typeof setup>>, id: string) => {
    const found = (await h.view('a', NOW)).items.find((l) => l.item.id === id);
    if (!found) throw new Error(`${id} が無い`);
    return found;
  };

  it('日を直しただけでは、ほかの家の番の行をうちの番にしない。「うちの番です」で作業にする', async () => {
    const h = await setup();
    const fixed = await h.run('a', NOW, {
      type: 'correctItem',
      itemId: 'n3:d2',
      interpretation: { date: '2026-12-21' },
    });
    expect(fixed.status).toBe('ok');
    expect((await h.plan(NOW)).tasks.some((t) => t.key === OTHER)).toBe(false);
    const seen = { throughSeq: (await h.view('a', NOW)).throughSeq };
    expect(
      (await h.run('a', NOW, { type: 'stateTurn', itemId: 'n3:d2', ours: true, seen })).status,
    ).toBe('ok');
    expect((await h.task(OTHER, NOW)).turnUnconfirmed).toBeUndefined();
  });

  it('「うちの番ではない」は作業を外すが、事項は外さない（出典の画面で、家族の言明として見せ、戻せる）', async () => {
    const h = await setup();
    const seen = { throughSeq: (await h.view('a', NOW)).throughSeq };
    expect(
      (await h.run('a', NOW, { type: 'stateTurn', itemId: 'n3:d1', ours: false, seen })).status,
    ).toBe('ok');
    expect((await h.plan(NOW)).tasks.some((t) => t.key === DUTY)).toBe(false);
    expect(await item(h, 'n3:d1')).toMatchObject({ live: true, turn: 'others', turnStated: true });
    const back = { throughSeq: (await h.view('b', NOW)).throughSeq };
    expect(
      (await h.run('b', NOW, { type: 'stateTurn', itemId: 'n3:d1', ours: true, seen: back }))
        .status,
    ).toBe('ok');
    expect((await h.plan(NOW)).tasks.some((t) => t.key === DUTY)).toBe(true);
  });

  it('見た後にもう一人が対象を直していたら、古い画面の「うちの番ではない」を断る', async () => {
    const h = await setup();
    const seen = { throughSeq: (await h.view('a', NOW)).throughSeq };
    await h.run('b', NOW, {
      type: 'correctItem',
      itemId: 'n3:d1',
      interpretation: { audience: '陽菜さん・ゆいさんのおうち' },
    });
    const stale = await h.run('a', NOW, {
      type: 'stateTurn',
      itemId: 'n3:d1',
      ours: false,
      seen,
    });
    expect(stale).toMatchObject({ status: 'conflict', reason: 'itemChanged' });
    expect((await h.plan(NOW)).tasks.some((t) => t.key === DUTY)).toBe(true);
  });

  it('言って戻した後（中身が同じに戻っても）、その前に見た画面からの言明を断る', async () => {
    const h = await setup();
    const old = { throughSeq: (await h.view('a', NOW)).throughSeq };
    const fresh = () => h.view('b', NOW).then((v) => ({ throughSeq: v.throughSeq }));
    await h.run('b', NOW, { type: 'stateTurn', itemId: 'n3:d1', ours: false, seen: await fresh() });
    await h.run('b', NOW, { type: 'stateTurn', itemId: 'n3:d1', ours: true, seen: await fresh() });
    expect((await h.plan(NOW)).tasks.some((t) => t.key === DUTY)).toBe(true);
    const stale = await h.run('a', NOW, {
      type: 'stateTurn',
      itemId: 'n3:d1',
      ours: false,
      seen: old,
    });
    expect(stale).toMatchObject({ status: 'conflict', reason: 'itemChanged' });
    expect((await h.plan(NOW)).tasks.some((t) => t.key === DUTY)).toBe(true);
  });

  it('当番でない事項には、うちの番かを言えない', async () => {
    const h = await setup();
    const seen = { throughSeq: (await h.view('a', NOW)).throughSeq };
    expect(
      await h.run('a', NOW, { type: 'stateTurn', itemId: 'n3:h1', ours: false, seen }),
    ).toMatchObject({ status: 'invalid', reason: 'notADuty' });
  });

  it('後のお知らせで置き換えた当番を「うちの番ではない」としても、前の当番を生き返らせない', async () => {
    const h = await setup();
    await h.addNotice(
      'n4',
      '12月13日(日)のお茶当番は、さくらさんのおうちに変わりました。',
      (sentenceId, written) => ({
        id: 'n4:e1',
        sourceId: 'n4',
        sentenceIds: [sentenceId],
        kind: 'duty',
        written,
        interpretation: {
          what: 'お茶当番',
          date: '2026-12-13',
          writtenWeekday: 7,
          audience: 'さくらさんのおうち',
          familyAction: true,
        },
        evidence: 'stated',
        effects: [{ type: 'replace', itemId: 'n3:d1' }],
      }),
    );
    const tea13 = async () =>
      (await h.plan(NOW)).tasks.filter(
        (t) => t.live && t.titleKey === 'task.duty' && t.titleParams.date === '2026-12-13',
      );
    expect((await tea13()).map((t) => t.turnUnconfirmed)).toEqual([true]);
    const seen = { throughSeq: (await h.view('a', NOW)).throughSeq };
    expect(
      (await h.run('a', NOW, { type: 'stateTurn', itemId: 'n4:e1', ours: false, seen })).status,
    ).toBe('ok');
    expect(await tea13()).toEqual([]);
  });

  it('推定の行に「うちの番です」と言っても、推定の中身で作業を作らない', async () => {
    const h = await setup();
    await h.addNotice(
      'n5',
      'さくらさんのおうちもお茶当番です（日付は別途）。',
      (sentenceId, written) => ({
        id: 'n5:g1',
        sourceId: 'n5',
        sentenceIds: [sentenceId],
        kind: 'duty',
        written,
        interpretation: {
          what: 'お茶当番',
          date: '2026-12-13',
          audience: 'さくらさんのおうち',
          familyAction: true,
        },
        evidence: 'inferred',
        effects: [],
      }),
    );
    const seen = { throughSeq: (await h.view('a', NOW)).throughSeq };
    expect(
      (await h.run('a', NOW, { type: 'stateTurn', itemId: 'n5:g1', ours: true, seen })).status,
    ).toBe('ok');
    expect(await item(h, 'n5:g1')).toMatchObject({
      trusted: false,
      turn: 'ours',
      turnStated: true,
    });
    expect((await h.plan(NOW)).tasks.some((t) => t.key === 'task:duty:n5:g1')).toBe(false);
  });
});
