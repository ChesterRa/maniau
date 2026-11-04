// 計画に入っている「すること」（家族の言明か、家族が確かめた読み取り）を直す・要らないにする（correctItem・
// dismissItem）。保存の前に「この変更で変わること」を見せ、見た計画の番号と見た物が今と同じ時だけ書く。直すと、前の
// 中身への選び・引き受け・「はい」を今の中身に当てない（選び直し・確かめ）。要らないにすると、送った依頼には取り消しの
// 連絡が要る。まだ確かめていない読み取りは今の決まりのまま（番号だけ）。架空のデモの家。Claude の API は呼ばない。
import {
  type Item,
  type NeedInterpretation,
  proposalSnapshot,
  type SaveablePreview,
} from '@maniau/core';
import { computePlan, foldEvents, itemsOf } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { type EventBody, memoryStore } from '../src/store';

const NOW = '2026-11-25T20:00+09:00';
const NEED: NeedInterpretation = {
  what: '陽菜を家で見る',
  shape: 'window',
  date: '2026-11-26',
  startTime: '08:00',
  endTime: '18:00',
  forMemberId: 'c',
};

async function setup() {
  const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let sequence = 0;
  const run = (command: Parameters<typeof runCommand>[3]) =>
    runCommand(
      store,
      'demo',
      { memberId: 'b', now: NOW, operationId: `edit-${++sequence}`, demo: true },
      command,
    );
  const plan = async () => computePlan(await events(), NOW);
  const preview = async (command: SaveablePreview) =>
    previewChange(await events(), { memberId: 'b', now: NOW }, command);
  const previewed = async (command: SaveablePreview) => {
    const shown = await preview(command);
    if ('reason' in shown) return shown;
    return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
  };
  const append = (bodies: EventBody[], actorId = 'b') =>
    store.withHousehold('demo', (log) => log.append(bodies, actorId, NOW));
  return { events, run, plan, preview, previewed, append };
}

/** 言明の「すること」に祖母のやり方を選び、本命にして頼み、「はい」をもらった家。 */
async function askedAndYes() {
  const app = await setup();
  expect(
    await app.previewed({
      type: 'stateNeed',
      text: 'あしたは陽菜を家で見る。',
      interpretation: NEED,
    }),
  ).toMatchObject({ status: 'ok' });
  const itemId = (await app.plan()).requirements.find((r) => r.kind === 'need' && r.live)?.basis
    .itemIds[0];
  if (!itemId) throw new Error('言明の「すること」が無い');
  expect(
    await app.previewed({ type: 'setNeedWays', itemId, wayIds: ['way-grandma'] }),
  ).toMatchObject({ status: 'ok' });
  let p = await app.plan();
  const arrangement = p.arrangements.find((a) => a.kind === 'need' && a.live);
  const option = arrangement?.options[0];
  if (!arrangement || !option) throw new Error('案が無い');
  expect(
    await app.run({
      type: 'chooseOption',
      arrangementKey: arrangement.key,
      optionKey: option.key,
      role: 'primary',
      assigneeId: 'b',
    }),
  ).toMatchObject({ status: 'ok' });
  p = await app.plan();
  const ask = p.tasks.find((t) => t.basis.optionKey === option.key && t.external);
  const shown = ask && proposalSnapshot(ask);
  if (!ask || !shown) throw new Error('頼む作業が無い');
  expect(await app.run({ type: 'accept', taskKey: ask.key, shown })).toMatchObject({
    status: 'ok',
  });
  expect(
    await app.run({
      type: 'recordSent',
      taskKey: ask.key,
      requestId: 'r-1',
      window: { start: arrangement.start, end: arrangement.end },
    }),
  ).toMatchObject({ status: 'ok' });
  expect(await app.run({ type: 'recordReply', requestId: 'r-1', reply: 'yes' })).toMatchObject({
    status: 'ok',
  });
  return { ...app, itemId, key: arrangement.key };
}

