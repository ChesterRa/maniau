// @vitest-environment happy-dom
// 子の居場所の足りない事実を聞く画面：名前だけの家族で例のお知らせを足した時の「きょう」の札、その日にだれが子を
// 見られるかと平日の型を入れる画面（見てから記録）、頼める人を足す札。家の情報は、見せる物の家庭から組む。
import {
  type Command,
  Household,
  type HouseholdPreview,
  helperAskOption,
  type Requirement,
  type TodayCard,
} from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactsCard, FactsScreen, HelperAskCard } from '../src/facts';
import i18n from '../src/i18n';
import type { Ctx, Route } from '../src/screens';
import { step } from './fake-fetch';

// 名前だけの家族（空から始めた試用）。例のお知らせの 12/7 の休みで、だれの予定も分からない時の要件（サーバーの
// 試験 own-family が、正式な口で同じ物が出ることを確かめる）。
const household = Household.parse({
  id: 'trial-own',
  region: 'JP',
  timeZone: 'Asia/Tokyo',
  members: [
    { id: 'a1', kind: 'adult', name: '大人A' },
    { id: 'a2', kind: 'adult', name: '大人B' },
    { id: 'c1', kind: 'child', name: '子H' },
  ],
  places: [],
  routines: [],
  careOptions: [],
  confirmDays: true,
});
const requirement: Requirement = {
  key: 'req:childCare:n1:i6:c1',
  kind: 'childCare',
  what: '振替休業日',
  date: '2026-12-07',
  nature: 'required',
  basis: { itemIds: ['n1:i6'], requirementKey: 'req:childCare:n1:i6:c1' },
  live: true,
  missingAdults: ['a1', 'a2'],
  unsure: [{ start: '2026-12-07T00:00+09:00', end: '2026-12-08T00:00+09:00' }],
};
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

interface Probe {
  ctx: Ctx;
  looked: Household[];
  sent: Command[];
  went: Route[];
}
function probe(lang: 'ja' | 'en' = 'ja'): Probe {
  const looked: Household[] = [];
  const sent: Command[] = [];
  const went: Route[] = [];
  const ctx = {
    lang,
    tz: 'Asia/Tokyo',
    now: '2026-11-25T19:40+09:00',
    me: household.members[0],
    household,
    plan: {
      tasks: [],
      requirements: [requirement],
      arrangements: [],
      requests: [],
      questions: [],
      throughSeq: 9,
    },
    today: { main: [], quiet: [] },
    items: [],
    sources: new Map(),
    readings: [],
    t: i18n.getFixedT(lang),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    go: (route: Route) => {
      went.push(route);
    },
    previewHousehold: async (next: Household) => {
      looked.push(next);
      const preview: HouseholdPreview = {
        changes: emptyChanges,
        issues: [],
        unverified: [],
        seen: 'S',
        throughSeq: 7,
      };
      return { preview };
    },
  } as unknown as Ctx;
  return { ctx, looked, sent, went };
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});
const text = () => host.textContent ?? '';
const press = async (label: string) => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  if (!found) throw new Error(`押す物が無い：${label}`);
  if (found.disabled) throw new Error(`押せない：${label}`);
  await step(() => found.click());
};
/** その大人の札の中の、選ぶ欄（ラジオ）を押す。 */
const choose = async (adult: string, label: string) => {
  // 大人ごとの札：選ぶ欄（fieldset）を持ち、名前で始まる物。
  const card = [...host.querySelectorAll('fieldset')]
    .map((f) => f.parentElement)
    .find((d) => d?.textContent?.startsWith(adult));
  const input = [...(card?.querySelectorAll('label') ?? [])]
    .find((l) => l.textContent === label)
    ?.querySelector('input');
  if (!input) throw new Error(`選ぶ欄が無い：${adult}・${label}`);
  await step(() => input.click());
};
const factsCard = (): Extract<TodayCard, { kind: 'facts' }> => ({ kind: 'facts', requirement });

describe('聞く札', () => {
  it('だれの予定も分からない日：日と子、分からない人を出し、手配が要るとも要らないとも言わない', async () => {
    const { ctx, went } = probe();
    await step(() => root.render(<FactsCard ctx={ctx} card={factsCard()} />));
    expect(text()).toContain('子Hを見る人は？');
    expect(text()).toContain('大人A・大人B');
    expect(text()).toContain('手配が要るとも要らないとも決めません');
    await press(i18n.t('card.facts.action'));
    expect(went).toEqual([{ name: 'facts', key: factsCard().requirement.key }]);
  });

  it('英語でも同じ物を出す', async () => {
    const { ctx } = probe('en');
    await step(() => root.render(<FactsCard ctx={ctx} card={factsCard()} />));
    expect(text()).toContain('who can watch 子H?');
    expect(text()).toContain('Enter who can watch');
  });
});

