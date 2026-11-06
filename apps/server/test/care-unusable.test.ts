// 取れる手を「使えない」とする（学童の登録が無かった・頼めなくなった等の事実）。使えないとした手は、手配の時間の
// 全部を見てもらえない手として、勧めず、新しくは選べず、選んであっても確保と言わない。送った頼み事は取り消さず、
// 要るかを確かめる（返事を追わない）。戻さない：また使う時は新しい手として足し、前の手の頼み事・返事を当てない。
// 見本の家族（架空）で、画面と同じ命令の道（見てから書く）を通し、知らせの門（検証器）も照らす。
import {
  afterSchoolOption,
  type Command,
  type Household,
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
const GAKUDO = keys.option(ARRANGEMENT, 'opt-gakudo');
const GRANDMA = keys.option(ARRANGEMENT, 'opt-grandma');

function family(stage: Parameters<typeof demoEvents>[0]) {
  const now = DEMO_STAGES.find((s) => s.id === stage)?.now ?? '';
  const store = memoryStore(new Map([['demo', demoEvents(stage)]]));
  let op = 0;
  const state = (at = now) =>
    store.withHousehold('demo', (log) => {
      const all = [...log.events()];
      const set = all.findLast((event) => event.type === 'householdSet');
      if (set?.type !== 'householdSet') throw new Error('家庭が無い');
      return { events: all, home: set.household, plan: computePlan(all, at) };
    });
  const run = (memberId: string, command: Command) =>
    runCommand(
      store,
      'demo',
      { memberId, operationId: `unusable-${++op}`, now, demo: true },
      command,
    );
  /** 見てから、見た物で家の情報を書く（画面と同じ）。 */
  const save = async (memberId: string, edit: (h: Household) => void) => {
    const current = await state();
    const next = structuredClone(current.home);
    edit(next);
    const preview = previewChange(
      current.events,
      { memberId, now },
      {
        type: 'updateHousehold',
        household: next,
      },
    );
    if ('status' in preview) return { status: preview.status, reason: preview.reason };
    return run(memberId, {
      type: 'updateHousehold',
      household: next,
      seen: { throughSeq: preview.throughSeq, changes: preview.seen },
    });
  };
  const unusable = (...ids: string[]) =>
    save('a', (h) => {
      h.unusableCareOptionIds = [...(h.unusableCareOptionIds ?? []), ...ids];
    });
  return { state, run, save, unusable };
}

const care = (plan: PlanResult) => {
  const found = plan.arrangements.find((a) => a.key === ARRANGEMENT);
  if (!found) throw new Error('手配が無い');
  return found;
};
const violations = (args: Parameters<typeof verifyPlan>[0]) =>
  verifyPlan(args)
    .issues.filter((i) => i.kind === 'violation')
    .map((i) => i.code);
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
  return { intents, blocked: intents.filter((i) => gate.blocked.has(i.key)) };
};

