// @vitest-environment happy-dom
// 周りの資源の所を使う新しいやり方（02-foundation §3.5）：今のやり方を写し、代わりにする資源の場所に頼む手順だけを
// この所にする。前の所の時間・費用・期限・返事までの時間は使わず、選ぶまで保存しない。この所の事前の登録は表で選び
// 直し（まだ分からないのは保存しない）、前提は家族が選ぶ。前のやり方は替えない。候補は架空の物（example.invalid）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Household, type HouseholdPreview } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import type { Ctx } from '../src/screens';
import { WayScreen } from '../src/ways';
import { step } from './fake-fetch';

const demo = Household.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), '../../data/demo/household.json'), 'utf8')),
);
const PLACE = {
  id: 'place-aaaaaaaaaaaa',
  kind: 'other' as const,
  name: 'みなと橋病児保育室（架空）',
  area: '豊洲',
  goods: [],
};
const SOURCE = {
  kind: 'webPage' as const,
  url: 'https://example.invalid/sick-care',
  quote: '利用には、事前の利用登録が必要です。',
  fetchedAt: '2026-11-05T09:58+09:00',
  quoteFound: true,
};
/** 候補を場所に結んで入れ、その登録（陽菜の分・済んだ）も入れた後の家。 */
const household: Household = {
  ...demo,
  places: [...demo.places, PLACE],
  resources: [
    ...demo.resources,
    {
      id: 'res-aaaaaaaaaaaa',
      kind: 'sickChildCare',
      name: PLACE.name,
      area: '豊洲',
      placeId: PLACE.id,
      notes: [{ text: '病気の子を預かる。', source: SOURCE }],
      use: 'candidate',
    },
  ],
  preparations: [
    ...demo.preparations,
    {
      id: 'prep-res-aaaaaaaaaaaa',
      name: `${PLACE.name}の事前の登録`,
      resourceId: 'res-aaaaaaaaaaaa',
      source: SOURCE,
      appliesTo: { kind: 'members', memberIds: ['c'] },
      state: 'done',
    },
  ],
};
const COPY = { wayId: 'way-sick-care', resourceId: 'res-aaaaaaaaaaaa', insteadOf: 'res-sick-care' };
const OLD = household.ways.find((w) => w.id === 'way-sick-care');

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

