// 加え間違えた通知を、現実に取り消された通知と混同しない。架空の資料と正式命令だけを使う。
import type { Command, PreviewCommand } from '@maniau/core';
import {
  notificationHistory,
  notificationIntents,
  proposalSnapshot,
  todayCards,
} from '@maniau/core';
import { computePlan, keys, requestSnapshot } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';
import { viewFor } from '../src/views';

const now = '2026-11-29T21:00+09:00';
const mistaken = {
  type: 'discardSource',
  sourceId: 'n1',
  reason: 'misfiled',
} as const satisfies PreviewCommand;
function setup(
  legacy = false,
  utcSnapshot = false,
  stage: Parameters<typeof demoEvents>[0] = 'chase',
) {
  const initial = demoEvents(stage).map((event) => {
    if (
      utcSnapshot &&
      event.type === 'externalRequestSent' &&
      event.requestId === 'r-grandma' &&
      event.snapshot?.window
    ) {
      return {
        ...event,
        snapshot: {
          ...event.snapshot,
          window: {
            start: '2026-12-06T23:10+00:00',
            end: '2026-12-07T09:15+00:00',
          },
        },
      };
    }
    if (!legacy || event.type !== 'externalRequestSent' || event.requestId !== 'r-grandma')
      return event;
    const { snapshot: _snapshot, ...old } = event;
    return old;
  });
  const store = memoryStore(new Map([['demo', initial]]));
  let number = 0;
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  const run = (memberId: string, command: Command) =>
    runCommand(
      store,
      'demo',
      {
        memberId,
        operationId: `mistaken-${++number}`,
        now,
        demo: true,
      },
      command,
    );
  const look = async () => previewChange(await events(), { memberId: 'b', now }, mistaken);
  const plan = async () => computePlan(await events(), now);
  const addSameDay = async () =>
    store.withHousehold('demo', (log) => {
      const prior = log.events();
      const notice = prior.find((e) => e.type === 'noticeReceived' && e.source.id === 'n1');
      const reading = prior.find(
        (e) => e.type === 'modelOutputRecorded' && e.call === 'extract' && e.sourceId === 'n1',
      );
      if (notice?.type !== 'noticeReceived' || reading?.type !== 'modelOutputRecorded')
        throw Error('材料が無い');
      const source = JSON.parse(JSON.stringify(notice.source).replaceAll('n1', 'n9'));
      const output = JSON.parse(JSON.stringify(reading.output).replaceAll('n1', 'n9'));
      log.append(
        [
          { type: 'noticeReceived', source },
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'same-day',
            sourceId: 'n9',
            sourceVersion: 1,
            output,
          },
        ],
        'b',
        now,
      );
    });
  const addRelated = async () =>
    store.withHousehold('demo', (log) => {
      const fixture = demoEvents('postponed');
      const notice = fixture.find(
        (event) => event.type === 'noticeReceived' && event.source.id === 'n2',
      );
      const reading = fixture.find(
        (event) => event.type === 'modelOutputRecorded' && event.sourceId === 'n2',
      );
      if (notice?.type !== 'noticeReceived' || reading?.type !== 'modelOutputRecorded')
        throw Error('材料が無い');
      log.append(
        [{ type: 'noticeReceived', source: { ...notice.source, receivedAt: now } }],
        'b',
        now,
      );
      log.append(
        [
          {
            type: 'modelOutputRecorded',
            call: 'extract',
            sourceId: 'n2',
            sourceVersion: 1,
            model: 'fixture',
            promptVersion: 'fixture',
            inputHash: 'related',
            output: reading.output,
          },
        ],
        'system',
        now,
      );
    });
  const purge = async () =>
    store.withHousehold('demo', (log) => {
      log.append([{ type: 'sourceContentPurged', sourceId: 'n1', scope: 'all' }], 'system', now);
    });
  return { events, run, look, plan, addSameDay, addRelated, purge };
}