/** 検証器の違反（計画と事象から独立に確かめる）。 */
const violations = async (app: Awaited<ReturnType<typeof setup>>) => {
  const all = await app.events();
  const household = foldEvents(all).household;
  if (!household) throw new Error('家の情報が無い');
  return verifyPlan({ household, plan: computePlan(all, NOW), events: all }).issues.filter(
    (i) => i.kind === 'violation',
  );
};

describe('計画に入っている「すること」を直す', () => {
  it('日を直すと、選び直しと依頼の確かめを見せてから書き、前の日の「はい」で新しい日を覆ったとは言わない', async () => {
    const app = await askedAndYes();
    const command: SaveablePreview = {
      type: 'correctItem',
      itemId: app.itemId,
      interpretation: { date: '2026-11-27' },
    };
    const shown = await app.preview(command);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.rechoose).toEqual([app.key]);
    expect(shown.changes.checks.map((r) => r.requestId)).toEqual(['r-1']);
    expect(shown.changes.cancels).toEqual([]);
    expect(
      await app.run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } }),
    ).toMatchObject({ status: 'ok' });
    const p = await app.plan();
    const arrangement = p.arrangements.find((a) => a.key === app.key);
    expect(arrangement?.start).toBe('2026-11-27T08:00+09:00');
    expect(arrangement?.options).toEqual([]);
    expect(arrangement?.reasons).toContainEqual({ code: 'inputMissing', refs: ['waysChanged'] });
    expect(p.requests.find((r) => r.requestId === 'r-1')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(p.tasks.some((t) => t.cancels === 'r-1')).toBe(false);
    expect(await violations(app)).toEqual([]);
  });

  it('見ていない・見た後に計画が進んだ・見た物と違う直しは書かない', async () => {
    const app = await askedAndYes();
    const command: SaveablePreview = {
      type: 'correctItem',
      itemId: app.itemId,
      interpretation: { endTime: '17:00' },
    };
    expect(await app.run(command)).toMatchObject({ status: 'invalid', reason: 'seenRequired' });
    const p = await app.plan();
    expect(await app.run({ ...command, seen: { throughSeq: p.throughSeq } })).toMatchObject({
      status: 'invalid',
      reason: 'seenRequired',
    });
    const shown = await app.preview(command);
    if ('reason' in shown) throw new Error(shown.reason);
    // 見た物と違う中身（見たのは 17:00）。
    expect(
      await app.run({
        ...command,
        interpretation: { endTime: '16:00' },
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'consequencesChanged' });
    // 見た後に、計画が進んだ（デモの時計を進める事象が入った）。
    expect(await app.run({ type: 'advanceClock', to: '2026-11-25T20:01+09:00' })).toMatchObject({
      status: 'ok',
    });
    expect(
      await app.run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } }),
    ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
  });
});

describe('「だれのため」を外す', () => {
  it('null で外すと、前の「だれのため」が残らず、送った依頼は相手への確かめになる', async () => {
    const app = await askedAndYes();
    const command: SaveablePreview = {
      type: 'correctItem',
      itemId: app.itemId,
      interpretation: { forMemberId: null },
    };
    const shown = await app.preview(command);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.checks.map((r) => r.requestId)).toEqual(['r-1']);
    expect(
      await app.run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } }),
    ).toMatchObject({ status: 'ok' });
    const item = itemsOf(foldEvents(await app.events())).find((i) => i.id === app.itemId);
    expect(item?.interpretation).not.toHaveProperty('forMemberId');
    expect((await app.plan()).requests.find((r) => r.requestId === 'r-1')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(await violations(app)).toEqual([]);
  });

  it('外した後に選び直せば、その人になる（後の直しが前の null に代わる）', async () => {
    const app = await askedAndYes();
    for (const forMemberId of [null, 'a']) {
      const command: SaveablePreview = {
        type: 'correctItem',
        itemId: app.itemId,
        interpretation: { forMemberId },
      };
      const shown = await app.preview(command);
      if ('reason' in shown) throw new Error(shown.reason);
      expect(
        await app.run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } }),
      ).toMatchObject({ status: 'ok' });
    }
    const item = itemsOf(foldEvents(await app.events())).find((i) => i.id === app.itemId);
    expect(item?.interpretation.forMemberId).toBe('a');
  });
});

