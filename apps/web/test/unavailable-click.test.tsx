// @vitest-environment happy-dom
// 手が離せない時間を、その日の画面で足す・外す：欄を確かめ（重なる・逆の時間は足させない）、見てから記録する。記録は、
// 見た家の情報と見た計画の番号を付けて送り、その日の場所の区間は変えない。DOM の試験では、デモのファイルを読まず、
// 要る物だけの材料で組む。
import type { Command, Household, HouseholdPreview } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { MemberDayScreen } from '../src/member-day';
import type { Ctx } from '../src/screens';
import { step } from './fake-fetch';

const KENTA = { id: 'u-kenta', memberId: 'a', date: '2026-12-19', start: '09:30', end: '10:30' };
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
const HOUSEHOLD: Household = {
  id: 'h-test',
  region: 'JP',
  timeZone: 'Asia/Tokyo',
  members: [
    { id: 'a', kind: 'adult', name: '健太', active: true },
    { id: 'c', kind: 'child', name: '陽菜', active: true },
  ],
  places: [],
  routines: [],
  routineExceptions: [],
  unavailable: [KENTA],
  careOptions: [],
  ways: [],
  closedDates: [],
  resources: [],
  preparations: [],
} as unknown as Household;

/**
 * hold を渡すと、見る計算の答えを、試験が releases の物を呼ぶまで返さない（見ている途中の操作と、答えの届く順を
 * 試す。頼んだ順に並ぶ）。
 */