function ctxWith(h: Household = household) {
  const looked: Household[] = [];
  const ctx = {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:05+09:00',
    me: h.members[1],
    household: h,
    plan: { tasks: [], requirements: [], arrangements: [], requests: [], questions: [] },
    t: i18n.getFixedT('ja'),
    previewHousehold: async (edited: Household) => {
      looked.push(edited);
      const preview: HouseholdPreview = {
        changes: NONE,
        issues: [],
        unverified: [],
        seen: 'S-1',
        throughSeq: 9,
      };
      return { preview };
    },
    go: () => {},
  } as unknown as Ctx;
  return { ctx, looked };
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
/** 見出しの文の付いた欄（label の中の input か select）。 */
const field = <T extends Element>(label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.querySelector('span')?.textContent === label)
    ?.querySelector<T & Element>('input, select') as T | undefined;
const select = (label: string) =>
  host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`) ?? undefined;
function enter(element: HTMLInputElement | HTMLSelectElement | undefined, value: string) {
  if (!element) throw new Error('欄が無い');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  const type = element instanceof HTMLSelectElement ? 'change' : 'input';
  element.dispatchEvent(new Event(type, { bubbles: true }));
}
/** 文の付いた選ぶ箱（選ぶ箱のある label だけから探す。選ぶ欄の選択肢の文には当てない）。 */
const check = (text: string) =>
  [...host.querySelectorAll('label')]
    .filter((l) => l.querySelector('input[type="checkbox"]'))
    .find((l) => l.textContent?.includes(text))
    ?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? undefined;
const look = () => button('この変更で変わることを見る');

/** 前の所の値を使わない欄を、家族が選ぶ（受け持つ時間・返事までの時間・いつまでに）。 */
async function fillFacts() {
  await step(() => enter(select('受け持てる時間（分かっていれば）'), 'part'));
  await step(() =>
    enter(host.querySelector<HTMLInputElement>('input[aria-label="始まり"]') ?? undefined, '09:00'),
  );
  await step(() =>
    enter(host.querySelector<HTMLInputElement>('input[aria-label="終わり"]') ?? undefined, '18:00'),
  );
  await step(() => enter(field<HTMLSelectElement>('返事までに見込む時間'), '180'));
  await step(() => enter(field<HTMLSelectElement>('いつまでに'), 'daysBefore'));
}

describe('周りの資源の所を使う、写したやり方', () => {
  it('この所に頼む手順と、空けた条件と、前提の案で開き、選ぶまで保存しない。前のやり方は替えない', async () => {
    const { ctx, looked } = ctxWith();
    await step(() => root.render(<WayScreen ctx={ctx} copy={COPY} />));
    const text = host.textContent ?? '';
    expect(text).toContain(
      '「病児保育に預ける」を写した新しいやり方です。みなと橋病児保育室（架空） に頼む・行く手順にしてあります。前のやり方は替えません。',
    );
    expect(text).toContain('みなと橋病児保育室（架空） に頼む・行く手順：病児保育を予約する');
    expect(text).toContain(
      '受け持つ時間・費用・期限・返事までの時間は、前の所の値を使わず、空けてあります',
    );
    expect(host.querySelector('a[href="https://example.invalid/sick-care"]')).not.toBeNull();
    expect(field<HTMLInputElement>('やり方の名前')?.value).toBe(
      '病児保育に預ける（みなと橋病児保育室（架空））',
    );
    expect(field<HTMLSelectElement>('外の相手に頼むか')?.value).toBe(PLACE.id);
    // 前の所の値（8:30–17:30・前の日 21:00・2000 円・返事までの時間）は、写さない。
    expect(field<HTMLSelectElement>('返事までに見込む時間')?.value).toBe('');
    expect(field<HTMLSelectElement>('いつまでに')?.value).toBe('');
    expect(select('受け持てる時間（分かっていれば）')?.value).toBe('');
    expect(text).toContain('前の所の時間は使わないので、選んでください');
    // 費用の円は分からない（前の所の 2000 円を使わない）。
    const yen = host.querySelector<HTMLInputElement>('input[aria-label="費用（円）"]');
    expect(yen?.disabled).toBe(true);
    expect(
      yen?.parentElement?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
    ).toBe(true);
    // 前提の案：代わりにする所の登録は外す（一覧で選び直せる）。この所の登録は、登録の欄だけで選ぶ。
    expect(check('病児保育の事前登録')?.checked).toBe(false);
    expect(check('みなと橋病児保育室（架空）の事前の登録')).toBeUndefined();
    expect(field<HTMLSelectElement>('みなと橋病児保育室（架空） の事前の登録')?.value).toBe('');
    expect(text).toContain('まだ入っていない欄か、選んでいない欄があります');
    expect(look()?.disabled).toBe(true);
    await fillFacts();
    // 登録を選ぶまでは、まだ保存しない。
    expect(look()?.disabled).toBe(true);
    await step(() =>
      enter(
        field<HTMLSelectElement>('みなと橋病児保育室（架空） の事前の登録'),
        'prep-res-aaaaaaaaaaaa',
      ),
    );
    expect(look()?.disabled).toBe(false);
    await step(() => look()?.click());
    const next = looked[0];
    const added = next?.ways.find((w) => !household.ways.some((h) => h.id === w.id));
    expect(added).toMatchObject({
      name: '病児保育に預ける（みなと橋病児保育室（架空））',
      steps: [
        {
          id: 'reserve',
          external: { to: PLACE.id, kind: 'reply' },
          waitAfterMin: 180,
          deadline: { type: 'daysBefore', days: 1, at: '21:00' },
          cover: true,
        },
      ],
      covers: { start: '09:00', end: '18:00' },
      cost: { yen: 0, unknown: ['yen'] },
      requires: ['prep-res-aaaaaaaaaaaa'],
      resourceIds: ['res-aaaaaaaaaaaa'],
    });
    expect(next?.ways.find((w) => w.id === 'way-sick-care')).toEqual(OLD);
  });

  it('登録が「まだ分からない」なら保存しない。「要らない」ならこの所の登録を前提に入れない。手順を前の所に戻すと、この所を使うとは書かない', async () => {
    const { ctx, looked } = ctxWith();
    await step(() => root.render(<WayScreen ctx={ctx} copy={COPY} />));
    await fillFacts();
    const registration = () => field<HTMLSelectElement>('みなと橋病児保育室（架空） の事前の登録');
    await step(() => enter(registration(), 'unsure'));
    expect(host.textContent).toContain('登録が要るか分からないうちは、保存しません');
    expect(look()?.disabled).toBe(true);
    await step(() => enter(registration(), 'none'));
    expect(look()?.disabled).toBe(false);
    // 予約を前の所に戻す：この所に頼む手順は無いと出し、使う資源は前の所のまま。
    await step(() => enter(field<HTMLSelectElement>('外の相手に頼むか'), 'sick-care'));
    expect(host.textContent).toContain(
      'まだどの手順も みなと橋病児保育室（架空） に頼んでいません',
    );
    await step(() => look()?.click());
    const added = looked[0]?.ways.find((w) => !household.ways.some((h) => h.id === w.id));
    expect(added?.steps[0]?.external).toEqual({ to: 'sick-care', kind: 'reply' });
    expect(added?.resourceIds).toEqual(['res-sick-care']);
    expect(added).not.toHaveProperty('requires');
  });

  it('この所の登録は登録の欄だけで決まり、ほかの前提は一覧で決まる（要る・要らない・同じ登録で食い違わず、選び直しても前の選びが残らない）', async () => {
    // 元のやり方に、この所と関係の無い前提がもう一つある家。
    const other = {
      id: 'prep-other',
      name: '区の子育て支援の利用者登録（架空）',
      appliesTo: { kind: 'household' as const },
      state: 'done' as const,
    };
    const withOther: Household = {
      ...household,
      preparations: [...household.preparations, other],
      ways: household.ways.map((w) =>
        w.id === 'way-sick-care' ? { ...w, requires: [...(w.requires ?? []), other.id] } : w,
      ),
    };
    const { ctx, looked } = ctxWith(withOther);
    await step(() => root.render(<WayScreen ctx={ctx} copy={COPY} />));
    await fillFacts();
    const registration = () => field<HTMLSelectElement>('みなと橋病児保育室（架空） の事前の登録');
    const added = () => looked.at(-1)?.ways.find((w) => !withOther.ways.some((h) => h.id === w.id));
    // 関係の無い前提は、写した表でも選んである。
    expect(check('区の子育て支援の利用者登録（架空）')?.checked).toBe(true);
    // 要る（この所の登録）：一覧に何を選んでいても、この所の登録が入る。
    await step(() => enter(registration(), 'prep-res-aaaaaaaaaaaa'));
    await step(() => look()?.click());
    expect(added()?.requires).toEqual([other.id, 'prep-res-aaaaaaaaaaaa']);
    // 前の所の登録と同じ登録に選び直す：その前提が入り、この所の登録は残らない。
    await step(() => enter(registration(), 'prep-sick-care'));
    expect(check('病児保育の事前登録')).toBeUndefined();
    await step(() => look()?.click());
    expect(added()?.requires).toEqual([other.id, 'prep-sick-care']);
    // 要らないに選び直す：同じ登録にした前提も残らず、関係の無い前提だけ。外せば無い。
    await step(() => enter(registration(), 'none'));
    expect(check('病児保育の事前登録')?.checked).toBe(false);
    await step(() => look()?.click());
    expect(added()?.requires).toEqual([other.id]);
    await step(() => check('区の子育て支援の利用者登録（架空）')?.click());
    await step(() => look()?.click());
    expect(added()).not.toHaveProperty('requires');
    expect(looked).toHaveLength(4);
  });

  it('開き直すと、登録は表で選び直す（前に選んだ物を持ち越さない）', async () => {
    const { ctx } = ctxWith();
    await step(() => root.render(<WayScreen ctx={ctx} copy={COPY} />));
    await step(() =>
      enter(field<HTMLSelectElement>('みなと橋病児保育室（架空） の事前の登録'), 'none'),
    );
    await step(() => root.unmount());
    root = createRoot(host);
    await step(() => root.render(<WayScreen ctx={ctx} copy={COPY} />));
    expect(field<HTMLSelectElement>('みなと橋病児保育室（架空） の事前の登録')?.value).toBe('');
  });

  it('この所の登録が家に無ければ、そう出す。写す元が無くなっていれば、写さない', async () => {
    const without = { ...household, preparations: demo.preparations };
    const { ctx } = ctxWith(without);
    await step(() => root.render(<WayScreen ctx={ctx} copy={COPY} />));
    expect(host.textContent).toContain(
      'みなと橋病児保育室（架空） の登録は、家の情報にまだありません',
    );
    await step(() => root.unmount());
    root = createRoot(host);
    const gone = ctxWith(demo);
    await step(() => root.render(<WayScreen ctx={gone.ctx} copy={COPY} />));
    expect(host.textContent).toContain('このやり方は、見つかりません。');
  });
});
