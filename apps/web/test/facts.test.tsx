// @vitest-environment happy-dom
// 子の居場所の足りない事実を聞く画面：名前だけの家族で例のお知らせを足した時の「きょう」の札、その日にだれが子を
// 見られるかと平日の型を入れる画面（見てから記録）、頼める人を足す札。家の情報は、見せる物の家庭から組む。
import {
  afterSchoolOption,
  type CareOptionTemplate,
  type Command,
  Household,
  type HouseholdPreview,
  helperAskOption,
  leaveOption,
  type Requirement,
  type TodayCard,
} from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CareOptionAddCard, FactsCard, FactsScreen } from '../src/facts';
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
    expect(text()).toContain('大人A、大人Bがこの日に見られるか');
    expect(text()).toContain('手配が要るとも要らないとも決めません');
    await press(i18n.t('card.facts.action'));
    expect(went).toEqual([{ name: 'facts', key: factsCard().requirement.key }]);
  });

  it('なぜその日に見る人が要るかを読み取りの言葉で見出しのように書き、元の文へ戻れる（日英。元の文が手元に無ければ入口を出さない）', async () => {
    const item = {
      id: 'n1:i6',
      sourceId: 'n1',
      sentenceIds: ['n1#9'],
      kind: 'dayChange',
      written: '5日(土)に行った場合、12月7日(月)は振替休業日です。',
    };
    const sources = new Map([['n1', { id: 'n1', title: '学習発表会のお知らせ' }]]);
    for (const lang of ['ja', 'en'] as const) {
      const { ctx, went } = probe(lang);
      const shown = { ...ctx, items: [{ item }], sources } as unknown as Ctx;
      await step(() => root.render(<FactsCard ctx={shown} card={factsCard()} />));
      expect(text()).toContain(lang === 'ja' ? '理由：振替休業日' : 'Why: 振替休業日');
      await press(
        lang === 'ja'
          ? '「学習発表会のお知らせ」の文を見る'
          : 'See the original: 学習発表会のお知らせ',
      );
      expect(went).toEqual([{ name: 'sources', sourceId: 'n1', highlight: ['n1#9'] }]);
    }
    const { ctx } = probe();
    await step(() => root.render(<FactsCard ctx={ctx} card={factsCard()} />));
    expect(text()).toContain('理由：振替休業日');
    // 条件しだいの日を、確かな事として一文で言わない（条件は次の行が書く）。
    expect(text()).not.toContain('12/7（月）は振替休業日');
    expect(text()).not.toContain('の文を見る');
    // 読み取りはあっても、元の文が手元に無ければ入口を出さない（開いても何も無い所へ連れて行かない）。
    const noSource = { ...ctx, items: [{ item }], sources: new Map() } as unknown as Ctx;
    await step(() => root.render(<FactsCard ctx={noSource} card={factsCard()} />));
    expect(text()).not.toContain('元の文を見る');
    expect(text()).not.toContain('の文を見る');
  });

  it('英語でも同じ物を出す', async () => {
    const { ctx } = probe('en');
    await step(() => root.render(<FactsCard ctx={ctx} card={factsCard()} />));
    expect(text()).toContain('who can watch 子H?');
    expect(text()).toContain('Enter who can watch');
    // 文の中の人の並びは英語の並べ方（費用の区切りの「 · 」で並べない）。
    expect(text()).toContain('whether 大人A and 大人B can watch');
    expect(text()).not.toContain('大人A · 大人B');
  });

  it('一部の時間だけ分からない時は、その時間を出す（英語は、時間そのものを見るようには読ませない）', async () => {
    const partial: Extract<TodayCard, { kind: 'facts' }> = {
      kind: 'facts',
      requirement: {
        ...requirement,
        unsure: [
          { start: '2026-12-07T08:00+09:00', end: '2026-12-07T09:00+09:00' },
          { start: '2026-12-07T17:00+09:00', end: '2026-12-07T19:00+09:00' },
        ],
      },
    };
    await step(() => root.render(<FactsCard ctx={probe().ctx} card={partial} />));
    expect(text()).toContain(
      '8:00–9:00、17:00–19:00に見られる人がいるか、まだ分かりません（大人A、大人B）',
    );
    await step(() => root.render(<FactsCard ctx={probe('en').ctx} card={partial} />));
    // 時刻の形（AM・PM の前の空白の種類など）は言葉の決まりの版で変わりうるので、空白をそろえ、二つの時間が順に
    // 「and」でつながって出ることを見る（時間が抜けても通るような見方にしない）。
    const en = text().replace(/\s/gu, ' ');
    expect(en).toMatch(/can watch during 8:00\D*9:00\D* and 5:00\D*7:00\D* \(大人A and 大人B\)/);
    expect(en).not.toContain('can watch on this day');
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
    await step(() => root.render(<CareOptionAddCard ctx={ctx} />));
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
      [...host.querySelectorAll('button')].find((b) => b.textContent === i18n.t('careAdd.look'));
    expect(look()?.disabled).toBe(true);
    const select = host.querySelector('select');
    if (!select) throw new Error('締切の欄が無い');
    expect(select.value).toBe('');
    await step(() => {
      select.value = '1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await press(i18n.t('careAdd.look'));
    const draft = looked.at(-1);
    const helper = draft?.members.find((m) => m.kind === 'helper');
    expect(helper?.name).toBe('サトウさん');
    expect(draft?.careOptions).toEqual([helperAskOption(`opt-${helper?.id}`, helper?.id ?? '', 1)]);
    await press(i18n.t('careAdd.add', { name: 'サトウさん' }));
    expect(sent).toHaveLength(1);
    expect(text()).toContain('「サトウさん」を足しました');
  });

  it('頼む手が全部使えないとした物の人なら、同じ人に新しい手を足す（人は増やさず、手は新しい ID）', async () => {
    const { ctx, looked } = probe();
    const old = helperAskOption('opt-h-old', 'h-old', 1);
    const withUnusable: Ctx = {
      ...ctx,
      household: {
        ...ctx.household,
        members: [
          ...ctx.household.members,
          { id: 'h-old', kind: 'helper', name: 'サトウさん', active: true },
        ],
        careOptions: [old],
        unusableCareOptionIds: [old.id],
      },
    };
    await step(() => root.render(<CareOptionAddCard ctx={withUnusable} />));
    const input = host.querySelector('input[type="text"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('呼び名の欄が無い');
    await step(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'サトウさん',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const select = host.querySelector('select');
    if (!select) throw new Error('締切の欄が無い');
    await step(() => {
      select.value = '3';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await press(i18n.t('careAdd.look'));
    const draft = looked.at(-1);
    expect(draft?.members.filter((m) => m.kind === 'helper').map((m) => m.id)).toEqual(['h-old']);
    const fresh = draft?.careOptions.at(-1);
    expect(fresh?.id).not.toBe(old.id);
    expect(fresh).toEqual(helperAskOption(fresh?.id ?? '', 'h-old', 3));
  });
});

describe('学童と休みの手を足す', () => {
  /** 値を入れて、変わったと知らせる（React の欄）。 */
  const typeInto = async (input: Element | null, value: string) => {
    if (!(input instanceof HTMLInputElement)) throw new Error('欄が無い');
    await step(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const pick = async (select: Element | null | undefined, value: string) => {
    if (!(select instanceof HTMLSelectElement)) throw new Error('選ぶ欄が無い');
    await step(() => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const selects = () => [...host.querySelectorAll('select')];
  const look = () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === i18n.t('careAdd.look'));

  /** 時刻の欄（見出しの言葉で探す）。 */
  const clock = (key: string) => host.querySelector(`input[aria-label="${i18n.t(key)}"]`);
  const radio = (key: string) =>
    [...host.querySelectorAll('label')]
      .find((l) => l.textContent === i18n.t(key))
      ?.querySelector('input[type="radio"]');
  const click = async (input: Element | null | undefined) => {
    if (!(input instanceof HTMLInputElement)) throw new Error('押す欄が無い');
    await step(() => input.click());
  };
  /** 学童の欄のうち、締切と費用以外（見てもらえる時間・登録・お弁当）を入れる。 */
  const restOfGakudo = async (
    bento: 'careAdd.afterSchool.bentoYes' | 'careAdd.afterSchool.bentoNo',
  ) => {
    await typeInto(clock('careAdd.afterSchool.hoursFrom'), '08:00');
    await typeInto(clock('careAdd.afterSchool.hoursTo'), '19:00');
    await click(host.querySelector('input[type="checkbox"]'));
    await click(radio(bento));
  };

  it('学童：名前・締切（前の週の曜日と時刻）・見てもらえる時間・費用・お弁当を入れ、登録を確かめて、決まった形の手を学童の場所と一緒に足す', async () => {
    const { ctx, looked, sent } = probe();
    await step(() => root.render(<CareOptionAddCard ctx={ctx} />));
    await press(i18n.t('careAdd.kind.afterSchool'));
    await typeInto(host.querySelector('input[type="text"]'), ' ひかり学童 ');
    // 締切を選ぶまでは見られない（初めの値で黙って記録しない）。
    expect(look()?.disabled).toBe(true);
    await pick(selects()[0], 'week');
    await pick(selects()[1], '1');
    await typeInto(clock('careAdd.at'), '18:30');
    await typeInto(host.querySelector('input[inputmode="numeric"]'), '1000');
    await typeInto(clock('careAdd.afterSchool.hoursFrom'), '08:00');
    await typeInto(clock('careAdd.afterSchool.hoursTo'), '19:00');
    // 登録を確かめ、お弁当が要るかを選ぶまでは見られない（選ばないのは「要らない」ではない）。
    expect(look()?.disabled).toBe(true);
    await click(host.querySelector('input[type="checkbox"]'));
    expect(look()?.disabled).toBe(true);
    await click(radio('careAdd.afterSchool.bentoYes'));
    expect(look()?.disabled).toBe(false);
    await press(i18n.t('careAdd.look'));
    const draft = looked.at(-1);
    const place = draft?.places.find((p) => p.kind === 'afterSchoolCare');
    expect(place?.name).toBe('ひかり学童');
    expect(draft?.careOptions).toEqual([
      afterSchoolOption(
        `opt-${place?.id}`,
        place?.id ?? '',
        { type: 'weekdayOfPreviousWeek', weekday: 1, at: '18:30' },
        1000,
        true,
        { start: '08:00', end: '19:00' },
      ),
    ]);
    await press(i18n.t('careAdd.add', { name: 'ひかり学童' }));
    expect(sent).toHaveLength(1);
    expect(text()).toContain('「ひかり学童」を足しました');
  });

  it('学童：締切は 1〜30 日前と分までの時刻で入れられ、お弁当が要らないも選べる', async () => {
    const { ctx, looked } = probe();
    await step(() => root.render(<CareOptionAddCard ctx={ctx} />));
    await press(i18n.t('careAdd.kind.afterSchool'));
    await typeInto(host.querySelector('input[type="text"]'), 'ひかり学童');
    await pick(selects()[0], 'days');
    const days = [...(selects()[1]?.querySelectorAll('option') ?? [])]
      .map((o) => o.getAttribute('value'))
      .filter((v) => v !== '');
    expect(days).toEqual(Array.from({ length: 30 }, (_, i) => String(i + 1)));
    await pick(selects()[1], '2');
    await typeInto(clock('careAdd.at'), '18:15');
    await typeInto(host.querySelector('input[inputmode="numeric"]'), '800');
    await restOfGakudo('careAdd.afterSchool.bentoNo');
    await press(i18n.t('careAdd.look'));
    const place = looked.at(-1)?.places.find((p) => p.kind === 'afterSchoolCare');
    expect(looked.at(-1)?.careOptions).toEqual([
      afterSchoolOption(
        `opt-${place?.id}`,
        place?.id ?? '',
        { type: 'daysBefore', days: 2, at: '18:15' },
        800,
        false,
        { start: '08:00', end: '19:00' },
      ),
    ]);
  });

  it('学童：見てもらえる時間の終わりが始まりより前なら、そう書き、見られない', async () => {
    const { ctx } = probe();
    await step(() => root.render(<CareOptionAddCard ctx={ctx} />));
    await press(i18n.t('careAdd.kind.afterSchool'));
    await typeInto(host.querySelector('input[type="text"]'), 'ひかり学童');
    await pick(selects()[0], 'days');
    await pick(selects()[1], '7');
    await typeInto(clock('careAdd.at'), '17:00');
    await typeInto(host.querySelector('input[inputmode="numeric"]'), '0');
    await restOfGakudo('careAdd.afterSchool.bentoNo');
    expect(look()?.disabled).toBe(false);
    await typeInto(clock('careAdd.afterSchool.hoursTo'), '07:30');
    expect(text()).toContain(i18n.t('careAdd.afterSchool.hoursBackwards'));
    expect(look()?.disabled).toBe(true);
  });

  it('学童：費用が数でない・上限を超える間は、見られない', async () => {
    const { ctx } = probe();
    await step(() => root.render(<CareOptionAddCard ctx={ctx} />));
    await press(i18n.t('careAdd.kind.afterSchool'));
    await typeInto(host.querySelector('input[type="text"]'), 'ひかり学童');
    await pick(selects()[0], 'days');
    await pick(selects()[1], '7');
    await typeInto(clock('careAdd.at'), '17:00');
    await restOfGakudo('careAdd.afterSchool.bentoNo');
    for (const yen of ['', 'abc', '-1', '100001']) {
      await typeInto(host.querySelector('input[inputmode="numeric"]'), yen);
      expect(look()?.disabled).toBe(true);
    }
    await typeInto(host.querySelector('input[inputmode="numeric"]'), '0');
    expect(look()?.disabled).toBe(false);
  });

  it('休み：休む人と締切（何営業日前と時刻）を選び、その人の職場の場所と一緒に、決まった形の手を足す', async () => {
    const { ctx, looked, sent } = probe();
    await step(() => root.render(<CareOptionAddCard ctx={ctx} />));
    await press(i18n.t('careAdd.kind.leave'));
    expect(look()?.disabled).toBe(true);
    // 営業日に会社だけの休みが入っていないことを、選ぶ所に書く。
    expect(text()).toContain(i18n.t('careAdd.leave.businessDays'));
    await pick(selects()[0], 'a2');
    const days = [...(selects()[1]?.querySelectorAll('option') ?? [])]
      .map((o) => o.getAttribute('value'))
      .filter((v) => v !== '');
    expect(days).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
    await pick(selects()[1], '3');
    await typeInto(clock('careAdd.at'), '18:00');
    await press(i18n.t('careAdd.look'));
    const draft = looked.at(-1);
    const work = draft?.places.find((p) => p.kind === 'workplace');
    expect(work?.name).toBe('大人Bの職場');
    const option = draft?.careOptions[0];
    expect(draft?.careOptions).toEqual([
      leaveOption(option?.id ?? '', 'a2', work?.id ?? '', 3, '18:00'),
    ]);
    const title = i18n.t('option.paidLeave.title', { name: '大人B' });
    await press(i18n.t('careAdd.add', { name: title }));
    expect(sent).toHaveLength(1);
    expect(text()).toContain(`「${title}」を足しました`);
  });

  it('休み：もう休む手のある大人は選べず、みんなにあれば、そう書く', async () => {
    const { ctx } = probe();
    const withLeave = (ids: string[]): Ctx => ({
      ...ctx,
      household: {
        ...ctx.household,
        careOptions: ids.map((id) =>
          leaveOption(`opt-leave-${id}`, id, `p-work-${id}`, 3, '18:00'),
        ),
      },
    });
    await step(() => root.render(<CareOptionAddCard ctx={withLeave(['a1'])} />));
    await press(i18n.t('careAdd.kind.leave'));
    const who = [...(selects()[0]?.querySelectorAll('option') ?? [])].map((o) => o.textContent);
    expect(who).toContain('大人B');
    expect(who).not.toContain('大人A');
    await step(() => root.render(<CareOptionAddCard ctx={withLeave(['a1', 'a2'])} />));
    expect(text()).toContain(i18n.t('careAdd.leave.none'));
  });

  it('古い休みの手に職場の記録が無くても、無い場所を指さない（手順の頼む先、同じ名前の職場、新しい職場の順）', async () => {
    const { ctx, looked } = probe();
    /** 職場の記録（providerId）の無い、古い形の休みの手。手順の頼む先は to。 */
    const oldLeave = (to: string) => {
      const old = leaveOption('opt-old', 'a1', to, 3, '18:00');
      delete old.providerId;
      return old;
    };
    /** 大人A の休みの手を、締切 3 日前の 18:00 で足して見る。 */
    const addLeave = async (old: CareOptionTemplate, places: Household['places']) => {
      await step(() => root.unmount());
      root = createRoot(host);
      const withOld: Ctx = {
        ...ctx,
        household: {
          ...ctx.household,
          places,
          careOptions: [old],
          unusableCareOptionIds: [old.id],
        },
      };
      await step(() => root.render(<CareOptionAddCard ctx={withOld} />));
      await press(i18n.t('careAdd.kind.leave'));
      await pick(selects()[0], 'a1');
      await pick(selects()[1], '3');
      await typeInto(clock('careAdd.at'), '18:00');
      await press(i18n.t('careAdd.look'));
      const draft = looked.at(-1);
      return { draft, fresh: draft?.careOptions.at(-1) };
    };
    const used = { id: 'p-work', kind: 'workplace', name: '前に使った職場', goods: [] } as const;
    const named = { id: 'p-other', kind: 'workplace', name: '大人Aの職場', goods: [] } as const;
    // 手順の頼む先が今ある職場：名前の違う職場でも、それを使う（同じ名前の別の職場に差し替えない）。
    const explicit = await addLeave(oldLeave('p-work'), [used, named]);
    expect(explicit.fresh?.providerId).toBe('p-work');
    expect(explicit.fresh?.steps[0]?.external?.to).toBe('p-work');
    expect(explicit.draft?.places).toHaveLength(2);
    // 頼む先が今の家の情報に無い：同じ名前の職場を使い、職場を二つにしない。
    const byName = await addLeave(oldLeave('p-gone'), [named]);
    expect(byName.fresh?.providerId).toBe('p-other');
    expect(byName.draft?.places).toHaveLength(1);
    // どれも無い：新しく足し、そこを指す。
    const none = await addLeave(oldLeave('p-gone'), []);
    const added = none.draft?.places.find((p) => p.id === none.fresh?.providerId);
    expect(added).toMatchObject({ kind: 'workplace', name: '大人Aの職場' });
  });

  it('使えないとした手しか無い大人・学童には、新しい手を足せる（前の職場・学童の場所を使い、手は新しい ID）', async () => {
    const { ctx, looked } = probe();
    const old = leaveOption('opt-leave-a1', 'a1', 'p-work-a1', 3, '18:00');
    const gakudo = afterSchoolOption(
      'opt-p-old',
      'p-old',
      { type: 'daysBefore', days: 3, at: '18:30' },
      1000,
      true,
      { start: '08:00', end: '19:00' },
    );
    const withUnusable: Ctx = {
      ...ctx,
      household: {
        ...ctx.household,
        places: [
          ...ctx.household.places,
          { id: 'p-work-a1', kind: 'workplace', name: '大人Aの職場', goods: [] },
          { id: 'p-old', kind: 'afterSchoolCare', name: 'ひかり学童', goods: [] },
        ],
        careOptions: [old, gakudo],
        unusableCareOptionIds: [old.id, gakudo.id],
      },
    };
    // 休み：使えないとした休みの手だけの大人も選べ、前の職場を使う。
    await step(() => root.render(<CareOptionAddCard ctx={withUnusable} />));
    await press(i18n.t('careAdd.kind.leave'));
    const who = [...(selects()[0]?.querySelectorAll('option') ?? [])].map((o) => o.textContent);
    expect(who).toContain('大人A');
    await pick(selects()[0], 'a1');
    await pick(selects()[1], '5');
    await typeInto(clock('careAdd.at'), '18:00');
    await press(i18n.t('careAdd.look'));
    const leave = looked.at(-1);
    expect(leave?.places.filter((p) => p.kind === 'workplace').map((p) => p.id)).toEqual([
      'p-work-a1',
    ]);
    const added = leave?.careOptions.at(-1);
    expect(added?.id).not.toBe(old.id);
    expect(added).toEqual(leaveOption(added?.id ?? '', 'a1', 'p-work-a1', 5, '18:00'));
    // 学童：同じ名前の学童の手が全部使えないとした物なら、その学童の場所に新しい手を足す。
    await step(() => root.unmount());
    root = createRoot(host);
    await step(() => root.render(<CareOptionAddCard ctx={withUnusable} />));
    await press(i18n.t('careAdd.kind.afterSchool'));
    await typeInto(host.querySelector('input[type="text"]'), 'ひかり学童');
    await pick(selects()[0], 'days');
    await pick(selects()[1], '3');
    await typeInto(clock('careAdd.at'), '18:30');
    await typeInto(host.querySelector('input[inputmode="numeric"]'), '1000');
    await restOfGakudo('careAdd.afterSchool.bentoNo');
    await press(i18n.t('careAdd.look'));
    const school = looked.at(-1);
    expect(school?.places.filter((p) => p.kind === 'afterSchoolCare').map((p) => p.id)).toEqual([
      'p-old',
    ]);
    const fresh = school?.careOptions.at(-1);
    expect(fresh?.id).not.toBe(gakudo.id);
    expect(fresh?.providerId).toBe('p-old');
  });
});
