// @vitest-environment happy-dom
// 「うちのこと」：計算に使っている家族と暮らしの情報を見せ、直したら保存の前に「この変更で変わること」を見せ、
// 見た物の要約と番号を付けて保存する。直せない直しは、サーバーの理由を言葉にして見せ、保存させない。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type ExternalRequest, Household, type HouseholdPreview } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HouseholdPreviewResult } from '../src/family';
import { HouseholdScreen, householdPreviewLines } from '../src/household';
import i18n from '../src/i18n';
import type { Ctx } from '../src/screens';
import { step } from './fake-fetch';

// 試験は apps/web で走る（画面の環境では import.meta.url がファイルを指さない）。
const household = Household.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), '../../data/demo/household.json'), 'utf8')),
);

const emptyChanges = {
  added: [],
  removed: [],
  moved: [],
  unplaced: [],
  placed: [],
  reassigned: [],
  changed: [],
  relocated: [],
  reconfirm: [],
  released: [],
  cancels: [],
  checks: [],
  deadlines: [],
  windows: [],
  conflicts: [],
  rechoose: [],
};

function ctxWith(result: HouseholdPreviewResult | undefined) {
  const sent: unknown[] = [];
  const looked: Household[] = [];
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:05+09:00',
    me: household.members[1],
    household,
    plan: {
      tasks: [],
      requirements: [],
      arrangements: [],
      requests: [],
      questions: [],
      throughSeq: 9,
    },
    today: { main: [], quiet: [] },
    items: [],
    sources: new Map(),
    readings: [],
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: unknown) => {
      sent.push(command);
      return { status: 'ok' };
    },
    previewHousehold: async (edited: Household) => {
      looked.push(edited);
      return result;
    },
    go: () => {},
  } as unknown as Ctx;
  return { ctx, sent, looked };
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

/** 見出しで始まる札の「直す」（札の並びの順に頼らない）。 */
const editIn = (label: string) =>
  [
    ...([...host.querySelectorAll('section')]
      .find((section) => section.textContent?.startsWith(label))
      ?.querySelectorAll('button') ?? []),
  ].find((b) => b.textContent === '直す');
const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text);

