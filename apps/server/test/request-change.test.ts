// 同じ日に頼む時間が変わった時の、時間の変更のお願い（架空のデモ・正式な命令）。前の依頼（R1）を名指しし、前の時間と
// 新しい時間を書いた変更のお願い（R2）を送ったと記録できる。相手が R2 に「はい」と言ったと記録されて初めて、R1 は R2 に
// 替わる（取り消しは出さず、後で R2 が断られても R1 には戻らない）。R2 の返事を待つ間は、R2 が今の時間のままの時だけ、
// R1 の確かめの札を止める。名指しの無い同じ日の二通目は、今までどおり受けない。エンジン・検証器・知らせの門は、それぞれ
// 事象から確かめる（偽の事象・偽の計画も照らす）。
import {
  type Command,
  type DomainEvent,
  notificationHistory,
  notificationIntents,
  todayCards,
} from '@maniau/core';
import { computePlan, keys } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { DEMO_STAGES, type DemoStageId, demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { type EventBody, memoryStore } from '../src/store';

const care = 'arr:childCare:n1:i6:c';
const primary = keys.option(care, 'opt-grandma');
const ask = keys.task(primary, 'ask');
type Plan = ReturnType<typeof computePlan>;

function household(stage: DemoStageId, edit?: (events: DomainEvent[]) => DomainEvent[]) {
  const now = DEMO_STAGES.find((s) => s.id === stage)?.now ?? '';
  const seeded = demoEvents(stage);
  const store = memoryStore(new Map([['demo', edit ? edit(seeded) : seeded]]));
  let seq = 0;
  const run = (memberId: string, command: Command) =>
    runCommand(
      store,
      'demo',
      { memberId, operationId: `change-${++seq}`, now, demo: true },
      command,
    );
  const state = () =>
    store.withHousehold('demo', (log) => {
      const events = [...log.events()];
      const set = events.findLast((e) => e.type === 'householdSet');
      if (set?.type !== 'householdSet') throw new Error('家族が無い');
      return { events, home: set.household, plan: computePlan(events, now) };
    });
  const window = async () => {
    const arrangement = (await state()).plan.arrangements.find((a) => a.key === care);
    if (!arrangement) throw new Error('子の居場所の手配が無い');
    return { start: arrangement.start, end: arrangement.end };
  };
  const request = async (id: string) =>
    (await state()).plan.requests.find((r) => r.requestId === id);
  const violations = async (plan?: Plan) => {
    const s = await state();
    return verifyPlan({ household: s.home, events: s.events, plan: plan ?? s.plan })
      .issues.filter((i) => i.kind === 'violation')
      .map((i) => i.code);
  };
  const blocked = async () => {
    const s = await state();
    const intents = notificationIntents(s.plan, s.home, notificationHistory(s.events));
    const gate = sendGate({
      household: s.home,
      plan: s.plan,
      events: s.events,
      intents,
      batchEnds: s.events.map((e) => e.seq),
    });
    // 家庭の全部を止める時（計画に違反がある）は、全部を止めたと返す（一つずつの止めだけを見ない）。
    return {
      keys: intents.map((i) => i.key),
      blocked: gate.all
        ? ['(all)']
        : intents.filter((i) => gate.blocked.has(i.key)).map((i) => i.key),
    };
  };
  // 画面に入口の無い変化（家族の登録の直し、偽の事象）は、事象を直接書く。
  const append = (bodies: readonly EventBody[], actorId: string) =>
    store.withHousehold('demo', (log) => log.append(bodies, actorId, now));
  /**
   * 大人の月曜の帰りを遅くする（家族の登録の直し）。子を見てもらう時間の終わりは、先に帰る大人の帰り：a を 18:15 から
   * 19:30 にすると 19:10（b の帰り）まで、さらに b を 19:10 から 19:40 にすると 19:30 まで延びる。
   */
  const homeAt = async (from: string, to: string, memberId = 'a') => {
    const { home } = await state();
    const changed = structuredClone(home);
    const monday = changed.routines.find((r) => r.memberId === memberId && r.weekday === 1);
    const back = monday?.segments.find((s) => s.kind === 'home' && s.start === from);
    const commute = monday?.segments.find((s) => s.kind === 'commute' && s.end === from);
    if (!back || !commute) throw new Error('月曜の帰りが無い');
    back.start = to;
    commute.end = to;
    await append([{ type: 'householdSet', household: changed }], 'a');
  };
  /** R1 を名指しした時間の変更のお願いを、今の時間で送ったと記録する（画面と同じ命令）。 */
  const askChange = async (requestId: string, previous = 'r-grandma', memberId = 'b') => {
    const before = await request(previous);
    if (!before?.window) throw new Error('前の依頼の時間が無い');
    return run(memberId, {
      type: 'recordSent',
      taskKey: ask,
      requestId,
      window: await window(),
      replaces: { requestId: previous, window: before.window },
    });
  };
  return { run, state, window, request, violations, blocked, append, homeAt, askChange };
}

/** ほかの手（a が休む）を本命に選ぶ（延びた時間を覆える手）。 */
const leaveA = keys.option(care, 'opt-leave-a');
const cancels = (plan: Plan, requestId: string) =>
  plan.tasks.some((t) => t.live && t.cancels === requestId);
const checkCards = (plan: Plan, memberId: string) =>
  todayCards(plan, memberId).main.flatMap((c) => (c.kind === 'check' ? [c.request.requestId] : []));

describe('同じ日の時間の変更のお願い', () => {
  for (const before of ['confirmed', 'awaitingReply'] as const) {
    it(`前の依頼が${before === 'confirmed' ? '「はい」' : '返事待ち'}でも、変更に「はい」で前の依頼が替わり、取り消しは出ない`, async () => {
      const h = household('chase');
      if (before === 'confirmed') {
        expect(
          await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' }),
        ).toMatchObject({ status: 'ok' });
      }
      const old = (await h.request('r-grandma'))?.window;
      await h.homeAt('18:15', '19:30');
      expect(await h.request('r-grandma')).toMatchObject({
        state: before,
        live: true,
        needsCheck: true,
      });
      expect(checkCards((await h.state()).plan, 'b')).toEqual(['r-grandma']);

      expect(await h.askChange('r-change')).toMatchObject({ status: 'ok' });
      let { plan } = await h.state();
      // 変更の返事を待つ間：R1 は元の状態のまま（約束が成り立ったとも、取り消したとも言わない）。確かめの札は止め、
      // 変更のお願いの返事を追う。前の時間の「はい」で、新しい時間を確保したとは言わない。
      expect(await h.request('r-grandma')).toMatchObject({
        state: before,
        live: true,
        needsCheck: true,
        changeAsked: 'r-change',
      });
      expect(await h.request('r-change')).toMatchObject({
        state: 'awaitingReply',
        live: true,
        replaces: { requestId: 'r-grandma', window: old },
        window: await h.window(),
      });
      expect((await h.request('r-change'))?.needsCheck).toBeUndefined();
      expect(checkCards(plan, 'b')).toEqual([]);
      expect(plan.arrangements.find((a) => a.key === care)?.status).toBe('dependsOnReply');
      expect(cancels(plan, 'r-grandma')).toBe(false);
      expect(await h.violations()).toEqual([]);
      expect((await h.blocked()).blocked).toEqual([]);

      expect(
        await h.run('b', { type: 'recordReply', requestId: 'r-change', reply: 'yes' }),
      ).toMatchObject({ status: 'ok' });
      ({ plan } = await h.state());
      expect(await h.request('r-grandma')).toMatchObject({ replacedBy: 'r-change', live: false });
      expect((await h.request('r-grandma'))?.needsCheck).toBeUndefined();
      expect(await h.request('r-change')).toMatchObject({ state: 'confirmed', live: true });
      expect(cancels(plan, 'r-grandma')).toBe(false);
      expect(plan.arrangements.find((a) => a.key === care)).toMatchObject({
        status: 'decidable',
        inUseOptionKey: primary,
      });
      expect(checkCards(plan, 'b')).toEqual([]);
      expect(await h.violations()).toEqual([]);
      expect((await h.blocked()).blocked).toEqual([]);
    });
  }

  it('変更に「はい」の後で断られても、前の依頼には戻らない。ほかの手を選ぶと、変更のお願いに取り消しを伝える', async () => {
    const h = household('chase');
    await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
    await h.homeAt('18:15', '19:30');
    expect(await h.askChange('r-change')).toMatchObject({ status: 'ok' });
    await h.run('b', { type: 'recordReply', requestId: 'r-change', reply: 'yes' });
    expect(
      await h.run('b', { type: 'recordReply', requestId: 'r-change', reply: 'no' }),
    ).toMatchObject({ status: 'ok' });
    let { plan } = await h.state();
    // 前の依頼は替わったまま（自動で戻して、前の時間の約束が残っているとは言わない）。この手は断られた。
    expect(await h.request('r-grandma')).toMatchObject({ replacedBy: 'r-change', live: false });
    expect(await h.request('r-change')).toMatchObject({ state: 'turnedDown', live: true });
    expect(plan.arrangements.find((a) => a.key === care)?.reasons.map((r) => r.code)).toContain(
      'turnedDown',
    );
    expect(cancels(plan, 'r-grandma')).toBe(false);
    expect(checkCards(plan, 'b')).toEqual([]);
    expect(await h.violations()).toEqual([]);
    // ほかの手（学童）を選ぶ：変更のお願いに取り消しを伝える（「OK だった」が押し間違いなら、相手には前の時間の
    // お願いが残っている。同じ日の分なので一つの連絡で足りる）。替わった前の依頼には、別に出さない。
    expect(
      await h.run('b', {
        type: 'chooseOption',
        arrangementKey: care,
        optionKey: leaveA,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    ({ plan } = await h.state());
    expect(cancels(plan, 'r-change')).toBe(true);
    expect(cancels(plan, 'r-grandma')).toBe(false);
    expect(await h.violations()).toEqual([]);
    expect((await h.blocked()).blocked).toEqual([]);
  });

  for (const before of ['confirmed', 'awaitingReply'] as const) {
    it(`変更が断られたら、前の依頼（${before === 'confirmed' ? '「はい」' : '返事待ち'}）はそのまま確かめに戻り、ほかの手を選ぶと前の依頼に取り消しを伝える`, async () => {
      const h = household('chase');
      if (before === 'confirmed') {
        await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
      }
      await h.homeAt('18:15', '19:30');
      expect(await h.askChange('r-change')).toMatchObject({ status: 'ok' });
      expect(
        await h.run('b', { type: 'recordReply', requestId: 'r-change', reply: 'no' }),
      ).toMatchObject({ status: 'ok' });
      let { plan } = await h.state();
      const r1 = await h.request('r-grandma');
      expect(r1).toMatchObject({ state: before, live: true, needsCheck: true });
      expect(r1?.replacedBy).toBeUndefined();
      expect(r1?.changeAsked).toBeUndefined();
      expect(checkCards(plan, 'b')).toEqual(['r-grandma']);
      expect(cancels(plan, 'r-grandma')).toBe(false);
      expect(cancels(plan, 'r-change')).toBe(false);
      expect(plan.arrangements.find((a) => a.key === care)?.reasons.map((r) => r.code)).toContain(
        'turnedDown',
      );
      // 断られた後に、同じ前の依頼の変更をもう一度は頼めない（ほかの手を選ぶ）。
      expect(await h.askChange('r-again')).toMatchObject({
        status: 'conflict',
        reason: 'alreadySent',
      });
      expect(await h.violations()).toEqual([]);
      expect(
        await h.run('b', {
          type: 'chooseOption',
          arrangementKey: care,
          optionKey: leaveA,
          role: 'primary',
          assigneeId: 'a',
        }),
      ).toMatchObject({ status: 'ok' });
      ({ plan } = await h.state());
      expect(cancels(plan, 'r-grandma')).toBe(true);
      expect(cancels(plan, 'r-change')).toBe(false);
      expect(await h.violations()).toEqual([]);
      expect((await h.blocked()).blocked).toEqual([]);
    });
  }

  it('変更の返事を待つ間に時間がまた変わったら、どちらも確かめに戻り、後の「はい」で今の時間を確保したとは言わない', async () => {
    const h = household('chase');
    await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
    await h.homeAt('18:15', '19:30');
    expect(await h.askChange('r-change')).toMatchObject({ status: 'ok' });
    await h.homeAt('19:10', '19:40', 'b');
    expect(await h.window()).toMatchObject({ end: '2026-12-07T19:30+09:00' });
    let { plan } = await h.state();
    expect(await h.request('r-change')).toMatchObject({ live: true, needsCheck: true });
    expect((await h.request('r-grandma'))?.changeAsked).toBeUndefined();
    expect(checkCards(plan, 'b').sort()).toEqual(['r-change', 'r-grandma']);
    // 変更の返事を待つ間は、次の変更は頼めない（一つずつ）。
    expect(await h.askChange('r-third')).toMatchObject({
      status: 'conflict',
      reason: 'alreadySent',
    });
    expect(await h.violations()).toEqual([]);
    // 後から変更（前の時間）に「はい」：前の依頼は替わるが、今の時間を確保したとは言わない（確かめが要る）。
    await h.run('b', { type: 'recordReply', requestId: 'r-change', reply: 'yes' });
    ({ plan } = await h.state());
    expect(await h.request('r-grandma')).toMatchObject({ replacedBy: 'r-change', live: false });
    expect(await h.request('r-change')).toMatchObject({
      state: 'confirmed',
      live: true,
      needsCheck: true,
    });
    expect(checkCards(plan, 'b')).toEqual(['r-change']);
    // 替えたお願いの時間をもう一度変えるのは頼める（名指すのは、今残っている変更のお願い）。
    expect(await h.askChange('r-third', 'r-change')).toMatchObject({ status: 'ok' });
    expect(await h.request('r-change')).toMatchObject({ changeAsked: 'r-third' });
    expect(await h.violations()).toEqual([]);
  });

  it('外で送った後、記録する前にもう一人が時間を変えたら、送った時間を今の時間として記録しない', async () => {
    const h = household('chase');
    await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
    await h.homeAt('18:15', '19:30');
    const shown = await h.window();
    const old = (await h.request('r-grandma'))?.window;
    if (!old) throw new Error('前の依頼の時間が無い');
    const { plan } = await h.state();
    await h.homeAt('19:10', '19:40', 'b');
    const before = (await h.state()).events.length;
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-stale',
        window: shown,
        shown: { throughSeq: plan.throughSeq, at: plan.now },
        replaces: { requestId: 'r-grandma', window: old },
      }),
    ).toMatchObject({ status: 'conflict' });
    expect((await h.state()).events.length).toBe(before);
  });

  it('名指しの前の依頼が違う・見せた前の時間が違う・時間が変わっていない・担当でない時は受けず、何も書かない', async () => {
    const h = household('backup');
    const old = (await h.request('r-grandma'))?.window;
    const gakudo = (await h.request('r-gakudo'))?.window;
    if (!old || !gakudo) throw new Error('前の依頼の時間が無い');
    const count = async () => (await h.state()).events.length;
    const change = async (
      requestId: string,
      replaces: { requestId: string; window: typeof old },
      memberId = 'b',
    ) =>
      h.run(memberId, {
        type: 'recordSent',
        taskKey: ask,
        requestId,
        window: await h.window(),
        replaces,
      });
    let before = await count();
    // 時間が変わっていない：変更のお願いではない。
    expect(await change('r-same', { requestId: 'r-grandma', window: old })).toMatchObject({
      status: 'conflict',
      reason: 'proposalChanged',
    });
    expect(await count()).toBe(before);
    await h.homeAt('18:15', '19:30');
    before = await count();
    // 別の作業（学童への届け）の依頼・無い依頼を名指す。
    expect(await change('r-other', { requestId: 'r-gakudo', window: gakudo })).toMatchObject({
      status: 'conflict',
      reason: 'requestGone',
    });
    expect(await change('r-none', { requestId: 'r-nothing', window: old })).toMatchObject({
      status: 'conflict',
      reason: 'requestGone',
    });
    // 見せた前の時間が、前の依頼の控えと違う。
    expect(
      await change('r-shifted', {
        requestId: 'r-grandma',
        window: { start: old.start, end: '2026-12-07T18:00+09:00' },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
    // 頼む作業の担当でない大人。
    expect(await change('r-not-mine', { requestId: 'r-grandma', window: old }, 'a')).toMatchObject({
      status: 'forbidden',
    });
    expect(await count()).toBe(before);
    expect(await h.violations()).toEqual([]);
  });

  it('家族が「もう要らない」と決めた前のお願いは、時間の変更のお願いで替えない', async () => {
    const h = household('chase');
    await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
    await h.homeAt('18:15', '19:30');
    // 手が同じ日に選ばれている間は、今は「もう要らない」を受けない。この規則より前の記録（や二つの画面の行き違い）で
    // 決めが残っている時を、事象で書く。
    expect(
      await h.run('b', {
        type: 'resolveRequestCheck',
        requestId: 'r-grandma',
        decision: 'cancel',
        seen: { throughSeq: (await h.state()).plan.throughSeq },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'optionStillChosen' });
    await h.append(
      [{ type: 'requestCheckResolved', requestId: 'r-grandma', decision: 'cancel' }],
      'b',
    );
    const before = (await h.state()).events.length;
    expect(await h.askChange('r-change')).toMatchObject({
      status: 'conflict',
      reason: 'requestGone',
    });
    expect((await h.state()).events.length).toBe(before);
    expect(cancels((await h.state()).plan, 'r-grandma')).toBe(true);
  });

  it('名指しの無い同じ日の二通目は今までどおり受けず、二つの画面から同じ変更を記録しても二通目は受けない', async () => {
    const h = household('chase');
    await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
    await h.homeAt('18:15', '19:30');
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-plain',
        window: await h.window(),
      }),
    ).toMatchObject({ status: 'conflict', reason: 'alreadySent' });
    expect(await h.askChange('r-first')).toMatchObject({ status: 'ok' });
    expect(await h.askChange('r-second')).toMatchObject({
      status: 'conflict',
      reason: 'alreadySent',
    });
    expect(
      (await h.state()).plan.requests.filter((r) => r.replaces).map((r) => r.requestId),
    ).toEqual(['r-first']);
  });
});

describe('時間の変更のお願いを、エンジンと検証器が事象から確かめる', () => {
  /** 前の依頼に「はい」、時間が延びた家庭と、前の依頼の控え。 */
  async function lengthened() {
    const h = household('chase');
    await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
    await h.homeAt('18:15', '19:30');
    const sent = (await h.state()).events.find(
      (e) => e.type === 'externalRequestSent' && e.requestId === 'r-grandma',
    );
    if (sent?.type !== 'externalRequestSent' || !sent.snapshot?.window)
      throw new Error('控えが無い');
    return { h, snapshot: sent.snapshot, old: sent.snapshot.window };
  }

  it('名指しの無い同じ日の依頼（午後を別に頼んだ等）に「はい」でも、前の依頼は替わらない', async () => {
    const { h, snapshot } = await lengthened();
    await h.append(
      [
        {
          type: 'externalRequestSent',
          taskKey: ask,
          requestId: 'r-afternoon',
          snapshot: { ...snapshot, window: await h.window() },
        },
        { type: 'externalReplyRecorded', requestId: 'r-afternoon', reply: 'yes' },
      ],
      'b',
    );
    const r1 = await h.request('r-grandma');
    expect(r1?.replacedBy).toBeUndefined();
    expect(r1).toMatchObject({ live: true, needsCheck: true });
    expect((await h.request('r-afternoon'))?.replaces).toBeUndefined();
  });

  for (const [label, change] of [
    ['相手が違う', { to: 'gakudo' }],
    ['子が無い', { childId: undefined }],
  ] as const) {
    it(`名指しがあっても結べない変更（${label}）では、前の依頼は替わらない`, async () => {
      const { h, snapshot, old } = await lengthened();
      await h.append(
        [
          {
            type: 'externalRequestSent',
            taskKey: ask,
            requestId: 'r-forged',
            snapshot: { ...snapshot, ...change, window: await h.window() },
            replaces: { requestId: 'r-grandma', window: old },
          },
          { type: 'externalReplyRecorded', requestId: 'r-forged', reply: 'yes' },
        ],
        'b',
      );
      expect((await h.request('r-grandma'))?.replacedBy).toBeUndefined();
      expect((await h.request('r-forged'))?.replaces).toBeUndefined();
      expect(await h.violations()).not.toContain('request_replacement_missing');
    });
  }

  it('見せた前の時間が控えと違う・家庭の時区で別の日の変更は結ばない（時刻の文字の先頭だけで日を決めない）', async () => {
    const { h, snapshot, old } = await lengthened();
    const now = await h.window();
    // 同じ瞬間を UTC で書いた前の時間は、同じ時間として結べる。
    const utc = (at: string) => new Date(at).toISOString().replace(/:00\.000Z$/, '+00:00');
    await h.append(
      [
        {
          type: 'externalRequestSent',
          taskKey: ask,
          requestId: 'r-utc',
          snapshot: { ...snapshot, window: now },
          replaces: {
            requestId: 'r-grandma',
            window: { start: utc(old.start), end: utc(old.end) },
          },
        },
      ],
      'b',
    );
    expect((await h.request('r-utc'))?.replaces?.requestId).toBe('r-grandma');
    // 家庭の時区では次の日（12/8 0:30〜7:00）だが、UTC で書くと日付の文字が前の依頼と同じ 12/7 になる時間は、
    // 同じ日の変更として結ばない。
    const h2 = (await lengthened()).h;
    await h2.append(
      [
        {
          type: 'externalRequestSent',
          taskKey: ask,
          requestId: 'r-nextday',
          snapshot: {
            ...snapshot,
            window: { start: '2026-12-07T15:30+00:00', end: '2026-12-07T22:00+00:00' },
          },
          replaces: { requestId: 'r-grandma', window: old },
        },
      ],
      'b',
    );
    expect((await h2.request('r-nextday'))?.replaces).toBeUndefined();
  });

  it('検証器は、事象で示せない「替わった」「変更待ち」「結び」と、替わった依頼への取り消しを違反にする', async () => {
    const { h } = await lengthened();
    const { plan } = await h.state();
    const forge = (edit: (p: Plan) => void) => {
      const copy = structuredClone(plan);
      edit(copy);
      return copy;
    };
    const r1 = (p: Plan) => {
      const found = p.requests.find((r) => r.requestId === 'r-grandma');
      if (!found) throw new Error('依頼が無い');
      return found;
    };
    expect(
      await h.violations(
        forge((p) => {
          Object.assign(r1(p), { replacedBy: 'r-x', live: false });
          delete r1(p).needsCheck;
        }),
      ),
    ).toContain('request_replacement_unproven');
    expect(
      await h.violations(forge((p) => Object.assign(r1(p), { changeAsked: 'r-x' }))),
    ).toContain('request_change_unproven');
    expect(
      await h.violations(
        forge((p) =>
          Object.assign(r1(p), {
            replaces: { requestId: 'r-gakudo', window: r1(p).window },
          }),
        ),
      ),
    ).toContain('request_change_unproven');

    // 本当に替わった後：替わった依頼を生きている物にする・取り消しを足すのは違反。
    expect(await h.askChange('r-change')).toMatchObject({ status: 'ok' });
    await h.run('b', { type: 'recordReply', requestId: 'r-change', reply: 'yes' });
    const replaced = (await h.state()).plan;
    const revive = structuredClone(replaced);
    const back = revive.requests.find((r) => r.requestId === 'r-grandma');
    if (!back) throw new Error('依頼が無い');
    delete back.replacedBy;
    back.live = true;
    expect(await h.violations(revive)).toContain('request_replacement_missing');
    const extra = structuredClone(replaced);
    const model = extra.tasks.find((t) => t.key === ask);
    if (!model) throw new Error('頼む作業が無い');
    extra.tasks.push({
      ...model,
      key: keys.cancellationTask('r-grandma'),
      titleKey: 'task.cancelRequest',
      cancels: 'r-grandma',
      commitment: 'proposed',
      live: true,
    });
    expect(await h.violations(extra)).toContain('unexpected_cancellation');
  });
});

describe('時間のほかも変わった依頼には、時間の変更のお願いを出さない', () => {
  type Snapshot = NonNullable<Extract<DomainEvent, { type: 'externalRequestSent' }>['snapshot']>;
  /** 用意した段の祖母の依頼（r-grandma）の、送った時の控え（今の根拠と同じ）。 */
  const seededSnapshot = (): Snapshot => {
    const sent = demoEvents('chase').find(
      (e) => e.type === 'externalRequestSent' && e.requestId === 'r-grandma',
    );
    if (sent?.type !== 'externalRequestSent' || !sent.snapshot?.condition)
      throw new Error('控えが無い');
    return sent.snapshot;
  };
  /** 祖母の依頼の控えを書き換えた家庭（送った時の条件の形が今と違う・控えに条件の形が無い古い事象）。 */
  const editedHousehold = (edit: (snapshot: Snapshot) => void) =>
    household('chase', (events) =>
      events.map((e) => {
        if (e.type !== 'externalRequestSent' || e.requestId !== 'r-grandma' || !e.snapshot)
          return e;
        const copy = structuredClone(e);
        if (copy.snapshot) edit(copy.snapshot);
        return copy;
      }),
    );

  const cases: readonly [string, () => Promise<ReturnType<typeof household>>, () => Snapshot][] = [
    [
      '送った時の条件の形が今と違う（読み直しで発表会の日の条件が替わった）',
      async () => {
        const h = editedHousehold((snapshot) => {
          const changed = snapshot.condition?.replace('2026-12-05', '2026-12-08');
          expect(changed).not.toBe(snapshot.condition);
          snapshot.condition = changed;
        });
        await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
        return h;
      },
      seededSnapshot,
    ],
    [
      '控えに条件の形が無い古い依頼（同じと推さない）',
      async () => {
        const h = editedHousehold((snapshot) => {
          delete snapshot.condition;
        });
        await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
        return h;
      },
      seededSnapshot,
    ],
    [
      '条件付きで頼んだ後に、条件が決まって条件付きでなくなった',
      async () => {
        const h = household('chase');
        await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
        expect((await h.request('r-grandma'))?.conditional).toBe(true);
        expect(
          await h.run('a', { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' }),
        ).toMatchObject({ status: 'ok' });
        // 条件が決まっただけでは、確かめは要らない（頼んだ時の前提のとおり）。
        expect(await h.request('r-grandma')).toMatchObject({ live: true, state: 'confirmed' });
        expect((await h.request('r-grandma'))?.conditional).toBeUndefined();
        expect((await h.request('r-grandma'))?.needsCheck).toBeUndefined();
        return h;
      },
      () => ({ ...seededSnapshot(), conditional: false }),
    ],
  ];

  for (const [label, setup, current] of cases) {
    it(`${label}時は、時間だけの変更と言わず、変更のお願いを受けず、偽の結びも結ばない`, async () => {
      const h = await setup();
      await h.homeAt('18:15', '19:30');
      const r1 = await h.request('r-grandma');
      expect(r1).toMatchObject({ state: 'confirmed', live: true, needsCheck: true });
      expect(r1?.timeOnly).toBeUndefined();
      expect(checkCards((await h.state()).plan, 'b')).toEqual(['r-grandma']);

      // 正式な命令：前の依頼を名指ししても受けず、何も書かない。
      const before = (await h.state()).events.length;
      expect(await h.askChange('r-change')).toMatchObject({
        status: 'conflict',
        reason: 'proposalChanged',
      });
      expect((await h.state()).events.length).toBe(before);

      // 偽の事象：今の根拠で送ったように書いた変更のお願いに「はい」でも、前の依頼は替わらない。
      const old = r1?.window;
      if (!old) throw new Error('前の依頼の時間が無い');
      await h.append(
        [
          {
            type: 'externalRequestSent',
            taskKey: ask,
            requestId: 'r-forged',
            snapshot: { ...current(), window: await h.window() },
            replaces: { requestId: 'r-grandma', window: old },
          },
          { type: 'externalReplyRecorded', requestId: 'r-forged', reply: 'yes' },
        ],
        'b',
      );
      expect((await h.request('r-grandma'))?.replacedBy).toBeUndefined();
      expect((await h.request('r-forged'))?.replaces).toBeUndefined();
      expect(await h.violations()).not.toContain('request_replacement_missing');
    });
  }
});

describe('使えないとした手の前の依頼', () => {
  const now = DEMO_STAGES.find((s) => s.id === 'chase')?.now ?? '';
  /** 祖母に「はい」をもらい、時間が延びた家庭で、祖母の手を家族が「使えない」にする（家の情報の直し）。 */
  const markUnusable = async (h: ReturnType<typeof household>) => {
    const { home } = await h.state();
    await h.append(
      [{ type: 'householdSet', household: { ...home, unusableCareOptionIds: ['opt-grandma'] } }],
      'a',
    );
  };

  it('使えないとした後の画面からは、時間の変更のお願いを受けない（入口も出さない）', async () => {
    const h = household('chase');
    await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
    await h.homeAt('18:15', '19:30');
    await markUnusable(h);
    const r1 = await h.request('r-grandma');
    expect(r1).toMatchObject({ live: true, needsCheck: true });
    expect(r1?.timeOnly).toBeUndefined();
    const before = (await h.state()).events.length;
    // 見せた画面の印が無い命令も、今の画面の印を付けた命令も受けない。
    expect(await h.askChange('r-change')).toMatchObject({
      status: 'conflict',
      reason: 'proposalChanged',
    });
    const { plan } = await h.state();
    if (!r1?.window) throw new Error('前の依頼の時間が無い');
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-change2',
        shown: { throughSeq: plan.throughSeq, at: now },
        window: await h.window(),
        replaces: { requestId: 'r-grandma', window: r1.window },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'proposalChanged' });
    expect((await h.state()).events.length).toBe(before);
  });

  it('送った時の画面で頼めた変更は、送った後にもう一人が「使えない」にしても記録し、確かめの札で追う', async () => {
    const h = household('chase');
    await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
    await h.homeAt('18:15', '19:30');
    // 彩が見ていた画面：時間の変更を頼める。
    const seen = await h.state();
    const r1 = seen.plan.requests.find((r) => r.requestId === 'r-grandma');
    expect(r1?.timeOnly).toBe(true);
    if (!r1?.window) throw new Error('前の依頼の時間が無い');
    const window = await h.window();
    // 彩が外で送った後、記録する前に、健太が祖母の手を「使えない」にした。
    await markUnusable(h);
    expect(
      await h.run('b', {
        type: 'recordSent',
        taskKey: ask,
        requestId: 'r-change',
        shown: { throughSeq: seen.plan.throughSeq, at: now },
        window,
        replaces: { requestId: 'r-grandma', window: r1.window },
      }),
    ).toMatchObject({ status: 'ok' });
    // 送った事実は残し、どちらの依頼も、要るかを頼んだ本人に確かめる（新しい時間を確保したとは言わない）。
    expect(await h.request('r-change')).toMatchObject({
      state: 'awaitingReply',
      live: true,
      needsCheck: true,
      replaces: { requestId: 'r-grandma' },
    });
    expect(await h.request('r-grandma')).toMatchObject({ live: true, needsCheck: true });
    expect((await h.request('r-grandma'))?.changeAsked).toBeUndefined();
    expect(checkCards((await h.state()).plan, 'b').sort()).toEqual(['r-change', 'r-grandma']);
    expect(await h.violations()).toEqual([]);
  });
});

describe('所への届け（学童）', () => {
  it('時間だけが変わっても、所への届けには時間の変更のお願いを受けない（相手に送る文を作れない）', async () => {
    const h = household('backup');
    await h.homeAt('18:15', '19:30');
    // 学童への届けも、変わったのは時間だけ（計画は timeOnly と言う）。入口を出すかは、相手が人かで決める。
    const r = await h.request('r-gakudo');
    expect(r).toMatchObject({ to: 'gakudo', live: true, needsCheck: true, timeOnly: true });
    if (!r?.window) throw new Error('前の依頼の時間が無い');
    const before = (await h.state()).events.length;
    expect(
      await h.run('a', {
        type: 'recordSent',
        taskKey: keys.task(keys.option(care, 'opt-gakudo'), 'submit'),
        requestId: 'r-gakudo-change',
        window: await h.window(),
        replaces: { requestId: 'r-gakudo', window: r.window },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'requestGone' });
    expect((await h.state()).events.length).toBe(before);
  });
});

describe('変更の返事待ちの間に手を使えないとした時（検証器）', () => {
  it('前の依頼の確かめを止めたと言う計画は、お願いの手が使えない・お願いが確かめ待ちなら違反にする', async () => {
    const h = household('chase');
    await h.run('b', { type: 'recordReply', requestId: 'r-grandma', reply: 'yes' });
    await h.homeAt('18:15', '19:30');
    expect(await h.askChange('r-change')).toMatchObject({ status: 'ok' });
    expect((await h.request('r-grandma'))?.changeAsked).toBe('r-change');
    const { home } = await h.state();
    await h.append(
      [{ type: 'householdSet', household: { ...home, unusableCareOptionIds: ['opt-grandma'] } }],
      'a',
    );
    // エンジン：どちらも確かめに戻し、前の依頼の札を止めない。
    expect(await h.request('r-change')).toMatchObject({ live: true, needsCheck: true });
    expect((await h.request('r-grandma'))?.changeAsked).toBeUndefined();
    expect(await h.violations()).toEqual([]);
    const { plan } = await h.state();
    const forged = (edit: (p: Plan) => void) => {
      const copy = structuredClone(plan);
      edit(copy);
      return copy;
    };
    const find = (p: Plan, id: string) => {
      const found = p.requests.find((r) => r.requestId === id);
      if (!found) throw new Error('依頼が無い');
      return found;
    };
    // 前の依頼の札だけを止めた計画。
    expect(
      await h.violations(
        forged((p) => Object.assign(find(p, 'r-grandma'), { changeAsked: 'r-change' })),
      ),
    ).toContain('request_change_unproven');
    // お願いの確かめ待ちも消した計画でも、手が使えないことは家庭の記録から分かる。
    expect(
      await h.violations(
        forged((p) => {
          Object.assign(find(p, 'r-grandma'), { changeAsked: 'r-change' });
          delete find(p, 'r-change').needsCheck;
        }),
      ),
    ).toContain('request_change_unproven');
  });
});