describe('取れる手を使えないとする', () => {
  it('返事待ちの本命を使えないとすると、返事を追わず、頼み事を確かめる札と決める札を出す。取り消しは書かない', async () => {
    // 見本の段 asked：美咲（b）が祖母に頼んで、返事待ち。
    const { state, unusable } = family('asked');
    expect(await unusable('opt-grandma')).toMatchObject({ status: 'ok' });
    const now = await state(NEAR);
    const arrangement = care(now.plan);
    const grandma = arrangement.options.find((o) => o.key === GRANDMA);
    expect(grandma?.unusable).toBe(true);
    expect(grandma?.coverGaps?.map((g) => [g.start, g.end, g.unsure ?? false])).toEqual([
      [arrangement.start, arrangement.end, false],
    ]);
    expect(arrangement.reasons.some((r) => r.code === 'notCovered')).toBe(true);
    const request = now.plan.requests.find((r) => r.requestId === 'r-grandma');
    expect(request).toMatchObject({ live: true, needsCheck: true, state: 'awaitingReply' });
    const cards = todayCards(now.plan, 'b');
    expect(cards.main.some((c) => c.kind === 'noReply')).toBe(false);
    expect(cards.main.some((c) => c.kind === 'check' && c.request.requestId === 'r-grandma')).toBe(
      true,
    );
    expect(cards.main.some((c) => c.kind === 'decide')).toBe(true);
    // 家族が伝えるまで、取り消しを書かない（取り消しを伝える作業も出さない）。
    expect(now.events.some((e) => e.type === 'cancellationSent')).toBe(false);
    expect(now.plan.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(false);
    const sent = notices(now);
    expect(sent.intents.some((i) => i.titleKey === 'notify.noReply')).toBe(false);
    expect(sent.blocked).toEqual([]);
    expect(violations({ household: now.home, events: now.events, plan: now.plan })).toEqual([]);
    // 検証器は、印を消す・確かめを外す書き換えを見つける。
    const tampered = structuredClone(now.plan);
    const option = care(tampered).options.find((o) => o.key === GRANDMA);
    if (option) delete option.unusable;
    const asked = tampered.requests.find((r) => r.requestId === 'r-grandma');
    if (asked) delete asked.needsCheck;
    expect(violations({ household: now.home, events: now.events, plan: tampered })).toEqual(
      expect.arrayContaining(['care_unusable_mismatch', 'care_unusable_request_unmarked']),
    );
  });

  it('使えないとした本命の代わりにほかの手を選ぶと、送った頼み事に取り消しを伝える作業が出る', async () => {
    // 決める画面の言葉（「ほかの手を選んでください。選ぶと、送った頼み事に取り消しを伝える作業が出ます」）の裏付け。
    // 見本の段 asked：祖母に頼んで返事待ち。学童の決め時は、まだ先。
    const { state, run, unusable } = family('asked');
    expect(await unusable('opt-grandma')).toMatchObject({ status: 'ok' });
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: ARRANGEMENT,
        optionKey: GAKUDO,
        role: 'primary',
      }),
    ).toMatchObject({ status: 'ok' });
    const now = await state();
    expect(now.plan.requests.find((r) => r.requestId === 'r-grandma')).toMatchObject({
      live: false,
      state: 'awaitingReply',
    });
    expect(now.plan.tasks.some((t) => t.live && t.cancels === 'r-grandma')).toBe(true);
    expect(violations({ household: now.home, events: now.events, plan: now.plan })).toEqual([]);
  });

  it('使えないとした予備をやめると、受けてもらった頼み事に取り消しを伝える作業が出る。本命は替えない', async () => {
    // 頼み事を確かめる札の「この予備はやめる」の裏付け（見本の段 backup：学童を予備に押さえ、「はい」をもらった）。
    const { state, run, unusable } = family('backup');
    expect(await unusable('opt-gakudo')).toMatchObject({ status: 'ok' });
    expect(
      await run('b', { type: 'dropOption', arrangementKey: ARRANGEMENT, optionKey: GAKUDO }),
    ).toMatchObject({ status: 'ok' });
    const now = await state(NEAR);
    expect(care(now.plan).chosenOptionKey).toBe(GRANDMA);
    expect(care(now.plan).backupOptionKeys).toEqual([]);
    expect(now.plan.requests.find((r) => r.requestId === 'r-gakudo')).toMatchObject({
      live: false,
      state: 'confirmed',
    });
    expect(now.plan.tasks.some((t) => t.live && t.cancels === 'r-gakudo')).toBe(true);
    expect(notices(now).blocked).toEqual([]);
    expect(violations({ household: now.home, events: now.events, plan: now.plan })).toEqual([]);
  });

  it('送る前に使えないとした本命の作業は、出さず知らせない。門も、家庭の記録で止める', async () => {
    // 見本の段 arrived：美咲（b）が祖母を本命に選び、頼む作業を健太（a）に提案した（まだ送っていない）。
    const { state, run, unusable } = family('arrived');
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: ARRANGEMENT,
        optionKey: GRANDMA,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const ask = `task:${GRANDMA}:ask`;
    const before = await state();
    const proposal = notices(before).intents.find(
      (i) => i.titleKey === 'notify.proposal' && i.subject.type === 'task' && i.subject.id === ask,
    );
    expect(todayCards(before.plan, 'a').main.some((c) => 'task' in c && c.task.key === ask)).toBe(
      true,
    );
    expect(await unusable('opt-grandma')).toMatchObject({ status: 'ok' });
    const now = await state();
    expect(todayCards(now.plan, 'a').main.some((c) => 'task' in c && c.task.key === ask)).toBe(
      false,
    );
    const sent = notices(now);
    expect(sent.intents.some((i) => i.subject.type === 'task' && i.subject.id === ask)).toBe(false);
    expect(sent.blocked).toEqual([]);
    expect(violations({ household: now.home, events: now.events, plan: now.plan })).toEqual([]);
    // 前に作った「おねがい」の知らせを今出そうとしても、門が止める（家庭の記録で、使えないとした手と見る）。
    if (!proposal) throw new Error('おねがいの知らせが無い');
    const gate = sendGate({
      household: now.home,
      plan: now.plan,
      events: now.events,
      intents: [proposal],
      batchEnds: now.events.map((e) => e.seq),
    });
    expect(gate.blocked.has(proposal.key)).toBe(true);
  });

  it('引き受けた本命の作業は、使えないとすると、要らなくなったと本人に知らせる', async () => {
    const { state, run, unusable } = family('arrived');
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: ARRANGEMENT,
        optionKey: GRANDMA,
        role: 'primary',
        assigneeId: 'a',
      }),
    ).toMatchObject({ status: 'ok' });
    const ask = `task:${GRANDMA}:ask`;
    const step = (await state()).plan.tasks.find((t) => t.key === ask);
    const shown = step && proposalSnapshot(step);
    if (!shown) throw new Error('頼む作業が無い');
    expect(await run('a', { type: 'accept', taskKey: ask, shown })).toMatchObject({ status: 'ok' });
    expect(await unusable('opt-grandma')).toMatchObject({ status: 'ok' });
    const now = await state();
    const release = now.plan.released?.find((r) => r.taskKey === ask);
    expect(release).toMatchObject({ assigneeId: 'a', reason: 'inactive' });
    const cards = todayCards(now.plan, 'a');
    expect(cards.main.some((c) => c.kind === 'released')).toBe(true);
    // 引き受けた作業として、上にも下（頼まれたこと）にも残さない。
    expect([...cards.main, ...cards.quiet].some((c) => 'task' in c && c.task.key === ask)).toBe(
      false,
    );
    expect(notices(now).blocked).toEqual([]);
    expect(violations({ household: now.home, events: now.events, plan: now.plan })).toEqual([]);
    // 動き始める時の前（30 分前）には、本人に知らせる（門も止めない）。家庭の時区は +09:00。
    if (!release?.start) throw new Error('引き受けた時刻が無い');
    const before = new Date(Date.parse(release.start) - 30 * 60_000 + 9 * 3_600_000);
    const near = await state(`${before.toISOString().slice(0, 16)}+09:00`);
    const sent = notices(near);
    expect(
      sent.intents.some(
        (i) =>
          i.titleKey === 'notify.released' && i.subject.type === 'task' && i.subject.id === ask,
      ),
    ).toBe(true);
    expect(sent.blocked).toEqual([]);
  });

  it('確保できた予備を使えないとすると、確保と言わず、本命の返事を追い直す。予備の頼み事は確かめる', async () => {
    // 見本の段 backup：祖母の返事待ちの間に、学童を予備に押さえ、「はい」をもらってある。
    const { state, unusable } = family('backup');
    const before = await state(NEAR);
    expect(securedBackup(before.plan, care(before.plan))?.key).toBe(GAKUDO);
    expect(await unusable('opt-gakudo')).toMatchObject({ status: 'ok' });
    const now = await state(NEAR);
    expect(securedBackup(now.plan, care(now.plan))).toBeUndefined();
    expect(now.plan.requests.find((r) => r.requestId === 'r-gakudo')).toMatchObject({
      live: true,
      needsCheck: true,
      state: 'confirmed',
    });
    expect(todayCards(now.plan, 'b').main.some((c) => c.kind === 'noReply')).toBe(true);
    const sent = notices(now);
    expect(sent.intents.some((i) => i.titleKey === 'notify.noReply')).toBe(true);
    expect(sent.blocked).toEqual([]);
    expect(now.events.some((e) => e.type === 'cancellationSent')).toBe(false);
    expect(violations({ household: now.home, events: now.events, plan: now.plan })).toEqual([]);
  });

  it('選んでいない手を使えないとすると、勧めず、選ぼうとしても断る', async () => {
    const { state, run, unusable } = family('arrived');
    expect(care((await state()).plan).recommendedOptionKey).toBe(GAKUDO);
    expect(await unusable('opt-gakudo')).toMatchObject({ status: 'ok' });
    const now = await state();
    expect(care(now.plan).recommendedOptionKey).toBe(GRANDMA);
    expect(
      await run('b', {
        type: 'chooseOption',
        arrangementKey: ARRANGEMENT,
        optionKey: GAKUDO,
        role: 'primary',
      }),
    ).toMatchObject({ status: 'invalid', reason: 'optionNotCovering' });
    expect(violations({ household: now.home, events: now.events, plan: now.plan })).toEqual([]);
  });

  it('また使う時は、同じ学童に新しい手を足す。前の手の頼み事・返事は新しい手に当てず、前の手も残る', async () => {
    const { state, unusable, save } = family('backup');
    expect(await unusable('opt-gakudo')).toMatchObject({ status: 'ok' });
    expect(
      await save('a', (h) => {
        h.careOptions.push(
          afterSchoolOption(
            'opt-gakudo-2',
            'gakudo',
            { type: 'daysBefore', days: 3, at: '18:30' },
            1000,
            false,
            { start: '08:00', end: '19:00' },
          ),
        );
      }),
    ).toMatchObject({ status: 'ok' });
    const now = await state(NEAR);
    const options = care(now.plan).options;
    const fresh = options.find((o) => o.templateId === 'opt-gakudo-2');
    const old = options.find((o) => o.key === GAKUDO);
    // 新しい手は、見てもらえない時間も使えない印も無い。前の手は、使えないとした手として残る。
    expect(fresh?.coverGaps).toBeUndefined();
    expect(fresh?.unusable).toBeUndefined();
    expect(old?.unusable).toBe(true);
    // 前の手の「はい」は、新しい手に当てない（新しい手は、まだ頼んでいない）。
    expect(now.plan.requests.filter((r) => r.basis.optionKey === fresh?.key)).toEqual([]);
    expect(now.plan.requests.find((r) => r.requestId === 'r-gakudo')).toMatchObject({
      live: true,
      needsCheck: true,
    });
    expect(securedBackup(now.plan, care(now.plan))).toBeUndefined();
    expect(violations({ household: now.home, events: now.events, plan: now.plan })).toEqual([]);
  });

  it('使えないとした手は戻せない。無い手・同じ手を二度は入れられない', async () => {
    const { unusable, save } = family('arrived');
    expect(await unusable('opt-gakudo')).toMatchObject({ status: 'ok' });
    // 戻す（一覧から外す）。
    expect(
      await save('a', (h) => {
        delete h.unusableCareOptionIds;
      }),
    ).toMatchObject({ status: 'invalid', reason: 'careOptionsLocked' });
    // 無い手、同じ手を二度。
    expect(await unusable('opt-nothing')).toMatchObject({
      status: 'invalid',
      reason: 'careOptionsLocked',
    });
    expect(await unusable('opt-gakudo')).toMatchObject({
      status: 'invalid',
      reason: 'careOptionsLocked',
    });
    // 使えないとした学童がある所に、使える学童の手を二つは足せない（一つの学童に、使える手は一つ）。
    const twice = await save('a', (h) => {
      for (const id of ['opt-gakudo-2', 'opt-gakudo-3']) {
        h.careOptions.push(
          afterSchoolOption(
            id,
            'gakudo',
            { type: 'daysBefore', days: 3, at: '18:30' },
            1000,
            false,
            { start: '08:00', end: '19:00' },
          ),
        );
      }
    });
    expect(twice).toMatchObject({ status: 'invalid', reason: 'careOptionsLocked' });
  });
});