describe('うちのこと', () => {
  it('人・ふだんの一週間・場所と店・取れる手を、計算に使う所と一緒に見せる', async () => {
    const { ctx } = ctxWith(undefined);
    await step(() => root.render(<HouseholdScreen ctx={ctx} />));
    const text = host.textContent ?? '';
    expect(text).toContain('健太（大人）');
    expect(text).toContain('陽菜（子ども）・小1・習い事の送り迎え：行きも帰りも要る');
    expect(text).toContain('おばあちゃん（頼める人）');
    expect(text).toMatch(/月：06:30–08:00 家・08:00–08:40 通勤（家→彩の職場（架空））/);
    expect(text).toContain('店：豊洲駅の近くの衣料品店');
    expect(text).toContain('毎日 10:00–21:00');
    expect(text).toContain('家族が確かめた');
    expect(text).toContain('学童に預ける');
    expect(text).toContain('前の週の月曜 18:30 まで');
    expect(text).toContain('学童の申込書を書く → 学童に申込書を出す（返事を待つ）');
    expect(text).toContain('おばあちゃんに頼む');
    expect(text).toContain('3日前の 21:00 まで');
    expect(text).toContain('作業を置ける時間と、子どもを預ける手配が要る時間に使います。');
  });

  it('取れる手の締切を直すと、保存の前に変わることを見せ、見た物の要約と番号を付けて保存する', async () => {
    const preview: HouseholdPreview = {
      changes: {
        ...emptyChanges,
        deadlines: [
          {
            arrangementKey: 'a1',
            optionKey: 'a1:opt-grandma',
            titleKey: 'option.askHelper',
            before: {
              decisionDeadline: '2026-12-04T20:55+09:00',
              deadlineCertainty: 'estimate',
              expired: false,
            },
            after: {
              decisionDeadline: '2026-12-02T20:55+09:00',
              deadlineCertainty: 'estimate',
              expired: false,
            },
          },
        ],
      },
      issues: [],
      unverified: ['required_arrangement_missing'],
      seen: 'abc123',
      throughSeq: 9,
    };
    const { ctx, sent, looked } = ctxWith({ preview });
    await step(() => root.render(<HouseholdScreen ctx={ctx} />));
    // 「取れる手」の札の「直す」（札の並びの順に頼らない）。
    const waysCard = [...host.querySelectorAll('section')].find((section) =>
      section.textContent?.startsWith('取れる手'),
    );
    const edit = [...(waysCard?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === '直す',
    );
    await step(() => edit?.click());
    const days = [...host.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
    // 祖母の手（3日前。取れる手の最後）の欄を5日前にする（有休の「3営業日前」と取り違えない）。
    const grandma = days.at(-1);
    if (!grandma) throw new Error('日数の欄が無い');
    await step(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(grandma, '5');
      grandma.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await step(() => button('変わることを見る')?.click());
    expect(looked[0]?.careOptions.find((o) => o.id === 'opt-grandma')?.deadline).toMatchObject({
      days: 5,
    });
    const text = host.textContent ?? '';
    expect(text).toContain('この変更で変わること');
    expect(text).toContain('の決め時：');
    expect(text).toContain('確かめきれない点が1件あります');
    await step(() => button('この内容で保存')?.click());
    expect(sent).toEqual([
      {
        type: 'updateHousehold',
        household: looked[0],
        seen: { throughSeq: 9, changes: 'abc123' },
      },
    ]);
  });

  it('選んだ手で見てもらえない時間が変わる時は、「この変更で変わること」に書く', () => {
    const { ctx } = ctxWith(undefined);
    const gakudo = {
      arrangementKey: 'arr:childCare:n1:i6:c',
      optionKey: 'opt:arr:childCare:n1:i6:c:opt-gakudo',
      templateId: 'opt-gakudo',
    };
    const gaps = [
      { start: '2026-12-07T08:10+09:00', end: '2026-12-07T09:00+09:00' },
      { start: '2026-12-07T16:00+09:00', end: '2026-12-07T18:15+09:00' },
    ];
    const lines = (covers: NonNullable<HouseholdPreview['changes']['covers']>) =>
      householdPreviewLines(ctx, {
        changes: { ...emptyChanges, covers },
        issues: [],
        unverified: [],
        seen: 'x',
        throughSeq: 9,
      } as HouseholdPreview);
    const name = '「学童に預ける」';
    expect(lines([{ ...gakudo, before: [], after: gaps }])).toEqual([
      `${name}では、8:10–9:00、16:00–18:15 を見てもらえなくなります（この手は新しくは選べず、選んである時は確保とは言いません）。`,
    ]);
    expect(lines([{ ...gakudo, before: gaps, after: [] }])).toEqual([
      `${name}で、手配の時間の全部を見てもらえるようになります。`,
    ]);
    expect(
      lines([{ ...gakudo, before: [], after: gaps.map((g) => ({ ...g, unsure: true as const })) }]),
    ).toEqual([
      `${name}では、8:10–9:00、16:00–18:15 を見てもらえると確かめられなくなります（この手は新しくは選べず、選んである時は確保とは言いません）。`,
    ]);
  });

  it('取れる手を「使えない」にでき、保存の前に変わることに書く。保存した手は、そう書き、戻す所を出さない', async () => {
    const preview: HouseholdPreview = {
      changes: emptyChanges,
      issues: [],
      unverified: [],
      seen: 'u1',
      throughSeq: 9,
    };
    const { ctx, looked } = ctxWith({ preview });
    await step(() => root.render(<HouseholdScreen ctx={ctx} />));
    const waysCard = () =>
      [...host.querySelectorAll('section')].find((section) =>
        section.textContent?.startsWith('取れる手'),
      );
    const edit = [...(waysCard()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === '直す',
    );
    await step(() => edit?.click());
    /** 取れる手の一つの欄（名前で探す）。 */
    const block = (title: string) =>
      [...(waysCard()?.querySelectorAll('div') ?? [])].find(
        (d) => d.firstElementChild?.textContent === title,
      );
    const toggle = (title: string, label: string) =>
      [...(block(title)?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);
    await step(() => toggle('学童に預ける', 'この手は使えない')?.click());
    expect(block('学童に預ける')?.textContent).toContain('使えないとした手です');
    // 保存の前なら、付けた印を外せる。
    expect(toggle('学童に預ける', '使えないにするのをやめる')).toBeDefined();
    await step(() => button('変わることを見る')?.click());
    expect(looked[0]?.unusableCareOptionIds).toEqual(['opt-gakudo']);
    expect(host.textContent).toContain(
      '「学童に預ける」を使えない手にします。新しくは選べず、選んである時も確保とは言いません。送った頼み事は取り消さず、要るかを確かめる札を出します。また使う時は、新しく足してください。',
    );
    // 印を外すと、見た物を消す（違う中身で保存しない）。
    await step(() => toggle('学童に預ける', '使えないにするのをやめる')?.click());
    expect(button('この内容で保存')).toBeUndefined();

    // 保存した後（家の情報に入っている手）は、そう書き、戻す所を出さない。
    await step(() => root.unmount());
    root = createRoot(host);
    const saved = ctxWith({ preview }).ctx;
    saved.household = { ...saved.household, unusableCareOptionIds: ['opt-gakudo'] };
    await step(() => root.render(<HouseholdScreen ctx={saved} />));
    expect(block('学童に預ける')?.textContent).toContain('使えないとした手です');
    const again = [...(waysCard()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === '直す',
    );
    await step(() => again?.click());
    expect(toggle('学童に預ける', 'この手は使えない')).toBeUndefined();
    expect(toggle('学童に預ける', '使えないにするのをやめる')).toBeUndefined();
  });

  it('学童の手の見てもらえる時間を直せる。逆さまの時間は直さず、そう言う', async () => {
    const preview: HouseholdPreview = {
      changes: emptyChanges,
      issues: [],
      unverified: [],
      seen: 'abc123',
      throughSeq: 9,
    };
    const { ctx, looked } = ctxWith({ preview });
    await step(() => root.render(<HouseholdScreen ctx={ctx} />));
    const waysCard = [...host.querySelectorAll('section')].find((section) =>
      section.textContent?.startsWith('取れる手'),
    );
    const edit = [...(waysCard?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === '直す',
    );
    await step(() => edit?.click());
    const field = (label: string) => {
      const found = host.querySelector(`input[aria-label="${label}"]`);
      if (!(found instanceof HTMLInputElement)) throw new Error(`${label} が無い`);
      return found;
    };
    const type = (input: HTMLInputElement, value: string) =>
      step(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    const from = field('見てもらえる時間の始まり');
    const to = field('見てもらえる時間の終わり');
    const backwards = '終わりは、始まりより後の時刻にしてください。';
    const missing = '始まりと終わりの時刻を入れてください。';
    expect([from.value, to.value]).toEqual(['08:00', '19:00']);
    // 逆さまの間は、そう書き、見る所へ進ませない（前に打った 9:00–19:00 を見せない）。
    await type(from, '09:00');
    await type(to, '07:00');
    expect([from.value, to.value]).toEqual(['09:00', '07:00']);
    expect(host.textContent).toContain(backwards);
    expect(button('変わることを見る')?.disabled).toBe(true);
    // 空の欄も同じ。
    await type(to, '');
    expect(host.textContent).toContain(missing);
    expect(button('変わることを見る')?.disabled).toBe(true);
    await type(to, '16:00');
    expect(host.textContent).not.toContain(backwards);
    expect(host.textContent).not.toContain(missing);
    await step(() => button('変わることを見る')?.click());
    expect(looked).toHaveLength(1);
    expect(looked[0]?.careOptions.find((o) => o.id === 'opt-gakudo')?.covers).toEqual({
      start: '09:00',
      end: '16:00',
    });
    expect(button('この内容で保存')).toBeDefined();
    // 見た後に逆さまにすると、見た物を消し、保存させない。
    await type(to, '08:30');
    expect(button('この内容で保存')).toBeUndefined();
    expect(button('変わることを見る')?.disabled).toBe(true);
  });

  it('直せない直しはサーバーの理由を言葉にし、保存のボタンを出さない', async () => {
    const { ctx, sent } = ctxWith({ refused: 'hoursOvernight' });
    await step(() => root.render(<HouseholdScreen ctx={ctx} />));
    await step(() => editIn('ふだんの一週間')?.click());
    await step(() => button('変わることを見る')?.click());
    expect(host.textContent).toContain('日をまたぐ営業時間は、まだ扱えません');
    expect(button('この内容で保存')).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('今の計画に見つからなくなるだけの引き受けは、要らなくなるとは言わず、確かめてもらうと書く', () => {
    const { ctx } = ctxWith(undefined);
    const content = { titleKey: 'task.gakudoForm.write', titleParams: {} };
    const lines = householdPreviewLines(ctx, {
      changes: {
        ...emptyChanges,
        released: [
          { taskKey: 't1', assigneeId: 'a', content, reason: 'unconfirmed' },
          { taskKey: 't2', assigneeId: 'a', content, reason: 'gone' },
        ],
      },
      issues: [],
      unverified: [],
      seen: 'x',
      throughSeq: 9,
    });
    expect(lines).toContain(
      '今の計画に見つからなくなる引き受け：学童の申込書を書く（まだ要るか、健太さんに確かめてもらいます）',
    );
    expect(lines).toContain('要らなくなる引き受け：学童の申込書を書く（健太さんに知らせます）');
    expect(lines).toHaveLength(2);
  });

  it('決め時を計算できなくなる手は、もう間に合わないと言い切らず、確かめられないと書く', () => {
    const { ctx } = ctxWith(undefined);
    const way = (
      after: HouseholdPreview['changes']['deadlines'][number]['after'],
    ): HouseholdPreview => ({
      changes: {
        ...emptyChanges,
        deadlines: [
          {
            arrangementKey: 'a1',
            optionKey: 'a1:opt-buy',
            titleKey: 'option.buy',
            before: {
              decisionDeadline: '2026-11-26T18:55+09:00',
              deadlineCertainty: 'estimate',
              expired: false,
            },
            after,
          },
        ],
      },
      issues: [],
      unverified: [],
      seen: 'x',
      throughSeq: 9,
    });
    const unknown = householdPreviewLines(
      ctx,
      way({ deadlineCertainty: 'undetermined', expired: true }),
    );
    expect(unknown.join('\n')).toContain('決め時を計算できず、間に合うか確かめられなくなります');
    expect(unknown.join('\n')).not.toContain('もう間に合わなくなります');
    // 過ぎた決め時を示せる時だけ、もう間に合わないと書く。
    const late = householdPreviewLines(
      ctx,
      way({
        decisionDeadline: '2026-11-25T18:55+09:00',
        deadlineCertainty: 'estimate',
        expired: true,
      }),
    );
    expect(late.join('\n')).toContain('もう間に合わなくなります');
  });

  it('子の居場所の手配が要る時間の変化を、前と後の時刻で書く', () => {
    const { ctx } = ctxWith(undefined);
    const child = household.members.find((m) => m.kind === 'child');
    if (!child) throw new Error('子どもがいない');
    const lines = householdPreviewLines(ctx, {
      changes: {
        ...emptyChanges,
        windows: [
          {
            arrangementKey: 'a1',
            kind: 'childCare',
            childId: child.id,
            before: { start: '2026-12-07T08:10+09:00', end: '2026-12-07T18:15+09:00' },
            after: { start: '2026-12-07T08:00+09:00', end: '2026-12-07T18:15+09:00' },
          },
        ],
      },
      issues: [],
      unverified: [],
      seen: 'x',
      throughSeq: 9,
    });
    expect(lines).toEqual([
      `${child.name}の居場所の手配が要る時間：12/7（月） 8:10–18:15 → 12/7（月） 8:00–18:15`,
    ]);
  });

  it('区間の時刻を直すと、つながっていた隣の区間も一緒に動かす（切れ目を作らない）', async () => {
    const { ctx, looked } = ctxWith({
      preview: { changes: emptyChanges, issues: [], unverified: [], seen: 'x', throughSeq: 9 },
    });
    await step(() => root.render(<HouseholdScreen ctx={ctx} />));
    await step(() => editIn('ふだんの一週間')?.click());
    const times = [...host.querySelectorAll('input[type="time"]')] as HTMLInputElement[];
    // 二つ目の区間の始まり（三つ目の欄）を 07:50 にする。
    const second = times[2];
    if (!second) throw new Error('時刻の欄が無い');
    await step(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(second, '07:50');
      second.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await step(() => button('変わることを見る')?.click());
    const edited = looked[0];
    if (!edited) throw new Error('見る物が送られていない');
    const changed = edited.routines.find((day) =>
      day.segments.some((s, i) => i === 1 && s.start === '07:50'),
    );
    expect(changed?.segments[0]?.end).toBe('07:50');
    for (const day of edited.routines) {
      for (const [i, s] of day.segments.entries()) {
        if (i > 0) expect(s.start).toBe(day.segments[i - 1]?.end);
      }
    }
  });

  it('過ごし方を替えると場所も合わせる：外出は家の場所を外し、家での仕事は家の場所のまま', async () => {
    const pick = async (kind: string) => {
      const { ctx, looked } = ctxWith({
        preview: { changes: emptyChanges, issues: [], unverified: [], seen: 'x', throughSeq: 9 },
      });
      await step(() => root.render(<HouseholdScreen ctx={ctx} />));
      await step(() => editIn('ふだんの一週間')?.click());
      const select = host.querySelector('select');
      if (!select) throw new Error('過ごし方の欄が無い');
      await step(() => {
        select.value = kind;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await step(() => button('変わることを見る')?.click());
      const first = looked[0]?.routines.find((d) =>
        d.segments.some((s, i) => i === 0 && s.kind === kind),
      )?.segments[0];
      await step(() => root.unmount());
      root = createRoot(host);
      return first;
    };
    expect(await pick('away')).toMatchObject({ kind: 'away' });
    expect((await pick('away'))?.placeId).toBeUndefined();
    expect(await pick('work')).toMatchObject({ kind: 'work', placeId: 'home' });
  });

  it('頼んだ相手に確かめが要る依頼を書く', () => {
    const { ctx } = ctxWith(undefined);
    const lines = householdPreviewLines(ctx, {
      changes: {
        ...emptyChanges,
        checks: [{ requestId: 'r1', to: 'g' } as ExternalRequest],
      },
      issues: [],
      unverified: [],
      seen: 'x',
      throughSeq: 9,
    });
    expect(lines).toEqual([
      'おばあちゃんへの頼み事は、頼んだ時と時間や根拠が変わるので、相手に確かめが要ります。',
    ]);
  });

  it('変わることが無ければ、そう言う', async () => {
    const { ctx } = ctxWith({
      preview: { changes: emptyChanges, issues: [], unverified: [], seen: 'x', throughSeq: 9 },
    });
    await step(() => root.render(<HouseholdScreen ctx={ctx} />));
    await step(() => editIn('場所と店')?.click());
    await step(() => button('変わることを見る')?.click());
    expect(host.textContent).toContain('計画は変わりません。');
  });
});
