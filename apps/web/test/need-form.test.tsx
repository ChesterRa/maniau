// @vitest-environment happy-dom
// 通用の「すること」の操作：やり方を選んで見てから保存する（家庭の並びで送る・見た物の要約を付ける・見た後に選びを
// 替えたら保存させない）。足す表は、欄から命令を作る（日だけの締切はその日の終わり。書かれていない時刻を作らない）。
// 断られた理由を出す。DOM の試験では、デモのファイルを読まず、要る物だけの材料で組む（計算は need-screens.test.tsx）。
import type { Command, HouseholdPreview, PreviewCommand } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HouseholdPreviewResult } from '../src/family';
import i18n from '../src/i18n';
import { NeedScreen, StateNeedScreen } from '../src/need';
import type { Ctx } from '../src/screens';
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
  changes: NONE,
  issues: [],
  unverified: [],
  seen,
  throughSeq: 7,
});
const way = (id: string, name: string) => ({
  id,
  name,
  steps: [
    {
      id: 'ask',
      name: `${name}の手配`,
      durationMin: 5,
      segments: ['home'],
      external: { to: 'g', kind: 'reply' },
      cover: true,
    },
  ],
  cost: { leaveMinutes: 0, helperRequests: 1, yen: 0, extraTasks: 0 },
  cancellable: true,
});

/** 画面に要る物だけの材料（言っただけで、やり方をまだ選んでいない「すること」）。 */
function materials(answer: (command: PreviewCommand) => HouseholdPreviewResult | undefined) {
  const looked: PreviewCommand[] = [];
  const sent: Command[] = [];
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
      ways: [way('way-1', '一つ目'), way('way-2', '二つ目')],
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
        },
      ],
      arrangements: [
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
          sentenceIds: [],
          interpretation: { what: '倉庫の鍵を返す' },
        },
        live: true,
        conditional: false,
        trusted: true,
      },
    ],
    sources: new Map([['f-1', { id: 'f-1', sender: 'family' }]]),
    // 家族の言明には、読み取りが無い。
    readings: [],
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
      return answer(command);
    },
    go: () => {},
  } as unknown as Ctx;
  return { ctx, looked, sent };
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
/** React の入力に値を入れる（画面の人が打つのと同じ事象を出す）。 */
function enter(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  const type = element instanceof HTMLSelectElement ? 'change' : 'input';
  element.dispatchEvent(new Event(type, { bubbles: true }));
}

describe('「すること」の操作', () => {
  it('やり方を選んで見てから保存する：家庭の並びで送り、見た物の要約を付ける。見た後に選びを替えたら保存させない', async () => {
    const { ctx, looked, sent } = materials(() => ({ preview: shown('S-1') }));
    await step(() => root.render(<NeedScreen ctx={ctx} arrangementKey={ARRANGEMENT} />));
    expect(host.textContent).toContain('使うやり方');
    expect(host.textContent).toContain('一つ目の手配（おばあちゃんの返事を待つ）');
    expect(button('この変更で変わることを見る')?.disabled).toBe(true);
    const boxes = () => [...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    await step(() => boxes()[1]?.click());
    await step(() => boxes()[0]?.click());
    await step(() => button('この変更で変わることを見る')?.click());
    expect(looked).toEqual([{ type: 'setNeedWays', itemId: ITEM, wayIds: ['way-1', 'way-2'] }]);
    expect(host.textContent).toContain('計画は変わりません。');
    // 見た後に選びを替えると、見た物は見せず、保存もさせない（替えた中身を、前に見た物で書かない）。
    await step(() => boxes()[1]?.click());
    expect(button('このやり方で保存')).toBeUndefined();
    expect(host.textContent).not.toContain('計画は変わりません。');
    await step(() => boxes()[1]?.click());
    await step(() => button('この変更で変わることを見る')?.click());
    await step(() => button('このやり方で保存')?.click());
    expect(sent).toEqual([
      {
        type: 'setNeedWays',
        itemId: ITEM,
        wayIds: ['way-1', 'way-2'],
        seen: { throughSeq: 7, changes: 'S-1' },
      },
    ]);
  });

  it('することを足す：日だけの締切はその日の終わり（時刻を作らない）。時間の形は始まりと終わりだけを送る。断られた理由を出す', async () => {
    let refuse: string | undefined = 'needDeadlineMissing';
    const { ctx, looked, sent } = materials(() =>
      refuse ? { refused: refuse } : { preview: shown('S-2') },
    );
    await step(() => root.render(<StateNeedScreen ctx={ctx} />));
    expect(button('この変更で変わることを見る')?.disabled).toBe(true);
    const [said] = host.querySelectorAll('textarea');
    const [what, date] = host.querySelectorAll<HTMLInputElement>(
      'input:not([type=radio]):not([type=time])',
    );
    const radios = host.querySelectorAll<HTMLInputElement>('input[type=radio]');
    const forWhom = host.querySelector('select');
    if (!said || !what || !date || !forWhom) throw new Error('欄が無い');
    // だれのためには、家族の大人と子だけ（頼む相手は出さない）。
    expect([...forWhom.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      '選ばない',
      '健太',
      '陽菜',
    ]);
    await step(() => enter(said, '町内会の倉庫の鍵を、28日までに会長さんに返す。'));
    await step(() => enter(what, '倉庫の鍵を返す'));
    await step(() => radios[1]?.click());
    await step(() => enter(date, '2026-11-28'));
    await step(() => button('この変更で変わることを見る')?.click());
    expect(looked.at(-1)).toEqual({
      type: 'stateNeed',
      text: '町内会の倉庫の鍵を、28日までに会長さんに返す。',
      interpretation: {
        what: '倉庫の鍵を返す',
        shape: 'by',
        date: '2026-11-28',
        deadline: '2026-11-28T00:00+09:00',
        deadlineDayOnly: true,
      },
    });
    expect(host.textContent).toContain('締切の日を入れてください。');
    expect(button('この内容で保存')).toBeUndefined();

    // 時間の形：始まりと終わりを入れるまで見られない。送るのは始まりと終わりだけ（締切は送らない）。
    refuse = 'needWindowOvernight';
    await step(() => radios[0]?.click());
    expect(button('この変更で変わることを見る')?.disabled).toBe(true);
    const [from, to] = host.querySelectorAll<HTMLInputElement>('input[type=time]');
    if (!from || !to) throw new Error('時刻の欄が無い');
    await step(() => enter(from, '15:00'));
    await step(() => enter(to, '13:00'));
    await step(() => enter(forWhom, 'c'));
    await step(() => button('この変更で変わることを見る')?.click());
    expect(looked.at(-1)).toEqual({
      type: 'stateNeed',
      text: '町内会の倉庫の鍵を、28日までに会長さんに返す。',
      interpretation: {
        what: '倉庫の鍵を返す',
        shape: 'window',
        date: '2026-11-28',
        startTime: '15:00',
        endTime: '13:00',
        forMemberId: 'c',
      },
    });
    expect(host.textContent).toContain('日をまたぐ時間は、まだ扱えません');

    refuse = undefined;
    await step(() => enter(from, '13:00'));
    await step(() => enter(to, '15:00'));
    await step(() => button('この変更で変わることを見る')?.click());
    await step(() => button('この内容で保存')?.click());
    expect(sent).toEqual([
      expect.objectContaining({
        type: 'stateNeed',
        interpretation: expect.objectContaining({ startTime: '13:00', endTime: '15:00' }),
        seen: { throughSeq: 7, changes: 'S-2' },
      }),
    ]);
  });
});
