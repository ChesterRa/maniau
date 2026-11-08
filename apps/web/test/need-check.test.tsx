// @vitest-environment happy-dom
// お知らせから読んだ「すること」を確かめる操作：札の「合っている」「読み取りが違う」は、見せた時の番号を付けて送り、
// 断られた理由を出す。形のそろわない読み取りに「合っている」を出さない。「直す」の画面は、読み取りで埋め、形は替え
// ず（読み取りに形が無い時だけ選ぶ）、締切の時刻が空なら日だけの締切として送る。DOM の試験では、デモのファイルを
// 読まず、要る物だけの材料で組む（計算から札までは need-screens.test.tsx）。
import type { Command, Item } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SendResult } from '../src/family';
import i18n from '../src/i18n';
import { NeedFixScreen } from '../src/need';
import { type Ctx, type Route, TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const WRITTEN =
  '12月12日（土）13:00〜14:00に地域交流会を行います。各家庭から大人1名、ご参加ください。';

const needItem = (id: string, interpretation: Item['interpretation']): Item => ({
  id,
  sourceId: 'n9',
  sentenceIds: ['n9#1'],
  kind: 'need',
  written: '各家庭から大人1名、ご参加ください。',
  interpretation,
  evidence: 'stated',
  effects: [],
});

/** 画面に要る物だけの材料（お知らせから読んで、まだ確かめていない「すること」）。 */
function materials(items: Item[], answer: () => SendResult = () => ({ status: 'ok' })) {
  const sent: Command[] = [];
  const went: Route[] = [];
  const requirements = items.map((item) => ({
    key: `req:need:${item.id}`,
    kind: 'need',
    what: item.interpretation.what ?? item.written,
    nature: 'required',
    basis: { itemIds: [item.id], requirementKey: `req:need:${item.id}` },
    live: true,
    unconfirmed: true,
  }));
  const ctx = {
    household: {
      timeZone: 'Asia/Tokyo',
      members: [
        { id: 'a', kind: 'adult', name: '健太', active: true },
        { id: 'c', kind: 'child', name: '陽菜', active: true },
      ],
      places: [],
      careOptions: [],
      ways: [],
    },
    plan: {
      throughSeq: 7,
      requirements,
      arrangements: [],
      tasks: [],
      requests: [],
      questions: [],
    },
    today: {
      main: requirements.map((requirement) => ({ kind: 'needCheck', requirement })),
      quiet: [],
    },
    items: items.map((item) => ({
      item,
      live: true,
      conditional: false,
      trusted: item.evidence === 'stated' || item.evidence === 'confirmed',
    })),
    sources: new Map([
      ['n9', { id: 'n9', sender: 'school', sentences: [{ id: 'n9#1', text: WRITTEN }] }],
    ]),
    // モデルが読んだお知らせには、読み取りがある（確かめてほしい文の印は無い）。
    readings: [{ sourceId: 'n9', origin: 'live', model: 'm' }],
    me: { id: 'a', kind: 'adult', name: '健太', active: true },
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:00+09:00',
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: Command) => {
      sent.push(command);
      return answer();
    },
    go: (route: Route) => went.push(route),
  } as unknown as Ctx;
  return { ctx, sent, went };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const buttons = (label: string) =>
  [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
const button = (label: string) => buttons(label)[0];
/** 外す二つをたたんだ一行（札ごとに一つ）。家族と同じく、一行を押して開いてから外す。 */
const dismissPanels = () =>
  [...host.querySelectorAll('details')].filter(
    (d) => d.querySelector('summary')?.textContent === '違う・うちには要らない時',
  );
async function openDismiss(at = 0) {
  const panel = dismissPanels()[at];
  expect(panel?.open).toBe(false);
  await step(() => panel?.querySelector('summary')?.click());
  expect(panel?.open).toBe(true);
}
function enter(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

const EXCHANGE = needItem('n9:i1', {
  date: '2026-12-12',
  startTime: '13:00',
  endTime: '14:00',
  what: '地域交流会への参加',
  shape: 'window',
});
const NO_END = needItem('n9:i2', {
  date: '2026-12-13',
  startTime: '09:00',
  endTimeUnconfirmed: true,
  what: '説明会への参加',
  shape: 'window',
});
const BY_DAY = needItem('n9:i3', {
  deadline: '2026-12-04T08:00+09:00',
  deadlineDayOnly: true,
  date: '2026-12-12',
  what: '設備の利用の申し込み',
  shape: 'by',
});

describe('お知らせから読んだ「すること」の確かめ', () => {
  it('札：読み取りと元の文を見せ、「合っている」「読み取りが違う」は見せた番号を付けて送る。断られた理由を出す', async () => {
    let answer: SendResult = { status: 'ok' };
    const { ctx, sent, went } = materials([EXCHANGE, NO_END], () => answer);
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain('読み取りを確かめる');
    expect(host.textContent).toContain('13:00〜14:00、だれかが要る');
    expect(host.textContent).toContain('終わりの時刻は読み取れていません');
    expect(host.textContent).toContain('「直す」で終わりの時刻を入れると');
    expect(host.textContent).toContain(WRITTEN);
    // 形のそろわない読み取り（終わりが無い）には、「合っている」を出さない（直してもらう）。
    expect(buttons('合っている')).toHaveLength(1);
    expect(buttons('直す')).toHaveLength(2);
    await step(() => button('合っている')?.click());
    expect(sent).toEqual([{ type: 'confirmItem', itemId: 'n9:i1', seen: { throughSeq: 7 } }]);
    answer = { status: 'conflict', reason: 'itemChanged' };
    await openDismiss(1);
    await step(() => buttons('読み取りが違う（外す）')[1]?.click());
    expect(sent[1]).toEqual({
      type: 'dismissItem',
      itemId: 'n9:i2',
      reason: 'misread',
      seen: { throughSeq: 7 },
    });
    expect(host.textContent).toContain('見せた後に、このお知らせの中身が変わりました。');
    await step(() => buttons('直す')[1]?.click());
    expect(went).toEqual([{ name: 'needFix', itemId: 'n9:i2' }]);
  });

  it('札と直す画面：お知らせの全文を見せ、指した文を太字にする（指さなかった文の条件を見落とさない）。たたむこともできる', async () => {
    const { ctx } = materials([{ ...EXCHANGE, sentenceIds: ['n9#1'] }]);
    const long = {
      ...ctx,
      sources: new Map([
        [
          'n9',
          {
            id: 'n9',
            sender: 'school',
            language: 'ja',
            sentences: [
              { id: 'n9#1', text: '12月4日までに欠席を連絡してください。' },
              { id: 'n9#2', text: '連絡は学年の窓口で受け付けます。' },
              { id: 'n9#3', text: '登校前にお願いします。' },
            ],
          },
        ],
      ]),
    } as unknown as Ctx;
    const all =
      '12月4日までに欠席を連絡してください。連絡は学年の窓口で受け付けます。登校前にお願いします。';
    await step(() => root.render(<TodayScreen ctx={long} />));
    // 指した文から二つ離れた「登校前に」も、初めから見える。
    expect(host.textContent).toContain(all);
    expect(host.querySelector('blockquote .font-bold')?.textContent).toBe(
      '12月4日までに欠席を連絡してください。',
    );
    await step(() => button('指した文と前後だけにする')?.click());
    expect(host.textContent).not.toContain('登校前にお願いします。');
    await step(() => button('お知らせの全文を見る（ほかに 1 文）')?.click());
    expect(host.textContent).toContain(all);
    // 直す画面も、同じ全文を見せる。
    await step(() => root.render(<NeedFixScreen ctx={long} itemId="n9:i1" />));
    expect(host.textContent).toContain(all);
  });

  it('札：元の文と食い違う読み取りと、確かめてほしい文を指す読み取りには、よく確かめるよう添える', async () => {
    const conflicting = { ...EXCHANGE, evidence: 'conflicting' as const };
    const { ctx } = materials([conflicting]);
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain('元の文と食い違うか、読み落としたかもしれない所があります');
    const plain = materials([EXCHANGE]);
    await step(() => root.render(<TodayScreen ctx={plain.ctx} />));
    expect(host.textContent).not.toContain('読み落としたかもしれない所');
    const checked = materials([EXCHANGE]);
    const withCheck = {
      ...checked.ctx,
      readings: [{ sourceId: 'n9', origin: 'live', model: 'm', check: ['n9#1'] }],
    } as Ctx;
    await step(() => root.render(<TodayScreen ctx={withCheck} />));
    expect(host.textContent).toContain('読み落としたかもしれない所');
  });

  it.each(['ja', 'en'] as const)(
    '札：書かれた日が分からず「あしたまでに」を入れた日から数えた読み取りには、その訳を出す (%s)',
    async (lang) => {
      const unanchored = {
        ...needItem('n9:i5', {
          deadline: '2026-11-26T08:00+09:00',
          deadlineDayOnly: true,
          date: '2026-11-26',
          relativeDay: 'tomorrow',
          relativeDayFromReceived: '2026-11-25',
          what: '窓口での申し込み',
          shape: 'by',
        }),
        evidence: 'inferred' as const,
      };
      const t = i18n.getFixedT(lang);
      const { ctx } = materials([unanchored]);
      await step(() => root.render(<TodayScreen ctx={{ ...ctx, lang, t }} />));
      expect(host.textContent).toContain(
        lang === 'ja'
          ? '「あした」を、入れた日（11/25（水））から数えました。お知らせが書かれた日が違えば、日付を直してください。'
          : '“Tomorrow” was counted from the day the notice was entered (Wed 11/25).',
      );
      // 書かれた日から数えた読み取りには出さない。
      const anchored = materials([EXCHANGE]);
      await step(() => root.render(<TodayScreen ctx={{ ...anchored.ctx, lang, t }} />));
      expect(host.textContent).toContain(
        lang === 'ja' ? '読み取りを確かめる' : 'Check the reading',
      );
      expect(host.textContent).not.toContain(
        lang === 'ja' ? '入れた日（' : 'the day the notice was entered',
      );
    },
  );

  it('札：読み取りの日時が過ぎた時と、今の答えで要らない時も出し、そう添える。「うちには要らない」で外せる', async () => {
    const pastItem = needItem('n9:i5', {
      date: '2026-11-20',
      startTime: '13:00',
      endTime: '14:00',
      what: '説明会への参加',
      shape: 'window',
    });
    const { ctx, sent } = materials([pastItem]);
    const notLive = {
      ...ctx,
      plan: {
        ...ctx.plan,
        requirements: ctx.plan.requirements.map((r) => ({ ...r, live: false })),
      },
      today: {
        ...ctx.today,
        main: ctx.today.main.map((c) =>
          c.kind === 'needCheck' ? { ...c, requirement: { ...c.requirement, live: false } } : c,
        ),
      },
    } as Ctx;
    await step(() => root.render(<TodayScreen ctx={notLive} />));
    expect(host.textContent).toContain('読み取りの日時は、もう過ぎています');
    expect(host.textContent).toContain('今の答えでは、要らないことになっています');
    await openDismiss();
    await step(() => button('うちには要らない（外す）')?.click());
    expect(sent).toEqual([
      { type: 'dismissItem', itemId: 'n9:i5', reason: 'notOurs', seen: { throughSeq: 7 } },
    ]);
    // 今の答えで要り、日時がまだ先の物には、どちらも添えない。
    const plain = materials([EXCHANGE]);
    await step(() => root.render(<TodayScreen ctx={plain.ctx} />));
    expect(host.textContent).not.toContain('もう過ぎています');
    expect(host.textContent).not.toContain('要らないことになっています');
  });

  it('札と直す画面：条件の式を連結と否定のまま見せ、答えはどの値への物かを書く。見せられなければ、確かめ・直しを出さない', async () => {
    const conditioned = { ...EXCHANGE, conditionNodeId: 'n9:c1' };
    const { ctx, sent } = materials([conditioned]);
    const condition = {
      kind: 'and' as const,
      children: [
        { kind: 'eq' as const, label: '行事が開催されるか', value: 'yes' },
        {
          kind: 'or' as const,
          children: [
            { kind: 'eq' as const, label: '参加を希望するか', value: 'yes' },
            {
              kind: 'not' as const,
              child: { kind: 'eq' as const, label: '雨天か', value: 'yes' },
            },
          ],
        },
      ],
    };
    const shown = (extra: Record<string, unknown>) =>
      ({
        ...ctx,
        items: ctx.items.map((l) => ({ ...l, ...extra })),
      }) as Ctx;
    await step(() =>
      root.render(
        <TodayScreen
          ctx={shown({
            condition,
            answers: [{ unknownId: 'n9:u2', label: '参加を希望するか', value: 'yes' }],
          })}
        />,
      ),
    );
    expect(host.textContent).toContain(
      '条件：「行事が開催されるか」が「はい」、かつ（「参加を希望するか」が「はい」、または「雨天か」が「はい」ではない）の時だけ要る',
    );
    expect(host.textContent).toContain('「参加を希望するか」は「はい」と分かると読みました');
    expect(buttons('合っている')).toHaveLength(1);
    // 見せられない条件：確かめ・直しは出さず、外す入口だけ残す。
    await step(() => root.render(<TodayScreen ctx={shown({ unshown: true })} />));
    expect(host.textContent).toContain('見分けられる形で見せられないので、確かめられません');
    expect(buttons('合っている')).toHaveLength(0);
    expect(buttons('直す')).toHaveLength(0);
    // 外すのが唯一の道なので、たたまずに開いて出す。
    expect(dismissPanels()[0]?.open).toBe(true);
    await step(() => button('読み取りが違う（外す）')?.click());
    expect(sent).toEqual([
      { type: 'dismissItem', itemId: 'n9:i1', reason: 'misread', seen: { throughSeq: 7 } },
    ]);
    // 直す画面：条件は直せないと書き、見せられない時は保存させない。
    await step(() => root.render(<NeedFixScreen ctx={shown({ condition })} itemId="n9:i1" />));
    expect(host.textContent).toContain('条件と答えは、ここでは直せません');
    expect(button('この内容で確かめる')).toBeDefined();
    await step(() => root.render(<NeedFixScreen ctx={shown({ unshown: true })} itemId="n9:i1" />));
    expect(button('この内容で確かめる')).toBeUndefined();
  });

  it('別のお知らせの問い・置き換えの先には、そのお知らせと日時を添える（札と直す画面）', async () => {
    const { ctx } = materials([{ ...EXCHANGE, conditionNodeId: 'n9:c1' }]);
    const from = { day: '2026-11-20', title: '練習会だより' };
    const extra = {
      condition: {
        kind: 'eq' as const,
        label: '参加するか',
        value: 'yes',
        from: { day: '2026-11-20' },
      },
      answers: [{ unknownId: 'p1:u1', label: '参加するか', value: 'yes', from }],
      targets: [
        { type: 'cancel', itemId: 'p1:i1', what: '練習会', when: { date: '2026-12-05' }, from },
        {
          type: 'replace',
          itemId: 'n8:i1',
          what: '申込み',
          when: { deadline: '2026-12-04T08:00+09:00', deadlineDayOnly: true },
        },
        { type: 'replace', itemId: 'gone:i1' },
      ],
    };
    const shownCtx = { ...ctx, items: ctx.items.map((l) => ({ ...l, ...extra })) } as Ctx;
    for (const screen of [
      <TodayScreen key="today" ctx={shownCtx} />,
      <NeedFixScreen key="fix" ctx={shownCtx} itemId="n9:i1" />,
    ]) {
      await step(() => root.render(screen));
      const text = host.textContent ?? '';
      expect(text).toContain('11/20（金）に届いたお知らせの「参加するか」が「はい」の時だけ要る');
      expect(text).toContain(
        '11/20（金）に届いた「練習会だより」の「参加するか」は「はい」と分かると読みました',
      );
      expect(text).toContain(
        '11/20（金）に届いた「練習会だより」の「練習会」（12/5（土））が無くなると読みました',
      );
      expect(text).toContain('「申込み」（12/4（金）まで）に代わると読みました');
      expect(text).toContain('（見つからない事項）に代わると読みました');
    }
  });

  it('直す：読み取りで埋め、形は送らず（読み取りの形のまま）、見せた番号を付けて送る。済めば、きょうに戻る', async () => {
    const { ctx, sent, went } = materials([NO_END]);
    await step(() => root.render(<NeedFixScreen ctx={ctx} itemId="n9:i2" />));
    expect(host.textContent).toContain(WRITTEN);
    expect(host.querySelectorAll('input[type=radio]')).toHaveLength(0);
    const [what, date] = host.querySelectorAll<HTMLInputElement>(
      'input:not([type=radio]):not([type=time])',
    );
    const [from, to] = host.querySelectorAll<HTMLInputElement>('input[type=time]');
    if (!what || !date || !from || !to) throw new Error('欄が無い');
    expect([what.value, date.value, from.value, to.value]).toEqual([
      '説明会への参加',
      '2026-12-13',
      '09:00',
      '',
    ]);
    expect(button('この内容で確かめる')?.disabled).toBe(true);
    await step(() => enter(to, '10:00'));
    await step(() => button('この内容で確かめる')?.click());
    expect(sent).toEqual([
      {
        type: 'correctItem',
        itemId: 'n9:i2',
        interpretation: {
          what: '説明会への参加',
          date: '2026-12-13',
          startTime: '09:00',
          endTime: '10:00',
        },
        seen: { throughSeq: 7 },
      },
    ]);
    expect(went).toEqual([{ name: 'today' }]);
  });

  it('直す（締切）：日は締切の日で埋め、時刻が空なら日だけの締切、入れればその時刻。見せた後に変わったと断られたら、きょうで見直してもらう', async () => {
    let answer: SendResult = { status: 'conflict', reason: 'itemChanged' };
    const { ctx, sent, went } = materials([BY_DAY], () => answer);
    await step(() => root.render(<NeedFixScreen ctx={ctx} itemId="n9:i3" />));
    const [, date] = host.querySelectorAll<HTMLInputElement>(
      'input:not([type=radio]):not([type=time])',
    );
    const [time] = host.querySelectorAll<HTMLInputElement>('input[type=time]');
    if (!date || !time) throw new Error('欄が無い');
    // 読み取りの日付（行事の日）ではなく、締切の日。日だけの締切なので、時刻は空。
    expect([date.value, time.value]).toEqual(['2026-12-04', '']);
    await step(() => button('この内容で確かめる')?.click());
    expect(sent[0]).toMatchObject({
      type: 'correctItem',
      interpretation: {
        what: '設備の利用の申し込み',
        deadline: '2026-12-04T00:00+09:00',
        deadlineDayOnly: true,
      },
    });
    expect(host.textContent).toContain('きょうの画面で見直してください。');
    expect(went).toEqual([]);
    answer = { status: 'ok' };
    await step(() => enter(time, '17:00'));
    await step(() => button('この内容で確かめる')?.click());
    expect(sent[1]).toMatchObject({
      interpretation: { deadline: '2026-12-04T17:00+09:00', deadlineDayOnly: false },
    });
    expect(went).toEqual([{ name: 'today' }]);
  });

  it('直す（日の無い読み取り）：日を空にし、家族が入れるまで保存させない（きょうの日で埋めない）', async () => {
    const undated = needItem('n9:i6', { what: '申込み', shape: 'by' });
    const { ctx, sent } = materials([undated]);
    await step(() => root.render(<NeedFixScreen ctx={ctx} itemId="n9:i6" />));
    const [, date] = host.querySelectorAll<HTMLInputElement>(
      'input:not([type=radio]):not([type=time])',
    );
    if (!date) throw new Error('日の欄が無い');
    expect(date.value).toBe('');
    expect(button('この内容で確かめる')?.disabled).toBe(true);
    await step(() => button('この内容で確かめる')?.click());
    expect(sent).toEqual([]);
    await step(() => enter(date, '2026-12-04'));
    await step(() => button('この内容で確かめる')?.click());
    expect(sent[0]).toMatchObject({
      interpretation: { deadline: '2026-12-04T00:00+09:00', deadlineDayOnly: true },
    });
  });

  it('直す（形の無い読み取り）：形を選んでもらい、選んだ形を送る', async () => {
    const shapeless = needItem('n9:i4', { date: '2026-12-12', what: '受付の手伝い' });
    const { ctx, sent } = materials([shapeless]);
    await step(() => root.render(<NeedFixScreen ctx={ctx} itemId="n9:i4" />));
    const radios = host.querySelectorAll<HTMLInputElement>('input[type=radio]');
    expect(radios).toHaveLength(2);
    await step(() => radios[1]?.click());
    await step(() => button('この内容で確かめる')?.click());
    expect(sent[0]).toMatchObject({
      type: 'correctItem',
      interpretation: { what: '受付の手伝い', shape: 'by', deadlineDayOnly: true },
    });
  });
});
