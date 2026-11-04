// @vitest-environment happy-dom
// 「すること」のやり方を家族が足す・やめる画面：分からない欄は分からないのまま送り（0・決まり無しにしない）、いつまでに・
// 場所・返事までに見込む時間は選ぶまで見せない。見てから、見た物の要約と番号を付けて保存する。やめたやり方は、今の
// 選びに入っている時だけ選ぶ所に出し、新しくは選べない。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Command, Household, type HouseholdPreview, type PreviewCommand } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { NeedScreen } from '../src/need';
import type { Ctx, Route } from '../src/screens';
import { WayScreen, WaysCard } from '../src/ways';
import { step } from './fake-fetch';

const household = Household.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), '../../data/demo/household.json'), 'utf8')),
);
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
  throughSeq: 9,
});

function ctxWith(h: Household = household, plan: Partial<Ctx['plan']> = {}) {
  const sent: Command[] = [];
  const looked: Household[] = [];
  const changed: PreviewCommand[] = [];
  const went: Route[] = [];
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:05+09:00',
    me: h.members[1],
    household: h,
    plan: {
      tasks: [],
      requirements: [],
      arrangements: [],
      requests: [],
      questions: [],
      throughSeq: 9,
      ...plan,
    },
    today: { main: [], quiet: [] },
    items: [],
    sources: new Map(),
    readings: [],
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    previewHousehold: async (edited: Household) => {
      looked.push(edited);
      return { preview: shown('S-1') };
    },
    previewChange: async (command: PreviewCommand) => {
      changed.push(command);
      return { preview: shown('S-2') };
    },
    go: (route: Route) => went.push(route),
  } as unknown as Ctx;
  return { ctx, sent, looked, changed, went };
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
const buttons = (label: string) =>
  [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
/** 見出しの文の付いた欄（label の中の input か select）。 */
const field = <T extends Element>(label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.querySelector('span')?.textContent === label)
    ?.querySelector<T & Element>('input, select') as T | undefined;
/** React の入力に値を入れる（画面の人が打つのと同じ事象を出す）。 */
function enter(element: HTMLInputElement | HTMLSelectElement | undefined, value: string) {
  if (!element) throw new Error('欄が無い');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  const type = element instanceof HTMLSelectElement ? 'change' : 'input';
  element.dispatchEvent(new Event(type, { bubbles: true }));
}

describe('やり方を足す', () => {
  it('分からない代償は分からないのまま、新しく登録する相手と一緒に送り、見てから保存して戻る', async () => {
    const { ctx, looked, sent, went } = ctxWith();
    await step(() => root.render(<WayScreen ctx={ctx} from="arr:need:f-1:i1" />));
    expect(host.textContent).toContain('まだ入っていない欄か、選んでいない欄があります');
    expect(button('この変更で変わることを見る')?.disabled).toBe(true);
    await step(() => enter(field<HTMLInputElement>('やり方の名前'), '近所の山田さんに来てもらう'));
    await step(() => enter(field<HTMLInputElement>('何をする'), '山田さんに来てもらえるか聞く'));
    await step(() => enter(field<HTMLSelectElement>('外の相手に頼むか'), '+new'));
    await step(() =>
      enter(
        host.querySelector<HTMLInputElement>('input[aria-label="相手の名前"]') ?? undefined,
        '山田さん',
      ),
    );
    // いつまでに・場所・返事までに見込む時間を選ぶまでは、見せない（決まり無し・場所なし・0 を置かない）。
    expect(button('この変更で変わることを見る')?.disabled).toBe(true);
    await step(() => enter(field<HTMLSelectElement>('返事までに見込む時間'), '0'));
    await step(() => enter(field<HTMLSelectElement>('決まった場所'), '-'));
    expect(button('この変更で変わることを見る')?.disabled).toBe(true);
    await step(() => enter(field<HTMLSelectElement>('いつまでに'), 'daysBefore'));
    // 新しい相手に頼む文の言葉は、選ぶまで見せない（分からないのを日本語にしない）。呼び方は任意。
    expect(button('この変更で変わることを見る')?.disabled).toBe(true);
    const language = host.querySelector<HTMLSelectElement>(
      'select[aria-label="頼む文の言葉（選んでください）"]',
    );
    await step(() => enter(language ?? undefined, 'en'));
    await step(() =>
      enter(
        host.querySelector<HTMLInputElement>('input[aria-label^="呼び方"]') ?? undefined,
        'Ms. Yamada',
      ),
    );
    await step(() => button('この変更で変わることを見る')?.click());
    expect(looked).toHaveLength(1);
    const draft = looked[0];
    const added = draft?.ways.find((w) => !household.ways.some((x) => x.id === w.id));
    const helper = draft?.members.find((m) => !household.members.some((x) => x.id === m.id));
    expect(helper).toMatchObject({
      kind: 'helper',
      name: '山田さん',
      active: true,
      outboundLanguage: 'en',
      addressAs: 'Ms. Yamada',
    });
    expect(added).toMatchObject({
      name: '近所の山田さんに来てもらう',
      steps: [
        {
          id: 's1',
          name: '山田さんに来てもらえるか聞く',
          external: { to: helper?.id, kind: 'reply' },
          waitAfterMin: 0,
          segments: ['home', 'commute', 'work'],
          deadline: { type: 'daysBefore', days: 1, at: '21:00' },
        },
      ],
      cost: {
        leaveMinutes: 0,
        helperRequests: 0,
        yen: 0,
        extraTasks: 0,
        unknown: ['leaveMinutes', 'helperRequests', 'yen', 'extraTasks'],
      },
    });
    expect(added?.steps[0]?.placeId).toBeUndefined();
    expect(added?.steps[0]?.cover).toBeUndefined();
    expect(added?.id).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/);
    expect(helper?.id).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/);
    expect(host.textContent).toContain('計画は変わりません。');
    await step(() => button('このやり方で保存')?.click());
    expect(sent).toEqual([
      { type: 'updateHousehold', household: draft, seen: { throughSeq: 9, changes: 'S-1' } },
    ]);
    expect(went).toEqual([{ name: 'need', key: 'arr:need:f-1:i1' }]);
  });

  it('見た後に欄を替えたら、見た物は見せず保存もさせない', async () => {
    const { ctx, sent } = ctxWith();
    await step(() => root.render(<WayScreen ctx={ctx} wayId="way-apply-online" />));
    expect(host.textContent).toContain('やり方を直す');
    expect(field<HTMLInputElement>('やり方の名前')?.value).toBe('区のホームページで申し込む');
    await step(() => button('この変更で変わることを見る')?.click());
    expect(button('このやり方で保存')).toBeDefined();
    await step(() => enter(field<HTMLInputElement>('やり方の名前'), '区のサイトで申し込む'));
    expect(button('このやり方で保存')).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe('やり方を直す', () => {
  /** 家の情報の、あるやり方の最初の手順だけを替えた物。 */
  const withStep = (wayId: string, change: Partial<Household['ways'][number]['steps'][number]>) =>
    Household.parse({
      ...household,
      ways: household.ways.map((w) =>
        w.id === wayId
          ? { ...w, steps: w.steps.map((s, i) => (i === 0 ? { ...s, ...change } : s)) }
          : w,
      ),
    });

  it('何も替えずに見ると、画面に出さない欄（相手の無い手順の次まで空ける時間）も元のまま送る', async () => {
    const h = withStep('way-apply-online', { waitAfterMin: 120 });
    const { ctx, looked } = ctxWith(h);
    await step(() => root.render(<WayScreen ctx={ctx} wayId="way-apply-online" />));
    expect(host.textContent).toContain('次の手順まで120分あけます');
    await step(() => button('この変更で変わることを見る')?.click());
    expect(looked[0]?.ways.find((w) => w.id === 'way-apply-online')).toEqual(
      h.ways.find((w) => w.id === 'way-apply-online'),
    );
  });

  it('家族が入れた休みの時間は、そのままの長さで書く（日に換えない・有休と言わない）', async () => {
    const h = Household.parse({
      ...household,
      ways: household.ways.map((w) =>
        w.id === 'way-apply-counter' ? { ...w, cost: { ...w.cost, leaveMinutes: 120 } } : w,
      ),
    });
    const { ctx } = ctxWith(h);
    await step(() => root.render(<WaysCard ctx={ctx} />));
    expect(host.textContent).toContain('休みを2時間取ります');
    expect(host.textContent).not.toContain('有休');
    const en = ctxWith(h).ctx;
    Object.assign(en, { lang: 'en', t: i18n.getFixedT('en') });
    await step(() => root.render(<WaysCard ctx={en} />));
    expect(host.textContent).toContain('Time off: 2 hours');
    expect(host.textContent).not.toContain('Paid leave');
  });

  it('相手を外すと、返事までに見込む時間も外れると見せてから送る', async () => {
    const h = withStep('way-grandma', { waitAfterMin: 1440 });
    const { ctx, looked } = ctxWith(h);
    await step(() => root.render(<WayScreen ctx={ctx} wayId="way-grandma" />));
    expect(field<HTMLSelectElement>('返事までに見込む時間')?.value).toBe('1440');
    await step(() => enter(field<HTMLSelectElement>('外の相手に頼むか'), ''));
    expect(host.textContent).toContain('返事までに見込む時間（1440分）も無くなります');
    await step(() => button('この変更で変わることを見る')?.click());
    const ask = looked[0]?.ways.find((w) => w.id === 'way-grandma')?.steps[0];
    expect(ask?.external).toBeUndefined();
    expect(ask?.waitAfterMin).toBe(0);
  });
});

describe('やり方をやめる', () => {
  it('やめると、選んである「すること」はそのままと見せ、やめた物の一覧を付けて見てから保存する', async () => {
    const { ctx, looked, sent } = ctxWith(household, {
      requirements: [
        {
          key: 'req:need:f-1:i1',
          kind: 'need',
          what: '陽菜を家で見る',
          nature: 'required',
          basis: { itemIds: ['f-1:i1'] },
          live: true,
        },
      ] as unknown as Ctx['plan']['requirements'],
      arrangements: [
        {
          key: 'arr:need:f-1:i1',
          requirementKey: 'req:need:f-1:i1',
          kind: 'need',
          live: true,
          options: [{ key: 'opt:arr:need:f-1:i1:way-grandma', templateId: 'way-grandma' }],
        },
      ] as unknown as Ctx['plan']['arrangements'],
    });
    await step(() => root.render(<WaysCard ctx={ctx} />));
    expect(host.textContent).toContain('祖母に来てもらう');
    expect(host.textContent).toContain('選んである「すること」：1件');
    // 祖母に来てもらう（家の情報の二つ目のやり方）をやめる。
    await step(() => buttons('やめる')[1]?.click());
    expect(host.textContent).toContain(
      '今選んである「すること」の選び・作業・頼み事は、そのままです',
    );
    expect(host.textContent).toContain('「陽菜を家で見る」で選んであります');
    await step(() => button('この変更で変わることを見る')?.click());
    expect(looked[0]?.stoppedWayIds).toEqual(['way-grandma']);
    expect(looked[0]?.ways).toEqual(household.ways);
    await step(() => button('やめて保存')?.click());
    expect(sent).toEqual([
      {
        type: 'updateHousehold',
        household: looked[0],
        seen: { throughSeq: 9, changes: 'S-1' },
      },
    ]);
  });

  it('選ぶ所には、やめたやり方を今の選びに入っている時だけ出し（残せる）、足す所へ行ける', async () => {
    const stopped = { ...household, stoppedWayIds: ['way-sick-care', 'way-grandma'] };
    const { ctx, went } = ctxWith(stopped, {
      requirements: [
        {
          key: 'req:need:f-1:i1',
          kind: 'need',
          what: '陽菜を家で見る',
          nature: 'required',
          basis: { itemIds: ['f-1:i1'] },
          live: true,
        },
      ] as unknown as Ctx['plan']['requirements'],
      arrangements: [
        {
          key: 'arr:need:f-1:i1',
          requirementKey: 'req:need:f-1:i1',
          kind: 'need',
          needShape: 'window',
          start: '2026-11-26T08:00+09:00',
          end: '2026-11-26T18:00+09:00',
          status: 'decidable',
          live: true,
          backupOptionKeys: [],
          reasons: [],
          options: [
            {
              key: 'opt:arr:need:f-1:i1:way-grandma',
              arrangementKey: 'arr:need:f-1:i1',
              templateId: 'way-grandma',
              titleKey: 'option.way',
              decisionDeadline: '2026-11-25T20:55+09:00',
              deadlineCertainty: 'estimate',
              expired: false,
              cost: { leaveMinutes: 0, helperRequests: 1, yen: 0, extraTasks: 0 },
              taskKeys: [],
            },
          ],
        },
      ] as unknown as Ctx['plan']['arrangements'],
    });
    Object.assign(ctx, {
      items: [
        {
          item: {
            id: 'f-1:i1',
            sourceId: 'f-1',
            kind: 'need',
            sentenceIds: [],
            interpretation: { what: '陽菜を家で見る' },
          },
          live: true,
          conditional: false,
          trusted: true,
        },
      ],
      sources: new Map([['f-1', { id: 'f-1', sender: 'family' }]]),
    });
    await step(() => root.render(<NeedScreen ctx={ctx} arrangementKey="arr:need:f-1:i1" />));
    const picker = [...host.querySelectorAll('label')].map((l) => l.textContent ?? '');
    expect(
      picker.some((t) => t.includes('祖母に来てもらう') && t.includes('やめたやり方です')),
    ).toBe(true);
    expect(picker.some((t) => t.includes('病児保育に預ける'))).toBe(false);
    expect(picker.some((t) => t.includes('区のホームページで申し込む'))).toBe(true);
    // やめたやり方の案は、新しくは選べない（お勧めも出さない）。
    expect(host.textContent).toContain('やめたやり方の手があるので、お勧めは出していません');
    await step(() => button('やり方を足す')?.click());
    expect(went).toEqual([{ name: 'way', from: 'arr:need:f-1:i1' }]);
  });
});