describe('見られるかを入れる画面', () => {
  it('選ぶまで見られず、平日の型（時刻と「前と後は家で見られる」）とその日の答えを、一つの直しにして見てから記録する', async () => {
    await i18n.changeLanguage('ja');
    const { ctx, looked, sent, went } = probe();
    const key = factsCard().requirement.key;
    await step(() => root.render(<FactsScreen ctx={ctx} requirementKey={key} />));
    const look = () =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === i18n.t('facts.look'));
    expect(look()?.disabled).toBe(true);
    // 大人A：平日は出社（8:00–19:00）。その日はふだんどおり。
    await choose('大人A', i18n.t('facts.week.office'));
    expect(text()).toContain('8:00');
    expect(text()).toContain('この時間の前と後は家にいて、子を見られる');
    await choose('大人A', i18n.t('facts.day.usual'));
    // 大人B：平日は分からない。その日は 9–18 時に見られず、ほかは分からない。
    await choose('大人B', i18n.t('facts.week.unknown'));
    await choose('大人B', i18n.t('facts.day.notSome'));
    // 「それ以外の時間は」は、選ばなければ分からないのまま（見られるとは書かない）。
    await press(i18n.t('facts.look'));
    const draft = looked.at(-1);
    expect(draft?.routines.filter((r) => r.memberId === 'a1').map((r) => r.weekday)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(draft?.routines.every((r) => r.allDay === true)).toBe(true);
    expect(draft?.routines[0]?.segments.map((s) => [s.kind, s.start, s.end])).toEqual([
      ['home', '06:00', '08:00'],
      ['work', '08:00', '19:00'],
      ['home', '19:00', '23:00'],
    ]);
    expect(draft?.routines.some((r) => r.memberId === 'a2')).toBe(false);
    expect(draft?.dayAnswers).toEqual([
      {
        memberId: 'a2',
        date: '2026-12-07',
        can: [],
        cannot: [{ start: '09:00', end: '18:00' }],
        rest: 'unknown',
      },
    ]);
    await press(i18n.t('facts.save'));
    expect(sent).toEqual([
      { type: 'updateHousehold', household: draft, seen: { throughSeq: 7, changes: 'S' } },
    ]);
    expect(went).toEqual([{ name: 'today' }]);
  });

  it('「分からない」と答えても、その日の答えとして書く（前の答えやふだんの週に戻さない）', async () => {
    const { ctx, looked } = probe();
    const key = factsCard().requirement.key;
    await step(() => root.render(<FactsScreen ctx={ctx} requirementKey={key} />));
    await choose('大人A', i18n.t('facts.day.unknown'));
    await press(i18n.t('facts.look'));
    expect(looked.at(-1)?.dayAnswers).toEqual([
      { memberId: 'a1', date: '2026-12-07', can: [], cannot: [], rest: 'unknown' },
    ]);
  });
  it('「それ以外の時間は見られる」は、家族が選んだ時だけ書く', async () => {
    const { ctx, looked } = probe();
    const key = factsCard().requirement.key;
    await step(() => root.render(<FactsScreen ctx={ctx} requirementKey={key} />));
    await choose('大人A', i18n.t('facts.day.notSome'));
    const select = host.querySelector('select');
    if (!select) throw new Error('それ以外の欄が無い');
    expect(select.value).toBe('unknown');
    await step(() => {
      select.value = 'can';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await press(i18n.t('facts.look'));
    expect(looked.at(-1)?.dayAnswers?.[0]?.rest).toBe('can');
  });
});

describe('ふだんどおり', () => {
  it('その日だけの一日がある人には「ふだんどおり」を出さない（答えを外すと、その日だけの一日に戻るので）', async () => {
    const week = [1, 2, 3, 4, 5].map((weekday) => ({
      memberId: 'a1',
      weekday,
      segments: [{ start: '06:00', end: '23:00', kind: 'home' as const, viaStationIds: [] }],
      allDay: true as const,
    }));
    const withDay = Household.parse({
      ...household,
      routines: week,
      routineExceptions: [
        {
          memberId: 'a1',
          date: '2026-12-07',
          segments: [{ start: '09:00', end: '18:00', kind: 'work', viaStationIds: [] }],
          allDay: true,
        },
      ],
    });
    const { ctx } = probe();
    const shown = { ...ctx, household: withDay } as Ctx;
    await step(() =>
      root.render(<FactsScreen ctx={shown} requirementKey={factsCard().requirement.key} />),
    );
    const labels = [...host.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels).not.toContain(i18n.t('facts.day.usual'));
    expect(labels).toContain(i18n.t('facts.day.all'));
  });
});

describe('頼める人を足す', () => {
  it('呼び名と頼む締切を選び、決まった形の「その人に頼む」を足す（見てから）', async () => {
    const { ctx, looked, sent } = probe();
    await step(() => root.render(<HelperAskCard ctx={ctx} />));
    const input = host.querySelector('input[type="text"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('呼び名の欄が無い');
    await step(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        ' サトウさん ',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 締切を選ぶまでは、見ることも足すこともできない（初めの値で黙って記録しない）。
    const look = () =>
      [...host.querySelectorAll('button')].find((b) => b.textContent === i18n.t('helperAsk.look'));
    expect(look()?.disabled).toBe(true);
    const select = host.querySelector('select');
    if (!select) throw new Error('締切の欄が無い');
    expect(select.value).toBe('');
    await step(() => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await press(i18n.t('helperAsk.look'));
    const draft = looked.at(-1);
    const helper = draft?.members.find((m) => m.kind === 'helper');
    expect(helper?.name).toBe('サトウさん');
    expect(draft?.careOptions).toEqual([helperAskOption(`opt-${helper?.id}`, helper?.id ?? '', 1)]);
    await press(i18n.t('helperAsk.add', { name: 'サトウさん' }));
    expect(sent).toHaveLength(1);
    expect(text()).toContain('サトウさんを足しました');
  });
});
