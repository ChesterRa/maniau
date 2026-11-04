// @vitest-environment happy-dom
// 計画に入っている「すること」を直す・要らないにする画面：保存の前に「この変更で変わること」を見て、見た物の要約と番号を
// 付けて保存する（見た後に欄や理由を替えたら保存させない）。家族の言明は理由を聞かず、モデルが読んだ物は（送り手が
// 家族でも）理由を選べ、条件の注意を見せる。「だれのため」を選ばないにすると、前の物を外す（null）。まだ確かめて
// いない読み取りは、今のまま一度で確かめる。DOM の試験は、要る物だけの材料で組む。
import type { Command, HouseholdPreview, PreviewCommand } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { NeedFixScreen, NeedScreen } from '../src/need';
import type { Ctx, Route } from '../src/screens';
import { step } from './fake-fetch';

const ITEM = 'f-1:i1';
const ARRANGEMENT = 'arr:need:f-1:i1';
const NONE = {
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
const shown = (seen: string): HouseholdPreview => ({
  changes: { ...NONE, rechoose: [ARRANGEMENT] },
  issues: [],
  unverified: [],
  seen,
  throughSeq: 7,
});

/**
 * 画面に要る物だけの材料。origin は出典：stated は家族の言明（読み取りが無い）、read はお知らせをモデルが読んだ物、
 * familyRead は家族が送ったお知らせをモデルが読んだ物（送り手は家族でも、読み取りがある）。unconfirmed はまだ確かめて
 * いない読み取り。extra は事項の解釈に足す欄（だれのため・条件）。
 */
function materials(
  origin: 'stated' | 'read' | 'familyRead',
  unconfirmed = false,
  extra: { forMemberId?: string; conditionNodeId?: string } = {},
) {
  const sender = origin === 'read' ? 'school' : 'family';
  const looked: PreviewCommand[] = [];
  const sent: Command[] = [];
  const went: Route[] = [];
  const ctx = {
    household: {
      timeZone: 'Asia/Tokyo',
      members: [
        { id: 'a', kind: 'adult', name: '健太', active: true },
        { id: 'c', kind: 'child', name: '陽菜', active: true },
        { id: 'g', kind: 'helper', name: 'おばあちゃん', active: true },
      ],
      places: [],
      careOptions: [],
      ways: [],
    },
    plan: {
      throughSeq: 7,
      requirements: [
        {
          key: 'req:need:f-1:i1',
          kind: 'need',
          what: '倉庫の鍵を返す',
          nature: 'required',
          basis: { itemIds: [ITEM] },
          live: true,
          ...(unconfirmed ? { unconfirmed: true } : {}),
        },
      ],
      arrangements: unconfirmed
        ? []
        : [
            {
              key: ARRANGEMENT,
              requirementKey: 'req:need:f-1:i1',
              kind: 'need',
              needShape: 'window',
              start: '2026-11-28T13:00+09:00',
              end: '2026-11-28T15:00+09:00',
              status: 'undetermined',
              options: [],
              backupOptionKeys: [],
              reasons: [{ code: 'inputMissing', refs: ['ways'] }],
              live: true,
            },
          ],
      tasks: [],
      requests: [],
      questions: [],
    },
    items: [
      {
        item: {
          id: ITEM,
          sourceId: 'f-1',
          kind: 'need',
          sentenceIds: ['f-1#1'],
          written: '28日13時から15時に倉庫の鍵を返す。',
          interpretation: {
            what: '倉庫の鍵を返す',
            shape: 'window',
            date: '2026-11-28',
            startTime: '13:00',
            endTime: '15:00',
            ...(extra.forMemberId ? { forMemberId: extra.forMemberId } : {}),
          },
          ...(extra.conditionNodeId ? { conditionNodeId: extra.conditionNodeId } : {}),
        },
        live: true,
        conditional: false,
        trusted: true,
      },
    ],
    sources: new Map([
      [
        'f-1',
        {
          id: 'f-1',
          sender,
          language: 'ja',
          sentences: [{ id: 'f-1#1', text: '28日13時から15時に倉庫の鍵を返す。' }],
        },
      ],
    ]),
    readings: origin === 'stated' ? [] : [{ sourceId: 'f-1', origin: 'live', model: 'test' }],
    me: { id: 'a', kind: 'adult', name: '健太', active: true },
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:00+09:00',
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    previewChange: async (command: PreviewCommand) => {
      looked.push(command);
      return { preview: shown(`S-${looked.length}`) };
    },
    go: (route: Route) => went.push(route),
  } as unknown as Ctx;
  return { ctx, looked, sent, went };
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

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
/** 見出しの文の付いた欄（label の中の input）。 */
const field = (label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.querySelector('span')?.textContent === label)
    ?.querySelector('input') ?? undefined;
/** React の入力に値を入れる（画面の人が打つのと同じ事象を出す）。 */
function enter(element: HTMLInputElement | undefined, value: string) {
  if (!element) throw new Error('欄が無い');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
/** 見出しの文の付いた選び（label の中の select）。 */
const select = (label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.querySelector('span')?.textContent === label)
    ?.querySelector('select') ?? undefined;
/** React の選びを替える（画面の人が選ぶのと同じ事象を出す）。 */
function pick(element: HTMLSelectElement | undefined, value: string) {
  if (!element) throw new Error('選びが無い');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
const radio = (label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.trim() === label)
    ?.querySelector<HTMLInputElement>('input[type="radio"]');

describe('「すること」の画面から直す・要らないにする', () => {
  it('家族の言明：直すは直す画面へ。要らないは理由を聞かず、変わることを見てから保存し、きょうへ戻る', async () => {
    const { ctx, looked, sent, went } = materials('stated');
    await step(() => root.render(<NeedScreen ctx={ctx} arrangementKey={ARRANGEMENT} />));
    await step(() => button('中身を直す')?.click());
    expect(went).toEqual([{ name: 'needFix', itemId: ITEM }]);
    await step(() => button('要らないにする')?.click());
    expect(host.textContent).toContain('この「すること」を要らないにする');
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    // 見る前は、要らないにできない（見る所だけ）。
    expect(button('要らないにする')).toBeUndefined();
    await step(() => button('この変更で変わることを見る')?.click());
    expect(looked).toEqual([{ type: 'dismissItem', itemId: ITEM, reason: 'other' }]);
    expect(host.textContent).toContain('この変更で変わること');
    await step(() => button('要らないにする')?.click());
    expect(sent).toEqual([
      {
        type: 'dismissItem',
        itemId: ITEM,
        reason: 'other',
        seen: { throughSeq: 7, changes: 'S-1' },
      },
    ]);
    expect(went.at(-1)).toEqual({ name: 'today' });
  });

  it('お知らせから読んだ物：理由を選べ、見た後に理由を替えたら保存させない', async () => {
    const { ctx, looked, sent } = materials('read');
    await step(() => root.render(<NeedScreen ctx={ctx} arrangementKey={ARRANGEMENT} />));
    await step(() => button('要らないにする')?.click());
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    await step(() => radio('読み取りが違っていた')?.click());
    await step(() => button('この変更で変わることを見る')?.click());
    expect(looked).toEqual([{ type: 'dismissItem', itemId: ITEM, reason: 'misread' }]);
    expect(button('要らないにする')).toBeDefined();
    await step(() => radio('もう要らなくなった')?.click());
    expect(button('要らないにする')).toBeUndefined();
    expect(button('この変更で変わることを見る')).toBeDefined();
    expect(sent).toEqual([]);
  });

  it('家族が送ったお知らせでも、モデルが読んだ物は理由を選べる（送り手で言明と決めない）', async () => {
    const { ctx } = materials('familyRead');
    await step(() => root.render(<NeedScreen ctx={ctx} arrangementKey={ARRANGEMENT} />));
    // 主の札も、お知らせに書かれた事として見せる（家族の言明とは言わない）。
    expect(host.textContent).not.toContain('家族が言ったことです');
    await step(() => button('要らないにする')?.click());
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });
});

describe('直す画面', () => {
  it('計画に入っている「すること」：見てから保存し、その「すること」へ戻る。見た後に欄を替えたら保存させない', async () => {
    const { ctx, looked, sent, went } = materials('stated');
    await step(() => root.render(<NeedFixScreen ctx={ctx} itemId={ITEM} />));
    expect(host.textContent).toContain('「すること」を直す');
    await step(() => enter(field('終わり'), '16:00'));
    expect(button('この内容で保存')).toBeUndefined();
    await step(() => button('この変更で変わることを見る')?.click());
    const correct = {
      type: 'correctItem',
      itemId: ITEM,
      interpretation: {
        what: '倉庫の鍵を返す',
        date: '2026-11-28',
        startTime: '13:00',
        endTime: '16:00',
      },
    };
    expect(looked).toEqual([correct]);
    // 見た後に欄を替えたら、見た物では保存させない。
    await step(() => enter(field('終わり'), '17:00'));
    expect(button('この内容で保存')).toBeUndefined();
    await step(() => enter(field('終わり'), '16:00'));
    expect(button('この内容で保存')).toBeDefined();
    await step(() => button('この内容で保存')?.click());
    expect(sent).toEqual([{ ...correct, seen: { throughSeq: 7, changes: 'S-1' } }]);
    expect(went).toEqual([{ name: 'need', key: ARRANGEMENT }]);
  });

  it('「だれのため」を選ばないにすると、前の物を外す直し（null）を見る', async () => {
    const { ctx, looked } = materials('stated', false, { forMemberId: 'c' });
    await step(() => root.render(<NeedFixScreen ctx={ctx} itemId={ITEM} />));
    await step(() => pick(select('だれのため（任意）'), ''));
    await step(() => button('この変更で変わることを見る')?.click());
    expect(looked).toEqual([
      {
        type: 'correctItem',
        itemId: ITEM,
        interpretation: {
          what: '倉庫の鍵を返す',
          forMemberId: null,
          date: '2026-11-28',
          startTime: '13:00',
          endTime: '15:00',
        },
      },
    ]);
  });

  it('家族が送ったお知らせをモデルが読んだ物は、条件の注意を見せる（言明として隠さない）', async () => {
    const { ctx } = materials('familyRead', true, { conditionNodeId: 'n1' });
    await step(() => root.render(<NeedFixScreen ctx={ctx} itemId={ITEM} />));
    expect(host.textContent).toContain('条件と答えは、ここでは直せません');
  });

  it('まだ確かめていない読み取り：今のまま、見せた番号だけで一度に確かめる', async () => {
    const { ctx, looked, sent, went } = materials('read', true);
    await step(() => root.render(<NeedFixScreen ctx={ctx} itemId={ITEM} />));
    expect(host.textContent).toContain('読み取りを直す');
    await step(() => button('この内容で確かめる')?.click());
    expect(looked).toEqual([]);
    expect(sent).toEqual([
      {
        type: 'correctItem',
        itemId: ITEM,
        interpretation: {
          what: '倉庫の鍵を返す',
          date: '2026-11-28',
          startTime: '13:00',
          endTime: '15:00',
        },
        seen: { throughSeq: 7 },
      },
    ]);
    expect(went).toEqual([{ name: 'today' }]);
  });
});
