// 通用の「すること」の画面：きょうの札、一つの「すること」の画面（家族のやり方を中身つきで見せる・本命・まだ受け持ちを
// 確かめられていない時間）、返事を記録する所の控え、頼む文。画面の材料は、サーバーと同じ命令と計算で作る（デモの家・
// 架空の家族）。場面の言葉を雛形に入れないことを、子の居場所でない例（荷物の受け取り）でも確かめる。押して確かめる
// 物（選ぶ・足す表）は need-form.test.tsx。
import type { Command, ExternalRequest, PreviewCommand, Way } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../server/src/commands';
import { demoEvents } from '../../server/src/demo';
import { previewChange } from '../../server/src/preview';
import { memoryStore } from '../../server/src/store';
import { viewFor } from '../../server/src/views';
import i18n from '../src/i18n';
import { NeedScreen } from '../src/need';
import {
  askDraft,
  askedLines,
  asksPerson,
  type Ctx,
  cancelDraft,
  TodayScreen,
  taskTitle,
} from '../src/screens';

const NOW = '2026-11-25T20:00+09:00';
const SICK = {
  text: '陽菜が熱っぽいので、明日は学校を休ませる。8時から18時まで、だれかが家で見ないといけない。',
  interpretation: {
    what: '陽菜を家で見る',
    shape: 'window' as const,
    date: '2026-11-26',
    startTime: '08:00',
    endTime: '18:00',
    forMemberId: 'c',
  },
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ');

/** デモの家に命令を順に書く（見る口の要約を付けて。サーバーと同じ道）。足すやり方は家の情報に足す（試験の材料）。 */
function family(extraWays: Way[] = []) {
  const events0 = demoEvents('arrived').map((e) =>
    e.type === 'householdSet'
      ? { ...e, household: { ...e.household, ways: [...e.household.ways, ...extraWays] } }
      : e,
  );
  const store = memoryStore(new Map([['demo', events0]]));
  const events = () => store.withHousehold('demo', (log) => [...log.events()]);
  let n = 0;
  const run = (command: Command, memberId = 'b') =>
    runCommand(
      store,
      'demo',
      { memberId, now: NOW, operationId: `ui-${++n}`, demo: true },
      command,
    );
  const write = async (command: PreviewCommand) => {
    const shown = previewChange(await events(), { memberId: 'b', now: NOW }, command);
    if ('reason' in shown) throw new Error(shown.reason);
    expect(
      await run({ ...command, seen: { throughSeq: shown.throughSeq, changes: shown.seen } }),
    ).toMatchObject({ status: 'ok' });
  };
  const ctx = async (memberId: string, lang: 'ja' | 'en' = 'ja'): Promise<Ctx> => {
    const view = viewFor(await events(), memberId, NOW);
    const me = view.household.members.find((m) => m.id === memberId);
    if (!me) throw new Error('大人が無い');
    return {
      plan: view.plan,
      household: view.household,
      today: view.today,
      items: view.items,
      sources: new Map(view.sources.map((s) => [s.id, s])),
      readings: [],
      me,
      lang,
      tz: view.household.timeZone,
      now: NOW,
      t: i18n.getFixedT(lang),
      outbound: (lng) => i18n.getFixedT(lng),
      send: async () => ({ status: 'ok' }),
      previewChange: async () => undefined,
      go: () => {},
    };
  };
  const need = async () => {
    const view = viewFor(await events(), 'b', NOW);
    const arrangement = view.plan.arrangements.find((a) => a.kind === 'need' && a.live);
    const requirement = view.plan.requirements.find((r) => r.kind === 'need' && r.live);
    if (!arrangement || !requirement) throw new Error('「すること」が無い');
    return { plan: view.plan, arrangement, itemId: requirement.basis.itemIds[0] ?? '' };
  };
  /** 本命に選ぶ（担当は b）。 */
  const choose = async (wayId: string) => {
    const { arrangement } = await need();
    const option = arrangement.options.find((o) => o.templateId === wayId);
    if (!option) throw new Error(`案が無い：${wayId}`);
    expect(
      await run({
        type: 'chooseOption',
        arrangementKey: arrangement.key,
        optionKey: option.key,
        role: 'primary',
        assigneeId: 'b',
      }),
    ).toMatchObject({ status: 'ok' });
    return option;
  };
  return { run, write, ctx, need, choose, events };
}

describe('通用の「すること」の画面', () => {
  it('言っただけの「すること」：二人のきょうに「やり方を選ぶ」札を出し、画面で家族のやり方を中身つきで見せる', async () => {
    const app = family();
    await app.write({ type: 'stateNeed', ...SICK });
    for (const member of ['a', 'b']) {
      const ctx = await app.ctx(member);
      expect(ctx.today.main.filter((c) => c.kind === 'need')).toHaveLength(1);
    }
    const ctx = await app.ctx('b');
    const today = text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
    expect(today).toContain('陽菜を家で見る');
    expect(today).toContain('使うやり方を選んでください');
    expect(today).toContain('することを足す');

    const { arrangement } = await app.need();
    const shown = text(
      renderToStaticMarkup(<NeedScreen ctx={ctx} arrangementKey={arrangement.key} />),
    );
    expect(shown).toContain('家族が言ったことです');
    expect(shown).toContain('だれのため：陽菜');
    expect(shown).toContain('祖母に来てもらう');
    expect(shown).toContain('祖母に来てもらえるか聞く（おばあちゃんの返事を待つ）');
    expect(shown).toContain('受け持つ：おばあちゃん');
    expect(shown).toContain('受け持つ：みらい橋病児保育室（架空）（08:30–17:30）');
    expect(shown).toContain('2000円');
    // 場所の書かれていない言明には、場所の注記を出さない。まだ選んでいないので、本命を選ぶ所も無い。
    expect(shown).not.toContain('書かれた場所に');
    expect(shown).not.toContain('本命を選ぶ');
  });

  it('返事を記録する所に記録した時の控えを出し、本命の「はい」の後も残る時間を、札と画面に時刻で出す', async () => {
    const app = family();
    await app.write({ type: 'stateNeed', ...SICK });
    const { itemId } = await app.need();
    await app.write({ type: 'setNeedWays', itemId, wayIds: ['way-sick-care', 'way-grandma'] });
    // やり方を選んだ後は、本命を選ぶ所を出す。
    let ctx = await app.ctx('b');
    let { arrangement } = await app.need();
    expect(
      text(renderToStaticMarkup(<NeedScreen ctx={ctx} arrangementKey={arrangement.key} />)),
    ).toContain('本命を選ぶ');
    const option = await app.choose('way-sick-care');
    const { plan } = await app.need();
    ({ arrangement } = await app.need());
    const reserve = plan.tasks.find((t) => t.live && t.basis.optionKey === option.key);
    if (!reserve) throw new Error('予約の作業が無い');
    await app.run({
      type: 'recordSent',
      taskKey: reserve.key,
      requestId: 'req-ui',
      window: { start: arrangement.start, end: arrangement.end },
    });
    // 返事を待つ間：窓（あすの朝）が近いので、まだ確かめられない時間の札を出し、返事待ちと添える。「はい」を記録
    // する所に、記録した時の控え（頼んだ手順・何の・いつの・だれの分）を出す。
    ctx = await app.ctx('b');
    expect(ctx.today.main.filter((c) => c.kind === 'need')).toHaveLength(1);
    const waiting = text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
    expect(waiting).toContain('返事を待っている依頼があります');
    expect(waiting).toContain('記録した時の内容：病児保育を予約する（陽菜を家で見る・');
    expect(waiting).toContain('相手が読んだ文ではありません');
    expect(waiting).toContain('だれの分：陽菜');
    await app.run({ type: 'recordReply', requestId: 'req-ui', reply: 'yes' });
    ctx = await app.ctx('a');
    const today = text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
    expect(today).toContain('まだ受け持ちを確かめられていない時間');
    expect(today).toMatch(/8:00–8:30.*17:30–18:00/);
    const screen = text(
      renderToStaticMarkup(<NeedScreen ctx={ctx} arrangementKey={arrangement.key} />),
    );
    expect(screen).toContain('外の相手の「はい」と、受け持つ家族の引き受け');
    expect(screen).toContain('いま進めている');
  });

  it('言明を取り下げた後の所への取り消しの文に、何を（子の名前を含む家族の言葉）を書かず、頼んだ時間で書く', async () => {
    const app = family();
    await app.write({ type: 'stateNeed', ...SICK });
    const { itemId } = await app.need();
    await app.write({ type: 'setNeedWays', itemId, wayIds: ['way-sick-care'] });
    const option = await app.choose('way-sick-care');
    const { plan, arrangement } = await app.need();
    const reserve = plan.tasks.find((t) => t.live && t.basis.optionKey === option.key);
    if (!reserve) throw new Error('予約の作業が無い');
    await app.run({
      type: 'recordSent',
      taskKey: reserve.key,
      requestId: 'req-place',
      window: { start: arrangement.start, end: arrangement.end },
    });
    await app.run({ type: 'recordReply', requestId: 'req-place', reply: 'yes' });
    const source = (await app.events()).find(
      (e) => e.type === 'noticeReceived' && e.source.sender === 'family',
    );
    if (source?.type !== 'noticeReceived') throw new Error('出典が無い');
    expect(await app.run({ type: 'withdrawSource', sourceId: source.source.id })).toMatchObject({
      status: 'ok',
    });
    const ctx = await app.ctx('b');
    const request = ctx.plan.requests.find((r) => r.requestId === 'req-place');
    if (!request) throw new Error('依頼が無い');
    // 控えには何をが残る（家族が見る返事の記録に使う）が、所への文には書かない。
    expect(request.askedNeed?.what).toBe('陽菜を家で見る');
    expect(ctx.household.places.some((p) => p.id === request.to)).toBe(true);
    expect(cancelDraft(ctx, request)).toBe(
      '11月26日（木）の8:00〜18:00の件でお願いしていたことを、取り消します。',
    );
    expect(text(renderToStaticMarkup(<TodayScreen ctx={ctx} />))).toContain('もう要らないこと');
  });

  it('頼む文と作業の題は、「すること」の何を・日・時間だけで書く（子の居場所でない例。学校・子の決まり文句を足さない）', async () => {
    const app = family();
    await app.write({
      type: 'stateNeed',
      text: '土曜の13時から15時に荷物が届くので、だれか家にいてほしい。',
      interpretation: {
        what: '荷物を家で受け取る',
        shape: 'window',
        date: '2026-11-28',
        startTime: '13:00',
        endTime: '15:00',
      },
    });
    const { itemId } = await app.need();
    await app.write({ type: 'setNeedWays', itemId, wayIds: ['way-grandma'] });
    const option = await app.choose('way-grandma');
    const ctx = await app.ctx('b');
    const ask = ctx.plan.tasks.find((t) => t.live && t.basis.optionKey === option.key);
    if (!ask) throw new Error('頼む作業が無い');
    expect(askDraft(ctx, ask)).toBe(
      'お母さん、お願いがあります。\n11月28日（土）の13:00から15:00まで、「荷物を家で受け取る」をお願いできませんか？',
    );
    expect(taskTitle(ctx, ask)).toContain('荷物を家で受け取る');
    expect(taskTitle(await app.ctx('b', 'en'), ask)).toContain('荷物を家で受け取る');
  });

  it('締切の「すること」を人に頼む文：書かれた締切の時刻は書き、日だけの締切は日だけ（日本語・英語）', async () => {
    for (const [deadline, dayOnly, ja, en] of [
      [
        '2026-11-28T17:00+09:00',
        false,
        '11月28日（土）の17:00までに、「資料を申し込む」をお願いできませんか？',
        'by 5:00 PM on Saturday, November 28?',
      ],
      [
        '2026-11-28T00:00+09:00',
        true,
        '11月28日（土）までに、「資料を申し込む」をお願いできませんか？',
        '” by Saturday, November 28?',
      ],
    ] as const) {
      const app = family();
      await app.write({
        type: 'stateNeed',
        text: '28日までに資料を申し込む。',
        interpretation: {
          what: '資料を申し込む',
          shape: 'by',
          date: '2026-11-28',
          deadline,
          ...(dayOnly ? { deadlineDayOnly: true as const } : {}),
        },
      });
      const { itemId } = await app.need();
      await app.write({ type: 'setNeedWays', itemId, wayIds: ['way-grandma'] });
      const option = await app.choose('way-grandma');
      const ctx = await app.ctx('b');
      const ask = ctx.plan.tasks.find((t) => t.live && t.basis.optionKey === option.key);
      if (!ask) throw new Error('頼む作業が無い');
      expect(askDraft(ctx, ask)).toContain(ja);
      // 頼む文は相手の言葉（祖母は日本語）。英語の文の形は、相手の言葉を英語にして確かめる。
      const english = await app.ctx('b', 'en');
      const helper = english.household.members.find((m) => m.id === 'g');
      if (helper) helper.outboundLanguage = 'en';
      expect(askDraft(english, ask)).toContain(en);
      if (dayOnly) expect(askDraft(english, ask)).not.toMatch(/\d{1,2}:\d{2}/);
    }
  });

  it('場所とだれの分を頼む文に書き、返事を記録する所には、頼んだ時の控えの場所・だれの分・手順を出す', async () => {
    const app = family();
    await app.write({
      type: 'stateNeed',
      text: '28日の13時から15時、地域センターで陽菜の荷物を受け取る。',
      interpretation: {
        what: '荷物を受け取る',
        shape: 'window',
        date: '2026-11-28',
        startTime: '13:00',
        endTime: '15:00',
        place: '地域センター',
        forMemberId: 'c',
      },
    });
    const { itemId } = await app.need();
    await app.write({ type: 'setNeedWays', itemId, wayIds: ['way-grandma'] });
    const option = await app.choose('way-grandma');
    let ctx = await app.ctx('b');
    const ask = ctx.plan.tasks.find((t) => t.live && t.basis.optionKey === option.key);
    if (!ask) throw new Error('頼む作業が無い');
    const draft = askDraft(ctx, ask);
    expect(draft).toContain('「荷物を受け取る」をお願いできませんか？');
    expect(draft).toContain('場所は地域センターです。');
    expect(draft).toContain('陽菜の分です。');
    const { arrangement } = await app.need();
    await app.run({
      type: 'recordSent',
      taskKey: ask.key,
      requestId: 'req-place',
      window: { start: arrangement.start, end: arrangement.end },
    });
    ctx = await app.ctx('b');
    const request = ctx.plan.requests.find((r) => r.requestId === 'req-place');
    if (!request) throw new Error('依頼が無い');
    const lines = askedLines(ctx, request);
    expect(lines[0]).toContain('記録した時の内容：祖母に来てもらえるか聞く（荷物を受け取る・');
    expect(lines).toContain('場所：地域センター');
    expect(lines).toContain('だれの分：陽菜');
    // 控えに中身の無い依頼は、今の値で埋めず、確かめられないと書く。
    const old = { ...request, askedNeed: undefined } as ExternalRequest;
    expect(askedLines(ctx, old)).toEqual([
      '頼んだ時の中身を、記録から確かめられません。何への返事かを確かめてから記録してください。',
    ]);
  });

  it('前提を聞く手順（受け持ちでない、外の相手への手順）は、「すること」を頼む文を作らない', async () => {
    const key: Way = {
      id: 'way-key',
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
    const app = family([key]);
    await app.write({
      type: 'stateNeed',
      text: '土曜の13時から15時に荷物が届く。',
      interpretation: {
        what: '荷物を家で受け取る',
        shape: 'window',
        date: '2026-11-28',
        startTime: '13:00',
        endTime: '15:00',
      },
    });
    const { itemId } = await app.need();
    await app.write({ type: 'setNeedWays', itemId, wayIds: ['way-key', 'way-grandma'] });
    const option = await app.choose('way-key');
    const ctx = await app.ctx('b');
    const ask = ctx.plan.tasks.find(
      (t) => t.live && t.basis.optionKey === option.key && t.step?.stepId === 'ask',
    );
    if (!ask) throw new Error('前提を聞く作業が無い');
    // 前提を聞く手順は、頼む文の画面を開かない（送ったと記録するだけ）。受け持つ手順（祖母に来てもらう）は開く。
    expect(asksPerson(ctx, ask)).toBe(false);
    const grandma = ctx.plan.tasks.find(
      (t) => t.basis.optionKey !== option.key && t.step?.templateId === 'way-grandma',
    );
    if (!grandma) throw new Error('祖母の作業が無い');
    expect(asksPerson(ctx, grandma)).toBe(true);
  });

  it('英語の画面でも同じ物を出す', async () => {
    const app = family();
    await app.write({ type: 'stateNeed', ...SICK });
    const ctx = await app.ctx('b', 'en');
    const { arrangement } = await app.need();
    const shown = text(
      renderToStaticMarkup(<NeedScreen ctx={ctx} arrangementKey={arrangement.key} />),
    );
    expect(shown).toContain('Ways to use');
    expect(shown).toContain('Covered by: みらい橋病児保育室（架空） (08:30–17:30)');
    expect(shown).toContain('Your family said this');
  });
});
