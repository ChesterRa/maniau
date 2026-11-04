// 家族の言明の「すること」（通用の need。02-foundation §3.4）を、命令の層で確かめる：言う → やり方を選ぶ →
// 置く → 引き受ける → 覆ったか。例 1：子が学校を休む日に、家で見る人が要る（病児保育・祖母・有休。医療の
// 助言はしない）。見るだけでは何も書かず、書く時は見た物と同じ計算の時だけ書く。
import {
  type Household,
  type NeedInterpretation,
  notificationIntents,
  proposalSnapshot,
  type SaveablePreview,
  type Task,
  todayCards,
  toEpochMinutes,
  type Way,
} from '@maniau/core';
import { computePlan } from '@maniau/core/engine';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../src/commands';
import { demoEvents } from '../src/demo';
import { previewChange } from '../src/preview';
import { memoryStore } from '../src/store';

const NOW = '2026-11-25T20:00+09:00';
const TEXT =
  '陽菜が熱っぽいので、明日は学校を休ませる。8時から18時まで、だれかが家で見ないといけない。';
const NEED = {
  what: '陽菜を家で見る',
  shape: 'window' as const,
  date: '2026-11-26',
  startTime: '08:00',
  endTime: '18:00',
  forMemberId: 'c',
};

/** デモの家（足すやり方があれば、家の情報に足す。試験の材料だけ）。 */
async function setup(extraWays: Way[] = [], edit: (h: Household) => void = () => {}) {
  const events0 = demoEvents('arrived').map((e) => {
    if (e.type !== 'householdSet') return e;
    const household = structuredClone(e.household);
    household.ways.push(...extraWays);
    edit(household);
    return { ...e, household };
  });
  const store = memoryStore(new Map([['demo', events0]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let sequence = 0;
  const run = (command: Parameters<typeof runCommand>[3], memberId = 'b') =>
    runCommand(
      store,
      'demo',
      { memberId, now: NOW, operationId: `need-${++sequence}`, demo: true },
      command,
    );
  const plan = async () => computePlan(await events(), NOW);
  const preview = async (command: SaveablePreview) =>
    previewChange(await events(), { memberId: 'b', now: NOW }, command);
  /** 見てから書く（見た計画の番号と、見た物の要約を付ける）。 */
  const previewed = async (command: SaveablePreview) => {
    const shown = await preview(command);
    if ('reason' in shown) throw new Error(shown.reason);
    const { throughSeq } = await plan();
    return run({ ...command, seen: { throughSeq, changes: shown.seen } });
  };
  /** 今の計画の、言明の「すること」の要件・手配・作業。 */
  const need = async () => {
    const p = await plan();
    const requirement = p.requirements.find((r) => r.kind === 'need' && r.live);
    const arrangement = p.arrangements.find((a) => a.kind === 'need' && a.live);
    const option = (wayId: string) => arrangement?.options.find((o) => o.templateId === wayId);
    const task = (wayId: string, stepId: string): Task | undefined =>
      p.tasks.find(
        (t) =>
          t.live &&
          t.basis.optionKey === option(wayId)?.key &&
          t.step?.templateId === wayId &&
          t.step.stepId === stepId,
      );
    const gaps = arrangement?.reasons.find((r) => r.code === 'notCovered')?.refs ?? [];
    return { plan: p, requirement, arrangement, option, task, gaps };
  };
  /** 言って、やり方を選ぶ（見てから書く）。 */
  const stated = async (wayIds: string[], interpretation: NeedInterpretation = NEED) => {
    expect(await previewed({ type: 'stateNeed', text: TEXT, interpretation })).toMatchObject({
      status: 'ok',
    });
    const itemId = (await need()).requirement?.basis.itemIds[0];
    if (!itemId) throw new Error('言明の「すること」が無い');
    expect(await previewed({ type: 'setNeedWays', itemId, wayIds })).toMatchObject({
      status: 'ok',
    });
    return itemId;
  };
  /** 本命に選ぶ。 */
  const choose = async (wayId: string, assigneeId = 'b') => {
    const { arrangement, option } = await need();
    if (!arrangement || !option(wayId)) throw new Error(`案が無い：${wayId}`);
    return run({
      type: 'chooseOption',
      arrangementKey: arrangement.key,
      optionKey: option(wayId)?.key ?? '',
      role: 'primary',
      assigneeId,
    });
  };
  /** 見た提案の控えを付けて引き受ける。 */
  const accept = async (task: Task | undefined, memberId = 'b') => {
    const shown = task && proposalSnapshot(task);
    if (!task || !shown) throw new Error('引き受けられる作業が無い');
    return run({ type: 'accept', taskKey: task.key, shown }, memberId);
  };
  /** 外の相手に頼んだと記録し、返事を記録する。 */
  const askAndReply = async (task: Task | undefined, requestId: string, reply: 'yes' | 'no') => {
    const { arrangement } = await need();
    if (!task || !arrangement) throw new Error('頼む作業が無い');
    expect(
      await run({
        type: 'recordSent',
        taskKey: task.key,
        requestId,
        window: { start: arrangement.start, end: arrangement.end },
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await run({ type: 'recordReply', requestId, reply })).toMatchObject({ status: 'ok' });
  };
  return { events, run, plan, preview, previewed, need, stated, choose, accept, askAndReply };
}

const at = (time: string) => toEpochMinutes(`2026-11-26T${time}+09:00`);
const span = (ref: string) => ref.split('/').map((t) => toEpochMinutes(t));

describe('家族の言明の「すること」', () => {
  it('見るだけでは何も書かず、見た物と同じ時だけ書き、家族の出典と事項（言明）になる', async () => {
    const app = await setup();
    const before = (await app.events()).length;
    const shown = await app.preview({ type: 'stateNeed', text: TEXT, interpretation: NEED });
    if ('reason' in shown) throw new Error(shown.reason);
    expect((await app.events()).length).toBe(before);
    const { throughSeq } = await app.plan();
    // 要約の無い・違う要約の言明は書かない。
    expect(await app.run({ type: 'stateNeed', text: TEXT, interpretation: NEED })).toMatchObject({
      status: 'invalid',
      reason: 'seenRequired',
    });
    expect(
      await app.run({
        type: 'stateNeed',
        text: TEXT,
        interpretation: { ...NEED, endTime: '17:00' },
        seen: { throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'conflict', reason: 'consequencesChanged' });
    expect(
      await app.run({
        type: 'stateNeed',
        text: TEXT,
        interpretation: NEED,
        seen: { throughSeq, changes: shown.seen },
      }),
    ).toMatchObject({ status: 'ok' });
    const added = (await app.events()).slice(before);
    expect(added.map((e) => e.type)).toEqual(['noticeReceived', 'itemsStated']);
    const [source, stated] = added;
    if (source?.type !== 'noticeReceived' || stated?.type !== 'itemsStated') throw new Error();
    expect(source.source.sender).toBe('family');
    expect(source.source.sentences.map((s) => s.text)).toEqual([TEXT]);
    // 出典と事項の ID に、原文を入れない。
    expect(source.source.id).not.toContain('陽菜');
    expect(stated.items[0]).toMatchObject({ kind: 'need', evidence: 'stated', written: TEXT });
    // やり方を選ぶまで、作業を作らない（推し量りで作らない）。
    const { requirement, arrangement, plan } = await app.need();
    expect(requirement).toMatchObject({ what: NEED.what, date: NEED.date });
    expect(arrangement?.options).toEqual([]);
    expect(arrangement?.reasons).toContainEqual(
      expect.objectContaining({ code: 'inputMissing', refs: ['ways'] }),
    );
    expect(plan.tasks.filter((t) => t.basis.arrangementKey === arrangement?.key)).toEqual([]);
  });

  it('窓の欠けた・日をまたぐ・成員でない人のための言明を断る', async () => {
    const app = await setup();
    for (const [interpretation, reason] of [
      [{ ...NEED, endTime: undefined }, 'needWindowMissing'],
      [{ ...NEED, startTime: '18:00', endTime: '08:00' }, 'needWindowOvernight'],
      [{ ...NEED, forMemberId: 'nobody' }, 'needMemberUnknown'],
      [{ what: '申込書を出す', shape: 'by' as const, date: '2026-11-26' }, 'needDeadlineMissing'],
    ] as const) {
      expect(await app.preview({ type: 'stateNeed', text: TEXT, interpretation })).toMatchObject({
        reason,
      });
    }
  });

  it('祖母に来てもらうやり方：頼む作業は窓の前に置き、受け持つ相手の「はい」で窓の全部を覆う', async () => {
    const app = await setup();
    await app.stated(['way-grandma', 'way-sick-care']);
    expect(await app.choose('way-grandma')).toMatchObject({ status: 'ok' });
    let now = await app.need();
    const ask = now.task('way-grandma', 'ask');
    // 外の相手が受け持つ手順は、前もって頼む作業（窓の時刻に置く受け持ちではない）。やり方の締切は前の日の 21:00。
    expect(ask).toMatchObject({ external: { to: 'g', kind: 'reply' }, commitment: 'proposed' });
    expect(ask?.cover).toBeUndefined();
    expect(ask?.end && toEpochMinutes(ask.end)).toBeLessThanOrEqual(
      toEpochMinutes('2026-11-25T21:00+09:00'),
    );
    // 引き受けと済みの控えは、今の「すること」の中身とやり方の版に結ぶ。
    expect(ask?.about).toBeDefined();
    expect(now.gaps.map(span)).toEqual([[at('08:00'), at('18:00')]]);
    // 頼む作業を引き受けても、相手の「はい」が無ければ覆ったと言わない。
    expect(await app.accept(ask)).toMatchObject({ status: 'ok' });
    now = await app.need();
    expect(now.gaps.map(span)).toEqual([[at('08:00'), at('18:00')]]);
    await app.askAndReply(now.task('way-grandma', 'ask'), 'req-g', 'yes');
    now = await app.need();
    expect(now.gaps).toEqual([]);
    expect(now.arrangement?.reasons.map((r) => r.code)).not.toContain('notCovered');
  });

  it('承認だけのやり方：承認は、だれかが窓を受け持つことではないので、覆ったと言わない', async () => {
    const leave: Way = {
      id: 'way-leave-only',
      name: '彩が有休を取る',
      steps: [
        {
          id: 'apply',
          name: '有休を申請する',
          durationMin: 5,
          segments: ['home', 'commute', 'work'],
          waitAfterMin: 0,
          assigneeId: 'b',
          external: { to: 'work-b', kind: 'approval' },
        },
      ],
      cost: { leaveMinutes: 480, helperRequests: 0, yen: 0, extraTasks: 0 },
      cancellable: true,
    };
    const app = await setup([leave]);
    await app.stated(['way-leave-only']);
    await app.choose('way-leave-only');
    await app.askAndReply((await app.need()).task('way-leave-only', 'apply'), 'req-leave', 'yes');
    expect((await app.need()).gaps.map(span)).toEqual([[at('08:00'), at('18:00')]]);
  });

  it('受け持ち：ふだんの予定でその区間にいる時間だけに置き、受け持ちの引き受けと外の相手の「はい」がそろって覆う', async () => {
    const both: Way = {
      id: 'way-home-both',
      name: '健太が家で受け取る（祖母に鍵を預けてよいか先に聞く）',
      steps: [
        {
          id: 'ask',
          name: '祖母に鍵を預けてよいか聞く',
          durationMin: 5,
          segments: ['home'],
          waitAfterMin: 0,
          external: { to: 'g', kind: 'reply' },
        },
        {
          id: 'stay',
          name: '家で受け取る',
          durationMin: 0,
          segments: ['home'],
          waitAfterMin: 0,
          assigneeId: 'a',
          cover: true,
        },
      ],
      cost: { leaveMinutes: 0, helperRequests: 1, yen: 0, extraTasks: 0 },
      cancellable: true,
    };
    const weekday: Way = {
      id: 'way-b-home',
      name: '彩が家で見る',
      steps: [
        {
          id: 'stay',
          name: '家で見る',
          durationMin: 0,
          segments: ['home'],
          waitAfterMin: 0,
          assigneeId: 'b',
          cover: true,
        },
      ],
      cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
      cancellable: true,
    };
    // 平日（彩は仕事）：受け持ちを仕事の時間に置かない（時刻なし）。覆ったとは言わない。
    const workday = await setup([weekday]);
    await workday.stated(['way-b-home']);
    await workday.choose('way-b-home');
    let now = await workday.need();
    expect(now.task('way-b-home', 'stay')).toMatchObject({ cover: true, assigneeId: 'b' });
    expect(now.task('way-b-home', 'stay')?.start).toBeUndefined();
    expect(now.gaps.map(span)).toEqual([[at('08:00'), at('18:00')]]);
    // 土曜の午後（二人とも家）：受け持ちを窓の時刻に置く。引き受けても、祖母の「はい」まで覆わない。
    const sat = (time: string) => toEpochMinutes(`2026-11-28T${time}+09:00`);
    const app = await setup([both]);
    await app.stated(['way-home-both'], {
      what: '荷物を家で受け取る',
      shape: 'window',
      date: '2026-11-28',
      startTime: '13:00',
      endTime: '15:00',
    });
    await app.choose('way-home-both', 'a');
    now = await app.need();
    const stay = now.task('way-home-both', 'stay');
    expect(stay?.start && toEpochMinutes(stay.start)).toBe(sat('13:00'));
    expect(stay?.end && toEpochMinutes(stay.end)).toBe(sat('15:00'));
    expect(await app.accept(stay, 'a')).toMatchObject({ status: 'ok' });
    now = await app.need();
    expect(now.gaps.map(span)).toEqual([[sat('13:00'), sat('15:00')]]);
    const ask = now.task('way-home-both', 'ask');
    if (!ask || !now.arrangement) throw new Error('頼む作業が無い');
    expect(
      await app.run(
        {
          type: 'recordSent',
          taskKey: ask.key,
          requestId: 'req-g',
          window: { start: now.arrangement.start, end: now.arrangement.end },
        },
        ask.assigneeId ?? 'a',
      ),
    ).toMatchObject({ status: 'ok' });
    expect(await app.run({ type: 'recordReply', requestId: 'req-g', reply: 'yes' })).toMatchObject({
      status: 'ok',
    });
    now = await app.need();
    expect(now.gaps).toEqual([]);
  });

  it('病児保育のやり方：「はい」でも、預かる時間の外（朝と夕方）は覆ったと言わない', async () => {
    const app = await setup();
    await app.stated(['way-grandma', 'way-sick-care']);
    expect(await app.choose('way-sick-care')).toMatchObject({ status: 'ok' });
    let now = await app.need();
    const reserve = now.task('way-sick-care', 'reserve');
    expect(reserve?.external).toEqual({ to: 'sick-care', kind: 'reply' });
    // 予約の手順は、前の日の 21:00 まで（手順ごとの締切）。
    expect(reserve?.deadline && toEpochMinutes(reserve.deadline)).toBeLessThanOrEqual(
      toEpochMinutes('2026-11-25T21:00+09:00'),
    );
    // 返事を待つ間：決める札・行き詰まりは出さない。窓（あすの朝）が近いので、まだ確かめられない時間の札は二人に
    // 出す。予備の勧めは、頼んだ本人に、次のやり方の決め時（祖母：前の日の 21:00）が近いので出す（選び直す所は
    // 「すること」の画面）。
    const { arrangement, task } = await app.need();
    const sent = task('way-sick-care', 'reserve');
    if (!sent || !arrangement) throw new Error('予約の作業が無い');
    await app.run({
      type: 'recordSent',
      taskKey: sent.key,
      requestId: 'req-sick',
      window: { start: arrangement.start, end: arrangement.end },
    });
    for (const member of ['a', 'b']) {
      const { main, quiet } = todayCards((await app.need()).plan, member);
      const cards = [...main, ...quiet].filter(
        (c) => 'arrangement' in c && c.arrangement?.kind === 'need',
      );
      expect(
        cards.map((c) => c.kind).filter((k) => ['backup', 'stuck', 'decide', 'need'].includes(k)),
      ).toEqual(member === 'b' ? ['backup', 'need'] : ['need']);
      const backup = cards.find((c) => c.kind === 'backup');
      expect(backup?.kind === 'backup' && backup.option.templateId).toBe(
        member === 'b' ? 'way-grandma' : false,
      );
    }
    expect(
      await app.run({ type: 'recordReply', requestId: 'req-sick', reply: 'yes' }),
    ).toMatchObject({ status: 'ok' });
    now = await app.need();
    expect(now.gaps.map(span)).toEqual([
      [at('08:00'), at('08:30')],
      [at('17:30'), at('18:00')],
    ]);
  });

  it('きょうの「すること」の札：決めることがある時だけ二人に出し、返事待ちの間は窓が近づくまで出さず、「はい」の後も残る時間があれば出す', async () => {
    const app = await setup();
    const needCards = async (member: string) =>
      todayCards((await app.need()).plan, member).main.filter((c) => c.kind === 'need');
    // 三日後の窓（返事待ちの間に、窓が近づく前と後を見る）。
    const later = { ...NEED, date: '2026-11-28' };
    // 言っただけ（やり方を選んでいない）：二人に出す。
    expect(
      await app.previewed({ type: 'stateNeed', text: TEXT, interpretation: later }),
    ).toMatchObject({ status: 'ok' });
    for (const member of ['a', 'b']) expect(await needCards(member)).toHaveLength(1);
    const itemId = (await app.need()).requirement?.basis.itemIds[0] ?? '';
    // やり方を選んだが、本命を選んでいない：出す。
    expect(
      await app.previewed({
        type: 'setNeedWays',
        itemId,
        wayIds: ['way-grandma', 'way-sick-care'],
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await needCards('a')).toHaveLength(1);
    // 本命を選んだ：予約の作業の札が出すので、この札は出さない。送って返事を待つ間も出さない。
    await app.choose('way-sick-care');
    expect(await needCards('a')).toEqual([]);
    const reserve = (await app.need()).task('way-sick-care', 'reserve');
    const { arrangement } = await app.need();
    if (!reserve || !arrangement) throw new Error('予約の作業が無い');
    await app.run({
      type: 'recordSent',
      taskKey: reserve.key,
      requestId: 'req-today',
      window: { start: arrangement.start, end: arrangement.end },
    });
    expect(await needCards('a')).toEqual([]);
    // 窓の前の晩（26 時間前から）は、返事待ちのままでも二人に出す（まだ確かめられない時間がある）。
    const eve = computePlan(await app.events(), '2026-11-27T07:00+09:00');
    for (const member of ['a', 'b']) {
      expect(todayCards(eve, member).main.filter((c) => c.kind === 'need')).toHaveLength(1);
    }
    // 「はい」の後も、預かる時間の外が残る：二人に出す（残る時間は手配の理由にある）。
    await app.run({ type: 'recordReply', requestId: 'req-today', reply: 'yes' });
    for (const member of ['a', 'b']) {
      const [card] = await needCards(member);
      expect(card?.kind === 'need' && card.arrangement.reasons.map((r) => r.code)).toContain(
        'notCovered',
      );
    }
    // 祖母を本命にして「はい」：窓の全部を覆うので、出さない。
    await app.choose('way-grandma');
    const ask = (await app.need()).task('way-grandma', 'ask');
    await app.askAndReply(ask, 'req-today-g', 'yes');
    expect((await app.need()).gaps).toEqual([]);
    expect(await needCards('a')).toEqual([]);
  });

  it('「すること」の知らせ：やり方を選ぶ前は日時が近づいた時だけ、本命は決め時の前から、受け持ちを確かめられない時間は窓の前から、二人に', async () => {
    const app = await setup();
    const household = (await app.events()).find((e) => e.type === 'householdSet');
    if (household?.type !== 'householdSet') throw new Error('家の情報が無い');
    /** その時の計画から、この「すること」の手配の札についての知らせ（題と宛先。予備の知らせは別の決まり）。 */
    const intents = async (at: string) => {
      const plan = computePlan(await app.events(), at);
      const key = plan.arrangements.find((a) => a.kind === 'need' && a.live)?.key;
      return notificationIntents(plan, household.household)
        .filter(
          (i) =>
            i.subject.type === 'arrangement' &&
            i.subject.id === key &&
            ['notify.need', 'notify.needGaps', 'notify.decide'].includes(i.titleKey),
        )
        .map((i) => ({ title: i.titleKey, to: i.toMemberId, until: i.until, actBy: i.actBy }));
    };
    // 三日後の窓（11/28 08:00〜18:00）。言っただけ（やり方を選んでいない）。
    const later = { ...NEED, date: '2026-11-28' };
    expect(
      await app.previewed({ type: 'stateNeed', text: TEXT, interpretation: later }),
    ).toMatchObject({ status: 'ok' });
    expect(await intents(NOW)).toEqual([]);
    // 窓の始まりの 26 時間前から、中身を言わずに二人に（始まりまでに動けばよい）。
    const window = { until: '2026-11-28T18:00+09:00', actBy: '2026-11-28T08:00+09:00' };
    expect(await intents('2026-11-27T07:00+09:00')).toEqual([
      { title: 'notify.need', to: 'a', ...window },
      { title: 'notify.need', to: 'b', ...window },
    ]);
    // やり方を選んだが、本命を選んでいない：最初に選べなくなる案の決め時（病児保育の予約は前の日 21:00 までに
    // 済ませるので、始めるのは 20:50 まで）の 26 時間前から。
    const itemId = (await app.need()).requirement?.basis.itemIds[0] ?? '';
    expect(
      await app.previewed({
        type: 'setNeedWays',
        itemId,
        wayIds: ['way-grandma', 'way-sick-care'],
      }),
    ).toMatchObject({ status: 'ok' });
    expect(await intents(NOW)).toEqual([]);
    const decide = await intents('2026-11-27T07:00+09:00');
    expect(decide.map((i) => [i.title, i.to])).toEqual([
      ['notify.decide', 'a'],
      ['notify.decide', 'b'],
    ]);
    expect(decide[0]?.until && toEpochMinutes(decide[0].until)).toBe(
      toEpochMinutes('2026-11-27T20:50+09:00'),
    );
    // 本命を選び、予約を送って返事を待つ間：窓が近づくまでは知らせない。近づいたら、受け持ちを確かめられない
    // 時間を二人に（窓の終わりまで）。
    await app.choose('way-sick-care');
    const reserve = (await app.need()).task('way-sick-care', 'reserve');
    const { arrangement } = await app.need();
    if (!reserve || !arrangement) throw new Error('予約の作業が無い');
    await app.run({
      type: 'recordSent',
      taskKey: reserve.key,
      requestId: 'req-notify',
      window: { start: arrangement.start, end: arrangement.end },
    });
    expect(await intents(NOW)).toEqual([]);
    expect(await intents('2026-11-27T07:00+09:00')).toEqual([
      { title: 'notify.needGaps', to: 'a', ...window },
      { title: 'notify.needGaps', to: 'b', ...window },
    ]);
    expect(await intents('2026-11-28T12:00+09:00')).toHaveLength(2);
    expect(await intents('2026-11-28T18:00+09:00')).toEqual([]);
  });

  it('締切の「すること」の知らせ：やり方を選ぶ前は、締切の 26 時間前から（計算した時刻を始まりにしない）', async () => {
    const app = await setup();
    const household = (await app.events()).find((e) => e.type === 'householdSet');
    if (household?.type !== 'householdSet') throw new Error('家の情報が無い');
    expect(
      await app.previewed({
        type: 'stateNeed',
        text: '金曜の17時までに、祖母に来週の予定を聞いておく。',
        interpretation: {
          what: '祖母に来週の予定を聞く',
          shape: 'by',
          deadline: '2026-11-27T17:00+09:00',
        },
      }),
    ).toMatchObject({ status: 'ok' });
    const titles = async (at: string) =>
      notificationIntents(computePlan(await app.events(), at), household.household)
        .filter((i) => i.titleKey === 'notify.need')
        .map((i) => [i.toMemberId, i.until, i.actBy]);
    expect(await titles(NOW)).toEqual([]);
    expect(await titles('2026-11-26T16:00+09:00')).toEqual([
      ['a', '2026-11-27T17:00+09:00', undefined],
      ['b', '2026-11-27T17:00+09:00', undefined],
    ]);
    expect(await titles('2026-11-27T17:00+09:00')).toEqual([]);
  });

  it('中身を直すと選んだやり方は選び直しになり、引き受けを当てない。元に戻せば選び直さずに戻るが、引き受けは本人にもう一度頼む', async () => {
    const app = await setup();
    const itemId = await app.stated(['way-grandma']);
    await app.choose('way-grandma');
    expect(await app.accept((await app.need()).task('way-grandma', 'ask'))).toMatchObject({
      status: 'ok',
    });
    // 終わりの時刻を直す：選んだ時と中身が違うので、やり方を選び直すまで作業を作らない。
    expect(
      await app.previewed({ type: 'correctItem', itemId, interpretation: { endTime: '17:00' } }),
    ).toMatchObject({ status: 'ok' });
    let now = await app.need();
    expect(now.arrangement?.options).toEqual([]);
    expect(now.arrangement?.reasons).toContainEqual(
      expect.objectContaining({ code: 'inputMissing', refs: ['waysChanged'] }),
    );
    expect(now.plan.released?.map((r) => r.taskKey)).toContainEqual(
      expect.stringContaining('way-grandma'),
    );
    // 元に戻す：最後の選び（同じ中身への物）が戻る。引き受けは、本人にもう一度頼む（黙って当てない）。
    expect(
      await app.previewed({ type: 'correctItem', itemId, interpretation: { endTime: '18:00' } }),
    ).toMatchObject({ status: 'ok' });
    now = await app.need();
    const ask = now.task('way-grandma', 'ask');
    expect(ask).toBeDefined();
    expect(ask?.commitment === 'accepted' && !ask.reconfirm).toBe(false);
    expect(now.gaps.map(span)).toEqual([[at('08:00'), at('18:00')]]);
  });

  it('中身を直した後に別のやり方を選び、元の中身に戻しても、前の選びを戻さない', async () => {
    const app = await setup();
    const itemId = await app.stated(['way-sick-care']);
    await app.previewed({ type: 'correctItem', itemId, interpretation: { endTime: '17:00' } });
    expect(
      await app.previewed({ type: 'setNeedWays', itemId, wayIds: ['way-grandma'] }),
    ).toMatchObject({ status: 'ok' });
    await app.previewed({ type: 'correctItem', itemId, interpretation: { endTime: '18:00' } });
    const now = await app.need();
    expect(now.arrangement?.options).toEqual([]);
    expect(now.arrangement?.reasons).toContainEqual(
      expect.objectContaining({ code: 'inputMissing', refs: ['waysChanged'] }),
    );
  });

  it('言明の直しも、言った時と同じ決まりで確かめる（形は替えない・窓を壊さない）', async () => {
    const app = await setup();
    const itemId = await app.stated(['way-grandma']);
    expect(
      await app.run({ type: 'correctItem', itemId, interpretation: { shape: 'by' } }),
    ).toMatchObject({ status: 'invalid', reason: 'needShapeLocked' });
    expect(
      await app.run({ type: 'correctItem', itemId, interpretation: { startTime: '19:00' } }),
    ).toMatchObject({ status: 'invalid', reason: 'needWindowOvernight' });
    expect(
      await app.run({ type: 'correctItem', itemId, interpretation: { forMemberId: 'nobody' } }),
    ).toMatchObject({ status: 'invalid', reason: 'needMemberUnknown' });
  });

  it('締切の「すること」：日だけの締切はその日の終わりまでとし、手順を締切の前に置き、覆う時間は出さない', async () => {
    const app = await setup();
    expect(
      await app.previewed({
        type: 'stateNeed',
        text: '金曜までに、祖母に来週の予定を聞いておく。',
        interpretation: {
          what: '祖母に来週の予定を聞く',
          shape: 'by',
          deadline: '2026-11-27T00:00+09:00',
          deadlineDayOnly: true,
        },
      }),
    ).toMatchObject({ status: 'ok' });
    const itemId = (await app.need()).requirement?.basis.itemIds[0] ?? '';
    expect(
      await app.previewed({ type: 'setNeedWays', itemId, wayIds: ['way-grandma'] }),
    ).toMatchObject({ status: 'ok' });
    await app.choose('way-grandma');
    const now = await app.need();
    expect(now.arrangement?.needShape).toBe('by');
    expect(now.arrangement?.end && toEpochMinutes(now.arrangement.end)).toBe(
      toEpochMinutes('2026-11-27T23:59+09:00'),
    );
    const ask = now.task('way-grandma', 'ask');
    expect(ask?.start && toEpochMinutes(ask.start)).toBeLessThan(
      toEpochMinutes('2026-11-27T23:59+09:00'),
    );
    expect(now.gaps).toEqual([]);
  });

  it('決まった場所の受け持ちは、その場所にいる区間だけに置く（家の区間に置かない）', async () => {
    const there: Way = {
      id: 'way-there',
      name: '健太が病児保育室で付き添う',
      steps: [
        {
          id: 'stay',
          name: '付き添う',
          durationMin: 0,
          segments: ['home'],
          waitAfterMin: 0,
          placeId: 'sick-care',
          assigneeId: 'a',
          cover: true,
        },
      ],
      cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
      cancellable: true,
    };
    const app = await setup([there]);
    await app.stated(['way-there'], {
      what: '付き添う',
      shape: 'window',
      date: '2026-11-28',
      startTime: '13:00',
      endTime: '15:00',
    });
    await app.choose('way-there', 'a');
    expect((await app.need()).task('way-there', 'stay')?.start).toBeUndefined();
  });

  it('決まった場所の受け持ちは、その場所の営業時間（書かれていれば）の内だけに置く', async () => {
    const there: Way = {
      id: 'way-there',
      name: '健太が病児保育室で付き添う',
      steps: [
        {
          id: 'stay',
          name: '付き添う',
          durationMin: 0,
          segments: ['away'],
          waitAfterMin: 0,
          placeId: 'sick-care',
          assigneeId: 'a',
          cover: true,
        },
      ],
      cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
      cancellable: true,
    };
    // 土曜は 9:00–11:00 だけ開いていて、健太は土曜の 10:00–12:00 にそこにいる（架空）。
    const edit = (h: Household) => {
      const place = h.places.find((p) => p.id === 'sick-care');
      if (place) {
        place.hours = {
          periods: [{ weekday: 6, open: '09:00', close: '11:00' }],
          closedDates: [],
          source: 'family',
        };
      }
      const saturday = h.routines.find((r) => r.memberId === 'a' && r.weekday === 6);
      const away = saturday?.segments.find((s) => s.kind === 'away');
      if (away) away.placeId = 'sick-care';
    };
    // 地図から得た営業時間は、閉まっているとは決めない（時刻で絞らない）。
    const fromMap = (h: Household) => {
      edit(h);
      const place = h.places.find((p) => p.id === 'sick-care');
      if (place?.hours) {
        place.hours.source = 'googlePlaces';
        place.hours.checkedAt = '2026-11-25T12:00+09:00';
      }
    };
    // 金曜 22:00 から土曜 11:00 までの夜をまたぐ営業（休みでなければ、土曜の朝も開いている）。
    const overnight = (closed: boolean) => (h: Household) => {
      edit(h);
      const place = h.places.find((p) => p.id === 'sick-care');
      if (place?.hours) {
        place.hours.periods = [{ weekday: 5, open: '22:00', close: '11:00' }];
        place.hours.closedDates = closed ? ['2026-11-28'] : [];
      }
    };
    // 書かれた休みの日は、同じ日の営業時間があっても置かない。
    const closedDay = (h: Household) => {
      edit(h);
      const place = h.places.find((p) => p.id === 'sick-care');
      if (place?.hours) place.hours.closedDates = ['2026-11-28'];
    };
    for (const [startTime, endTime, placed, household] of [
      ['11:30', '12:00', false, edit],
      ['10:00', '11:00', true, edit],
      ['11:30', '12:00', true, fromMap],
      ['10:00', '11:00', false, closedDay],
      ['10:00', '11:00', true, overnight(false)],
      ['10:00', '11:00', false, overnight(true)],
    ] as const) {
      const app = await setup([there], household);
      await app.stated(['way-there'], {
        what: '付き添う',
        shape: 'window',
        date: '2026-11-28',
        startTime,
        endTime,
      });
      await app.choose('way-there', 'a');
      expect((await app.need()).task('way-there', 'stay')?.start !== undefined).toBe(placed);
    }
  });

  it('場所の書かれた「すること」は、家族の受け持ちを引き受けても覆ったと言わない（その場所にいると示せない）', async () => {
    const home: Way = {
      id: 'way-a-home',
      name: '健太が家で受け取る',
      steps: [
        {
          id: 'stay',
          name: '家で受け取る',
          durationMin: 0,
          segments: ['home'],
          waitAfterMin: 0,
          placeId: 'home',
          assigneeId: 'a',
          cover: true,
        },
      ],
      cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
      cancellable: true,
    };
    const app = await setup([home]);
    await app.stated(['way-a-home'], {
      what: '子ども会の打ち合わせに出る',
      shape: 'window',
      date: '2026-11-28',
      startTime: '13:00',
      endTime: '14:00',
      place: '地区センター',
    });
    await app.choose('way-a-home', 'a');
    expect(await app.accept((await app.need()).task('way-a-home', 'stay'), 'a')).toMatchObject({
      status: 'ok',
    });
    const sat = (time: string) => toEpochMinutes(`2026-11-28T${time}+09:00`);
    expect((await app.need()).gaps.map(span)).toEqual([[sat('13:00'), sat('14:00')]]);
  });

  it('やり方で担当の決まった手順は、本命に選ぶ時もほかの大人に付け替えない（頼み直しも断る）', async () => {
    const fixedWay: Way = {
      id: 'way-a-home',
      name: '健太が家で受け取る',
      steps: [
        {
          id: 'stay',
          name: '家で受け取る',
          durationMin: 0,
          segments: ['home'],
          waitAfterMin: 0,
          assigneeId: 'a',
          cover: true,
        },
      ],
      cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
      cancellable: true,
    };
    const app = await setup([fixedWay]);
    await app.stated(['way-a-home'], {
      what: '荷物を家で受け取る',
      shape: 'window',
      date: '2026-11-28',
      startTime: '13:00',
      endTime: '15:00',
    });
    // 彩が自分を担当にして選んでも、受け持ちは決まった健太に頼む。
    expect(await app.choose('way-a-home', 'b')).toMatchObject({ status: 'ok' });
    const stay = (await app.need()).task('way-a-home', 'stay');
    expect(stay?.assigneeId).toBe('a');
    expect(stay?.start).toBeDefined();
    if (!stay) throw new Error('受け持ちが無い');
    expect(
      await app.run({ type: 'proposeAssignment', taskKey: stay.key, assigneeId: 'b' }),
    ).toMatchObject({ status: 'invalid', reason: 'fixedAssignee' });
  });

  it('やり方と取れる手の ID が同じでも、担当の決まりは手配の種類の物だけを当てる（取り違えない）', async () => {
    // 取れる手 opt-leave-a の apply は健太（a）に決まっている。同じ ID のやり方の apply は彩（b）に決める。
    const same: Way = {
      id: 'opt-leave-a',
      name: '彩が家で受け取る',
      steps: [
        {
          id: 'apply',
          name: '家で受け取る',
          durationMin: 0,
          segments: ['home'],
          waitAfterMin: 0,
          assigneeId: 'b',
          cover: true,
        },
      ],
      cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
      cancellable: true,
    };
    const app = await setup([same]);
    await app.stated(['opt-leave-a'], {
      what: '荷物を家で受け取る',
      shape: 'window',
      date: '2026-11-28',
      startTime: '13:00',
      endTime: '15:00',
    });
    expect(await app.choose('opt-leave-a', 'b')).toMatchObject({ status: 'ok' });
    const step = (await app.need()).task('opt-leave-a', 'apply');
    expect(step?.assigneeId).toBe('b');
    if (!step) throw new Error('受け持ちの作業が無い');
    expect(
      await app.run({
        type: 'proposeAssignment',
        taskKey: step.key,
        assigneeId: 'a',
        seen: { taskKey: step.key, assigneeId: 'b', commitment: step.commitment },
      }),
    ).toMatchObject({ status: 'invalid', reason: 'fixedAssignee' });
  });

  it('同じやり方の受け持ちを同じ人に二つ置かない（後の方は時刻なし）', async () => {
    const twice: Way = {
      id: 'way-twice',
      name: '健太が二つ受け持つ',
      steps: [
        {
          id: 'one',
          name: '家で受け取る',
          durationMin: 0,
          segments: ['home'],
          waitAfterMin: 0,
          assigneeId: 'a',
          cover: true,
        },
        {
          id: 'two',
          name: '家で見る',
          durationMin: 0,
          segments: ['home'],
          waitAfterMin: 0,
          assigneeId: 'a',
          cover: true,
        },
      ],
      cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
      cancellable: true,
    };
    const app = await setup([twice]);
    await app.stated(['way-twice'], {
      what: '荷物を家で受け取る',
      shape: 'window',
      date: '2026-11-28',
      startTime: '13:00',
      endTime: '15:00',
    });
    await app.choose('way-twice', 'a');
    const now = await app.need();
    expect(now.task('way-twice', 'one')?.start).toBeDefined();
    expect(now.task('way-twice', 'two')?.start).toBeUndefined();
  });

  it('やり方の選びは、今ある「すること」と家庭のやり方だけ', async () => {
    const app = await setup();
    const itemId = await app.stated([]);
    expect(
      await app.preview({ type: 'setNeedWays', itemId, wayIds: ['way-unknown'] }),
    ).toMatchObject({ reason: 'wayUnknown' });
    expect(
      await app.preview({ type: 'setNeedWays', itemId: 'no-such-item', wayIds: ['way-grandma'] }),
    ).toMatchObject({ reason: 'needGone' });
  });

  it('言明を取り下げると、手配が無くなり、「はい」をくれた相手への取り消しの連絡が要る', async () => {
    const app = await setup();
    await app.stated(['way-sick-care']);
    await app.choose('way-sick-care');
    await app.askAndReply((await app.need()).task('way-sick-care', 'reserve'), 'req-sick', 'yes');
    const source = (await app.events()).find(
      (e) => e.type === 'noticeReceived' && e.source.sender === 'family',
    );
    if (source?.type !== 'noticeReceived') throw new Error('出典が無い');
    const sourceId = source.source.id;
    expect(await app.run({ type: 'withdrawSource', sourceId })).toMatchObject({ status: 'ok' });
    const now = await app.need();
    expect(now.arrangement).toBeUndefined();
    expect(now.plan.tasks.filter((t) => t.live && t.cancels === 'req-sick')).toHaveLength(1);
  });
});
