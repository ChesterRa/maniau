// @vitest-environment happy-dom
// 駅の近くで店を探して選ぶ（デモの地図）：開いても何も送らず、Claude の案は押した時だけ品物の名前で聞き、
// 探すのは「探す」を押した時だけ、直した言葉で。選んだ店は「この変更で変わること」を見てから保存し、
// 新しい店は place ID と家族の呼び名だけを足す。家庭にある店も選べ、前に選んだ店からはその品物を外す。
// 地図・Claude の応答は手で作った架空の物。
import type { Household, HouseholdPreview, Task } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FoundStore } from '../src/family';
import i18n from '../src/i18n';
import { type Ctx, TodayScreen } from '../src/screens';
import { step } from './fake-fetch';

const household = {
  id: 'h',
  region: 'JP-13',
  timeZone: 'Asia/Tokyo',
  members: [
    { id: 'a', name: '健太', kind: 'adult', active: true },
    { id: 'b', name: '彩', kind: 'adult', active: true },
  ],
  places: [
    { id: 'home', kind: 'home', name: '家', nearStationId: 'st', goods: [] },
    { id: 'st', kind: 'station', name: '豊洲駅', googlePlaceId: 'g-st', goods: [] },
    {
      id: 'shop',
      kind: 'store',
      name: '豊洲駅の近くの衣料品店',
      nearStationId: 'st',
      googlePlaceId: 'g-shop',
      walkFromStationMin: 5,
      goods: ['kidsClothing'],
    },
    {
      id: 'picked',
      kind: 'store',
      name: '前に選んだ店',
      nearStationId: 'st',
      googlePlaceId: 'g-picked',
      goods: ['白い長袖シャツ'],
    },
  ],
  routines: [],
  careOptions: [],
  ways: [],
  resources: [],
} as unknown as Household;

const buy = {
  key: 'task:opt:arr:purchase:i3:buy:buy',
  titleKey: 'task.buy',
  titleParams: { what: '白い長袖シャツ' },
  basis: { itemIds: ['i3'], requirementKey: 'req:i3', arrangementKey: 'arr:purchase:i3' },
  durationMin: 15,
  after: [],
  segments: ['commute', 'away'],
  placeKind: 'store',
  goods: '白い長袖シャツ',
  assigneeId: 'a',
  start: '2026-11-26T18:59+09:00',
  end: '2026-11-26T19:14+09:00',
  atPlaceId: 'picked',
  travelBeforeMin: 5,
  travelAfterMin: 5,
  travelSource: 'estimate',
  commitment: 'proposed',
  live: true,
} as unknown as Task;

const preview: HouseholdPreview = {
  changes: {
    added: [],
    removed: [],
    moved: [],
    unplaced: [],
    placed: [],
    reassigned: [],
    changed: [],
    relocated: [{ taskKey: buy.key, before: 'picked', after: 'new' }],
    reconfirm: [],
    released: [],
    cancels: [],
    checks: [],
    deadlines: [],
    windows: [],
    conflicts: [],
    rechoose: [],
  },
  issues: [],
  unverified: [],
  seen: 'seen-1',
  throughSeq: 7,
};

const found: FoundStore[] = [
  {
    placeId: 'g-new',
    name: '架空の子供服店',
    address: '架空の住所',
    walkMin: 4,
    attributions: [{ provider: '架空の提供者', providerUri: 'https://example.com/p' }],
  },
  { placeId: 'g-shop', name: '架空の衣料品店', walkMin: 7, known: true },
  { placeId: 'g-picked', name: '架空の前の店', walkMin: 8, known: true },
];

interface Log {
  kinds: string[];
  searches: [string, string][];
  previews: Household[];
  sent: unknown[];
}

function ctxWith(log: Log, maps: 'full' | 'noKinds' | 'none' = 'full'): Ctx {
  return {
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T21:00+09:00',
    me: household.members[0],
    household,
    plan: {
      tasks: [buy],
      requirements: [{ key: 'req:i3', kind: 'belongings', what: '白い長袖シャツ', basis: {} }],
      arrangements: [
        {
          key: 'arr:purchase:i3',
          kind: 'purchase',
          requirementKey: 'req:i3',
          options: [],
          reasons: [],
        },
      ],
      requests: [],
      questions: [],
      throughSeq: 7,
    },
    today: { main: [{ kind: 'proposal', task: buy }], quiet: [] },
    items: [],
    sources: new Map(),
    readings: [],
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: unknown) => {
      log.sent.push(command);
      return { status: 'ok' };
    },
    // 見る：足した店があれば、買い物の行く所がそこへ替わると返す（サーバーの同じ計算の代わり）。
    previewHousehold: async (h: Household) => {
      log.previews.push(h);
      const added = h.places.find((p) => !household.places.some((q) => q.id === p.id));
      return {
        preview: added
          ? {
              ...preview,
              changes: {
                ...preview.changes,
                relocated: [{ taskKey: buy.key, before: 'picked', after: added.id }],
              },
            }
          : preview,
      };
    },
    ...(maps === 'none'
      ? {}
      : {
          maps: {
            walk: async () => undefined,
            search: async (query: string, stationId: string) => {
              log.searches.push([query, stationId]);
              return { status: 'ok' as const, stores: found };
            },
            ...(maps === 'full'
              ? {
                  kinds: async (what: string) => {
                    log.kinds.push(what);
                    return ['子供服', '衣料品店'];
                  },
                }
              : {}),
          },
        }),
    go: () => {},
  } as unknown as Ctx;
}

