// 送った依頼が今も要るかを、家族の決めごとの順で決める（読み取りや中身が替わっても、家族の決めごとは消えない）。
// - お知らせから読んだ「すること」を確かめ、外の相手に頼んで「はい」をもらった後に、お知らせの文が直されて読み直すと、
//   新しい読み取りは家族の確かめを待つ（手配は確かめるまで作らない）。その間、前の依頼は取り消さず、要るかを確かめる
//   物にする（確かめていない読み取りで、取り消しの連絡を作らない）。確かめれば元に戻り、外せば取り消しの連絡が要る。
// - 送った後に家族が外した・選び替えた依頼は、その後に読み直し（同じ中身・日の違う中身・事項が見つからない）や、日の
//   直しがあっても、要らないまま（取り消しの連絡を消さない）。家族がやり方を足し直して本命・予備が戻れば、依頼も戻る。
//   ほかの案が本命になっていれば、足し直しただけでは戻らない。取り消しを送った依頼は、選び直しても取り消したまま。
// 読み取りは手で書いた架空の物で、モデルの出力ではない。Claude の API は呼ばない。
import {
  type DomainEvent,
  type Item,
  type PlanResult,
  type PreviewCommand,
  proposalSnapshot,
} from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { type EventBody, memoryStore } from '../src/store';

const NOW = '2026-11-25T20:00+09:00';
const ITEM: Item = {
  id: 'n-1:i1',
  sourceId: 'n-1',
  sentenceIds: ['n-1#1'],
  kind: 'need',
  written: '26日は8時から18時まで、大人がいてください。',
  interpretation: {
    what: '家で子を見る大人がいる',
    shape: 'window',
    date: '2026-11-26',
    startTime: '08:00',
    endTime: '18:00',
  },
  evidence: 'stated',
  effects: [],
};
/** 読み直した日の違う読み取り（同じ事項 ID）。 */
const MOVED: Item = {
  ...ITEM,
  written: '27日は8時から18時まで、大人がいてください。',
  interpretation: { ...ITEM.interpretation, date: '2026-11-27' },
};
const reading = (sourceVersion: number, items: Item[] = [ITEM]): EventBody => ({
  type: 'modelOutputRecorded',
  call: 'extract',
  sourceId: 'n-1',
  sourceVersion,
  model: 'fixture',
  promptVersion: 'fixture',
  inputHash: `n-1-v${sourceVersion}`,
  output: {
    sourceId: 'n-1',
    items,
    unknowns: [],
    conditions: [],
    irrelevantSentenceIds: items.length === 0 ? ['n-1#1'] : [],
    ambiguities: [],
  },
});

