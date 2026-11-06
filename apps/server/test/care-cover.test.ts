// 子の居場所の取れる手が、手配の時間のうち見てもらえない時間を持つ時（学童の一日利用の時間が短い、休む大人に
// その日の手が離せない時間がある）。足りない手は、勧めず、新しくは選べず、受け付けられても確保とは言わない。今使う
// 手が後から足りなくなれば、手配にその時間を書き、決める札を残す。見本の家族（架空）と、画面と同じ命令の道を通す。
import {
  afterSchoolOption,
  type Command,
  type Household,
  leaveOption,
  notificationHistory,
  notificationIntents,
  type PlanResult,
  proposalSnapshot,
  securedBackup,
  todayCards,
} from '@maniau/core';
import { computePlan, keys } from '@maniau/core/engine';
import { verifyPlan } from '@maniau/verify';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { DEMO_STAGES, demoEvents } from '../src/demo';
import { sendGate } from '../src/gate';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const ARRANGEMENT = 'arr:childCare:n1:i6:c';
const NEAR = '2026-12-06T06:10+09:00';

function family(
  stage: Parameters<typeof demoEvents>[0],
  edit: (h: Household) => Household = (h) => h,
) {
  const now = DEMO_STAGES.find((s) => s.id === stage)?.now ?? '';
  const events = demoEvents(stage).map((event) =>
    event.type === 'householdSet' ? { ...event, household: edit(event.household) } : event,
  );
  const store = memoryStore(new Map([['demo', events]]));
  let op = 0;
  const state = (at = now) =>
    store.withHousehold('demo', (log) => {
      const all = [...log.events()];
      const set = all.findLast((event) => event.type === 'householdSet');
      if (set?.type !== 'householdSet') throw new Error('家庭が無い');
      return { events: all, home: set.household, plan: computePlan(all, at) };
    });
  const run = (memberId: string, command: Command) =>
    runCommand(store, 'demo', { memberId, operationId: `cover-${++op}`, now, demo: true }, command);
  /** 見てから、見た物で家の情報を書く（画面と同じ）。 */
  const saveHousehold = async (memberId: string, next: Household) => {
    const current = await state();
    const preview = previewChange(
      current.events,
      { memberId, now },
      {
        type: 'updateHousehold',
        household: next,
      },
    );
    if ('status' in preview) throw new Error(`preview: ${preview.status}/${preview.reason}`);
    return run(memberId, {
      type: 'updateHousehold',
      household: next,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    });
  };
  return { state, run, saveHousehold };
}

const care = (plan: PlanResult) => {
  const found = plan.arrangements.find((a) => a.key === ARRANGEMENT);
  if (!found) throw new Error('手配が無い');
  return found;
};
const clock = (spans: readonly { start: string; end: string }[] | undefined) =>
  (spans ?? []).map((g) => [g.start.slice(11, 16), g.end.slice(11, 16)]);
const violations = (args: Parameters<typeof verifyPlan>[0]) =>
  verifyPlan(args)
    .issues.filter((i) => i.kind === 'violation')
    .map((i) => i.code);
/** その時の知らせの意図と、送る前の門（検証器が独立に照らす）が止めた物。 */
const notices = (s: {
  home: Household;
  plan: PlanResult;
  events: Parameters<typeof notificationHistory>[0];
}) => {
  const intents = notificationIntents(s.plan, s.home, notificationHistory(s.events));
  const gate = sendGate({
    household: s.home,
    plan: s.plan,
    events: s.events,
    intents,
    batchEnds: s.events.map((e) => e.seq),
  });
  return { intents, blocked: intents.filter((i) => gate.blocked.has(i.key)), gate };
};

