// @vitest-environment happy-dom
// 家族が決める値の問いの札：お知らせの言葉の名前と、値ごとに要る物（期限つき。ほかの条件しだいの物は分けて
// 書く）、決める期限（時刻は、その期限を作った要件に書かれた時だけ）を見せ、値を選んでもらう（見せた計画の
// 番号と問いを付けて送る）。yes・no は「はい・いいえ」、ほかの値はお知らせの言葉のまま。
import type { Question } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { type Ctx, TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const household = {
  members: [
    { id: 'a', name: '健太', kind: 'adult', active: true },
    { id: 'b', name: '彩', kind: 'adult', active: true },
    { id: 'c', name: '陽菜', kind: 'child', active: true },
  ],
  places: [],
  careOptions: [],
};

const TEXT = '参加される方は、11月30日(月)17:00までに申込書を提出してください。';

const requirement = {
  key: 'req:submission:p1:s1',
  kind: 'submission',
  what: '申込書',
  by: '2026-11-30T17:00+09:00',
  nature: 'required',
  basis: { itemIds: ['p1:s1'], requirementKey: 'req:submission:p1:s1' },
  live: true,
  conditional: true,
};

const question = (over: Partial<Question> = {}): Question => ({
  key: 'q:p1:u-join',
  unknownId: 'p1:u-join',
  until: '2026-11-30T17:00+09:00',
  affects: ['req:submission:p1:s1'],
  family: {
    label: '親子清掃に参加するか',
    choices: [
      { value: 'yes', requirementKeys: ['req:submission:p1:s1'], conditionalKeys: [] },
      { value: 'no', requirementKeys: [], conditionalKeys: [] },
    ],
  },
  ...over,
});

function ctxWith(q: Question) {
  const sent: unknown[] = [];
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:05+09:00',
    me: household.members[0],
    household,
    plan: {
      tasks: [],
      requirements: [requirement],
      arrangements: [],
      requests: [],
      questions: [q],
      throughSeq: 9,
    },
    today: { main: [{ kind: 'question', question: q }], quiet: [] },
    items: [
      {
        item: {
          id: 'p1:s1',
          sourceId: 'p1',
          sentenceIds: ['p1#1'],
          kind: 'submission',
          written: TEXT,
          interpretation: { what: '申込書', deadline: '2026-11-30T17:00+09:00' },
          evidence: 'stated',
          effects: [],
        },
        live: true,
        conditional: true,
        trusted: true,
      },
    ],
    sources: new Map([
      [
        'p1',
        {
          id: 'p1',
          version: 1,
          receivedAt: '2026-11-25T20:00+09:00',
          sender: 'school',
          language: 'ja',
          medium: 'text',
          title: '（架空）親子清掃のお知らせ',
          sentences: [{ id: 'p1#1', text: TEXT }],
        },
      ],
    ]),
    readings: [],
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: unknown) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: () => {},
  } as unknown as Ctx;
  return { ctx, sent };
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

const buttons = (text: string) =>
  [...host.querySelectorAll('button')].filter((b) => b.textContent === text);

