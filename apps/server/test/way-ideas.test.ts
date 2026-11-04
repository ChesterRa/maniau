// デモの家庭で、新しい「すること」に Claude がやり方の案を出す（W4）。案を作るだけで何も書かない。数と同時に読む数を
// 抑え、同じ操作 ID は作り直さない。作る間に前提が変わったら、古い案を見せない。架空のデモの家。Claude の API は
// 呼ばない（偽物の読み手）。
import type { Command, PreviewCommand, WayIdeasContext, WayIdeasOutput } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { demoSessions, type WayIdeasReader } from '../src/demo-sessions';
import { ReadingError } from '../src/reading/extract';

const OUTPUT: WayIdeasOutput = {
  drafts: [
    {
      name: '祖母に出てもらう',
      why: '祖母が交流会に出る',
      steps: [
        {
          name: '祖母に出てもらえるか聞く',
          quote: '祖母に頼めるかも',
          assignee: { kind: 'adult', id: 'b' },
          counterpart: { kind: 'helper', id: 'g', name: null, quote: null },
          place: { kind: 'none', id: null, name: null, quote: null },
          minutes: 5,
          segments: ['home', 'commute', 'work'],
          cover: true,
        },
      ],
      covers: 'whole',
      cost: { leaveMinutes: null, extraTasks: null },
      unclear: ['祖母が出てよい会か、書かれていません'],
    },
  ],
  reuse: [{ wayId: 'way-grandma', why: '祖母に来てもらう手立てが、もうある' }],
  missing: [],
};

function reader(during?: () => Promise<void>, fail?: Error) {
  const contexts: WayIdeasContext[] = [];
  const read: WayIdeasReader = async (context) => {
    contexts.push(context);
    await during?.();
    if (fail) throw fail;
    return {
      output: OUTPUT,
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };
  return { read, contexts };
}

/** 交流会の「すること」を言った（計画に入っている）デモ。 */
async function setup(limits: { perDay?: number } = {}) {
  const sessions = demoSessions(Date.now, limits);
  const id = sessions.create('arrived');
  let op = 0;
  const run = async (command: Command) => {
    const done = await sessions.command(id, 'b', `op-${++op}`, command);
    expect(done?.result).toMatchObject({ status: 'ok' });
    return done;
  };
  const previewed = async (command: PreviewCommand) => {
    const shown = await sessions.changePreview(id, 'b', command);
    if (!shown || 'reason' in shown) throw new Error('見られない');
    return run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } });
  };
  const done = await previewed({
    type: 'stateNeed',
    text: '12月12日の13時から14時に地域交流会に出る。',
    interpretation: {
      what: '地域交流会に出る',
      shape: 'window',
      date: '2026-12-12',
      startTime: '13:00',
      endTime: '14:00',
    },
  });
  const plan = done?.view.plan;
  const requirement = plan?.requirements.find((r) => r.kind === 'need' && r.live);
  const arrangement = plan?.arrangements.find((a) => a.requirementKey === requirement?.key);
  const itemId = requirement?.basis.itemIds[0];
  if (!arrangement || !itemId) throw new Error('手配が無い');
  const seq = async () => (await sessions.view(id, 'b'))?.throughSeq;
  return { sessions, id, key: arrangement.key, itemId, previewed, seq };
}

const input = (arrangementKey: string, operationId = 'w-1', text = '祖母に頼めるかも。') => ({
  arrangementKey,
  text,
  language: 'ja' as const,
  operationId,
});

describe('デモの家庭で、やり方の案を出す', () => {
  it('「すること」と家の名前を送り、確かめた案と送った物を返す。何も書かない', async () => {
    const t = await setup();
    const before = await t.seq();
    const { read, contexts } = reader();
    const done = await t.sessions.wayIdeas(t.id, 'b', input(t.key), read);
    expect(done?.status).toBe('ok');
    if (done?.status !== 'ok') return;
    expect(contexts).toHaveLength(1);
    expect(done.sent).toEqual(contexts[0]);
    expect(done.sent.need).toMatchObject({
      what: '地域交流会に出る',
      shape: 'window',
      date: '2026-12-12',
      start: '13:00',
      end: '14:00',
    });
    expect(done.sent.familyWords).toBe('祖母に頼めるかも。');
    expect(done.ideas.drafts[0]?.steps[0]).toMatchObject({
      quote: '祖母に頼めるかも',
      counterpart: { kind: 'helper', id: 'g' },
    });
    expect(done.ideas.drafts[0]?.cost.helperRequests).toBe(1);
    expect(done.ideas.reuse).toEqual([
      { wayId: 'way-grandma', why: '祖母に来てもらう手立てが、もうある' },
    ]);
    expect(await t.seq()).toBe(before);
  });

  it('同じ操作 ID は作り直さずに同じ案を返す。中身が違えば断る', async () => {
    const t = await setup();
    const { read, contexts } = reader();
    const first = await t.sessions.wayIdeas(t.id, 'b', input(t.key), read);
    const again = await t.sessions.wayIdeas(t.id, 'b', input(t.key), read);
    expect(again).toEqual(first);
    expect(contexts).toHaveLength(1);
    expect(await t.sessions.wayIdeas(t.id, 'b', input(t.key, 'w-1', '別の考え'), read)).toEqual({
      status: 'conflict',
    });
  });

  it('手配が無い・家族の大人でない時は、呼ばずに断り、数えない', async () => {
    const t = await setup({ perDay: 1 });
    const { read, contexts } = reader();
    expect(await t.sessions.wayIdeas(t.id, 'b', input('arr:need:none'), read)).toEqual({
      status: 'needGone',
    });
    expect(await t.sessions.wayIdeas(t.id, 'c', input(t.key, 'w-2'), read)).toEqual({
      status: 'invalid',
    });
    expect(contexts).toHaveLength(0);
    // 断った物は数えていないので、一日の一回はまだ使える。
    expect((await t.sessions.wayIdeas(t.id, 'b', input(t.key, 'w-3'), read))?.status).toBe('ok');
    expect(await t.sessions.wayIdeas(t.id, 'b', input(t.key, 'w-4'), read)).toEqual({
      status: 'limit',
    });
  });

  it('作る間に「すること」が直されたら、古い前提の案を見せない', async () => {
    const t = await setup();
    const { read } = reader(async () => {
      await t.previewed({
        type: 'correctItem',
        itemId: t.itemId,
        interpretation: { endTime: '15:00' },
      });
    });
    expect(await t.sessions.wayIdeas(t.id, 'b', input(t.key), read)).toEqual({ status: 'stale' });
  });

  it('読み取りに失敗したら、理由の種類だけを返す', async () => {
    const t = await setup();
    const { read } = reader(undefined, new ReadingError('refusal', 'refusal'));
    expect(await t.sessions.wayIdeas(t.id, 'b', input(t.key), read)).toEqual({
      status: 'failed',
      reason: 'refusal',
    });
  });

  it('知らないデモは無し', async () => {
    const { read } = reader();
    const sessions = demoSessions();
    expect(await sessions.wayIdeas('nope', 'b', input('arr:need:x'), read)).toBeUndefined();
  });
});
