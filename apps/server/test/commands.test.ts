// 命令の処理（02-foundation §7.2・§7.3）：権限、提案の控え、操作 ID、家庭ごとの一列。
import { type Command, type DomainEvent, proposalSnapshot } from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { demoSessions } from '../src/demo-sessions';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

const NOW = '2026-11-25T19:40+09:00';
const CARE = 'arr:childCare:n1:i6:c';
const GRANDMA = `opt:${CARE}:opt-grandma`;
const GAKUDO = `opt:${CARE}:opt-gakudo`;
const ASK = `task:${GRANDMA}:ask`;

function setup(now: string = NOW) {
  const store = memoryStore(new Map([['h', demoEvents('arrived')]]));
  let op = 0;
  const run = (memberId: string, command: Command, operationId = `op-${++op}`) =>
    runCommand(store, 'h', { memberId, operationId, now, demo: false }, command);
  const events = () => store.withHousehold('h', (log) => [...log.events()]);
  const plan = async () => computePlan(await events(), now);
  const task = async (key: string) => {
    const found = (await plan()).tasks.find((t) => t.key === key);
    if (!found) throw new Error(`作業が無い：${key}`);
    return found;
  };
  return { store, run, events, plan, task };
}

describe('命令', () => {
  it('引き受けは担当の本人だけで、本人が見た提案が今の提案と同じ時だけ', async () => {
    const { run, task, events } = setup();
    await run('b', { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'b' });
    const shown = proposalSnapshot(await task(ASK));
    if (!shown) throw new Error('置けていない');
    expect((await run('a', { type: 'accept', taskKey: ASK, shown })).status).toBe('forbidden');
    const moved = { ...shown, start: '2026-12-04T20:50+09:00' };
    expect(await run('b', { type: 'accept', taskKey: ASK, shown: moved })).toMatchObject({
      status: 'conflict',
      reason: 'proposalChanged',
    });
    expect((await run('b', { type: 'accept', taskKey: ASK, shown })).status).toBe('ok');
    const accepted = (await events()).at(-1);
    expect(accepted).toMatchObject({ type: 'commitmentChanged', action: 'accept', shown });
    expect((await task(ASK)).reconfirm).toBeUndefined();
  });

  it('送ったの記録は、控えをサーバーが今の計画から作る。押し間違いの直しは送った本人だけ', async () => {
    const { run, task, events } = setup();
    await run('b', { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'b' });
    const shown = proposalSnapshot(await task(ASK));
    if (!shown) throw new Error('置けていない');
    await run('b', { type: 'accept', taskKey: ASK, shown });
    expect((await run('b', { type: 'recordSent', taskKey: ASK, requestId: 'r1' })).status).toBe(
      'ok',
    );
    const sent = (await events()).at(-1);
    expect(sent?.type === 'externalRequestSent' && sent.snapshot).toMatchObject({
      to: 'g',
      conditional: true,
      condition: expect.stringContaining('n1:u1'),
      window: { start: expect.any(String), end: expect.any(String) },
    });
    expect((await run('a', { type: 'correctSentRecord', requestId: 'r1' })).status).toBe(
      'forbidden',
    );
    expect((await run('b', { type: 'correctSentRecord', requestId: 'r1' })).status).toBe('ok');
    expect(computePlan(await events(), NOW).requests).toEqual([]);
  });

  it('案を選ぶ時に担当を付ければ作業を提案し、自分が担当なら、画面で見た提案の控えを付けた作業だけ引き受ける', async () => {
    const { run, events, task } = setup();
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey: GRANDMA,
        role: 'primary',
        assigneeId: 'c',
      }),
    ).toMatchObject({ status: 'invalid', reason: 'assigneeNotAnAdult' });
    const snapshot = proposalSnapshot(await task(ASK));
    if (!snapshot) throw new Error('置けていない');
    const choose = (extra: object) =>
      run('b', {
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey: GRANDMA,
        role: 'primary',
        assigneeId: 'b',
        ...extra,
      } as Command);
    // 控えが今の提案と違えば、何も足さずに見せ直す。他の人の作業の控えは付けられない。
    const count = (await events()).length;
    expect(
      await choose({ shown: [{ taskKey: ASK, snapshot: { ...snapshot, start: NOW } }] }),
    ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey: GRANDMA,
        role: 'primary',
        assigneeId: 'a',
        shown: [{ taskKey: ASK, snapshot }],
      }),
    ).toMatchObject({ status: 'invalid', reason: 'shownForAnother' });
    expect((await events()).length).toBe(count);
    // 控えを付けた作業だけ、その控えで引き受ける。
    expect((await choose({ shown: [{ taskKey: ASK, snapshot }] })).status).toBe('ok');
    const added = (await events()).slice(-3);
    expect(added.map((e) => e.type)).toEqual([
      'optionChosen',
      'assignmentProposed',
      'commitmentChanged',
    ]);
    expect(added.at(-1)).toMatchObject({ shown: snapshot });
    expect(await task(ASK)).toMatchObject({ assigneeId: 'b', commitment: 'accepted' });
    expect((await task(ASK)).reconfirm).toBeUndefined();
  });

  it('同じ案を同じ担当で選び直しても、別の人の引き受けを提案に戻さない', async () => {
    const { run, events, task } = setup();
    const choose: Command = {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
      assigneeId: 'a',
    };
    expect((await run('b', choose)).status).toBe('ok');
    const shown = proposalSnapshot(await task(ASK));
    if (!shown) throw new Error('置けていない');
    expect((await run('a', { type: 'accept', taskKey: ASK, shown })).status).toBe('ok');
    const count = (await events()).length;
    // 応答が届かず、別の操作 ID で送り直された選び直し。
    expect((await run('b', choose)).status).toBe('noop');
    expect((await events()).length).toBe(count);
    expect(await task(ASK)).toMatchObject({ assigneeId: 'a', commitment: 'accepted' });
    // 断った後なら、もう一度頼む。
    await run('a', { type: 'commitment', taskKey: ASK, action: 'decline' });
    expect((await run('b', choose)).status).toBe('ok');
    expect(await task(ASK)).toMatchObject({ assigneeId: 'a', commitment: 'proposed' });
  });

  it('控えを付けずに自分を担当にした時は、提案するだけで引き受けない', async () => {
    const { run, events, task } = setup();
    await run('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
      assigneeId: 'b',
    });
    expect((await events()).slice(-2).map((e) => e.type)).toEqual([
      'optionChosen',
      'assignmentProposed',
    ]);
    expect(await task(ASK)).toMatchObject({ assigneeId: 'b', commitment: 'proposed' });
  });

  it('本人しかできない手順（自分の有休の申請）は、別の大人に頼めない。選んだ人ではなく本人に提案する', async () => {
    const { run, events } = setup();
    const leaveA = `opt:${CARE}:opt-leave-a`;
    const apply = `task:${leaveA}:apply`;
    const proposed = await run('b', { type: 'proposeAssignment', taskKey: apply, assigneeId: 'b' });
    expect(proposed).toMatchObject({ status: 'invalid', reason: 'fixedAssignee' });
    expect(
      (await run('b', { type: 'proposeAssignment', taskKey: apply, assigneeId: 'a' })).status,
    ).toBe('ok');
    // 彩が自分を担当にして健太の有休を選んでも、申請は健太に提案する。
    const chosen = await run('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: leaveA,
      role: 'primary',
      assigneeId: 'b',
    });
    expect(chosen.status).toBe('ok');
    const last = (await events())
      .filter((e) => e.type === 'assignmentProposed' && e.taskKey === apply)
      .at(-1);
    expect(last?.type === 'assignmentProposed' && last.assigneeId).toBe('a');
  });

  it('決め時を過ぎて始めていない案は選べず、選んでいない案は取り下げられない', async () => {
    const late = setup('2026-12-06T09:00+09:00');
    const gakudo = (await late.plan()).arrangements
      .find((a) => a.key === CARE)
      ?.options.find((o) => o.key === GAKUDO);
    expect(gakudo?.expired).toBe(true);
    expect(
      await late.run('b', {
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey: GAKUDO,
        role: 'primary',
      }),
    ).toMatchObject({ status: 'conflict', reason: 'optionExpired' });
    const { run } = setup();
    expect(
      await run('b', { type: 'dropOption', arrangementKey: CARE, optionKey: GAKUDO }),
    ).toMatchObject({ status: 'conflict', reason: 'notChosen' });
    await run('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GAKUDO,
      role: 'backup',
    });
    // 本命を予備にも選ぶのは断る。
    await run('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
    });
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey: GRANDMA,
        role: 'backup',
      }),
    ).toMatchObject({ status: 'conflict', reason: 'alreadyPrimary' });
    expect(
      (await run('b', { type: 'dropOption', arrangementKey: CARE, optionKey: GAKUDO })).status,
    ).toBe('ok');
  });

  it('二人が見た札の古い操作（持つ・頼む・案をやめる）は、もう一人が先に持った後なら断る', async () => {
    const { run, task, plan } = setup();
    await run('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GAKUDO,
      role: 'primary',
      assigneeId: 'b',
    });
    const write = `task:${GAKUDO}:write`;
    await run('b', { type: 'commitment', taskKey: write, action: 'decline' });
    // 二人とも「担当がいない」札を見た（その時の担当と状態、案の作業の全部）。
    const seen = (t: { key: string; assigneeId?: string | undefined; commitment: string }) => ({
      taskKey: t.key,
      assigneeId: t.assigneeId ?? null,
      commitment: t.commitment as 'declined',
    });
    const shownTask = seen(await task(write));
    const shownOption = {
      tasks: (await plan()).tasks.filter((t) => t.live && t.basis.optionKey === GAKUDO).map(seen),
      requests: [],
    };
    // 健太が先に持つ。
    expect(
      (
        await run('a', {
          type: 'proposeAssignment',
          taskKey: write,
          assigneeId: 'a',
          seen: shownTask,
        })
      ).status,
    ).toBe('ok');
    // 彩の古い札の「自分でやる」と「この案はやめる」は、黙って替えずに断る。
    expect(
      await run('b', {
        type: 'proposeAssignment',
        taskKey: write,
        assigneeId: 'b',
        seen: shownTask,
      }),
    ).toMatchObject({ status: 'conflict', reason: 'taskChanged' });
    expect(
      await run('b', {
        type: 'dropOption',
        arrangementKey: CARE,
        optionKey: GAKUDO,
        seen: shownOption,
      }),
    ).toMatchObject({ status: 'conflict', reason: 'optionChanged' });
    expect((await task(write)).assigneeId).toBe('a');
  });

  it('案をやめる古い操作は、見せた後に外の依頼へ返事が来ていたら断る', async () => {
    const { run, task, plan } = setup();
    await run('b', {
      type: 'chooseOption',
      arrangementKey: CARE,
      optionKey: GRANDMA,
      role: 'primary',
    });
    await run('b', { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'b' });
    const shown = proposalSnapshot(await task(ASK));
    if (!shown) throw new Error('置けていない');
    await run('b', { type: 'accept', taskKey: ASK, shown });
    await run('b', { type: 'recordSent', taskKey: ASK, requestId: 'r1' });
    const now = await plan();
    const seenOption = {
      tasks: now.tasks
        .filter((t) => t.live && t.basis.optionKey === GRANDMA)
        .map((t) => ({
          taskKey: t.key,
          assigneeId: t.assigneeId ?? null,
          commitment: t.commitment,
        })),
      requests: now.requests
        .filter((r) => r.live && r.basis.optionKey === GRANDMA)
        .map((r) => ({ requestId: r.requestId, state: r.state })),
    };
    expect(seenOption.requests).toEqual([{ requestId: 'r1', state: 'awaitingReply' }]);
    await run('b', { type: 'recordReply', requestId: 'r1', reply: 'yes' });
    expect(
      await run('b', {
        type: 'dropOption',
        arrangementKey: CARE,
        optionKey: GRANDMA,
        seen: seenOption,
      }),
    ).toMatchObject({ status: 'conflict', reason: 'optionChanged' });
  });

  it('要らなくなった手配・作業には、新しく決める命令を断る（済んだ等の記録は受け付ける）', async () => {
    const store = memoryStore(new Map([['h', demoEvents('postponed')]]));
    const at = '2026-12-04T18:10+09:00';
    let op = 0;
    const run = (command: Command) =>
      runCommand(
        store,
        'h',
        { memberId: 'b', operationId: `p-${++op}`, now: at, demo: false },
        command,
      );
    const plan = computePlan(await store.withHousehold('h', (log) => [...log.events()]), at);
    expect(plan.arrangements.find((a) => a.key === CARE)?.live).toBe(false);
    expect(
      await run({
        type: 'chooseOption',
        arrangementKey: CARE,
        optionKey: GRANDMA,
        role: 'primary',
      }),
    ).toMatchObject({ status: 'conflict', reason: 'arrangementGone' });
    expect(await run({ type: 'proposeAssignment', taskKey: ASK, assigneeId: 'a' })).toMatchObject({
      status: 'conflict',
      reason: 'taskGone',
    });
    // 起きた事の記録（返事）は、要らなくなった後でも受け付ける。
    expect((await run({ type: 'recordReply', requestId: 'r-gakudo', reply: 'no' })).status).toBe(
      'ok',
    );
  });

  it('依頼の ID は、押し間違いを直して消した後も使わない', async () => {
    const { run, task } = setup();
    await run('b', { type: 'proposeAssignment', taskKey: ASK, assigneeId: 'b' });
    const shown = proposalSnapshot(await task(ASK));
    if (!shown) throw new Error('置けていない');
    await run('b', { type: 'accept', taskKey: ASK, shown });
    await run('b', { type: 'recordSent', taskKey: ASK, requestId: 'r1' });
    await run('b', { type: 'correctSentRecord', requestId: 'r1' });
    expect(await task(ASK)).toMatchObject({ commitment: 'accepted' });
    expect(await run('b', { type: 'recordSent', taskKey: ASK, requestId: 'r1' })).toMatchObject({
      status: 'invalid',
      reason: 'requestIdTaken',
    });
    expect((await run('b', { type: 'recordSent', taskKey: ASK, requestId: 'r2' })).status).toBe(
      'ok',
    );
    // 同じ作業の依頼は一通だけ（二通目は、押し間違いを直してから）。
    expect(await run('b', { type: 'recordSent', taskKey: ASK, requestId: 'r3' })).toMatchObject({
      status: 'conflict',
      reason: 'alreadySent',
    });
  });

  it('事項と出典への確かめは、今あって取り下げていない物だけ。取り下げた出典の未定の値には答えられない', async () => {
    const { run } = setup();
    expect(await run('b', { type: 'confirmItem', itemId: 'nope' })).toMatchObject({
      status: 'conflict',
      reason: 'itemGone',
    });
    expect(
      await run('b', { type: 'dismissItem', itemId: 'nope', reason: 'notOurs' }),
    ).toMatchObject({ status: 'conflict', reason: 'itemGone' });
    expect(await run('b', { type: 'withdrawSource', sourceId: 'nope' })).toMatchObject({
      status: 'conflict',
      reason: 'sourceGone',
    });
    expect((await run('b', { type: 'withdrawSource', sourceId: 'n1' })).status).toBe('ok');
    expect((await run('b', { type: 'withdrawSource', sourceId: 'n1' })).status).toBe('noop');
    expect(await run('b', { type: 'confirmItem', itemId: 'n1:i6' })).toMatchObject({
      status: 'conflict',
      reason: 'sourceWithdrawn',
    });
    expect(
      await run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' }),
    ).toMatchObject({ status: 'conflict', reason: 'unknownRetired' });
  });

  it('お知らせごと消した出典の原文と事項は、見せる物に出さない', async () => {
    const { store, events } = setup();
    await store.withHousehold('h', (log) =>
      log.append([{ type: 'sourceContentPurged', sourceId: 'n1', scope: 'all' }], 'system', NOW),
    );
    const view = viewFor(await events(), 'b', NOW);
    expect(view.sources.map((s) => s.id)).not.toContain('n1');
    expect(view.items.filter((i) => i.item.sourceId === 'n1')).toEqual([]);
  });

  it('同じ操作 ID の送り直しは何も足さず、中身が違えば衝突。何も起きない操作も記録する', async () => {
    const { run, events } = setup();
    const answer: Command = { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' };
    expect((await run('b', answer, 'same')).status).toBe('ok');
    const count = (await events()).length;
    expect((await run('b', answer, 'same')).status).toBe('noop');
    expect((await events()).length).toBe(count);
    expect(await run('b', { ...answer, value: '2026-12-08' } as Command, 'same')).toMatchObject({
      status: 'conflict',
      reason: 'operationIdReused',
    });
    expect(await run('a', answer, 'same')).toMatchObject({ status: 'conflict' });
  });

  it('無い未定の値や、宣言の無い値への答えは断る', async () => {
    const { run } = setup();
    expect(await run('b', { type: 'answer', unknownId: 'n1:nope', value: 'yes' })).toMatchObject({
      status: 'conflict',
      reason: 'unknownGone',
    });
    expect(
      await run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-06' }),
    ).toMatchObject({ status: 'invalid', reason: 'undeclaredValue' });
  });

  it('子や知らない人の命令、デモでない家庭の時計は断る', async () => {
    const { run } = setup();
    const answer: Command = { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' };
    expect((await run('c', answer)).status).toBe('forbidden');
    expect((await run('nobody', answer)).status).toBe('forbidden');
    expect((await run('a', { type: 'advanceClock', to: '2026-11-30T18:00+09:00' })).status).toBe(
      'forbidden',
    );
  });

  it('デモの時計を進めた後の命令は、並んで届いても進めた時刻で記録する。時計は戻せない', async () => {
    const store = memoryStore(new Map([['h', demoEvents('arrived')]]));
    const later = '2026-11-28T12:00+09:00';
    const run = (operationId: string, command: Command) =>
      runCommand(store, 'h', { memberId: 'b', operationId, now: NOW, demo: true }, command);
    const [advanced, answered] = await Promise.all([
      run('t1', { type: 'advanceClock', to: later }),
      run('t2', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' }),
    ]);
    expect([advanced.status, answered.status]).toEqual(['ok', 'ok']);
    const events = await store.withHousehold('h', (log) => [...log.events()]);
    const clock = events.findIndex((e) => e.type === 'clockAdvanced');
    for (const event of events.slice(clock + 1)) expect(event.occurredAt).toBe(later);
    expect(await run('t3', { type: 'advanceClock', to: NOW })).toMatchObject({
      status: 'invalid',
      reason: 'clockBackwards',
    });
  });

  it('同じ家庭の命令は一列に並び、通し番号が重ならない', async () => {
    const { run, events } = setup();
    const before = (await events()).length;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        run(i % 2 === 0 ? 'a' : 'b', {
          type: 'answer',
          unknownId: 'n1:u1',
          value: i % 2 === 0 ? '2026-12-05' : '2026-12-08',
        }),
      ),
    );
    const seqs = (await events()).map((e: DomainEvent) => e.seq);
    expect(seqs.length).toBe(before + 10);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });
});