describe('家族で決めることの札', () => {
  it('お知らせの言葉で聞き、値ごとに要る物と期限、決める期限を見せる', async () => {
    const { ctx } = ctxWith(question());
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    const text = host.textContent ?? '';
    expect(text).toContain('家族で決めること');
    expect(text).toContain('親子清掃に参加するか');
    expect(text).toContain('はいなら：申込書（11/30');
    // 要る物の無い値は、この答えで要る作業が無いとだけ言う（同じお知らせのほかの作業は別に出ている）。
    expect(text).toContain('いいえなら：この答えで要る作業はありません');
    expect(text).not.toContain('することはありません');
    expect(text).toContain('までに決めてください。');
    expect(text).toContain('決めるまで、これに関わる作業は「だれがやるか」に出しません。');
    expect(text).toContain('「（架空）親子清掃のお知らせ」の文を見る');
    // 家にあるかの言葉（ある・ない）は使わない。
    expect(buttons('ある')).toHaveLength(0);
    expect(buttons('はい')).toHaveLength(1);
    expect(buttons('いいえ')).toHaveLength(1);
  });

  it('値を選ぶと、見せた計画の番号と見せた問い（key・期限・変わる要件）を付けて答える', async () => {
    const { ctx, sent } = ctxWith(question());
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    const [yes] = buttons('はい');
    await step(() => yes?.click());
    expect(sent).toEqual([
      {
        type: 'answer',
        unknownId: 'p1:u-join',
        value: 'yes',
        seen: {
          throughSeq: 9,
          question: {
            key: 'q:p1:u-join',
            until: '2026-11-30T17:00+09:00',
            affects: ['req:submission:p1:s1'],
          },
        },
      },
    ]);
  });

  it('yes・no でない値は、お知らせの言葉のまま見せる。期限の無い問いには期限を書かない', async () => {
    const q = question({
      family: {
        label: '参加する時間',
        choices: [
          { value: '午前', requirementKeys: [], conditionalKeys: [] },
          { value: '両方', requirementKeys: ['req:submission:p1:s1'], conditionalKeys: [] },
        ],
      },
    });
    delete q.until;
    const { ctx } = ctxWith(q);
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    const text = host.textContent ?? '';
    expect(text).toContain('両方なら：申込書（11/30');
    expect(text).toContain('午前なら：この答えで要る作業はありません');
    expect(text).not.toContain('までに決めてください。');
    expect(buttons('両方')).toHaveLength(1);
  });

  it('ほかの条件しだいの物は、値を選んだだけで要ると断定せず、分けて書く', async () => {
    const REQ = 'req:submission:p1:s1';
    const { ctx } = ctxWith(
      question({
        family: {
          label: '親子清掃に参加するか',
          choices: [
            { value: 'yes', requirementKeys: [REQ], conditionalKeys: [REQ] },
            { value: 'no', requirementKeys: [REQ], conditionalKeys: [REQ] },
          ],
        },
      }),
    );
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    const text = host.textContent ?? '';
    expect(text).toContain('はいなら：ほかの条件しだいで、申込書（11/30');
    expect(text).toContain('いいえなら：ほかの条件しだいで、申込書（11/30');
    expect(text).not.toContain('はいなら：申込書');
  });

  it('確かに要る物とほかの条件しだいの物が両方あれば、両方を分けて書く', async () => {
    const { ctx } = ctxWith(
      question({
        affects: ['req:submission:p1:s1', 'req:submission:p1:s2'],
        family: {
          label: '親子清掃に参加するか',
          choices: [
            {
              value: 'yes',
              requirementKeys: ['req:submission:p1:s1', 'req:submission:p1:s2'],
              conditionalKeys: ['req:submission:p1:s2'],
            },
            { value: 'no', requirementKeys: [], conditionalKeys: [] },
          ],
        },
      }),
    );
    ctx.plan.requirements.push({
      ...requirement,
      key: 'req:submission:p1:s2',
      what: '保護者証',
      by: '2026-12-02T17:00+09:00',
      basis: { itemIds: ['p1:s1'], requirementKey: 'req:submission:p1:s2' },
    } as (typeof ctx.plan.requirements)[number]);
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain(
      'はいなら：申込書（11/30（月） 17:00まで）。ほかの条件しだいで、保護者証（12/2（水） 17:00まで）',
    );
  });

  it('前の答えが使えなくなって聞き直す時は、前の答えを添える', async () => {
    const { ctx } = ctxWith(
      question({
        family: {
          label: '親子清掃を欠席するか',
          choices: [
            { value: 'yes', requirementKeys: ['req:submission:p1:s1'], conditionalKeys: [] },
            { value: 'no', requirementKeys: [], conditionalKeys: [] },
          ],
          previous: 'yes',
        },
      }),
    );
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(host.textContent).toContain(
      '前は「はい」と答えましたが、その後お知らせの読み取りが直されました。もう一度決めてください。',
    );
  });

  it('決める期限の時刻は、その期限を作った要件の物だけで決める（日だけの締切に、ほかの要件の時刻を借りない）', async () => {
    const q = question({
      until: '2026-11-30T08:00+09:00',
      affects: ['req:submission:p1:s1', 'req:submission:p1:s2'],
      family: {
        label: '親子清掃に参加するか',
        choices: [
          {
            value: 'yes',
            requirementKeys: ['req:submission:p1:s1', 'req:submission:p1:s2'],
            conditionalKeys: [],
          },
          { value: 'no', requirementKeys: [], conditionalKeys: [] },
        ],
      },
    });
    const { ctx } = ctxWith(q);
    const [first] = ctx.plan.requirements;
    const [original] = ctx.items;
    if (!first || !original) throw new Error('資料が無い');
    first.by = '2026-11-30T08:00+09:00';
    original.item.interpretation = {
      what: '申込書',
      deadline: '2026-11-30T08:00+09:00',
      deadlineDayOnly: true,
    };
    ctx.plan.requirements.push({
      ...first,
      key: 'req:submission:p1:s2',
      what: '保護者証',
      by: '2026-12-02T17:00+09:00',
      basis: { itemIds: ['p1:s2'], requirementKey: 'req:submission:p1:s2' },
    });
    ctx.items.push({
      ...original,
      item: {
        ...original.item,
        id: 'p1:s2',
        interpretation: { what: '保護者証', deadline: '2026-12-02T17:00+09:00' },
      },
    });
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    const text = host.textContent ?? '';
    expect(text).toMatch(/11\/30（月）までに決めてください。/);
    expect(text).not.toMatch(/11\/30（月）\s*8:00までに決めてください/);
    // それぞれの要件の行は、それぞれの書き方のまま（書かれた時刻は見せる）。
    expect(text).toMatch(/保護者証（12\/2（水）\s*17:00まで）/);
  });
});
