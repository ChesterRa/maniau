// 変更と排除を正式な命令で記録し、検証器が事象から不正な計画を独立に検出する。架空のデモの家。API は呼ばない。
import { type NeedInterpretation, proposalSnapshot, type SaveablePreview } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

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
  return { events, run, plan, preview, previewed };
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

describe('独立監査：変更後の計画を検証器が事象と照らす', () => {
  it('日を直しても旧依頼の確認印を落とした計画は違反', async () => {
    const app = await askedAndYes();
    expect(
      await app.previewed({
        type: 'correctItem',
        itemId: app.itemId,
        interpretation: { date: '2026-11-27' },
      }),
    ).toMatchObject({ status: 'ok' });
    const events = await app.events();
    const household = foldEvents(events).household;
    if (!household) throw new Error('家の情報が無い');
    const correct = computePlan(events, NOW);
    const baseline = verifyPlan({ household, plan: correct, events });
    expect(baseline.issues.filter((i) => i.kind === 'violation')).toEqual([]);
    const wrong = structuredClone(correct);
    const request = wrong.requests.find((r) => r.requestId === 'r-1');
    if (!request) throw new Error('頼んだ控えが無い');
    expect(request.needsCheck).toBe(true);
    delete request.needsCheck;
    const report = verifyPlan({ household, plan: wrong, events });
    expect(report.issues.filter((i) => i.kind === 'violation').map((i) => i.code)).toContain(
      'request_uncertainty_unmarked',
    );
  });
  it('だれのためかを外しても旧依頼の確認印を落とした計画は違反', async () => {
    const app = await askedAndYes();
    expect(
      await app.previewed({
        type: 'correctItem',
        itemId: app.itemId,
        interpretation: { forMemberId: null },
      }),
    ).toMatchObject({ status: 'ok' });
    const events = await app.events();
    const household = foldEvents(events).household;
    if (!household) throw new Error('家の情報が無い');
    const correct = computePlan(events, NOW);
    expect(
      verifyPlan({ household, plan: correct, events }).issues.filter((i) => i.kind === 'violation'),
    ).toEqual([]);
    const wrong = structuredClone(correct);
    const request = wrong.requests.find((r) => r.requestId === 'r-1');
    if (!request) throw new Error('頼んだ控えが無い');
    expect(request.needsCheck).toBe(true);
    delete request.needsCheck;
    const report = verifyPlan({ household, plan: wrong, events });
    expect(report.issues.filter((i) => i.kind === 'violation').map((i) => i.code)).toContain(
      'request_uncertainty_unmarked',
    );
  });
  it('外した後に取り消しの連絡を落とした計画は違反', async () => {
    const app = await askedAndYes();
    expect(
      await app.previewed({
        type: 'dismissItem',
        itemId: app.itemId,
        reason: 'other',
      }),
    ).toMatchObject({ status: 'ok' });
    const events = await app.events();
    const household = foldEvents(events).household;
    if (!household) throw new Error('家の情報が無い');
    const correct = computePlan(events, NOW);
    expect(
      verifyPlan({ household, plan: correct, events }).issues.filter((i) => i.kind === 'violation'),
    ).toEqual([]);
    const wrong = structuredClone(correct);
    expect(wrong.tasks.some((t) => t.cancels === 'r-1')).toBe(true);
    wrong.tasks = wrong.tasks.filter((t) => t.cancels !== 'r-1');
    const report = verifyPlan({ household, plan: wrong, events });
    expect(report.issues.filter((i) => i.kind === 'violation').map((i) => i.code)).toContain(
      'cancellation_missing',
    );
  });
});
