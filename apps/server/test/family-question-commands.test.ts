// 家族が決める値（参加するか等）への答えを、正式の命令（runCommand）で受ける：見せた計画の通し番号が今と
// 同じ時だけ受ける（もう一人の答え・読み直しの後の古い札、先の番号を断る）。問いの札からの答えは、今の時刻の
// 問いが見せた物と同じ時だけ。文を直して読み直す前は受けない。受けた答えには問いの形を控え、読み直しや直しで
// 替われば使わずに聞き直す。家族の値でない未定の値（お知らせの書く日など）は、今までどおり受ける。
import { Extraction } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { memoryStore } from '../src/store';

const START = '2026-11-25T20:00+09:00';
const NOW = '2026-11-25T20:05+09:00';
const TEXT = '参加される方は、11月30日(月)17:00までに申込書を提出してください。';

async function setup() {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  await store.withHousehold('demo', (log) => {
    const first = log.events().find((e) => e.type === 'noticeReceived');
    if (first?.type !== 'noticeReceived') throw new Error('お知らせが無い');
    log.append(
      [
        {
          type: 'noticeReceived',
          source: {
            ...first.source,
            id: 'p1',
            title: '（架空）親子清掃のお知らせ',
            sentences: [{ id: 'p1#1', text: TEXT }],
          },
        },
        {
          type: 'modelOutputRecorded',
          call: 'extract',
          sourceId: 'p1',
          model: 'fixture',
          promptVersion: 'fixture',
          inputHash: 'fixture',
          output: {
            sourceId: 'p1',
            unknowns: [
              {
                id: 'p1:u-join',
                label: '親子清掃に参加するか',
                values: ['yes', 'no'],
                kind: 'family',
              },
            ],
            conditions: [{ id: 'p1:c-join', kind: 'eq', unknownId: 'p1:u-join', value: 'yes' }],
            irrelevantSentenceIds: [],
            ambiguities: [],
            items: [
              {
                id: 'p1:s1',
                sourceId: 'p1',
                sentenceIds: ['p1#1'],
                kind: 'submission',
                written: TEXT,
                evidence: 'stated',
                effects: [],
                conditionNodeId: 'p1:c-join',
                interpretation: { what: '申込書', deadline: '2026-11-30T17:00+09:00' },
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
  const run = (memberId: string, command: Parameters<typeof runCommand>[3], now = NOW) =>
    runCommand(
      store,
      'demo',
      { memberId, now, operationId: `family-question-${++sequence}`, demo: true },
      command,
    );
  const plan = async (now = NOW) =>
    computePlan(await store.withHousehold('demo', (log) => [...log.events()]), now);
  /** お知らせの文を直す（読み直しの読み取りを渡せば、それも記録する）。 */
  const correct = (text: string[], output?: (before: Extraction) => Extraction) =>
    store.withHousehold('demo', (log) => {
      const old = log.events().find((e) => e.type === 'modelOutputRecorded' && e.sourceId === 'p1');
      if (old?.type !== 'modelOutputRecorded') throw new Error('読み取りが無い');
      log.append(
        [
          {
            type: 'transcriptionCorrected',
            sourceId: 'p1',
            sourceVersion: 2,
            sentences: text.map((t, i) => ({ id: `p1#${i + 1}`, text: t })),
          },
          ...(output
            ? [
                {
                  type: 'modelOutputRecorded' as const,
                  call: 'extract' as const,
                  model: 'fixture',
                  promptVersion: 'fixture',
                  inputHash: 'fixture-v2',
                  sourceId: 'p1',
                  sourceVersion: 2,
                  output: output(Extraction.parse(old.output)),
                },
              ]
            : []),
        ],
        'b',
        NOW,
      );
    });
  return { run, plan, correct };
}

/** 問いの札からの答え（見せた問いの key・期限・変わる要件を付ける）。 */
const fromCard = (
  value: string,
  throughSeq: number,
  question: { key: string; until?: string; affects: string[] },
) => ({
  type: 'answer' as const,
  unknownId: 'p1:u-join',
  value,
  seen: { throughSeq, question },
});

const answer = (value: string, throughSeq?: number) => ({
  type: 'answer' as const,
  unknownId: 'p1:u-join',
  value,
  ...(throughSeq === undefined ? {} : { seen: { throughSeq } }),
});

describe('家族が決める値への答え', () => {
  it('見せた計画の番号が今と同じ答えだけを受け、問いが消えて作業が出る', async () => {
    const app = await setup();
    const before = await app.plan();
    expect(before.questions.map((q) => q.unknownId)).toContain('p1:u-join');
    expect(await app.run('a', answer('yes', before.throughSeq))).toMatchObject({ status: 'ok' });
    const after = await app.plan();
    expect(after.questions.map((q) => q.unknownId)).not.toContain('p1:u-join');
    expect(after.tasks.some((t) => t.key === 'task:submit:p1:s1' && t.live)).toBe(true);
  });

  it('番号の無い答えと、古い番号・先の番号の答えを断る（記録は進まない）', async () => {
    const app = await setup();
    const { throughSeq } = await app.plan();
    expect(await app.run('a', answer('yes'))).toMatchObject({
      status: 'invalid',
      reason: 'seenRequired',
    });
    for (const seen of [throughSeq - 1, throughSeq + 1]) {
      expect(await app.run('a', answer('yes', seen))).toMatchObject({
        status: 'conflict',
        reason: 'proposalChanged',
      });
    }
    expect((await app.plan()).throughSeq).toBe(throughSeq);
  });

  it('もう一人が先に答えた後の、古い札の答えを断る（同じ値でも）', async () => {
    const app = await setup();
    const { throughSeq } = await app.plan();
    expect(await app.run('a', answer('no', throughSeq))).toMatchObject({ status: 'ok' });
    for (const value of ['yes', 'no']) {
      expect(await app.run('b', answer(value, throughSeq))).toMatchObject({
        status: 'conflict',
        reason: 'proposalChanged',
      });
    }
  });

  it('問いの札からの答えは、今の時刻の問いが見せた物と同じ時だけ受ける（期限が過ぎた古い札を断る）', async () => {
    const app = await setup();
    const shown = (await app.plan()).questions.find((q) => q.unknownId === 'p1:u-join');
    if (!shown) throw new Error('問いが無い');
    const { throughSeq } = await app.plan();
    const card = { key: shown.key, until: shown.until, affects: shown.affects };
    // 事象は何も足されないまま、期限（11/30 17:00）が過ぎた。古い札の答えは断る。
    const late = '2026-11-30T17:00+09:00';
    expect((await app.plan(late)).questions.some((q) => q.unknownId === 'p1:u-join')).toBe(false);
    expect(await app.run('a', fromCard('yes', throughSeq, card), late)).toMatchObject({
      status: 'conflict',
      reason: 'proposalChanged',
    });
    // 見せた物と違う問い（期限や変わる要件が違う）も断る。
    expect(
      await app.run('a', fromCard('yes', throughSeq, { ...card, until: '2026-11-29T17:00+09:00' })),
    ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
    expect(await app.run('a', fromCard('yes', throughSeq, { ...card, affects: [] }))).toMatchObject(
      { status: 'conflict', reason: 'proposalChanged' },
    );
    // 期限の前で、見せた物と同じなら受ける。
    expect(await app.run('a', fromCard('yes', throughSeq, card))).toMatchObject({ status: 'ok' });
  });

  it('札でない答え（一言など）は、問いが期限で消えた後も、家族の決めごととして記録する', async () => {
    const app = await setup();
    const late = '2026-12-01T09:00+09:00';
    const { throughSeq } = await app.plan(late);
    expect(await app.run('a', answer('no', throughSeq), late)).toMatchObject({ status: 'ok' });
  });

  it('家族の値でない未定の値（発表会の日）は、今までどおり番号なしで答えられる', async () => {
    const app = await setup();
    expect(
      await app.run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' }),
    ).toMatchObject({ status: 'ok' });
  });

  it('期限が過ぎて一つの要件が外れ、同じ問いが残っても、変わる前の札の答えは受けない', async () => {
    const app = await setup();
    const second = '参加される方は、12月2日(水)17:00までに保護者証も提出してください。';
    await app.correct([TEXT, second], (before) => {
      const [first] = before.items;
      if (!first) throw new Error('事項が無い');
      return {
        ...before,
        items: [
          first,
          {
            ...first,
            id: 'p1:s2',
            sentenceIds: ['p1#2'],
            written: second,
            interpretation: { what: '保護者証', deadline: '2026-12-02T17:00+09:00' },
          },
        ],
      };
    });
    const before = await app.plan();
    const shown = before.questions.find((q) => q.unknownId === 'p1:u-join');
    if (!shown) throw new Error('問いが無い');
    expect(shown.affects).toHaveLength(2);
    const card = { key: shown.key, until: shown.until, affects: shown.affects };
    const late = '2026-11-30T17:00+09:00';
    const now = (await app.plan(late)).questions.find((q) => q.unknownId === 'p1:u-join');
    expect(now).toMatchObject({ until: '2026-12-02T17:00+09:00' });
    expect(now?.affects).toHaveLength(1);
    expect(await app.run('a', fromCard('yes', before.throughSeq, card), late)).toMatchObject({
      status: 'conflict',
      reason: 'proposalChanged',
    });
    if (!now) return;
    const fresh = { key: now.key, until: now.until, affects: now.affects };
    expect(await app.run('a', fromCard('yes', before.throughSeq, fresh), late)).toMatchObject({
      status: 'ok',
    });
  });

  it('文を直して読み直す前は、問いを出さず、答え（札でも一言でも）を受けない', async () => {
    const app = await setup();
    await app.correct(['欠席される方は、欠席届を提出してください。']);
    const pending = await app.plan();
    expect(pending.questions.map((q) => q.unknownId)).not.toContain('p1:u-join');
    for (const command of [
      answer('yes', pending.throughSeq),
      fromCard('yes', pending.throughSeq, { key: 'q:p1:u-join', affects: [] }),
    ]) {
      expect(await app.run('a', command)).toMatchObject({
        status: 'conflict',
        reason: 'rereadPending',
      });
    }
  });

  it('答えた後、読み直しで同じ ID が別の問いになれば、前の答えを当てずに聞き直す', async () => {
    const app = await setup();
    const before = await app.plan();
    expect(await app.run('a', answer('yes', before.throughSeq))).toMatchObject({ status: 'ok' });
    const absent = '欠席される方は、11月30日(月)17:00までに欠席届を提出してください。';
    await app.correct([absent], (old) => ({
      ...old,
      unknowns: old.unknowns.map((u) => ({ ...u, label: '親子清掃を欠席するか' })),
      items: old.items.map((i) => ({
        ...i,
        written: absent,
        interpretation: { what: '欠席届', deadline: '2026-11-30T17:00+09:00' },
      })),
    }));
    const after = await app.plan();
    expect(after.questions.find((q) => q.unknownId === 'p1:u-join')?.family).toMatchObject({
      label: '親子清掃を欠席するか',
      previous: 'yes',
    });
  });

  it('答えた後、もう一人が事項の中身（締切）を直せば、前の答えを当てずに聞き直す', async () => {
    const app = await setup();
    const before = await app.plan();
    expect(await app.run('a', answer('yes', before.throughSeq))).toMatchObject({ status: 'ok' });
    expect((await app.plan()).questions.map((q) => q.unknownId)).not.toContain('p1:u-join');
    expect(
      await app.run('b', {
        type: 'correctItem',
        itemId: 'p1:s1',
        interpretation: { what: '申込書', deadline: '2026-12-04T17:00+09:00' },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await app.plan();
    expect(after.questions.find((q) => q.unknownId === 'p1:u-join')).toMatchObject({
      until: '2026-12-04T17:00+09:00',
      family: { previous: 'yes' },
    });
  });
});