describe('学童の一日利用の時間が、手配の時間より短い', () => {
  it('足りない時間を示し、勧めず、選べない。検証器も同じ時間を求める', async () => {
    const { state, run, saveHousehold } = family('chase');
    const next = structuredClone((await state()).home);
    next.places.push({ id: 'p-short', kind: 'afterSchoolCare', name: '架空の短い学童', goods: [] });
    next.careOptions.push(
      afterSchoolOption(
        'opt-short',
        'p-short',
        { type: 'daysBefore', days: 3, at: '21:00' },
        500,
        false,
        { start: '09:00', end: '16:00' },
      ),
    );
    expect(await saveHousehold('a', next)).toMatchObject({ status: 'ok' });
    const now = await state();
    const arrangement = care(now.plan);
    expect([arrangement.start.slice(11, 16), arrangement.end.slice(11, 16)]).toEqual([
      '08:10',
      '18:15',
    ]);
    const optionKey = keys.option(ARRANGEMENT, 'opt-short');
    const option = arrangement.options.find((o) => o.key === optionKey);
    expect(clock(option?.coverGaps)).toEqual([
      ['08:10', '09:00'],
      ['16:00', '18:15'],
    ]);
    expect(arrangement.recommendedOptionKey).not.toBe(optionKey);
    // 見本の学童（08:00–19:00）は、この日の手配の時間を全部見てもらえる。
    const full = arrangement.options.find((o) => o.templateId === 'opt-gakudo');
    expect(full?.coverGaps).toBeUndefined();
    for (const role of ['primary', 'backup'] as const) {
      expect(
        await run('a', { type: 'chooseOption', arrangementKey: ARRANGEMENT, optionKey, role }),
      ).toMatchObject({ status: 'invalid', reason: 'optionNotCovering' });
    }
    expect(violations({ household: now.home, events: now.events, plan: now.plan })).toEqual([]);
    // 検証器は、計画から足りない時間を消すと、家庭の記録から求めた物と違うと言う（エンジンを読まない）。
    const tampered = structuredClone(now.plan);
    const hidden = care(tampered).options.find((o) => o.key === optionKey);
    if (hidden) delete hidden.coverGaps;
    expect(violations({ household: now.home, events: now.events, plan: tampered })).toContain(
      'care_cover_gap_missing',
    );
  });
});