describe('計画に入っている「すること」を要らないにする', () => {
  it('送った依頼への取り消しの連絡を見せてから書き、書くと依頼は要らなくなり、取り消しの作業ができる', async () => {
    const app = await askedAndYes();
    const command: SaveablePreview = { type: 'dismissItem', itemId: app.itemId, reason: 'other' };
    expect(await app.run(command)).toMatchObject({ status: 'invalid', reason: 'seenRequired' });
    const shown = await app.preview(command);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(shown.changes.cancels.map((r) => r.requestId)).toEqual(['r-1']);
    expect(
      await app.run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } }),
    ).toMatchObject({ status: 'ok' });
    const p = await app.plan();
    expect(p.arrangements.some((a) => a.key === app.key && a.live)).toBe(false);
    expect(p.requests.find((r) => r.requestId === 'r-1')?.live).toBe(false);
    expect(p.tasks.some((t) => t.live && t.cancels === 'r-1')).toBe(true);
    expect(await violations(app)).toEqual([]);
  });
});

describe('ほかの事項と、まだ確かめていない読み取り', () => {
  it('「すること」でない事項は、この見せ方を使わない（今の札の確かめのまま）', async () => {
    const app = await setup();
    const other = itemsOf(foldEvents(await app.events())).find((i) => i.kind !== 'need');
    if (!other) throw new Error('「すること」でない事項が無い');
    expect(
      await app.preview({ type: 'dismissItem', itemId: other.id, reason: 'notOurs' }),
    ).toMatchObject({ status: 'invalid', reason: 'previewNeedOnly' });
  });

  it('まだ確かめていない読み取りの「すること」は、見せた番号だけで直せる（直すと計画に入る）', async () => {
    const app = await setup();
    const item: Item = {
      id: 'n-1:i1',
      sourceId: 'n-1',
      sentenceIds: ['n-1#1'],
      kind: 'need',
      written: '26日は8時から18時まで、大人がいてください。',
      interpretation: { what: '家で子を見る', shape: 'window', date: '2026-11-26' },
      evidence: 'stated',
      effects: [],
    };
    await app.append([
      {
        type: 'noticeReceived',
        source: {
          id: 'n-1',
          version: 1,
          receivedAt: NOW,
          sender: 'school',
          language: 'ja',
          medium: 'text',
          sentences: [{ id: 'n-1#1', text: item.written }],
        },
      },
    ]);
    await app.append(
      [
        {
          type: 'modelOutputRecorded',
          call: 'extract',
          sourceId: 'n-1',
          sourceVersion: 1,
          model: 'fixture',
          promptVersion: 'fixture',
          inputHash: 'n-1',
          output: {
            sourceId: 'n-1',
            items: [item],
            unknowns: [],
            conditions: [],
            irrelevantSentenceIds: [],
            ambiguities: [],
          },
        },
      ],
      'system',
    );
    const p = await app.plan();
    expect(p.requirements.find((r) => r.basis.itemIds.includes(item.id))).toMatchObject({
      unconfirmed: true,
    });
    // 見せる物も出せる（直すと計画に入る）が、書く時に要るのは見せた番号だけ。
    const shown = await app.preview({
      type: 'correctItem',
      itemId: item.id,
      interpretation: { startTime: '08:00', endTime: '18:00' },
    });
    expect('reason' in shown).toBe(false);
    expect(
      await app.run({
        type: 'correctItem',
        itemId: item.id,
        interpretation: { startTime: '08:00', endTime: '18:00' },
        seen: { throughSeq: p.throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await app.plan();
    expect(after.requirements.find((r) => r.basis.itemIds.includes(item.id))?.unconfirmed).toBe(
      undefined,
    );
  });
});
