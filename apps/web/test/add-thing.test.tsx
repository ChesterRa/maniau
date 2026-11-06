// @vitest-environment happy-dom
// 一言の「すること」を足す画面：何をする・いつまでに（時刻は空でよい）・だれがする（家族の大人だけ）を入れ、見てから
// 足す。自分たちで済ませるやり方が家に無ければ、足すことを「変わること」に添える。断られた理由を出し、詳しい表へ戻れる。
import type { Command, HouseholdPreview, PreviewCommand } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HouseholdPreviewResult } from '../src/family';
import i18n from '../src/i18n';
import { AddThingScreen } from '../src/need';
import type { Ctx, Route } from '../src/screens';
import { step } from './fake-fetch';

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
const SELF = {
  id: 'way-self',
  name: '自分たちで済ませる',
  steps: [{ id: 'do', name: '済ませる', durationMin: 15, segments: ['home', 'work'] }],
  cost: { leaveMinutes: 0, helperRequests: 0, yen: 0, extraTasks: 0 },
};

/** 画面に要る物だけの材料（大人二人・子・頼める人の家。自分たちで済ませるやり方は、hasWay の時だけある）。 */
function materials(
  answer: (command: PreviewCommand) => HouseholdPreviewResult | undefined,
  options: { lang?: 'ja' | 'en'; hasWay?: boolean } = {},
) {
  const lang = options.lang ?? 'ja';
  const looked: PreviewCommand[] = [];
  const sent: Command[] = [];
  const went: Route[] = [];
  const ctx = {
    household: {
      timeZone: 'Asia/Tokyo',
      members: [
        { id: 'a', kind: 'adult', name: '健太', active: true },
        { id: 'b', kind: 'adult', name: '美咲', active: true },
        { id: 'c', kind: 'child', name: '陽菜', active: true },
        { id: 'g', kind: 'helper', name: 'おばあちゃん', active: true },
      ],
      places: [],
      careOptions: [],
      ways: options.hasWay ? [SELF] : [],
    },
    plan: {
      throughSeq: 7,
      requirements: [],
      arrangements: [],
      tasks: [],
      requests: [],
      questions: [],
    },
    items: [],
    sources: new Map(),
    readings: [],
    me: { id: 'a', kind: 'adult', name: '健太', active: true },
    lang,
    tz: 'Asia/Tokyo',
    now: '2026-11-25T20:00+09:00',
    t: i18n.getFixedT(lang),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
    },
    previewChange: async (command: PreviewCommand) => {
      looked.push(command);
      return answer(command);
    },
    go: (route: Route) => {
      went.push(route);
    },
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
/** React の入力に値を入れる（画面の人が打つのと同じ事象を出す）。 */
function enter(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
const fields = () => {
  const what = host.querySelector<HTMLInputElement>('input:not([type])');
  const date = host.querySelector<HTMLInputElement>('input[type=date]');
  const time = host.querySelector<HTMLInputElement>('input[type=time]');
  const radios = [...host.querySelectorAll<HTMLInputElement>('input[type=radio]')];
  if (!what || !date || !time) throw new Error('欄が無い');
  return { what, date, time, radios };
};

describe('一言の「すること」を足す', () => {
  it('何をする・いつまでに・だれがするだけで、見てから足す。やり方が家に無ければ足すと添える', async () => {
    const { ctx, looked, sent, went } = materials(() => ({ preview: shown('T-1') }));
    await step(() => root.render(<AddThingScreen ctx={ctx} />));
    const look = 'この変更で変わることを見る';
    expect(button(look)?.disabled).toBe(true);
    const { what, date, radios } = fields();
    // だれがするは、家族の大人だけ（子と頼める人は出さない）。始めは自分。
    expect(radios.map((r) => r.parentElement?.textContent)).toEqual(['健太', '美咲']);
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    // 日は、始めは今日。
    expect(date.value).toBe('2026-11-25');
    await step(() => enter(what, '学童の書類を出す'));
    await step(() => enter(date, '2026-11-27'));
    await step(() => radios[1]?.click());
    await step(() => button(look)?.click());
    expect(looked).toEqual([
      {
        type: 'addThing',
        text: '学童の書類を出す',
        date: '2026-11-27',
        assigneeId: 'b',
        wayName: '自分たちで済ませる',
        stepName: '済ませる',
      },
    ]);
    expect(host.textContent).toContain(
      'やり方「自分たちで済ませる」を、うちのやり方に足します（「うちのこと」で直せます）。',
    );
    // 置き方の前提（かかる時間と、する所）を、確かめた事ではないと書く。
    expect(host.textContent).toContain(
      'ここで足す事は、家または仕事の時間に 15 分でできる事として（できるかは確かめていません）、締切までに置ける時間を探します。置けない時は、そう示します。',
    );
    await step(() => button('足す')?.click());
    expect(sent).toEqual([{ ...looked[0], seen: { throughSeq: 7, changes: 'T-1' } }]);
    expect(went).toEqual([{ name: 'today' }]);
  });

  it('断られた理由を出して足させない。やり方が家にあれば、足すとは書かない。詳しい表へ行ける', async () => {
    const { ctx, sent, went } = materials(() => ({ refused: 'thingPast' }), { hasWay: true });
    await step(() => root.render(<AddThingScreen ctx={ctx} />));
    const { what, time } = fields();
    await step(() => enter(what, '学童の書類を出す'));
    await step(() => enter(time, '19:00'));
    await step(() => button('この変更で変わることを見る')?.click());
    expect(host.textContent).toContain('その日時は、もう過ぎています。日か時刻を直してください。');
    expect(host.textContent).not.toContain('うちのやり方に足します');
    // 家にあるやり方を使う時は、その手順の時間と区間で書く。
    expect(host.textContent).toContain('家または仕事の時間に 15 分で');
    expect(button('足す')).toBeUndefined();
    expect(sent).toEqual([]);
    const detailed = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('詳しく入れる'),
    );
    await step(() => detailed?.click());
    expect(went).toEqual([{ name: 'stateNeed' }]);
  });

  it('自分たちで済ませるやり方が直されていて使えない時は、そう書き、詳しい表へ案内する', async () => {
    const { ctx } = materials(() => ({ refused: 'selfWayChanged' }), { hasWay: true });
    await step(() => root.render(<AddThingScreen ctx={ctx} />));
    const { what } = fields();
    await step(() => enter(what, '学童の書類を出す'));
    await step(() => button('この変更で変わることを見る')?.click());
    expect(host.textContent).toContain(
      '自分たちで済ませるやり方が直されていて（頼む相手・場所・決まった人などが入っているので）、ここからは足せません。',
    );
    expect(button('足す')).toBeUndefined();
  });

  it('英語の画面では、やり方と手順の名前も英語で送り、時刻を入れればその時刻までにする', async () => {
    const { ctx, looked } = materials(() => ({ preview: shown('T-2') }), { lang: 'en' });
    await step(() => root.render(<AddThingScreen ctx={ctx} />));
    const { what, date, time } = fields();
    await step(() => enter(what, 'Return the storeroom key'));
    await step(() => enter(date, '2026-11-28'));
    await step(() => enter(time, '10:00'));
    await step(() => button('See what this changes')?.click());
    expect(looked).toEqual([
      {
        type: 'addThing',
        text: 'Return the storeroom key',
        date: '2026-11-28',
        byTime: '10:00',
        assigneeId: 'a',
        wayName: 'Do it ourselves',
        stepName: 'Get it done',
      },
    ]);
    expect(host.textContent).toContain(
      'Adds the way “Do it ourselves” to your ways (you can change it in “Our family”).',
    );
    expect(button('Add')).toBeDefined();
    expect(host.textContent).toContain(
      'Things added here are treated as taking 15 minutes during “Home” or “Work” time in your usual week',
    );
  });
});