describe('休む大人に、その日の手が離せない時間がある', () => {
  // 見本の家族にあらかじめある休みの手を除き、休みの手を家族が足す形で入れる（架空の初期条件）。
  const withoutLeave = (h: Household): Household => ({
    ...h,
    careOptions: h.careOptions.filter((o) => o.kind !== 'paidLeave'),
  });

  it('受け付けられた予備でも、後から足りなくなれば確保と言わず、返事待ちの追いかけが戻る', async () => {
    const { state, run, saveHousehold } = family('chase', withoutLeave);
    const start = structuredClone((await state()).home);
    start.careOptions.push(leaveOption('opt-leave-new', 'a', 'work-a', 3, '18:00'));
    expect(await saveHousehold('a', start)).toMatchObject({ status: 'ok' });
    const optionKey = keys.option(ARRANGEMENT, 'opt-leave-new');
    expect(
      await run('a', {
        type: 'chooseOption',
        arrangementKey: ARRANGEMENT,
        optionKey,
        role: 'backup',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const chosen = care((await state()).plan);
    expect(
      await run('a', {
        type: 'recordSent',
        taskKey: keys.task(optionKey, 'apply'),
        requestId: 'r-leave-new',
        window: { start: chosen.start, end: chosen.end },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await run('a', { type: 'recordReply', requestId: 'r-leave-new', reply: 'yes' }),
    ).toMatchObject({ status: 'ok' });
    const before = await state(NEAR);
    expect(securedBackup(before.plan, care(before.plan))?.key).toBe(optionKey);
    const chasing = (plan: PlanResult) =>
      todayCards(plan, 'b').main.filter((c) => c.kind === 'noReply');
    expect(chasing(before.plan)).toHaveLength(0);

    // 休む大人に、その日 11:00–12:00 の手が離せない時間を足す（家でのオンライン会議など）。
    const busy = structuredClone((await state()).home);
    busy.unavailable = [
      ...(busy.unavailable ?? []),
      { id: 'u-busy', memberId: 'a', date: '2026-12-07', start: '11:00', end: '12:00' },
    ];
    expect(await saveHousehold('a', busy)).toMatchObject({ status: 'ok' });
    const after = await state(NEAR);
    const arrangement = care(after.plan);
    expect(clock(arrangement.options.find((o) => o.key === optionKey)?.coverGaps)).toEqual([
      ['11:00', '12:00'],
    ]);
    expect(securedBackup(after.plan, arrangement)).toBeUndefined();
    expect(chasing(after.plan).length).toBeGreaterThan(0);
    expect(violations({ household: after.home, events: after.events, plan: after.plan })).toEqual(
      [],
    );
    // 返事を待つ知らせも戻り、送る前の門（検証器）も、その予備を確保と数えずに通す。
    const sent = notices(after);
    expect(sent.intents.some((i) => i.titleKey === 'notify.noReply')).toBe(true);
    expect(sent.blocked).toEqual([]);
  });

  it('今使う本命が後から足りなくなれば、手配にその時間を書き、決める札を残す', async () => {
    const { state, run, saveHousehold } = family('arrived', withoutLeave);
    const start = structuredClone((await state()).home);
    start.careOptions.push(leaveOption('opt-leave-new', 'a', 'work-a', 3, '18:00'));
    expect(await saveHousehold('a', start)).toMatchObject({ status: 'ok' });
    const optionKey = keys.option(ARRANGEMENT, 'opt-leave-new');
    expect(
      await run('a', {
        type: 'chooseOption',
        arrangementKey: ARRANGEMENT,
        optionKey,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const settled = care((await state()).plan);
    expect(settled.inUseOptionKey).toBe(optionKey);
    expect(settled.reasons.some((r) => r.code === 'notCovered')).toBe(false);

    const busy = structuredClone((await state()).home);
    busy.unavailable = [
      ...(busy.unavailable ?? []),
      { id: 'u-busy', memberId: 'a', date: '2026-12-07', start: '11:00', end: '12:00' },
    ];
    expect(await saveHousehold('a', busy)).toMatchObject({ status: 'ok' });
    const after = await state();
    const arrangement = care(after.plan);
    expect(arrangement.reasons.find((r) => r.code === 'notCovered')?.refs).toEqual([
      expect.stringMatching(/^2026-12-07T11:00.*\/2026-12-07T12:00/),
    ]);
    const decide = todayCards(after.plan, 'a').main.filter(
      (c) => c.kind === 'decide' && c.arrangement.key === ARRANGEMENT,
    );
    expect(decide).toHaveLength(1);
    expect(violations({ household: after.home, events: after.events, plan: after.plan })).toEqual(
      [],
    );
    // 検証器は、手配から足りない時間の記録を消すと、そう言う。
    const tampered = structuredClone(after.plan);
    const hidden = care(tampered);
    hidden.reasons = hidden.reasons.filter((r) => r.code !== 'notCovered');
    expect(violations({ household: after.home, events: after.events, plan: tampered })).toContain(
      'care_not_covered_missing',
    );
  });
});

describe('休む本人が子を見る作業', () => {
  const withoutLeave = (h: Household): Household => ({
    ...h,
    careOptions: h.careOptions.filter((o) => o.kind !== 'paidLeave'),
  });
  /** 美咲（b）が 12/7 の朝と夕方は見られる（手配の時間が 9:00–17:00 になる）。 */
  const shorter = (h: Household): Household => ({
    ...h,
    dayAnswers: [
      ...(h.dayAnswers ?? []).filter((a) => !(a.memberId === 'b' && a.date === '2026-12-07')),
      {
        memberId: 'b',
        date: '2026-12-07',
        can: [
          { start: '06:00', end: '09:00' },
          { start: '17:00', end: '23:00' },
        ],
        cannot: [],
        rest: 'cannot',
      },
    ],
  });

  it('見る子と手配の時間が控えに入り、古い控えでは引き受けず、時間が替われば確かめ直す', async () => {
    const { state, run, saveHousehold } = family('arrived', withoutLeave);
    const start = structuredClone((await state()).home);
    start.careOptions.push(leaveOption('opt-leave-new', 'a', 'work-a', 3, '18:00'));
    expect(await saveHousehold('a', start)).toMatchObject({ status: 'ok' });
    const optionKey = keys.option(ARRANGEMENT, 'opt-leave-new');
    // 美咲が、健太の休みを本命に選ぶ（休みを伝えるのは健太だけ）。
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: ARRANGEMENT,
        optionKey,
        role: 'primary',
      }),
    ).toMatchObject({ status: 'ok' });
    const taskKey = keys.task(optionKey, 'apply');
    const first = (await state()).plan.tasks.find((t) => t.key === taskKey);
    expect(first?.watch?.childId).toBe('c');
    expect(clock(first?.watch ? [first.watch] : [])).toEqual([['08:10', '18:15']]);
    const old = first && proposalSnapshot(first);
    if (!old) throw new Error('控えが無い');
    // 申し込む作業そのもの（日・時刻・用件）は替わらないまま、手配の時間だけが 9:00–17:00 になる。
    expect(await saveHousehold('b', shorter((await state()).home))).toMatchObject({
      status: 'ok',
    });
    const moved = (await state()).plan.tasks.find((t) => t.key === taskKey);
    expect(clock(moved?.watch ? [moved.watch] : [])).toEqual([['09:00', '17:00']]);
    expect(await run('a', { type: 'accept', taskKey, shown: old })).toMatchObject({
      status: 'conflict',
      reason: 'proposalChanged',
    });
    const now = moved && proposalSnapshot(moved);
    if (!now) throw new Error('控えが無い');
    expect(await run('a', { type: 'accept', taskKey, shown: now })).toMatchObject({
      status: 'ok',
    });
    expect((await state()).plan.tasks.find((t) => t.key === taskKey)?.reconfirm).toBeUndefined();
    // 引き受けた後に手配の時間が替われば（美咲の答えを外す）、確かめ直してもらう。
    const back = structuredClone((await state()).home);
    back.dayAnswers = (back.dayAnswers ?? []).filter((a) => a.memberId !== 'b');
    expect(await saveHousehold('b', back)).toMatchObject({ status: 'ok' });
    const after = await state();
    expect(after.plan.tasks.find((t) => t.key === taskKey)?.reconfirm).toBe(true);
    expect(violations({ household: after.home, events: after.events, plan: after.plan })).toEqual(
      [],
    );
    // 検証器は、子を見る作業から見る子と時間を消すと、そう言う。
    const tampered = structuredClone(after.plan);
    const hidden = tampered.tasks.find((t) => t.key === taskKey);
    if (hidden) delete hidden.watch;
    expect(violations({ household: after.home, events: after.events, plan: tampered })).toContain(
      'care_watch_mismatch',
    );
  });

  it('選んだ後に本人が答え直した見られない時間は数え、選ぶ前の答え（仕事で見られない）は数えない', async () => {
    // 健太は、選ぶ前に 12/7 を「8:10–18:15 は見られない（仕事）」と答えていた。
    const before = (h: Household): Household => ({
      ...withoutLeave(h),
      dayAnswers: [
        ...(h.dayAnswers ?? []),
        {
          memberId: 'a',
          date: '2026-12-07',
          can: [],
          cannot: [{ start: '08:10', end: '18:15' }],
          rest: 'can',
        },
      ],
    });
    const { state, run, saveHousehold } = family('chase', before);
    const start = structuredClone((await state()).home);
    start.careOptions.push(leaveOption('opt-leave-new', 'a', 'work-a', 3, '18:00'));
    expect(await saveHousehold('a', start)).toMatchObject({ status: 'ok' });
    const optionKey = keys.option(ARRANGEMENT, 'opt-leave-new');
    expect(
      care((await state()).plan).options.find((o) => o.key === optionKey)?.coverGaps,
    ).toBeUndefined();
    expect(
      await run('a', {
        type: 'chooseOption',
        arrangementKey: ARRANGEMENT,
        optionKey,
        role: 'backup',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const chosen = care((await state()).plan);
    expect(
      await run('a', {
        type: 'recordSent',
        taskKey: keys.task(optionKey, 'apply'),
        requestId: 'r-leave-new',
        window: { start: chosen.start, end: chosen.end },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(
      await run('a', { type: 'recordReply', requestId: 'r-leave-new', reply: 'yes' }),
    ).toMatchObject({ status: 'ok' });
    const secured = await state(NEAR);
    expect(securedBackup(secured.plan, care(secured.plan))?.key).toBe(optionKey);

    // 承認の後に、健太が 12/7 を「8:10–18:15 は見られない、ほかは分からない」と答え直す（中身が変わったので、選んだ
    // 後の答えになる。手配の時間は替わらない）。手配の時間は大人の全員が見られない時間なので、休む本人がそう答えれば、
    // 手配の時間の全部が見てもらえない時間（確かめられない、ではない）。分からない残りは手配の時間の外にある。
    const cannot = structuredClone((await state()).home);
    cannot.dayAnswers = [
      ...(cannot.dayAnswers ?? []).filter((a) => a.memberId !== 'a'),
      {
        memberId: 'a',
        date: '2026-12-07',
        can: [],
        cannot: [{ start: '08:10', end: '18:15' }],
        rest: 'unknown',
      },
    ];
    expect(await saveHousehold('a', cannot)).toMatchObject({ status: 'ok' });
    const after = await state(NEAR);
    const window = care(after.plan);
    const gaps = window.options.find((o) => o.key === optionKey)?.coverGaps;
    expect([window.start, window.end]).toEqual([chosen.start, chosen.end]);
    expect(gaps?.map((g) => [g.start, g.end, g.unsure ?? false])).toEqual([
      [window.start, window.end, false],
    ]);
    expect(securedBackup(after.plan, care(after.plan))).toBeUndefined();
    expect(todayCards(after.plan, 'b').main.some((c) => c.kind === 'noReply')).toBe(true);
    expect(violations({ household: after.home, events: after.events, plan: after.plan })).toEqual(
      [],
    );
  });
});

describe('学童の見てもらえる時間を直す', () => {
  it('学童の手は「うち」の直しで時間を直せ、記録の無い前からの手にも入れられる。休みの手の時間は直せない', async () => {
    // 前からの記録の形：見本の学童の手から、見てもらえる時間を外して始める。
    const legacy = (h: Household): Household => ({
      ...h,
      careOptions: h.careOptions.map((o) => {
        if (o.id !== 'opt-gakudo') return o;
        const { covers: _covers, ...rest } = o;
        return rest;
      }),
    });
    const { state, saveHousehold } = family('arrived', legacy);
    const gakudo = keys.option(ARRANGEMENT, 'opt-gakudo');
    const unknown = care((await state()).plan).options.find((o) => o.key === gakudo);
    expect(unknown?.coverGaps?.every((g) => g.unsure === true)).toBe(true);
    const fix = (covers: unknown) => {
      return async () => {
        const next = structuredClone((await state()).home);
        const option = next.careOptions.find((o) => o.id === 'opt-gakudo');
        if (option) Object.assign(option, { covers });
        return saveHousehold('a', next);
      };
    };
    expect(await fix({ start: '08:00', end: '19:00' })()).toMatchObject({ status: 'ok' });
    expect(
      care((await state()).plan).options.find((o) => o.key === gakudo)?.coverGaps,
    ).toBeUndefined();
    expect(await fix({ start: '09:00', end: '16:00' })()).toMatchObject({ status: 'ok' });
    expect(
      clock(care((await state()).plan).options.find((o) => o.key === gakudo)?.coverGaps),
    ).toEqual([
      ['08:10', '09:00'],
      ['16:00', '18:15'],
    ]);
    // 逆さま・一日の全部・外すは、直せない。
    for (const covers of [{ start: '19:00', end: '08:00' }, 'whole']) {
      await expect(fix(covers)()).rejects.toThrow(/careOptionsLocked/);
    }
    const leave = structuredClone((await state()).home);
    const option = leave.careOptions.find((o) => o.id === 'opt-leave-a');
    if (option) option.covers = { start: '09:00', end: '17:00' };
    await expect(saveHousehold('a', leave)).rejects.toThrow(/careOptionsLocked/);
  });
});

describe('学童の時間を直す前に、変わることを見る', () => {
  const shorter = (stage: Parameters<typeof demoEvents>[0]) => {
    const now = DEMO_STAGES.find((s) => s.id === stage)?.now ?? '';
    const events = demoEvents(stage);
    const set = events.findLast((e) => e.type === 'householdSet');
    if (set?.type !== 'householdSet') throw new Error('家庭が無い');
    const next = structuredClone(set.household);
    const option = next.careOptions.find((o) => o.id === 'opt-gakudo');
    if (option) option.covers = { start: '09:00', end: '16:00' };
    const preview = previewChange(
      events,
      { memberId: 'a', now },
      {
        type: 'updateHousehold',
        household: next,
      },
    );
    if ('status' in preview) throw new Error(`preview: ${preview.status}`);
    return preview.changes;
  };

  it('予備に選んだ学童の時間を短くすると、見てもらえなくなる時間を「変わること」に出す', () => {
    // 見本の段 backup：祖母が本命、学童が予備（申し込みを出してある）。
    const changes = shorter('backup');
    expect(changes.covers?.map((c) => [c.templateId, clock(c.before), clock(c.after)])).toEqual([
      [
        'opt-gakudo',
        [],
        [
          ['08:10', '09:00'],
          ['16:00', '18:15'],
        ],
      ],
    ]);
  });

  it('選んでいない学童でも、まだ選べるなら、見てもらえなくなる時間を出す（勧める手が替われば、それも出す）', () => {
    const gaps = [
      ['08:10', '09:00'],
      ['16:00', '18:15'],
    ];
    // 見本の段 arrived：まだ何も選んでいない。学童を勧めていたので、勧める手も祖母に替わる。
    const arrived = shorter('arrived');
    expect(arrived.covers?.map((c) => [c.templateId, clock(c.before), clock(c.after)])).toEqual([
      ['opt-gakudo', [], gaps],
    ]);
    expect(arrived.recommendations.map((r) => r.after?.templateId)).toEqual(['opt-grandma']);
    // 見本の段 chase：祖母が本命で、学童は選んでいない（勧める手の変化は無い）。選べなくなることは出す。
    const chase = shorter('chase');
    expect(chase.recommendations).toEqual([]);
    expect(chase.covers?.map((c) => [c.templateId, clock(c.before), clock(c.after)])).toEqual([
      ['opt-gakudo', [], gaps],
    ]);
  });
});

describe('知らせの門も、見てもらえない時間が残る手を、確保・次の手に数えない', () => {
  // 見本の段 chase（祖母に頼んで返事待ち。ほかの手はもう決め時を過ぎている）に、まだ選んでいない学童を足す。
  const program = (id: string, at: string, covers: { start: string; end: string }) => ({
    place: { id: `p-${id}`, kind: 'afterSchoolCare' as const, name: `架空の学童 ${id}`, goods: [] },
    option: afterSchoolOption(
      `opt-${id}`,
      `p-${id}`,
      { type: 'daysBefore', days: 1, at },
      500,
      false,
      covers,
    ),
  });
  const withPrograms = async (list: ReturnType<typeof program>[]) => {
    const { state, saveHousehold } = family('chase');
    const next = structuredClone((await state()).home);
    for (const p of list) {
      next.places.push(p.place);
      next.careOptions.push(p.option);
    }
    expect(await saveHousehold('a', next)).toMatchObject({ status: 'ok' });
    return state(NEAR);
  };

  it('選べない手の決め時が近くても、返事を待つ知らせを止めない', async () => {
    const now = await withPrograms([program('short', '21:00', { start: '09:00', end: '16:00' })]);
    const short = care(now.plan).options.find((o) => o.templateId === 'opt-short');
    expect(short?.coverGaps?.length).toBeGreaterThan(0);
    expect(todayCards(now.plan, 'b').main.some((c) => c.kind === 'backup')).toBe(false);
    const sent = notices(now);
    expect(sent.intents.some((i) => i.titleKey === 'notify.noReply')).toBe(true);
    expect(sent.blocked).toEqual([]);
  });

  it('選べない手の決め時が早くても、選べる手の「予備を押さえる」知らせを通す。選べない手の知らせは止める', async () => {
    const now = await withPrograms([
      program('short', '20:00', { start: '09:00', end: '16:00' }),
      program('full', '21:00', { start: '08:00', end: '19:00' }),
    ]);
    const options = care(now.plan).options;
    const short = options.find((o) => o.templateId === 'opt-short');
    const full = options.find((o) => o.templateId === 'opt-full');
    if (!short?.decisionDeadline || !full?.decisionDeadline) throw new Error('決め時が無い');
    expect(short.decisionDeadline < full.decisionDeadline).toBe(true);
    const sent = notices(now);
    const backup = sent.intents.filter((i) => i.titleKey === 'notify.backup');
    expect(
      backup.map((i) => (i.subject.type === 'arrangement' ? i.subject.optionId : undefined)),
    ).toEqual([full.key]);
    expect(sent.blocked).toEqual([]);
    // 同じ知らせを、選べない手（短い学童）について作っても、門が止める（検証器が独立に見てもらえない時間を求める）。
    const original = backup[0];
    if (original?.subject.type !== 'arrangement') throw new Error('知らせが無い');
    const forged = {
      ...original,
      key: `backup:${ARRANGEMENT}:${short.key}:${original.toMemberId}`,
      subject: { ...original.subject, optionId: short.key },
    };
    const gate = sendGate({
      household: now.home,
      plan: now.plan,
      events: now.events,
      intents: [forged],
      batchEnds: now.events.map((e) => e.seq),
    });
    expect(gate.blocked.has(forged.key)).toBe(true);
  });
});