let root: Root;
let host: HTMLDivElement;
let log: Log;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  log = { kinds: [], searches: [], previews: [], sent: [] };
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const button = (text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === text);
const press = async (text: string, index = 0) => {
  const target = [...host.querySelectorAll('button')].filter((b) => b.textContent === text)[index];
  if (!target) throw new Error(`押す物が無い：${text}`);
  await step(() => target.click());
};
const queryInput = () =>
  [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.startsWith('探す言葉'))
    ?.querySelector('input') as HTMLInputElement;

describe('駅の近くで店を探す', () => {
  it('開いても何も送らない。案は押した時だけ品物の名前で聞き、探すのは押した時だけ', async () => {
    await step(() => root.render(<TodayScreen ctx={ctxWith(log)} />));
    await press('ほかの店を探す');
    expect(log.kinds).toEqual([]);
    expect(log.searches).toEqual([]);
    expect(host.textContent).toContain('豊洲駅の近くの店');
    expect(host.textContent).toContain('送るのは品物の名前（白い長袖シャツ）だけです');
    expect(host.textContent).toContain('探す言葉は、そのまま Google に送ります');
    expect(queryInput().value).toBe('白い長袖シャツ');

    await press('探す言葉の案を Claude に聞く');
    expect(log.kinds).toEqual(['白い長袖シャツ']);
    expect(queryInput().value).toBe('子供服');
    expect(log.searches).toEqual([]);

    await press('衣料品店');
    await press('探す');
    expect(log.searches).toEqual([['衣料品店', 'st']]);
    const text = host.textContent ?? '';
    expect(text).toContain('架空の子供服店');
    expect(text).toContain('駅から歩いて4分');
    expect(text).toContain('うちの店「豊洲駅の近くの衣料品店」です');
    // 前に選んだ店は、もうこの品物を買う店（選び直すボタンを出さない）。
    expect(text).toContain('この品物は、もうこの店で買うことにしています');
    expect([...host.querySelectorAll('[translate="no"]')].map((e) => e.textContent)).toContain(
      'Google Maps',
    );
    // 提供者は、その店の結果のそばにだけ書く（ほかの店には付けない）。
    const items = [...host.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items[0]).toContain('データ提供：架空の提供者');
    expect(items[1]).not.toContain('データ提供');
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent === '架空の提供者');
    expect(link?.getAttribute('href')).toBe('https://example.com/p');
  });

  it('新しい店を選ぶと、place ID と呼び名だけを足し、前に選んだ店から品物を外して、見てから保存する', async () => {
    await step(() => root.render(<TodayScreen ctx={ctxWith(log, 'noKinds')} />));
    await press('ほかの店を探す');
    expect(button('探す言葉の案を Claude に聞く')).toBeUndefined();
    await press('探す');
    await press('この店で買う', 0);
    expect(log.previews).toHaveLength(1);
    const draft = log.previews[0];
    const added = draft?.places.find((p) => p.googlePlaceId === 'g-new');
    expect(added).toMatchObject({
      kind: 'store',
      name: '白い長袖シャツ',
      nearStationId: 'st',
      goods: ['白い長袖シャツ'],
    });
    expect(added?.id).toMatch(/^store-[a-z0-9-]+$/);
    expect(Object.keys(added ?? {}).sort()).toEqual(
      ['goods', 'googlePlaceId', 'id', 'kind', 'lookedUpAt', 'name', 'nearStationId'].sort(),
    );
    expect(draft?.places.find((p) => p.id === 'picked')?.goods).toEqual([]);
    // 保存する前でも、足す店の呼び名を書く（今の家の情報にはまだ無い）。
    expect(host.textContent).toContain('（前に選んだ店 → 白い長袖シャツ）');

    await press('この店で買うと決める');
    expect(log.sent).toEqual([
      { type: 'updateHousehold', household: draft, seen: { throughSeq: 7, changes: 'seen-1' } },
    ]);
  });

  it('家庭にある店を選ぶと、その店の扱う品物に足す（新しい場所は足さない）', async () => {
    await step(() => root.render(<TodayScreen ctx={ctxWith(log, 'noKinds')} />));
    await press('ほかの店を探す');
    await press('探す');
    await press('この店で買う', 1);
    const draft = log.previews[0];
    expect(draft?.places).toHaveLength(household.places.length);
    expect(draft?.places.find((p) => p.id === 'shop')?.goods).toEqual([
      'kidsClothing',
      '白い長袖シャツ',
    ]);
    expect(draft?.places.find((p) => p.id === 'picked')?.goods).toEqual([]);
    expect(host.textContent).toContain(
      'うちの店「豊洲駅の近くの衣料品店」で、白い長袖シャツも買うことにします。',
    );
  });

  it('品物の名前が種類の名前と同じ字なら、この品物のための店は選ばせない（「この店で買う」と言わない）', async () => {
    const ctx = ctxWith(log, 'noKinds');
    const requirement = ctx.plan.requirements[0] as { what: string };
    requirement.what = 'kidsClothing';
    await step(() => root.render(<TodayScreen ctx={ctx} />));
    expect(button('ほかの店を探す')).toBeUndefined();
    expect(host.textContent).toContain(
      '「kidsClothing」は店の扱う品物の種類の名前と同じなので、この品物のための店は、ここでは選べません。',
    );
    expect(log.previews).toEqual([]);
  });

  it('地図の口の無い画面では、店を探す手を出さない', async () => {
    await step(() => root.render(<TodayScreen ctx={ctxWith(log, 'none')} />));
    expect(button('ほかの店を探す')).toBeUndefined();
  });
});