/** 二人が異なる端末を見ている時の、送信画面と当時の計画。 */
async function sendingFromOldScreen() {
  const h = setup(false, false, 'arrived');
  const arrangementKey = 'arr:childCare:n1:i6:c';
  const optionKey = keys.option(arrangementKey, 'opt-grandma');
  expect(
    await h.run('b', {
      type: 'chooseOption',
      arrangementKey,
      optionKey,
      role: 'primary',
      assigneeId: 'a',
    }),
  ).toMatchObject({ status: 'ok' });
  const before = await h.plan();
  const task = before.tasks.find((entry) => entry.key === `task:${optionKey}:ask`);
  const arrangement = before.arrangements.find((entry) => entry.key === arrangementKey);
  const proposal = task && proposalSnapshot(task);
  if (!task || !arrangement || !proposal) throw Error('依頼の控えが無い');
  expect(await h.run('a', { type: 'accept', taskKey: task.key, shown: proposal })).toMatchObject({
    status: 'ok',
  });
  const screen = await h.plan();
  const sent = {
    type: 'recordSent',
    taskKey: task.key,
    requestId: 'r-sent-offline',
    window: { start: arrangement.start, end: arrangement.end },
    shown: { throughSeq: screen.throughSeq, at: now },
  } as const;
  const discard = async () => {
    const preview = await h.look();
    if ('status' in preview) throw Error('外す内容を見られない');
    return h.run('b', {
      ...mistaken,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    });
  };
  return { h, task, sent, discard };
}