function materials(
  household: Household = HOUSEHOLD,
  hold?: { releases: (() => void)[] },
  /** 見るたびに、見た計画の番号と要約を変える（n 回目は 6+n と S-n）。 */
  numbered = false,
) {
  const looked: Household[] = [];
  const sent: Command[] = [];
  const went: unknown[] = [];
  const preview: HouseholdPreview = {
    changes: NONE,
    issues: [],
    unverified: [],
    seen: 'S-1',
    throughSeq: 7,
  };
  const ctx = {
    household,
    plan: {
      throughSeq: 7,
      requirements: [],
      arrangements: [],
      tasks: [],
      requests: [],
      questions: [],
    },
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-12-06T10:00+09:00',
    t: i18n.getFixedT('ja'),
    go: (route: unknown) => {
      went.push(route);
    },
    previewHousehold: async (shown: Household) => {
      looked.push(shown);
      const n = looked.length;
      if (hold) await new Promise<void>((resolve) => hold.releases.push(resolve));
      return { preview: numbered ? { ...preview, seen: `S-${n}`, throughSeq: 6 + n } : preview };
    },
    send: async (command: Command) => {
      sent.push(command);
      return { status: 'ok' };
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
function enter(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}
async function open(ctx: Ctx) {
  await step(() =>
    root.render(
      <MemberDayScreen
        ctx={ctx}
        route={{ name: 'memberDay', memberId: 'a', date: '2026-12-19' }}
      />,
    ),
  );
  const from = host.querySelector<HTMLInputElement>('input[aria-label="始まり"]');
  const to = host.querySelector<HTMLInputElement>('input[aria-label="終わり"]');
  if (!from || !to) throw new Error('時刻の欄が無い');
  return { from, to };
}

describe('手が離せない時間を足す・外す', () => {
  it('重なる・逆の時間は足させず、正しい時間は見てから記録する（場所の区間は変えない）', async () => {
    const { ctx, looked, sent, went } = materials();
    const { from, to } = await open(ctx);
    const add = () => button('この時間を足して見る');
    expect(add()?.disabled).toBe(true);
    await step(() => enter(from, '10:00'));
    await step(() => enter(to, '11:00'));
    expect(host.textContent).toContain('記録してある手が離せない時間と重なっています');
    expect(add()?.disabled).toBe(true);
    await step(() => enter(from, '16:00'));
    await step(() => enter(to, '15:00'));
    expect(host.textContent).toContain('始まりが先になるように');
    expect(add()?.disabled).toBe(true);
    // 前の物の終わりちょうどから始まる時間は、重ならない（半開き）。
    await step(() => enter(from, '10:30'));
    await step(() => enter(to, '11:00'));
    expect(add()?.disabled).toBe(false);
    expect(looked).toHaveLength(0);
    await step(() => add()?.click());
    expect(looked).toHaveLength(1);
    const household = looked[0];
    const added = household?.unavailable?.find((u) => u.id !== 'u-kenta');
    expect(added).toMatchObject({
      memberId: 'a',
      date: '2026-12-19',
      start: '10:30',
      end: '11:00',
    });
    expect(household?.unavailable).toContainEqual(KENTA);
    expect(household?.routineExceptions).toEqual([]);
    expect(host.textContent).toContain('10:30–11:00 を手が離せない時間として足すと：');
    expect(sent).toHaveLength(0);
    await step(() => button('手が離せない時間を記録する')?.click());
    expect(sent).toEqual([
      { type: 'updateHousehold', household, seen: { throughSeq: 7, changes: 'S-1' } },
    ]);
    expect(went).toEqual([{ name: 'today' }]);
  });

  it('外す：その時間だけを除いた家の情報を見てから記録する', async () => {
    const { ctx, looked, sent } = materials();
    await open(ctx);
    await step(() => button('外して見る')?.click());
    expect(looked).toHaveLength(1);
    expect(looked[0]?.unavailable ?? []).toEqual([]);
    expect(host.textContent).toContain('手が離せない時間（09:30–10:30）を外すと：');
    await step(() => button('この時間を外して記録する')?.click());
    expect(sent).toEqual([
      { type: 'updateHousehold', household: looked[0], seen: { throughSeq: 7, changes: 'S-1' } },
    ]);
  });

  it('見た後に時刻を変えたら、前に見た物では記録させない（戻しても、もう一度見る）', async () => {
    const { ctx, looked, sent } = materials();
    const { from, to } = await open(ctx);
    await step(() => enter(from, '10:30'));
    await step(() => enter(to, '11:00'));
    await step(() => button('この時間を足して見る')?.click());
    expect(button('手が離せない時間を記録する')).toBeDefined();
    await step(() => enter(to, '12:00'));
    expect(button('手が離せない時間を記録する')).toBeUndefined();
    expect(host.textContent).not.toContain('10:30–11:00 を手が離せない時間として足すと');
    await step(() => enter(to, '11:00'));
    expect(button('手が離せない時間を記録する')).toBeUndefined();
    await step(() => enter(from, '11:00'));
    await step(() => enter(to, '12:00'));
    await step(() => button('この時間を足して見る')?.click());
    expect(looked).toHaveLength(2);
    expect(looked[1]?.unavailable?.find((u) => u.id !== 'u-kenta')).toMatchObject({
      start: '11:00',
      end: '12:00',
    });
    await step(() => button('手が離せない時間を記録する')?.click());
    expect(sent).toEqual([
      { type: 'updateHousehold', household: looked[1], seen: { throughSeq: 7, changes: 'S-1' } },
    ]);
  });

  it('見ている途中に時刻を変えたら、遅れて届いた見る答えでは記録させない', async () => {
    const hold: { releases: (() => void)[] } = { releases: [] };
    const { ctx, looked, sent } = materials(HOUSEHOLD, hold);
    const { from, to } = await open(ctx);
    await step(() => enter(from, '10:30'));
    await step(() => enter(to, '11:00'));
    await step(() => button('この時間を足して見る')?.click());
    expect(looked).toHaveLength(1);
    await step(() => enter(to, '12:00'));
    await step(() => hold.releases[0]?.());
    expect(button('手が離せない時間を記録する')).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('後から頼んだ見る答えが先に届いても、前の答えで上書きしない（今の物で記録できる）', async () => {
    const hold: { releases: (() => void)[] } = { releases: [] };
    const { ctx, looked, sent } = materials(HOUSEHOLD, hold);
    const { from, to } = await open(ctx);
    await step(() => enter(from, '10:30'));
    await step(() => enter(to, '11:00'));
    await step(() => button('この時間を足して見る')?.click());
    await step(() => enter(from, '11:00'));
    await step(() => enter(to, '12:00'));
    await step(() => button('この時間を足して見る')?.click());
    expect(looked).toHaveLength(2);
    await step(() => hold.releases[1]?.());
    expect(button('手が離せない時間を記録する')?.disabled).toBe(false);
    await step(() => hold.releases[0]?.());
    expect(host.textContent).toContain('11:00–12:00 を手が離せない時間として足すと：');
    expect(host.textContent).not.toContain('計算しています');
    expect(button('手が離せない時間を記録する')?.disabled).toBe(false);
    await step(() => button('手が離せない時間を記録する')?.click());
    expect(sent).toEqual([
      { type: 'updateHousehold', household: looked[1], seen: { throughSeq: 7, changes: 'S-1' } },
    ]);
  });

  it('計画が進んで同じ中身を見直した時も、前の頼みの遅れた答えでは記録しない', async () => {
    const hold: { releases: (() => void)[] } = { releases: [] };
    const { ctx, looked, sent } = materials(HOUSEHOLD, hold, true);
    const { from, to } = await open(ctx);
    await step(() => enter(from, '10:30'));
    await step(() => enter(to, '11:00'));
    await step(() => button('この時間を足して見る')?.click());
    const later = { ...ctx, plan: { ...ctx.plan, throughSeq: 8 } } as Ctx;
    await step(() =>
      root.render(
        <MemberDayScreen
          ctx={later}
          route={{ name: 'memberDay', memberId: 'a', date: '2026-12-19' }}
        />,
      ),
    );
    expect(looked).toHaveLength(2);
    expect(JSON.stringify(looked[1])).toBe(JSON.stringify(looked[0]));
    await step(() => hold.releases[1]?.());
    await step(() => hold.releases[0]?.());
    await step(() => button('手が離せない時間を記録する')?.click());
    expect(sent).toEqual([
      { type: 'updateHousehold', household: looked[1], seen: { throughSeq: 8, changes: 'S-2' } },
    ]);
  });

  it('外して見た後に「この日をふだんに戻す」を押したら、ふだんに戻すことを見て記録する（逆の順も）', async () => {
    const day = {
      memberId: 'a',
      date: '2026-12-19',
      segments: [{ start: '09:00', end: '17:00', kind: 'away', viaStationIds: [] }],
    };
    const withDay = { ...HOUSEHOLD, routineExceptions: [day] } as unknown as Household;
    const first = materials(withDay);
    await open(first.ctx);
    await step(() => button('外して見る')?.click());
    expect(first.looked[0]?.routineExceptions).toEqual([day]);
    await step(() => button('この日をふだんに戻す')?.click());
    expect(first.looked).toHaveLength(2);
    expect(first.looked[1]?.routineExceptions).toEqual([]);
    expect(first.looked[1]?.unavailable).toEqual([KENTA]);
    expect(host.textContent).not.toContain('を外すと：');
    expect(button('この時間を外して記録する')).toBeUndefined();
    await step(() => button('ふだんに戻して記録する')?.click());
    expect(first.sent).toEqual([
      {
        type: 'updateHousehold',
        household: first.looked[1],
        seen: { throughSeq: 7, changes: 'S-1' },
      },
    ]);
    await step(() => root.unmount());
    root = createRoot(host);
    const second = materials(withDay);
    await open(second.ctx);
    await step(() => button('この日をふだんに戻す')?.click());
    await step(() => button('外して見る')?.click());
    const last = second.looked.at(-1);
    expect(last?.routineExceptions).toEqual([day]);
    expect(last?.unavailable ?? []).toEqual([]);
    await step(() => button('この時間を外して記録する')?.click());
    expect(second.sent).toEqual([
      { type: 'updateHousehold', household: last, seen: { throughSeq: 7, changes: 'S-1' } },
    ]);
  });
});
