// 家族の一言：読むだけで何も書かず、言った本人が候補を押した時に、見せた時と今の対象が同じなら記録する。
// 読み取りは偽物（決まった出力を返す）で、Claude の API は呼ばない。
import {
  type Command,
  type ConditionNode,
  proposalSnapshot,
  type UtteranceContext,
  type UtteranceOutput,
} from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp, type FamilyBackend } from '../src/app';
import { DEMO_STAGES, demoEvents } from '../src/demo';
import {
  demoSessions,
  MAX_UTTERANCES_PER_SESSION,
  type UtteranceReader,
} from '../src/demo-sessions';
import { ReadingError } from '../src/reading/extract';
import { CONDITION_TOO_COMPLEX, conditionText, utteranceContext } from '../src/utterance-context';
import { type View, viewFor } from '../src/views';

const output = (o: Partial<UtteranceOutput> & Pick<UtteranceOutput, 'kind'>): UtteranceOutput => ({
  actions: [],
  refs: { taskKeys: [], requestIds: [], itemIds: [] },
  unsupported: null,
  ...o,
});

const replyYes = output({
  kind: 'change',
  actions: [
    {
      type: 'recordReply',
      taskKey: null,
      requestId: 'r-grandma',
      reply: 'yes',
      unknownId: null,
      value: null,
    },
  ],
});