/** 確かめて、祖母に頼み、「はい」をもらった家庭（読み直しの前）。 */
async function askedAndYes() {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  await store.withHousehold('demo', (log) => {
    log.append(
      [
        {
          type: 'noticeReceived',
          source: {
            id: 'n-1',
            version: 1,
            receivedAt: NOW,
            sender: 'school',
            language: 'ja',
            medium: 'text',
            sentences: [{ id: 'n-1#1', text: ITEM.written }],
          },
        },
      ],
      'b',
      NOW,
    );
    log.append([reading(1)], 'system', NOW);
  });
  const events = (): Promise<DomainEvent[]> =>
    store.withHousehold('demo', (log) => [...log.events()]);
  const plan = async (): Promise<PlanResult> => computePlan(await events(), NOW);
  let serial = 0;
  const run = (command: Parameters<typeof runCommand>[3]) =>
    runCommand(
      store,
      'demo',
      { memberId: 'b', now: NOW, operationId: `op-${++serial}`, demo: true },
      command,
    );
  /** 見てから書く（見た計画の番号と要約を付ける）。 */
  const previewed = async (command: PreviewCommand) => {
    const shown = previewChange(await events(), { memberId: 'b', now: NOW }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
  };
  const ways = (wayIds: string[]) => previewed({ type: 'setNeedWays', itemId: ITEM.id, wayIds });
  const ok = { status: 'ok' };
  expect(
    await run({
      type: 'confirmItem',
      itemId: ITEM.id,
      seen: { throughSeq: (await plan()).throughSeq },
    }),
  ).toMatchObject(ok);
  expect(await ways(['way-grandma'])).toMatchObject(ok);
  let p = await plan();
  const arrangement = p.arrangements.find((a) => a.kind === 'need' && a.live);
  const option = arrangement?.options[0];
  if (!arrangement || !option) throw new Error('案が無い');
  const choose = (optionKey: string) =>
    run({
      type: 'chooseOption',
      arrangementKey: arrangement.key,
      optionKey,
      role: 'primary',
      assigneeId: 'b',
    });
  expect(await choose(option.key)).toMatchObject(ok);
  p = await plan();
  const ask = p.tasks.find((t) => t.basis.optionKey === option.key && t.external);
  const snapshot = ask && proposalSnapshot(ask);
  if (!ask || !snapshot) throw new Error('頼む作業が無い');
  expect(await run({ type: 'accept', taskKey: ask.key, shown: snapshot })).toMatchObject(ok);
  expect(
    await run({
      type: 'recordSent',
      taskKey: ask.key,
      requestId: 'r-1',
      window: { start: arrangement.start, end: arrangement.end },
    }),
  ).toMatchObject(ok);
  expect(await run({ type: 'recordReply', requestId: 'r-1', reply: 'yes' })).toMatchObject(ok);
  /** 文を直して読み直す（読み直した事項は、家族の確かめを待つ）。 */
  const reread = (items: readonly Item[] = [ITEM]) =>
    store.withHousehold('demo', (log) => {
      log.append(
        [
          {
            type: 'transcriptionCorrected',
            sourceId: 'n-1',
            sourceVersion: 2,
            sentences: [{ id: 'n-1#1', text: items[0]?.written ?? '（読めない）' }],
          },
        ],
        'b',
        NOW,
      );
      log.append([reading(2, [...items])], 'system', NOW);
    });
  const drop = () =>
    run({ type: 'dropOption', arrangementKey: arrangement.key, optionKey: option.key });
  return {
    plan,
    run,
    previewed,
    ways,
    choose,
    drop,
    reread,
    arrangementKey: arrangement.key,
    optionKey: option.key,
  };
}

/** 依頼が要らず、取り消しの連絡の作業がある。 */
async function cancelled(plan: () => Promise<PlanResult>) {
  const p = await plan();
  expect(p.requests.find((r) => r.requestId === 'r-1')?.live).toBe(false);
  expect(p.tasks.some((t) => t.live && t.cancels === 'r-1')).toBe(true);
}
/** 依頼が要り（確かめが要るかは needsCheck）、取り消しの連絡は無い。 */
async function standing(plan: () => Promise<PlanResult>, needsCheck: boolean) {
  const p = await plan();
  const request = p.requests.find((r) => r.requestId === 'r-1');
  expect(request?.live).toBe(true);
  expect(request?.needsCheck === true).toBe(needsCheck);
  expect(p.tasks.some((t) => t.live && t.cancels === 'r-1')).toBe(false);
}

describe('読み直しで確かめを待つ「すること」の、前の依頼', () => {
  it('確かめるまで、「はい」をもらった依頼を取り消さず、要るかを確かめる物にする', async () => {
    const app = await askedAndYes();
    await app.reread();
    expect(
      (await app.plan()).requirements.find((r) => r.basis.itemIds.includes(ITEM.id)),
    ).toMatchObject({ unconfirmed: true });
    await standing(app.plan, true);
  });

  it('同じ中身を確かめれば、依頼は元のまま（疑いも取り消しも無い）', async () => {
    const app = await askedAndYes();
    await app.reread();
    expect(
      await app.run({
        type: 'confirmItem',
        itemId: ITEM.id,
        seen: { throughSeq: (await app.plan()).throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    await standing(app.plan, false);
  });

  it('家族が外せば、依頼は要らなくなり、取り消しの連絡が要る', async () => {
    const app = await askedAndYes();
    await app.reread();
    expect(
      await app.run({
        type: 'dismissItem',
        itemId: ITEM.id,
        reason: 'misread',
        seen: { throughSeq: (await app.plan()).throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    await cancelled(app.plan);
  });
});

describe('送った後に家族が外した依頼は、中身が替わっても要らないまま', () => {
  it('案を外した（dropOption）後の読み直し', async () => {
    const app = await askedAndYes();
    expect(await app.drop()).toMatchObject({ status: 'ok' });
    await cancelled(app.plan);
    await app.reread();
    await cancelled(app.plan);
  });

  it.each([
    ['同じ中身の読み直し', [ITEM]],
    ['日の違う読み直し（同じ事項 ID）', [MOVED]],
    ['事項が見つからない読み直し', []],
  ] as const)('やり方を選び替えた後の%s', async (_, items) => {
    const app = await askedAndYes();
    expect(await app.ways(['way-sick-care'])).toMatchObject({ status: 'ok' });
    await cancelled(app.plan);
    await app.reread(items);
    await cancelled(app.plan);
  });

  it('やり方を選び替えた後に、家族が日を直した（手配はある）', async () => {
    const app = await askedAndYes();
    expect(await app.ways(['way-sick-care'])).toMatchObject({ status: 'ok' });
    // 計画に入っている「すること」の直しは、見てから書く。
    expect(
      await app.previewed({
        type: 'correctItem',
        itemId: ITEM.id,
        interpretation: { date: '2026-11-27' },
      }),
    ).toMatchObject({ status: 'ok' });
    await cancelled(app.plan);
  });
});

describe('家族が選び直した時', () => {
  it('やり方を足し直せば、本命が戻り、依頼も戻る。もう一度外せば、また要らない', async () => {
    const app = await askedAndYes();
    expect(await app.ways(['way-sick-care'])).toMatchObject({ status: 'ok' });
    await cancelled(app.plan);
    expect(await app.ways(['way-sick-care', 'way-grandma'])).toMatchObject({ status: 'ok' });
    expect(
      (await app.plan()).arrangements.find((a) => a.key === app.arrangementKey)?.chosenOptionKey,
    ).toBe(app.optionKey);
    await standing(app.plan, false);
    expect(await app.ways(['way-sick-care'])).toMatchObject({ status: 'ok' });
    await cancelled(app.plan);
  });

  it('ほかの案を本命にした後は、やり方を足し直しただけでは依頼は戻らない', async () => {
    const app = await askedAndYes();
    expect(await app.ways(['way-sick-care'])).toMatchObject({ status: 'ok' });
    const sick = `opt:${app.arrangementKey}:way-sick-care`;
    expect(await app.choose(sick)).toMatchObject({ status: 'ok' });
    expect(await app.ways(['way-sick-care', 'way-grandma'])).toMatchObject({ status: 'ok' });
    expect(
      (await app.plan()).arrangements.find((a) => a.key === app.arrangementKey)?.chosenOptionKey,
    ).toBe(sick);
    await cancelled(app.plan);
  });

  it('外した案を本命に選び直せば、依頼は戻る', async () => {
    const app = await askedAndYes();
    expect(await app.drop()).toMatchObject({ status: 'ok' });
    await cancelled(app.plan);
    expect(await app.choose(app.optionKey)).toMatchObject({ status: 'ok' });
    await standing(app.plan, false);
  });

  it('取り消しを送った依頼は、案を選び直しても取り消したまま（前の「はい」を当てない）', async () => {
    const app = await askedAndYes();
    expect(await app.drop()).toMatchObject({ status: 'ok' });
    expect(await app.run({ type: 'recordCancellationSent', requestId: 'r-1' })).toMatchObject({
      status: 'ok',
    });
    expect(await app.choose(app.optionKey)).toMatchObject({ status: 'ok' });
    const p = await app.plan();
    expect(p.requests.find((r) => r.requestId === 'r-1')?.state).toBe('cancelled');
    expect(p.tasks.some((t) => t.live && t.cancels === 'r-1')).toBe(false);
    // 取り消した依頼の「はい」で、受け持ったとは数えない（頼み直しが要る）。
    expect(
      p.arrangements
        .find((a) => a.key === app.arrangementKey)
        ?.reasons.some((r) => r.code === 'notCovered'),
    ).toBe(true);
  });
});