describe('デモの家庭（見る人ごと）', () => {
  it('期限を過ぎたデモは、作る時を待たずに、触った時に捨てる', async () => {
    let now = 0;
    const sessions = demoSessions(() => now);
    const id = sessions.create('arrived');
    expect(await sessions.view(id, 'b')).toBeDefined();
    now = 13 * 60 * 60 * 1000;
    expect(await sessions.view(id, 'b')).toBeUndefined();
    expect(
      await sessions.command(id, 'b', 'x', {
        type: 'answer',
        unknownId: 'n1:u1',
        value: '2026-12-05',
      }),
    ).toBeUndefined();
  });

  it('作って、見て、命令して、見直す。別の人のデモは変わらない', async () => {
    const app = createApp();
    const make = async () => {
      const response = await app.request('/api/demo/sessions', {
        method: 'POST',
        body: JSON.stringify({ stage: 'arrived' }),
        headers: { 'content-type': 'application/json' },
      });
      expect(response.status).toBe(200);
      const made = (await response.json()) as {
        sessionId: string;
        household: { id: string };
        readings: { sourceId: string; origin: string }[];
        stages: { id: string }[];
      };
      expect(made.readings.map((r) => r.sourceId)).toEqual(['n1', 'n2']);
      expect(made.stages.map((s) => s.id)).toContain('postponed');
      return made.sessionId;
    };
    const mine = await make();
    const theirs = await make();
    const view = async (sid: string) =>
      (await (await app.request(`/api/demo/sessions/${sid}/view?member=b`)).json()) as {
        throughSeq: number;
        today: { main: { kind: string }[] };
      };
    const before = await view(mine);
    expect(before.today.main.map((c) => c.kind)).toContain('decide');

    const response = await app.request(`/api/demo/sessions/${mine}/commands`, {
      method: 'POST',
      body: JSON.stringify({
        memberId: 'b',
        operationId: 'x1',
        command: { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' },
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(200);
    const done = (await response.json()) as {
      result: { status: string };
      view: { throughSeq: number };
    };
    expect(done.result.status).toBe('ok');
    expect(done.view.throughSeq).toBe(before.throughSeq + 1);
    expect((await view(theirs)).throughSeq).toBe(before.throughSeq);

    expect((await app.request('/api/demo/sessions/nope/view?member=b')).status).toBe(404);
    const bad = await app.request(`/api/demo/sessions/${mine}/commands`, {
      method: 'POST',
      body: JSON.stringify({ memberId: 'b', operationId: 'x2', command: { type: 'nope' } }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
  });
});