/** 決まった出力を返す読み取り（受け取った前提を残す）。 */
const reader =
  (out: UtteranceOutput, calls: UtteranceContext[] = []): UtteranceReader =>
  async (context) => {
    calls.push(context);
    return {
      output: out,
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };

let op = 0;
const say = (text: string) => ({ text, operationId: `say-${++op}` });

async function heard(stage = 'chase', out = replyYes, calls: UtteranceContext[] = []) {
  const sessions = demoSessions();
  const id = sessions.create(stage as 'chase');
  const before = await sessions.view(id, 'b');
  const done = await sessions.utterance(
    id,
    'b',
    say('おばあちゃん大丈夫だって'),
    reader(out, calls),
  );
  if (done?.status !== 'ok') throw new Error(`読めない：${done?.status}`);
  return { sessions, id, before, done };
}

const grandma = (view: { plan: { requests: { requestId: string; state: string }[] } }) =>
  view.plan.requests.find((r) => r.requestId === 'r-grandma')?.state;

describe('家族の一言', () => {
  it('読むだけでは何も書かず、言った本人が押すと記録する', async () => {
    const calls: UtteranceContext[] = [];
    const { sessions, id, before, done } = await heard('chase', replyYes, calls);
    // 前提：話した人、頼んだ日は送った時の控えの日、架空のデモの名前。
    expect(calls[0]?.speaker).toEqual({ id: 'b', name: '彩' });
    expect(calls[0]?.requests.find((r) => r.id === 'r-grandma')).toMatchObject({
      to: 'おばあちゃん',
      forDate: '2026-12-07',
      state: 'awaitingReply',
      needed: true,
    });
    expect(done.reply.kind).toBe('change');
    if (done.reply.kind !== 'change') return;
    const [proposal] = done.reply.proposals;
    if (!proposal) throw new Error('候補が無い');
    // 控え（見せた時の状態）は返さない。
    expect(Object.keys(proposal).sort()).toEqual(['command', 'id']);
    expect(done.view.throughSeq).toBe(before?.throughSeq);
    expect(grandma(done.view)).toBe('awaitingReply');

    expect((await sessions.confirm(id, 'a', proposal.id, 'c-1'))?.status).toBe('forbidden');
    expect((await sessions.confirm(id, 'b', 'unknown', 'c-1'))?.status).toBe('gone');
    const confirmed = await sessions.confirm(id, 'b', proposal.id, 'c-1');
    expect(confirmed?.status).toBe('ok');
    if (confirmed?.status !== 'ok') return;
    expect(grandma(confirmed.view)).toBe('confirmed');
    // 返事が届かなかった時の送り直し（同じ操作 ID）は、二度記録せず済んだと答える。
    const again = await sessions.confirm(id, 'b', proposal.id, 'c-1');
    expect(again?.status).toBe('ok');
    if (again?.status !== 'ok') return;
    expect(again.view.throughSeq).toBe(confirmed.view.throughSeq);
  });

  it('見せた後に、もう一人が別の返事を記録していたら、古い候補で上書きしない', async () => {
    const { sessions, id, done } = await heard();
    if (done.reply.kind !== 'change') throw new Error('変更でない');
    const [proposal] = done.reply.proposals;
    if (!proposal) throw new Error('候補が無い');
    const other = await sessions.command(id, 'a', 'cmd-1', {
      type: 'recordReply',
      requestId: 'r-grandma',
      reply: 'no',
    });
    expect(other?.result.status).toBe('ok');
    const stale = await sessions.confirm(id, 'b', proposal.id, 'c-2');
    expect(stale?.status).toBe('changed');
    if (stale?.status !== 'changed') return;
    expect(grandma(stale.view)).toBe('turnedDown');
    expect(stale.view.throughSeq).toBe(other?.view.throughSeq);
  });

  it('別の大人の作業のことなら候補を出さず、話した人には変えられないと返す', async () => {
    const { done } = await heard(
      'asked',
      output({
        kind: 'change',
        actions: [
          {
            type: 'withdraw',
            taskKey: 'task:opt:arr:purchase:n1:i5:buy:buy',
            requestId: null,
            reply: null,
            unknownId: null,
            value: null,
          },
        ],
      }),
    );
    expect(done.reply).toEqual({ kind: 'clarify', proposals: [], reason: 'otherAdultsTask' });
  });

  it('同じ操作の送り直しは読み直さず同じ答えを返す。中身が違えば断る。数を超えたら断る', async () => {
    const calls: UtteranceContext[] = [];
    const sessions = demoSessions();
    const id = sessions.create('chase');
    const first = { text: 'おばあちゃん大丈夫だって', operationId: 'same' };
    const one = await sessions.utterance(id, 'b', first, reader(replyYes, calls));
    const two = await sessions.utterance(id, 'b', first, reader(replyYes, calls));
    expect(one?.status).toBe('ok');
    expect(two?.status).toBe('ok');
    if (one?.status !== 'ok' || two?.status !== 'ok') return;
    expect(two.reply).toEqual(one.reply);
    expect(calls).toHaveLength(1);
    expect(
      (await sessions.utterance(id, 'b', { ...first, text: '別の文' }, reader(replyYes)))?.status,
    ).toBe('conflict');
    for (let i = 1; i < MAX_UTTERANCES_PER_SESSION; i += 1) {
      expect((await sessions.utterance(id, 'b', say(`${i}`), reader(replyYes)))?.status).toBe('ok');
    }
    expect((await sessions.utterance(id, 'b', say('over'), reader(replyYes)))?.status).toBe(
      'limit',
    );
    // 大人でない人の一言は読まない（数えない）。
    const other = sessions.create('chase');
    expect((await sessions.utterance(other, 'c', say('x'), reader(replyYes)))?.status).toBe(
      'invalid',
    );
  });

  it('お知らせと一言は、一日の数を一緒に数える', async () => {
    const sessions = demoSessions(Date.now, { perDay: 1 });
    const id = sessions.create('chase');
    expect((await sessions.utterance(id, 'b', say('a'), reader(replyYes)))?.status).toBe('ok');
    expect((await sessions.utterance(id, 'b', say('b'), reader(replyYes)))?.status).toBe('limit');
  });

  it('読めなかった時は何も残さず、同じ操作 ID で読み直せる', async () => {
    const sessions = demoSessions();
    const id = sessions.create('chase');
    const refusal: UtteranceReader = async () => {
      throw new ReadingError('refusal', 'refusal');
    };
    const input = say('おばあちゃん大丈夫だって');
    expect(await sessions.utterance(id, 'b', input, refusal)).toEqual({
      status: 'failed',
      reason: 'refusal',
    });
    expect((await sessions.utterance(id, 'b', input, reader(replyYes)))?.status).toBe('ok');
  });

  it('読む間に計画が変わったら、古い前提の答えを見せず、読み直してもらう', async () => {
    const sessions = demoSessions();
    const id = sessions.create('chase');
    const question = output({
      kind: 'question',
      refs: { taskKeys: [], requestIds: [], itemIds: ['n1:i7'] },
    });
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const calls: UtteranceContext[] = [];
    const slow: UtteranceReader = async (context) => {
      entered();
      await gate;
      return reader(question, calls)(context);
    };
    const input = say('12/7は通常授業？');
    const reading = sessions.utterance(id, 'b', input, slow);
    await started;
    // 読む間に、もう一人が発表会の日を答えた（12/7 の通常授業は、もう当てはまらない）。
    const answered = await sessions.command(id, 'a', 'cmd-u1', {
      type: 'answer',
      unknownId: 'n1:u1',
      value: '2026-12-05',
    });
    expect(answered?.result.status).toBe('ok');
    open();
    expect(await reading).toEqual({ status: 'stale' });
    // 同じ操作 ID で送り直すと、今の前提で読み直す。
    const again = await sessions.utterance(id, 'b', input, reader(question, calls));
    expect(again?.status).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.items.some((i) => i.id === 'n1:i7')).toBe(false);
  });

  it('返事が届かなかった送り直しでも、読んだ後に前提が変われば古い答えを返さない', async () => {
    const sessions = demoSessions();
    const id = sessions.create('chase');
    const calls: UtteranceContext[] = [];
    const question = output({ kind: 'question' });
    const input = say('12/7は通常授業？');
    expect((await sessions.utterance(id, 'b', input, reader(question, calls)))?.status).toBe('ok');
    await sessions.command(id, 'a', 'cmd-u1', {
      type: 'answer',
      unknownId: 'n1:u1',
      value: '2026-12-08',
    });
    expect(await sessions.utterance(id, 'b', input, reader(question, calls))).toEqual({
      status: 'stale',
    });
    expect(calls).toHaveLength(1);
    // 新しい操作で、今の前提で読み直す。
    const again = await sessions.utterance(
      id,
      'b',
      say('12/7は通常授業？'),
      reader(question, calls),
    );
    expect(again?.status).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('同じ種類の対象がほかにもある候補には、記録させない訳を付け、押されても記録しない', async () => {
    const sessions = demoSessions();
    const id = sessions.create('chase');
    const calls: UtteranceContext[] = [];
    // 頼み事が一件だけなら、記録できる候補（訳なし）。
    const reply = await sessions.utterance(
      id,
      'b',
      say('おばあちゃん大丈夫だって'),
      reader(replyYes, calls),
    );
    if (reply?.status !== 'ok' || reply.reply.kind !== 'change') throw new Error('候補が無い');
    expect(calls[0]?.requests.map((r) => r.id)).toEqual(['r-grandma']);
    expect(reply.reply.proposals[0]?.blocked).toBeUndefined();
    // 作業は、計画の生きている作業（比べるための案の作業も）がほかにもあるので、記録させない。
    const asked = sessions.create('asked');
    const accept = output({
      kind: 'change',
      actions: [
        {
          type: 'done',
          taskKey: 'task:opt:arr:purchase:n1:i5:buy:buy',
          requestId: null,
          reply: null,
          unknownId: null,
          value: null,
        },
      ],
    });
    const task = await sessions.utterance(asked, 'a', say('シャツ買った'), reader(accept));
    if (task?.status !== 'ok' || task.reply.kind !== 'change') throw new Error('候補が無い');
    const [proposal] = task.reply.proposals;
    expect(proposal?.blocked).toBe('otherTasks');
    // 画面を通らずに押されても、記録しない（今の計画を返して見せ直す）。
    const before = (await sessions.view(asked, 'a'))?.plan.throughSeq;
    const confirmed = await sessions.confirm(asked, 'a', proposal?.id ?? '', 'confirm-1');
    expect(confirmed?.status).toBe('changed');
    expect((await sessions.view(asked, 'a'))?.plan.throughSeq).toBe(before);
  });

  it('見せた後に同じ種類の対象が増えたら、記録しない（家庭を押さえた中で判断し直す）', async () => {
    const sessions = demoSessions();
    const id = sessions.create('chase');
    const reply = await sessions.utterance(
      id,
      'b',
      say('おばあちゃん大丈夫だって'),
      reader(replyYes),
    );
    if (reply?.status !== 'ok' || reply.reply.kind !== 'change') throw new Error('候補が無い');
    const [proposal] = reply.reply.proposals;
    expect(proposal?.blocked).toBeUndefined();
    // 見せた後に、学童を予備にして、健太が申込書を出した（頼み事が二件になった）。
    let op = 0;
    const run = async (memberId: string, command: Command) => {
      const done = await sessions.command(id, memberId, `op-${++op}`, command);
      if (done?.result.status !== 'ok')
        throw new Error(`${command.type}：${JSON.stringify(done?.result)}`);
      return done?.view as View;
    };
    const care = 'arr:childCare:n1:i6:c';
    const gakudo = `opt:${care}:opt-gakudo`;
    const view = await run('b', {
      type: 'chooseOption',
      arrangementKey: care,
      optionKey: gakudo,
      role: 'backup',
      assigneeId: 'a',
    });
    const submit = view.plan.tasks.find((t) => t.key === `task:${gakudo}:submit`);
    const shown = submit && proposalSnapshot(submit);
    if (!submit || !shown) throw new Error('出す作業が無い');
    await run('a', { type: 'accept', taskKey: submit.key, shown });
    const arrangement = view.plan.arrangements.find((a) => a.key === care);
    if (!arrangement) throw new Error('手配が無い');
    await run('a', {
      type: 'recordSent',
      taskKey: submit.key,
      requestId: 'r-gakudo-new',
      window: { start: arrangement.start, end: arrangement.end },
    });
    const stale = await sessions.confirm(id, 'b', proposal?.id ?? '', 'confirm-2');
    expect(stale?.status).toBe('changed');
    if (stale?.status !== 'changed') return;
    expect(stale.view.plan.requests.find((r) => r.requestId === 'r-grandma')?.state).toBe(
      'awaitingReply',
    );
  });

  it('比べるための候補の作業（まだ選んでいない案の物）は、前提に入れない', () => {
    const stage = DEMO_STAGES.find((s) => s.id === 'arrived');
    if (!stage) throw new Error('段が無い');
    const events = demoEvents(stage.id);
    const candidates = viewFor(events, 'b', stage.now).plan.tasks.filter(
      (t) => t.live && t.commitment === 'proposed' && t.key.includes('opt-gakudo'),
    );
    expect(candidates.length).toBeGreaterThan(0);
    const context = utteranceContext(events, 'b', stage.now, '学童の申込書は書いた？');
    expect(context?.tasks.filter((t) => t.key.includes('opt-gakudo'))).toEqual([]);
  });

  it('子を共有する深い条件の式は、展開しきらずに「複雑」と返す（指数的に長くしない）', () => {
    const nodes = new Map<string, ConditionNode>();
    nodes.set('e', { id: 'e', kind: 'eq', unknownId: 'u', value: 'yes' });
    let previous = 'e';
    for (let i = 0; i < 30; i += 1) {
      const id = `n${i}`;
      nodes.set(id, { id, kind: 'and', childIds: [previous, previous] });
      previous = id;
    }
    const labels = new Map([['u', '雨']]);
    expect(conditionText('e', nodes, labels)).toBe('雨が「yes」');
    expect(conditionText('n0', nodes, labels)).toBe('雨が「yes」、かつ雨が「yes」');
    expect(conditionText(previous, nodes, labels)).toBe(CONDITION_TOO_COMPLEX);
  });

  it('鍵の無いサーバーと、家族の家庭を出すサーバーでは、一言を読めない', async () => {
    for (const app of [
      createApp(),
      createApp({ family: {} as FamilyBackend, listener: reader(replyYes) }),
    ]) {
      const made = await app.request('/api/demo/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'chase' }),
      });
      const { sessionId, canHear } = (await made.json()) as {
        sessionId: string;
        canHear: boolean;
      };
      expect(canHear).toBe(false);
      const response = await app.request(`/api/demo/sessions/${sessionId}/utterances`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memberId: 'b', operationId: 'x', text: 'おばあちゃん大丈夫だって' }),
      });
      expect(response.status).toBe(503);
    }
  });

  it('HTTP：読んで候補を返し、押すと記録する。見せた後に変わっていれば 409 で今の物を返す', async () => {
    const app = createApp({ listener: reader(replyYes) });
    const made = await app.request('/api/demo/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'chase' }),
    });
    const { sessionId, canHear } = (await made.json()) as { sessionId: string; canHear: boolean };
    expect(canHear).toBe(true);
    const post = (path: string, body: unknown) =>
      app.request(`/api/demo/sessions/${sessionId}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const heardResponse = await post('utterances', {
      memberId: 'b',
      operationId: 'h-1',
      text: 'おばあちゃん大丈夫だって',
    });
    expect(heardResponse.status).toBe(200);
    const { reply } = (await heardResponse.json()) as {
      reply: { kind: string; proposals: { id: string }[] };
    };
    const [proposal] = reply.proposals;
    if (!proposal) throw new Error('候補が無い');
    const stale = await post('commands', {
      memberId: 'a',
      operationId: 'x-1',
      command: { type: 'recordReply', requestId: 'r-grandma', reply: 'no' },
    });
    expect(stale.status).toBe(200);
    const conflict = await post(`proposals/${proposal.id}`, { memberId: 'b', operationId: 'p-1' });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe('proposalChanged');
    expect(
      (await post(`proposals/${proposal.id}`, { memberId: 'a', operationId: 'p-2' })).status,
    ).toBe(403);
    expect((await post('proposals/nothing', { memberId: 'b', operationId: 'p-3' })).status).toBe(
      404,
    );
  });
});
