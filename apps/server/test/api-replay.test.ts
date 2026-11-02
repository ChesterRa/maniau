// 画面が使う HTTP の入口から、架空の家庭の操作を順にたどる。エンジンや置き場所は直接呼ばない。
import type { Command, ProposalSnapshot, Task } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { CommandResult } from '../src/commands';
import type { View } from '../src/views';

const care = 'arr:childCare:n1:i6:c';
const grandma = `opt:${care}:opt-grandma`;
const ask = `task:${grandma}:ask`;
const jsonHeaders = { 'content-type': 'application/json' };
type App = ReturnType<typeof createApp>;

async function makeSession(app: App, stage: 'arrived' | 'postponed' = 'arrived'): Promise<string> {
  const response = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ stage }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

async function getView(app: App, session: string, memberId = 'b'): Promise<View> {
  const response = await app.request(`/api/demo/sessions/${session}/view?member=${memberId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as View;
}

async function command(
  app: App,
  session: string,
  memberId: string,
  operationId: string,
  body: Command,
): Promise<{ status: number; result: CommandResult; view: View }> {
  const response = await app.request(`/api/demo/sessions/${session}/commands`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ memberId, operationId, command: body }),
  });
  const result = (await response.json()) as { result: CommandResult; view: View };
  return { status: response.status, ...result };
}

/** 表示を受け取った画面が、その提案について保持する控え。 */
function shown(task: Task): ProposalSnapshot {
  if (!task.start || !task.end) throw new Error('作業の時刻が無い');
  return {
    start: task.start,
    end: task.end,
    ...(task.detour ? { delayedArrival: task.detour.delayedArrival } : {}),
    titleKey: task.titleKey,
    titleParams: task.titleParams,
    ...(task.atPlaceId ? { atPlaceId: task.atPlaceId } : {}),
    travelBeforeMin: task.travelBeforeMin,
    travelAfterMin: task.travelAfterMin,
    ...(task.external ? { external: task.external } : {}),
    ...(task.condition ? { condition: task.condition } : {}),
  };
}

describe('HTTP からたどる架空の家庭', () => {
  it('案を選び、本人が見た提案を引き受け、頼んで、返事を記録する', async () => {
    const app = createApp();
    const session = await makeSession(app);
    const initial = await getView(app, session);
    expect(initial.plan.requests).toEqual([]);
    expect(initial.plan.arrangements.find((a) => a.key === care)?.conditional).toBe(true);

    const selected = await command(app, session, 'b', 'select', {
      type: 'chooseOption',
      arrangementKey: care,
      optionKey: grandma,
      role: 'primary',
      assigneeId: 'b',
    });
    expect(selected.status).toBe(200);
    expect(selected.view.plan.arrangements.find((a) => a.key === care)?.chosenOptionKey).toBe(
      grandma,
    );
    const task = selected.view.plan.tasks.find((entry) => entry.key === ask);
    expect(task).toMatchObject({ assigneeId: 'b', commitment: 'proposed' });
    if (!task) throw new Error('頼む作業が無い');
    expect(
      selected.view.today.main.some((card) => card.kind === 'proposal' && card.task.key === ask),
    ).toBe(true);
    expect(
      (await getView(app, session, 'a')).today.main.some(
        (card) => card.kind === 'proposal' && card.task.key === ask,
      ),
    ).toBe(false);
    const proposal = shown(task);

    const other = await command(app, session, 'a', 'other-accept', {
      type: 'accept',
      taskKey: ask,
      shown: proposal,
    });
    expect(other.status).toBe(403);
    const stale = await command(app, session, 'b', 'old-accept', {
      type: 'accept',
      taskKey: ask,
      shown: { ...proposal, titleKey: '以前の用件' },
    });
    expect(stale.status).toBe(409);
    expect(stale.result).toMatchObject({ reason: 'proposalChanged' });
    expect(stale.view.throughSeq).toBe(selected.view.throughSeq);

    const accepted = await command(app, session, 'b', 'accept', {
      type: 'accept',
      taskKey: ask,
      shown: proposal,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.view.plan.tasks.find((entry) => entry.key === ask)).toMatchObject({
      commitment: 'accepted',
    });
    expect(
      accepted.view.today.quiet.some((card) => card.kind === 'todo' && card.task.key === ask),
    ).toBe(true);
    const sentCommand: Command = { type: 'recordSent', taskKey: ask, requestId: 'r-http' };
    const sent = await command(app, session, 'b', 'send', sentCommand);
    expect(sent.status).toBe(200);
    expect(sent.view.plan.requests.find((entry) => entry.requestId === 'r-http')).toMatchObject({
      to: 'g',
      sentBy: 'b',
      state: 'awaitingReply',
    });
    expect(
      sent.view.today.quiet.some(
        (card) => card.kind === 'waiting' && card.request.requestId === 'r-http',
      ),
    ).toBe(true);

    const retry = await command(app, session, 'b', 'send', sentCommand);
    expect(retry.result).toMatchObject({ status: 'noop' });
    expect(retry.view.throughSeq).toBe(sent.view.throughSeq);
    expect(retry.view.plan.requests.filter((entry) => entry.requestId === 'r-http')).toHaveLength(
      1,
    );
    const changedRetry = await command(app, session, 'b', 'send', {
      ...sentCommand,
      requestId: 'another',
    });
    expect(changedRetry.status).toBe(409);
    expect(changedRetry.result).toMatchObject({ reason: 'operationIdReused' });

    const replied = await command(app, session, 'a', 'reply', {
      type: 'recordReply',
      requestId: 'r-http',
      reply: 'yes',
    });
    expect(replied.status).toBe(200);
    expect(replied.view.plan.requests.find((entry) => entry.requestId === 'r-http')?.state).toBe(
      'confirmed',
    );
    expect(
      (await getView(app, session, 'b')).today.quiet.some(
        (card) => card.kind === 'waiting' && card.request.requestId === 'r-http',
      ),
    ).toBe(false);
    const tooLate = await command(app, session, 'b', 'correct', {
      type: 'correctSentRecord',
      requestId: 'r-http',
    });
    expect(tooLate.status).toBe(409);
    expect(tooLate.result).toMatchObject({ reason: 'alreadyAnswered' });
    expect(tooLate.view.plan.requests.find((entry) => entry.requestId === 'r-http')?.state).toBe(
      'confirmed',
    );
  });

  it('先に頼んだ後で日付が決まって不要になれば、同じデモの中で取消しを出す', async () => {
    const app = createApp();
    const session = await makeSession(app);
    const selected = await command(app, session, 'b', 'select', {
      type: 'chooseOption',
      arrangementKey: care,
      optionKey: grandma,
      role: 'primary',
      assigneeId: 'b',
    });
    expect(selected.status).toBe(200);
    const sent = await command(app, session, 'b', 'send', {
      type: 'recordSent',
      taskKey: ask,
      requestId: 'r-change',
    });
    expect(
      sent.view.plan.requests.find((request) => request.requestId === 'r-change'),
    ).toMatchObject({ live: true, state: 'awaitingReply' });

    const changed = await command(app, session, 'a', 'answer', {
      type: 'answer',
      unknownId: 'n1:u1',
      value: '2026-12-08',
    });
    expect(changed.status).toBe(200);
    expect(
      changed.view.plan.requests.find((request) => request.requestId === 'r-change'),
    ).toMatchObject({ live: false, state: 'awaitingReply' });
    const senderView = await getView(app, session, 'b');
    expect(
      senderView.today.main.some(
        (card) => card.kind === 'cancel' && card.request.requestId === 'r-change',
      ),
    ).toBe(true);
    const cancelled = await command(app, session, 'b', 'cancel', {
      type: 'recordCancellationSent',
      requestId: 'r-change',
    });
    expect(cancelled.status).toBe(200);
    expect(
      cancelled.view.plan.requests.find((request) => request.requestId === 'r-change')?.state,
    ).toBe('cancelled');
    expect(
      cancelled.view.today.main.some(
        (card) => card.kind === 'cancel' && card.request.requestId === 'r-change',
      ),
    ).toBe(false);
  });

  it('予定変更後の二つの取消しを別々に記録し、失効した案は選ばない', async () => {
    const app = createApp();
    const session = await makeSession(app, 'postponed');
    const before = await getView(app, session);
    expect(before.plan.arrangements.find((a) => a.key === care)?.live).toBe(false);
    for (const id of ['r-grandma', 'r-gakudo']) {
      expect(before.plan.requests.find((entry) => entry.requestId === id)?.live).toBe(false);
      expect(before.plan.tasks.some((task) => task.live && task.cancels === id)).toBe(true);
    }
    expect(
      before.today.main.some(
        (card) => card.kind === 'cancel' && card.request.requestId === 'r-grandma',
      ),
    ).toBe(true);
    expect(
      before.today.main.some(
        (card) => card.kind === 'cancel' && card.request.requestId === 'r-gakudo',
      ),
    ).toBe(false);
    expect(
      (await getView(app, session, 'a')).today.main.some(
        (card) => card.kind === 'cancel' && card.request.requestId === 'r-gakudo',
      ),
    ).toBe(true);
    const staleChoice = await command(app, session, 'b', 'stale-choice', {
      type: 'chooseOption',
      arrangementKey: care,
      optionKey: grandma,
      role: 'primary',
    });
    expect(staleChoice.status).toBe(409);
    expect(staleChoice.result).toMatchObject({ reason: 'arrangementGone' });
    expect(staleChoice.view.throughSeq).toBe(before.throughSeq);

    const cancelled = await command(app, session, 'b', 'cancel-grandma', {
      type: 'recordCancellationSent',
      requestId: 'r-grandma',
    });
    expect(cancelled.status).toBe(200);
    expect(
      cancelled.view.plan.requests.find((entry) => entry.requestId === 'r-grandma')?.state,
    ).toBe('cancelled');
    expect(
      cancelled.view.plan.tasks.some((task) => task.live && task.cancels === 'r-grandma'),
    ).toBe(false);
    expect(cancelled.view.plan.tasks.some((task) => task.live && task.cancels === 'r-gakudo')).toBe(
      true,
    );
    const other = await command(app, session, 'a', 'cancel-gakudo', {
      type: 'recordCancellationSent',
      requestId: 'r-gakudo',
    });
    expect(other.status).toBe(200);
    expect(other.view.plan.requests.find((entry) => entry.requestId === 'r-gakudo')?.state).toBe(
      'cancelled',
    );
    expect(other.view.plan.tasks.some((task) => task.live && task.cancels === 'r-gakudo')).toBe(
      false,
    );
  });

  it('別々のデモは操作と操作 ID を共有しない', async () => {
    const app = createApp();
    const first = await makeSession(app);
    const second = await makeSession(app);
    expect(first).not.toBe(second);
    const before = await getView(app, second);
    const answered = await command(app, first, 'b', 'same-id', {
      type: 'answer',
      unknownId: 'n1:u1',
      value: '2026-12-05',
    });
    expect(answered.status).toBe(200);
    expect((await getView(app, second)).throughSeq).toBe(before.throughSeq);
    const other = await command(app, second, 'b', 'same-id', {
      type: 'answer',
      unknownId: 'n1:u1',
      value: '2026-12-08',
    });
    expect(other.status).toBe(200);
    expect(answered.view.plan.arrangements.find((a) => a.key === care)?.live).toBe(true);
    expect(other.view.plan.arrangements.find((a) => a.key === care)?.live).toBe(false);
  });
});