describe('加え間違えたお知らせ', () => {
  it('同じ手が今も本命の時、依頼だけを不要にせず決める画面で見直す', async () => {
    const h = setup();
    expect(
      await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' }),
    ).toMatchObject({ status: 'ok' });
    const before = await h.events();
    const set = before.findLast((event) => event.type === 'householdSet');
    if (set?.type !== 'householdSet') throw Error('家庭が無い');
    const household = structuredClone(set.household);
    const monday = household.routines.find(
      (routine) => routine.memberId === 'a' && routine.weekday === 1,
    );
    const home = monday?.segments.find(
      (segment) => segment.kind === 'home' && segment.start === '18:15',
    );
    const commute = monday?.segments.find(
      (segment) => segment.kind === 'commute' && segment.end === '18:15',
    );
    if (!home || !commute) throw Error('帰りの予定が無い');
    home.start = '19:30';
    commute.end = '19:30';
    const change = { type: 'updateHousehold', household } as const;
    const preview = previewChange(before, { memberId: 'a', now }, change);
    if ('status' in preview) throw Error(`予定の直しを見られない: ${preview.reason}`);
    expect(
      await h.run('a', {
        ...change,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const current = await h.plan();
    expect(current.requests.find((request) => request.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    const events = await h.events();
    expect(
      await h.run('b', {
        type: 'resolveRequestCheck',
        requestId: 'r-grandma',
        decision: 'cancel',
        seen: { throughSeq: current.throughSeq },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'optionStillChosen' });
    expect(await h.events()).toEqual(events);
  });

  it('日付の直しと担当替えの後、前の担当の画面から依頼を記録しない', async () => {
    const { h, task, sent } = await sendingFromOldScreen();
    const correction: PreviewCommand = {
      type: 'correctItem',
      itemId: 'n1:i6',
      interpretation: { date: '2026-12-14' },
    };
    const preview = previewChange(await h.events(), { memberId: 'b', now }, correction);
    if ('status' in preview) throw Error('日付の直しを見られない');
    expect(
      await h.run('b', {
        ...correction,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('b', { type: 'proposeAssignment', taskKey: task.key, assigneeId: 'b' }),
    ).toMatchObject({ status: 'ok' });
    const events = await h.events();
    expect(await h.run('a', sent)).toMatchObject({
      status: 'conflict',
      reason: 'assignmentChanged',
    });
    expect(await h.events()).toEqual(events);
  });

  it('別の人が条件に答えても、実際に送った前の条件を控えに残す', async () => {
    const { h, task, sent } = await sendingFromOldScreen();
    const original = requestSnapshot(await h.events(), now, task.key);
    expect(
      await h.run('b', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' }),
    ).toMatchObject({ status: 'ok' });
    expect(await h.run('a', sent)).toMatchObject({ status: 'ok' });
    const event = (await h.events()).findLast((entry) => entry.type === 'externalRequestSent');
    expect(event?.type === 'externalRequestSent' && event.snapshot).toEqual(original);
  });

  it.each(['window', 'childId'] as const)(
    '旧い子の依頼で %s の控えが足りない時、お知らせを外す前に別に確かめてもらう',
    async (missing) => {
      const initial = demoEvents('chase').map((event) => {
        if (
          event.type !== 'externalRequestSent' ||
          event.requestId !== 'r-grandma' ||
          !event.snapshot
        )
          return event;
        const snapshot = { ...event.snapshot };
        delete snapshot[missing];
        return { ...event, snapshot };
      });
      expect(previewChange(initial, { memberId: 'b', now }, mistaken)).toMatchObject({
        status: 'invalid',
        reason: 'legacyRequestUnclear',
      });
      const store = memoryStore(new Map([['demo', initial]]));
      expect(
        await runCommand(
          store,
          'demo',
          { memberId: 'b', operationId: `partial-${missing}`, now, demo: true },
          mistaken,
        ),
      ).toMatchObject({ status: 'invalid', reason: 'legacyRequestUnclear' });
    },
  );
  it('家族が外す前の画面から実際に送った依頼は、後でも記録して確認できる', async () => {
    const { h, sent, discard } = await sendingFromOldScreen();
    expect(await discard()).toMatchObject({ status: 'ok' });
    expect(await h.run('a', sent)).toMatchObject({ status: 'ok' });
    const after = await h.plan();
    expect(after.requests.find((r) => r.requestId === 'r-sent-offline')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(after.tasks.some((t) => t.live && t.cancels === 'r-sent-offline')).toBe(false);
    const events = await h.events();
    const set = events.findLast((event) => event.type === 'householdSet');
    if (set?.type !== 'householdSet') throw Error('家庭が無い');
    expect(
      verifyPlan({ household: set.household, events, plan: after }).issues.filter(
        (issue) => issue.kind === 'violation',
      ),
    ).toEqual([]);
    const forged = structuredClone(after);
    const request = forged.requests.find((r) => r.requestId === 'r-sent-offline');
    if (!request) throw Error('依頼が無い');
    delete request.needsCheck;
    expect(
      verifyPlan({ household: set.household, events, plan: forged }).issues.map(
        (issue) => issue.code,
      ),
    ).toContain('excluded_request_unchecked');
    request.live = false;
    expect(
      verifyPlan({ household: set.household, events, plan: forged }).issues.map(
        (issue) => issue.code,
      ),
    ).toContain('excluded_request_unchecked');
    expect(await h.run('a', { ...sent, requestId: 'r-sent-twice' })).toMatchObject({
      status: 'conflict',
      reason: 'alreadySent',
    });
  });
  it('日を直す前の画面から実際に送った依頼は、元の日のまま記録して確かめる', async () => {
    const { h, sent } = await sendingFromOldScreen();
    const correction: PreviewCommand = {
      type: 'correctItem',
      itemId: 'n1:i6',
      // 原文の「月曜日」と矛盾しない別の日。曜日の違反は別の試験で確かめる。
      interpretation: { date: '2026-12-14' },
    };
    const shown = previewChange(await h.events(), { memberId: 'b', now }, correction);
    if ('status' in shown) throw Error('日付の直しを見られない');
    expect(
      await h.run('b', {
        ...correction,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await h.run('a', sent)).toMatchObject({ status: 'ok' });
    const after = await h.plan();
    expect(after.requests.find((r) => r.requestId === sent.requestId)).toMatchObject({
      live: true,
      needsCheck: true,
      window: sent.window,
    });
    expect(after.tasks.some((t) => t.live && t.cancels === sent.requestId)).toBe(false);
    const events = await h.events();
    const set = events.findLast((event) => event.type === 'householdSet');
    if (set?.type !== 'householdSet') throw Error('家庭が無い');
    expect(
      verifyPlan({ household: set.household, events, plan: after }).issues.filter(
        (issue) => issue.kind === 'violation',
      ),
    ).toEqual([]);
  });
  it('古い画面からの送信記録は、本人・元の時間・有効な版だけを受け付ける', async () => {
    const { h, sent, discard } = await sendingFromOldScreen();
    expect(await discard()).toMatchObject({ status: 'ok' });
    const before = await h.events();
    expect(await h.run('b', sent)).toMatchObject({ status: 'conflict', reason: 'taskGone' });
    expect(await h.run('a', { ...sent, shown: undefined })).toMatchObject({
      status: 'conflict',
      reason: 'taskGone',
    });
    expect(
      await h.run('a', { ...sent, shown: { ...sent.shown, throughSeq: 999999 } }),
    ).toMatchObject({ status: 'conflict', reason: 'taskGone' });
    expect(await h.run('a', { ...sent, shown: { ...sent.shown, throughSeq: 0 } })).toMatchObject({
      status: 'conflict',
      reason: 'taskGone',
    });
    expect(
      await h.run('a', { ...sent, shown: { ...sent.shown, at: '2026-12-01T21:00+09:00' } }),
    ).toMatchObject({ status: 'conflict', reason: 'taskGone' });
    expect(
      await h.run('a', { ...sent, window: { ...sent.window, start: '2026-12-08T08:10+09:00' } }),
    ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
    expect(await h.events()).toEqual(before);
  });
  it('古い画面の後に本人が辞退した場合や、原文が削除された場合は、過去の作業を復活させない', async () => {
    const unchanged = await sendingFromOldScreen();
    expect(
      await unchanged.h.run('a', {
        type: 'commitment',
        taskKey: unchanged.task.key,
        action: 'withdraw',
      }),
    ).toMatchObject({ status: 'ok' });
    const afterWithdraw = await unchanged.h.events();
    // 出典と依頼の控えが変わらなくても、本人が辞退した後の古い画面は受けない。
    expect(await unchanged.h.run('a', unchanged.sent)).toMatchObject({
      status: 'conflict',
      reason: 'taskGone',
    });
    expect(await unchanged.h.events()).toEqual(afterWithdraw);
    const first = await sendingFromOldScreen();
    expect(
      await first.h.run('a', { type: 'commitment', taskKey: first.task.key, action: 'withdraw' }),
    ).toMatchObject({ status: 'ok' });
    expect(await first.discard()).toMatchObject({ status: 'ok' });
    expect(await first.h.run('a', first.sent)).toMatchObject({
      status: 'conflict',
      reason: 'taskGone',
    });
    const second = await sendingFromOldScreen();
    expect(await second.discard()).toMatchObject({ status: 'ok' });
    await second.h.purge();
    expect(await second.h.run('a', second.sent)).toMatchObject({
      status: 'conflict',
      reason: 'taskGone',
    });
  });
  it('実際に取り下げられたお知らせは、古い画面で送った事実を記録した後も取消しを伝える', async () => {
    const { h, sent } = await sendingFromOldScreen();
    expect(await h.run('b', { type: 'withdrawSource', sourceId: 'n1' })).toMatchObject({
      status: 'ok',
    });
    expect(await h.run('a', sent)).toMatchObject({ status: 'ok' });
    const after = await h.plan();
    expect(after.requests.find((r) => r.requestId === sent.requestId)).toMatchObject({
      live: false,
    });
    expect(after.tasks.some((t) => t.live && t.cancels === sent.requestId)).toBe(true);
    const events = await h.events();
    const set = events.findLast((event) => event.type === 'householdSet');
    if (set?.type !== 'householdSet') throw Error('家庭が無い');
    expect(
      verifyPlan({ household: set.household, events, plan: after }).issues.filter(
        (issue) => issue.kind === 'violation',
      ),
    ).toEqual([]);
  });
  it('関係する出典が変わって元に戻った後、古い確認を当てた計画を検証器が見つける', async () => {
    const h = setup();
    await h.addRelated();
    const preview = await h.look();
    if ('status' in preview) throw Error(`見られない: ${preview.reason}`);
    expect(
      await h.run('b', {
        ...mistaken,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const before = await h.plan();
    expect(before.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(
      await h.run('b', {
        type: 'resolveRequestCheck',
        requestId: 'r-grandma',
        decision: 'keep',
        seen: { throughSeq: before.throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    const kept = await h.plan();
    expect(kept.requests.find((r) => r.requestId === 'r-grandma')?.standalone).toBe(true);
    const keptEvents = await h.events();
    const set = keptEvents.findLast((event) => event.type === 'householdSet');
    if (set?.type !== 'householdSet') throw Error('家庭が無い');
    expect(
      verifyPlan({ household: set.household, events: keptEvents, plan: kept }).issues.filter(
        (i) => i.kind === 'violation',
      ),
    ).toEqual([]);
    for (const what of ['発表会の別名', '学習発表会']) {
      const correction: PreviewCommand = {
        type: 'correctItem',
        itemId: 'n2:i1',
        interpretation: { what },
      };
      const shown = previewChange(await h.events(), { memberId: 'b', now }, correction);
      if ('status' in shown) throw Error(`直す内容を見られない: ${shown.reason}`);
      expect(
        await h.run('b', {
          ...correction,
          seen: { throughSeq: shown.throughSeq, changes: shown.seen },
        }),
      ).toMatchObject({ status: 'ok' });
    }
    const all = await h.events();
    const current = computePlan(all, now);
    expect(current.requests.find((r) => r.requestId === 'r-grandma')?.needsCheck).toBe(true);
    expect(
      verifyPlan({ household: set.household, events: all, plan: current }).issues.filter(
        (i) => i.kind === 'violation',
      ),
    ).toEqual([]);
    const forged = structuredClone(current);
    const request = forged.requests.find((r) => r.requestId === 'r-grandma');
    if (!request) throw Error('依頼が無い');
    request.standalone = true;
    delete request.needsCheck;
    const codes = verifyPlan({ household: set.household, events: all, plan: forged }).issues.map(
      (i) => i.code,
    );
    expect(codes).toContain('request_standalone_unconfirmed');
  });
  it('先に変化を見せ、送った依頼はまだ要るかを確かめる（現実の取消しを作らない）', async () => {
    const h = setup();
    const before = await h.plan();
    expect(before.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({ live: true });
    const preview = await h.look();
    if ('status' in preview) throw Error(`preview: ${preview.status}/${preview.reason}`);
    expect(preview.changes.checks.map((r) => r.requestId)).toContain('r-grandma');
    expect(preview.changes.cancels.map((r) => r.requestId)).not.toContain('r-grandma');
    expect(
      await h.run('b', {
        ...mistaken,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const after = await h.plan();
    expect(after.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
      state: 'awaitingReply',
    });
    expect(after.tasks.filter((t) => t.cancels === 'r-grandma' && t.live)).toHaveLength(0);
    expect(after.arrangements.filter((a) => a.live && a.kind === 'childCare')).toHaveLength(0);
    expect(
      todayCards(after, 'b').main.some(
        (c) => c.kind === 'check' && c.request.requestId === 'r-grandma',
      ),
    ).toBe(true);
    const events = await h.events();
    const set = events.findLast((e) => e.type === 'householdSet');
    if (set?.type !== 'householdSet') throw Error('家庭が無い');
    expect(
      verifyPlan({ household: set.household, events, plan: after }).issues.filter(
        (x) => x.kind === 'violation',
      ),
    ).toEqual([]);
    // 翌日の昼には、送った人への「まだ要るか」の知らせが出せ、取消しの知らせにはならない。
    const daytime = computePlan(events, '2026-11-30T12:00+09:00');
    const intents = notificationIntents(daytime, set.household, notificationHistory(events));
    const check = intents.find(
      (intent) =>
        intent.titleKey === 'notify.check' &&
        intent.subject.type === 'request' &&
        intent.subject.id === 'r-grandma',
    );
    if (!check) throw Error('確認の知らせが無い');
    expect(
      intents.some(
        (intent) =>
          intent.titleKey === 'notify.cancel' &&
          intent.subject.type === 'request' &&
          intent.subject.id === 'r-grandma',
      ),
    ).toBe(false);
    const gate = sendGate({
      household: set.household,
      plan: daytime,
      events,
      intents,
      batchEnds: events.map((event) => event.seq),
    });
    expect(gate.all).toBe(false);
    expect(gate.blocked.has(check.key)).toBe(false);
    // 検証器は、誤りとした出典に基づく依頼を、要確認を消して見せる改ざんを独立に見つける。
    const tampered = structuredClone(after);
    const changed = tampered.requests.find((r) => r.requestId === 'r-grandma');
    if (!changed) throw Error('依頼が無い');
    delete changed.needsCheck;
    expect(
      verifyPlan({ household: set.household, events, plan: tampered }).issues.map((x) => x.code),
    ).toContain('excluded_request_unchecked');
    // 依頼そのものが計画から消えていても、送った控えをたどって独立に見つける。
    const missing = structuredClone(after);
    missing.requests = missing.requests.filter((r) => r.requestId !== 'r-grandma');
    expect(
      verifyPlan({ household: set.household, events, plan: missing }).issues.map((x) => x.code),
    ).toContain('active_request_missing');
  });

  it('見た後に返事が入ったら、古い預かった変化のまま保存しない', async () => {
    const h = setup();
    const preview = await h.look();
    if ('status' in preview) throw Error('見られない');
    expect(
      await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await h.run('b', {
        ...mistaken,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'conflict' });
    expect((await h.plan()).arrangements.some((a) => a.live && a.kind === 'childCare')).toBe(true);
  });

  it('前からの sourceWithdrawn の意味を変えず、確かな取り下げは取消しを残す', async () => {
    const h = setup();
    expect(await h.run('b', { type: 'withdrawSource', sourceId: 'n1' })).toMatchObject({
      status: 'ok',
    });
    const after = await h.plan();
    expect(after.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({ live: false });
    expect(after.tasks.some((t) => t.cancels === 'r-grandma' && t.live)).toBe(true);
  });

  it('送った本人が控えを見て、要るまま残す。別の日の手配の確保にはせず、同じ子・日が戻れば再確認', async () => {
    const h = setup();
    const preview = await h.look();
    if ('status' in preview) throw Error('見られない');
    await h.run('b', {
      ...mistaken,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    });
    const before = await h.plan();
    const decision = {
      type: 'resolveRequestCheck',
      requestId: 'r-grandma',
      decision: 'keep',
      seen: { throughSeq: before.throughSeq },
    } as const;
    expect(await h.run('a', decision)).toMatchObject({
      status: 'forbidden',
      reason: 'notTheSender',
    });
    expect(await h.run('b', decision)).toMatchObject({ status: 'ok' });
    const kept = await h.plan();
    expect(kept.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      state: 'awaitingReply',
      standalone: true,
    });
    expect(kept.requests.find((r) => r.requestId === 'r-grandma')?.needsCheck).not.toBe(true);
    expect(kept.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(false);
    expect(
      todayCards(kept, 'b').quiet.some(
        (c) => c.kind === 'waiting' && c.request.requestId === 'r-grandma',
      ),
    ).toBe(true);
    const keptEvents = await h.events();
    const set = keptEvents.findLast((e) => e.type === 'householdSet');
    if (set?.type !== 'householdSet') throw Error('家庭が無い');
    expect(
      verifyPlan({ household: set.household, events: keptEvents, plan: kept }).issues.filter(
        (i) => i.kind === 'violation',
      ),
    ).toEqual([]);
    expect(
      await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' }),
    ).toMatchObject({ status: 'ok' });
    const confirmed = await h.plan();
    expect(confirmed.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      state: 'confirmed',
      standalone: true,
    });
    expect(
      todayCards(confirmed, 'b').quiet.some(
        (c) => c.kind === 'waiting' && c.request.requestId === 'r-grandma',
      ),
    ).toBe(true);
    await h.addSameDay();
    const returned = await h.plan();
    expect(
      returned.arrangements.some((a) => a.live && a.kind === 'childCare' && a.childId === 'c'),
    ).toBe(true);
    expect(returned.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(returned.requests.find((r) => r.requestId === 'r-grandma')?.standalone).not.toBe(true);
    expect(returned.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(false);
    const returnedEvents = await h.events();
    const forged = structuredClone(returned);
    const forgedRequest = forged.requests.find((r) => r.requestId === 'r-grandma');
    if (!forgedRequest) throw Error('依頼が無い');
    forgedRequest.standalone = true;
    delete forgedRequest.needsCheck;
    expect(
      verifyPlan({ household: set.household, events: returnedEvents, plan: forged }).issues.map(
        (i) => i.code,
      ),
    ).toContain('request_standalone_unconfirmed');
    // 新しく現れた出典がまた取り下げられても、その前の「まだ要る」を黙って復活させない。
    expect(await h.run('b', { type: 'withdrawSource', sourceId: 'n9' })).toMatchObject({
      status: 'ok',
    });
    expect((await h.plan()).requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
    });
  });

  it('要らないと決めてから連絡を出し、実際に伝えた記録が入るまでは取消し済みと言わない', async () => {
    const h = setup();
    const preview = await h.look();
    if ('status' in preview) throw Error('見られない');
    await h.run('b', {
      ...mistaken,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    });
    const seen = (await h.plan()).throughSeq;
    await h.run('a', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
    expect(
      await h.run('b', {
        type: 'resolveRequestCheck',
        requestId: 'r-grandma',
        decision: 'cancel',
        seen: { throughSeq: seen },
      }),
    ).toMatchObject({ status: 'conflict' });
    const current = await h.plan();
    expect(
      await h.run('b', {
        type: 'resolveRequestCheck',
        requestId: 'r-grandma',
        decision: 'cancel',
        seen: { throughSeq: current.throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    const toTell = await h.plan();
    expect(toTell.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: false,
      state: 'confirmed',
    });
    expect(toTell.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(true);
    const events = await h.events();
    const set = events.findLast((e) => e.type === 'householdSet');
    if (set?.type !== 'householdSet') throw Error('家庭が無い');
    expect(
      verifyPlan({ household: set.household, events, plan: toTell }).issues.filter(
        (i) => i.kind === 'violation',
      ),
    ).toEqual([]);
    expect(
      await h.run('b', { type: 'recordCancellationSent', requestId: 'r-grandma' }),
    ).toMatchObject({ status: 'ok' });
    expect((await h.plan()).requests.find((r) => r.requestId === 'r-grandma')?.state).toBe(
      'cancelled',
    );
  });

  it('控えが UTC でも家庭の日で比べ、同日の出典が現れた後は元の確認を復活させない', async () => {
    const h = setup(false, true);
    const preview = await h.look();
    if ('status' in preview) throw Error('見られない');
    expect(
      await h.run('b', {
        ...mistaken,
        seen: { throughSeq: preview.throughSeq, changes: preview.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const before = await h.plan();
    expect(
      await h.run('b', {
        type: 'resolveRequestCheck',
        requestId: 'r-grandma',
        decision: 'keep',
        seen: { throughSeq: before.throughSeq },
      }),
    ).toMatchObject({ status: 'ok' });
    await h.addSameDay();
    expect((await h.plan()).requests.find((r) => r.requestId === 'r-grandma')?.needsCheck).toBe(
      true,
    );
    expect(await h.run('b', { type: 'withdrawSource', sourceId: 'n9' })).toMatchObject({
      status: 'ok',
    });
    expect((await h.plan()).requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    const all = await h.events();
    const set = all.findLast((event) => event.type === 'householdSet');
    if (set?.type !== 'householdSet') throw Error('家庭が無い');
    expect(
      verifyPlan({
        household: set.household,
        events: all,
        plan: computePlan(all, now),
      }).issues.filter((issue) => issue.kind === 'violation'),
    ).toEqual([]);
  });

  it('控えの無い古い依頼を黙って消さない', async () => {
    const h = setup(true);
    const before = await h.plan();
    expect(before.requests.some((r) => r.requestId === 'r-grandma')).toBe(true);
    const beforeEvents = await h.events();
    expect(await h.look()).toMatchObject({ status: 'invalid', reason: 'legacyRequestUnclear' });
    expect(await h.run('b', mistaken)).toMatchObject({
      status: 'invalid',
      reason: 'legacyRequestUnclear',
    });
    expect(await h.events()).toEqual(beforeEvents);
  });

  it('家族が直接書いたすることを、お知らせの読み間違いとしては外さない', async () => {
    const h = setup();
    const statement: PreviewCommand = {
      type: 'stateNeed',
      text: '12月4日に陽菜を見る',
      interpretation: {
        what: '陽菜を見る',
        shape: 'window',
        date: '2026-12-04',
        startTime: '09:00',
        endTime: '10:00',
        forMemberId: 'c',
      },
    };
    const shown = previewChange(await h.events(), { memberId: 'b', now }, statement);
    if ('status' in shown) throw Error('言明を見られない');
    expect(
      await h.run('b', {
        ...statement,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const before = await h.events();
    const stated = before.findLast((event) => event.type === 'itemsStated');
    if (stated?.type !== 'itemsStated') throw Error('言明が無い');
    const discard: PreviewCommand = {
      type: 'discardSource',
      sourceId: stated.sourceId,
      reason: 'misread',
    };
    expect(previewChange(before, { memberId: 'b', now }, discard)).toMatchObject({
      status: 'invalid',
      reason: 'statedSourceNotNotice',
    });
    expect(await h.run('b', discard)).toMatchObject({
      status: 'invalid',
      reason: 'statedSourceNotNotice',
    });
    expect(await h.events()).toEqual(before);
  });

  it('外したお知らせの説明を、今もそのお知らせで変わったこととして表示しない', async () => {
    const at = '2026-12-04T18:10+09:00';
    const initial = demoEvents('postponed');
    const store = memoryStore(new Map([['demo', initial]]));
    const events = () => store.withHousehold('demo', (log) => [...log.events()]);
    expect(viewFor(initial, 'b', at).changes?.sourceId).toBe('n2');
    const command: PreviewCommand = { type: 'discardSource', sourceId: 'n2', reason: 'misread' };
    const shown = previewChange(await events(), { memberId: 'b', now: at }, command);
    if ('status' in shown) throw Error(`外す内容を見られない: ${shown.reason}`);
    expect(
      await runCommand(
        store,
        'demo',
        { memberId: 'b', operationId: 'discard-n2', now: at, demo: true },
        { ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } },
      ),
    ).toMatchObject({ status: 'ok' });
    expect(viewFor(await events(), 'b', at).changes?.sourceId).not.toBe('n2');
  });

  it('加え間違えた読み取りの型の誤りを、新しい計画の違反に残さない', async () => {
    const initial = demoEvents('arrived').map((event) =>
      event.type === 'modelOutputRecorded' && event.call === 'extract' && event.sourceId === 'n1'
        ? { ...event, output: { invalid: true } }
        : event,
    );
    const store = memoryStore(new Map([['demo', initial]]));
    const events = () => store.withHousehold('demo', (log) => [...log.events()]);
    const preview = previewChange(await events(), { memberId: 'b', now }, mistaken);
    if ('status' in preview) throw Error('見られない');
    expect(
      await runCommand(
        store,
        'demo',
        { memberId: 'b', operationId: 'discard-bad', now, demo: true },
        { ...mistaken, seen: { throughSeq: preview.throughSeq, changes: preview.seen } },
      ),
    ).toMatchObject({ status: 'ok' });
    const after = await events();
    const set = after.findLast((event) => event.type === 'householdSet');
    if (set?.type !== 'householdSet') throw Error('家庭が無い');
    const report = verifyPlan({
      household: set.household,
      events: after,
      plan: computePlan(after, now),
    });
    expect(
      report.issues.filter((issue) => issue.kind === 'violation').map((issue) => issue.code),
    ).not.toContain('invalid_extraction');
  });
});
