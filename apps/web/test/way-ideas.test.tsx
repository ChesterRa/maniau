// @vitest-environment happy-dom
// 「すること」に Claude がやり方の案を出す（W4）。送り先と本文、断りの読み替え、操作 ID の使い方、押す前に送る物を
// 見せること（サーバーと同じ関数で作る物）、案を表に写す時に分からない欄と外の事実の欄を既定値で埋めないこと、前の
// 中身で出した案を写さないこと。架空のデモの家と、偽物の読み手（Claude の API は呼ばない）。DOM の試験ではファイルを
// 読むデモの組み立てを使えないので、事象を手で組み、サーバーの代わりに同じ確かめ（checkWayIdeas）を通す（デモの家庭の
// 口そのものは、サーバーの試験で確かめる）。
import {
  type CheckedDraft,
  checkWayIdeas,
  DomainEvent,
  Household,
  type HouseholdPreview,
  type Interpretation,
  type WayIdeasContext,
  type WayIdeasOutput,
  wayIdeasContext,
} from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import householdJson from '../../../data/demo/household.json';
import { viewFor } from '../../server/src/views';
import {
  type SessionView,
  useDemoSession,
  useFamilySession,
  type WayIdeasRequest,
  type WayIdeasResult,
} from '../src/family';
import i18n from '../src/i18n';
import { NeedScreen } from '../src/need';
import type { Ctx, Route } from '../src/screens';
import { forgetIdeas, ideaDraft, WayIdeasScreen } from '../src/way-ideas';
import { WayScreen } from '../src/ways';
import { type Call, installFetch, step, take } from './fake-fetch';

let calls: Call[] = [];
let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  calls = installFetch();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  forgetIdeas();
  await i18n.changeLanguage('ja');
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const link = (label: string) =>
  [...host.querySelectorAll('button, a')].find((b) => b.textContent?.trim() === label) as
    | HTMLElement
    | undefined;
/** 見出しの文の付いた欄（label の中の input か select か textarea）。 */
const field = <T extends Element>(label: string) =>
  [...host.querySelectorAll('label')]
    .find((l) => l.querySelector('span')?.textContent === label)
    ?.querySelector<T & Element>('input, select, textarea') as T | undefined;
/** React の入力に値を入れる（画面の人が打つのと同じ事象を出す）。 */
function enter(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null | undefined,
  value: string,
) {
  if (!element) throw new Error('欄が無い');
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
  setter?.call(element, value);
  const type = element instanceof HTMLSelectElement ? 'change' : 'input';
  element.dispatchEvent(new Event(type, { bubbles: true }));
}

// ── 送り先と本文 ──────────────────────────────

const REQUEST: WayIdeasRequest = {
  arrangementKey: 'arr:need:x',
  text: '祖母に頼めるかも。',
  language: 'ja',
  operationId: 'w-1',
};

let demo: ReturnType<typeof useDemoSession> | undefined;
let live: ReturnType<typeof useFamilySession> | undefined;
function DemoProbe() {
  demo = useDemoSession('arrived', 'b');
  return null;
}
function FamilyProbe() {
  live = useFamilySession('b');
  return null;
}

describe('案を頼む送り先と、断りの読み替え', () => {
  const ask = async (fn: () => Promise<WayIdeasResult> | undefined) => {
    let result: WayIdeasResult | undefined;
    await step(() => {
      void fn()?.then((r) => {
        result = r;
      });
    });
    return () => result;
  };
  const isIdeas = (c: Call) => c.url.endsWith('way-ideas');

  it('デモは /api/demo/sessions/:sid/way-ideas へ memberId を添えて送る。手配が無ければ needGone', async () => {
    await step(() => root.render(<DemoProbe />));
    await step(() =>
      take(calls, (c) => c.url === '/api/demo/sessions').respond(200, {
        sessionId: 's1',
        household: { members: [] },
        readings: [],
        stages: [],
      }),
    );
    await step(() =>
      take(calls, (c) => c.url.endsWith('/view?member=b')).respond(200, { throughSeq: 12 }),
    );
    const ok = await ask(() => demo?.wayIdeas(REQUEST));
    const call = take(calls, isIdeas);
    expect(call.url).toBe('/api/demo/sessions/s1/way-ideas');
    expect(call.body).toEqual({ memberId: 'b', ...REQUEST });
    const ideas = { drafts: [], reuse: [], missing: ['だれが出られるか'], notes: [] };
    await step(() => call.respond(200, { ideas, sent: { language: 'ja' } }));
    expect(ok()).toEqual({ status: 'ok', ideas, sent: { language: 'ja' } });
    const gone = await ask(() => demo?.wayIdeas(REQUEST));
    await step(() => take(calls, isIdeas).respond(409, { error: 'needGone' }));
    expect(gone()).toEqual({ status: 'needGone' });
    // 何も書かないので、見せる物は読み直さない。
    expect(calls.filter((c) => c.url.endsWith('/view?member=b'))).toHaveLength(1);
  });

  it('家族の家庭は /api/way-ideas へ as を添えて送る。記録の途中は分からない、前の結果が無いは失われた', async () => {
    await step(() => root.render(<FamilyProbe />));
    await step(() =>
      take(calls, (c) => c.url === '/api/view?as=b').respond(200, {
        throughSeq: 3,
      } as SessionView),
    );
    const cases: [number, Record<string, string>, WayIdeasResult][] = [
      [502, { error: 'readingFailed', reason: 'store' }, { status: 'uncertain' }],
      [409, { error: 'readingUncertain' }, { status: 'lost' }],
      [429, { error: 'readingLimit' }, { status: 'limit' }],
      [429, { error: 'readingBusy' }, { status: 'busy' }],
      [409, { error: 'readingStale' }, { status: 'stale' }],
      [409, { error: 'needGone' }, { status: 'needGone' }],
      [403, { error: 'testHouseholdOnly' }, { status: 'testOnly' }],
      [502, { error: 'readingFailed', reason: 'refusal' }, { status: 'failed', reason: 'refusal' }],
    ];
    for (const [status, body, expected] of cases) {
      const result = await ask(() => live?.wayIdeas(REQUEST));
      const call = take(calls, isIdeas);
      expect(call.url).toBe('/api/way-ideas');
      expect(call.body).toEqual({ as: 'b', ...REQUEST });
      await step(() => call.respond(status, body));
      expect(result()).toEqual(expected);
    }
    const dropped = await ask(() => live?.wayIdeas(REQUEST));
    await step(() => take(calls, isIdeas).drop());
    expect(dropped()).toEqual({ status: 'uncertain' });
  });
});

// ── 案を出す画面（デモの家庭の本物の計画と確かめ。読み手だけ偽物） ──────────────

const OUTPUT: WayIdeasOutput = {
  drafts: [
    {
      name: '祖母に出てもらう',
      why: '祖母が交流会に出る',
      steps: [
        {
          name: '祖母に出てもらえるか聞く',
          quote: '祖母に頼めるかも',
          assignee: { kind: 'adult', id: 'b' },
          counterpart: { kind: 'helper', id: 'g', name: null, quote: null },
          place: { kind: 'none', id: null, name: null, quote: null },
          minutes: 5,
          segments: ['home', 'commute', 'work'],
          cover: true,
        },
      ],
      covers: 'whole',
      cost: { leaveMinutes: null, extraTasks: null },
      unclear: ['祖母が出てよい会か、書かれていません'],
    },
  ],
  reuse: [{ wayId: 'way-grandma', why: '祖母に来てもらう手立てが、もうある' }],
  missing: [],
};

const NEED = '12月12日の13時から14時に地域交流会に出る。';
const household = Household.parse(householdJson);
const AT = '2026-11-25T20:00+09:00';
const NOW = '2026-11-25T21:00+09:00';
const SID = 'f-test';

/** 交流会の「すること」を家族が言った家（計画に入っている）の事象。直しと、家の情報の替えを足せる。 */
function eventsWith(
  corrections: Partial<Interpretation>[] = [],
  edit: (h: Household) => void = () => {},
): DomainEvent[] {
  const edited = structuredClone(household);
  edit(edited);
  let seq = 0;
  const event = (body: Record<string, unknown>) =>
    DomainEvent.parse({
      id: `e-${++seq}`,
      householdId: household.id,
      seq,
      version: 1,
      occurredAt: AT,
      recordedAt: AT,
      actorId: 'b',
      ...body,
    });
  return [
    event({ type: 'householdSet', household: edited }),
    event({
      type: 'noticeReceived',
      source: {
        id: SID,
        version: 1,
        receivedAt: AT,
        sender: 'family',
        language: 'ja',
        medium: 'text',
        sentences: [{ id: `${SID}#1`, text: NEED }],
      },
    }),
    event({
      type: 'itemsStated',
      sourceId: SID,
      items: [
        {
          id: `${SID}:i1`,
          sourceId: SID,
          sentenceIds: [`${SID}#1`],
          kind: 'need',
          written: NEED,
          interpretation: {
            what: '地域交流会に出る',
            shape: 'window',
            date: '2026-12-12',
            startTime: '13:00',
            endTime: '14:00',
          },
          evidence: 'stated',
          effects: [],
        },
      ],
    }),
    ...corrections.map((interpretation) =>
      event({ type: 'itemCorrected', itemId: `${SID}:i1`, interpretation }),
    ),
  ];
}

/** 画面と同じ材料・同じ関数で作る、送る物。 */
const localContext = (ctx: Ctx, key: string, words: string) =>
  wayIdeasContext(
    {
      plan: ctx.plan,
      items: ctx.items.map((l) => l.item),
      household: ctx.household,
      sources: [...ctx.sources.values()],
    },
    key,
    words,
    'ja',
    ctx.me.id,
  );

/** その家の画面の材料。案はサーバーと同じ関数で前提を作り、同じ確かめを通す（偽物の読み手の出力）。 */
function setup(output: WayIdeasOutput = OUTPUT) {
  const reads: WayIdeasContext[] = [];
  const went: Route[] = [];
  const asked: WayIdeasRequest[] = [];
  const ctxOf = (events: DomainEvent[]): Ctx => {
    const view = viewFor(events, 'b', NOW);
    const me = view.household.members.find((m) => m.id === 'b');
    if (!me) throw new Error('大人が無い');
    const ctx: Ctx = {
      plan: view.plan,
      household: view.household,
      today: view.today,
      items: view.items,
      sources: new Map(view.sources.map((s) => [s.id, s])),
      readings: [],
      me,
      lang: 'ja',
      tz: view.household.timeZone,
      now: view.now,
      t: i18n.getFixedT('ja'),
      outbound: (lng) => i18n.getFixedT(lng),
      send: async () => ({ status: 'ok' }),
      go: (route: Route) => went.push(route),
      wayIdeas: async (request) => {
        asked.push(request);
        const sent = localContext(ctx, request.arrangementKey, request.text ?? '');
        if (!sent) return { status: 'needGone' };
        reads.push(sent);
        return { status: 'ok', ideas: checkWayIdeas(output, sent, view.household), sent };
      },
    };
    return ctx;
  };
  const ctx = ctxOf(eventsWith());
  const requirement = ctx.plan.requirements.find((r) => r.kind === 'need' && r.live);
  const arrangement = ctx.plan.arrangements.find((a) => a.requirementKey === requirement?.key);
  if (!arrangement) throw new Error('手配が無い');
  return { ctx, ctxOf, key: arrangement.key, reads, went, asked };
}

describe('案を出す画面', () => {
  it('押す前に送る物を見せ（サーバーと同じ関数で作る物）、案と今のやり方を見せる。何も書かない', async () => {
    const t = setup();
    let sent = 0;
    const ctx: Ctx = {
      ...t.ctx,
      send: async () => {
        sent += 1;
        return { status: 'ok' };
      },
    };
    await step(() => root.render(<WayIdeasScreen ctx={ctx} arrangementKey={t.key} />));
    expect(host.textContent).toContain('地域交流会に出る');
    expect(host.textContent).toContain('Anthropic の Claude API に');
    expect(host.textContent).toContain('値段・相手の返事の早さ・締切の決まり・受け持てる時間は');
    expect(host.textContent).toContain('送る名前：健太・彩・おばあちゃん');
    await step(() => enter(field<HTMLTextAreaElement>('家族の考え（任意）'), '祖母に頼めるかも。'));
    await step(() => button('案を出す（Claude が読みます）')?.click());
    expect(t.asked).toEqual([
      {
        arrangementKey: t.key,
        text: '祖母に頼めるかも。',
        language: 'ja',
        operationId: t.asked[0]?.operationId,
      },
    ]);
    // 送った物（家の情報は名前と ID だけ。ふだんの予定は無い）と、押す前に見せた名前は同じ。
    expect(t.reads).toHaveLength(1);
    expect(JSON.stringify(t.reads[0]?.household)).not.toContain('routine');
    const names = t.reads[0]?.household;
    expect(host.textContent).toContain(
      `送る名前：${[...(names?.adults ?? []), ...(names?.helpers ?? []), ...(names?.places ?? []), ...(names?.ways ?? [])].map((x) => x.name).join('・')}`,
    );
    const text = host.textContent ?? '';
    expect(text).toContain('案1');
    expect(text).toContain('祖母に出てもらう');
    expect(text).toContain('する人：彩');
    expect(text).toContain('頼む相手：おばあちゃん');
    // 引用は家族の考えにあった物なので、元の文に書かれていたようには見せない。
    expect(text).toContain('家族の考えから：「祖母に頼めるかも」');
    expect(text).not.toContain('元の文から');
    expect(text).toContain('祖母が出てよい会か、書かれていません');
    expect(text).toContain('今のやり方で足りるかもしれません');
    expect(text).toContain('祖母に来てもらう');
    expect(button('この案を表に入れる')).toBeDefined();
    expect(sent).toBe(0);
    await step(() => button('この案を表に入れる')?.click());
    expect(t.went).toEqual([{ name: 'way', from: t.key, idea: 0 }]);
    expect(ideaDraft(t.ctx, t.key, 0)?.name).toBe('祖母に出てもらう');
    await step(() => link('「すること」に戻って選ぶ')?.click());
    expect(t.went.at(-1)).toEqual({ name: 'need', key: t.key });
  });

  it('出した後に「すること」を直すと、前の中身の案と示し、表に写さない', async () => {
    const t = setup();
    await step(() => root.render(<WayIdeasScreen ctx={t.ctx} arrangementKey={t.key} />));
    await step(() => button('案を出す（Claude が読みます）')?.click());
    expect(button('この案を表に入れる')).toBeDefined();
    const after = t.ctxOf(eventsWith([{ endTime: '15:00' }]));
    // 手配の key は直しても同じ（事項の根の ID）。前の案は、前の中身の物として出す。
    expect(after.plan.arrangements.some((a) => a.key === t.key && a.live)).toBe(true);
    await step(() => root.render(<WayIdeasScreen ctx={after} arrangementKey={t.key} />));
    expect(host.textContent).toContain('前の「すること」の中身か、前の言葉で出した物です');
    expect(host.textContent).toContain('祖母に出てもらう');
    expect(button('この案を表に入れる')).toBeUndefined();
    expect(ideaDraft(after, t.key, 0)).toBeUndefined();
  });

  it('出した後に直したやり方には、前のわけを付けない（今のやり方の勧めから外す）', async () => {
    const t = setup();
    await step(() => root.render(<WayIdeasScreen ctx={t.ctx} arrangementKey={t.key} />));
    await step(() => button('案を出す（Claude が読みます）')?.click());
    expect(host.textContent).toContain('祖母に来てもらう手立てが、もうある');
    const after = t.ctxOf(
      eventsWith([], (h) => {
        const way = h.ways.find((w) => w.id === 'way-grandma');
        if (way) way.name = '別の窓口に電話する';
      }),
    );
    await step(() => root.render(<WayIdeasScreen ctx={after} arrangementKey={t.key} />));
    expect(host.textContent).not.toContain('祖母に来てもらう手立てが、もうある');
    expect(host.textContent).not.toContain('今のやり方で足りるかもしれません');
    expect(host.textContent).toContain('Claude が出した後に直したやり方は、ここには出しません');
    // 「すること」は同じなので、案は表に写せる。
    expect(button('この案を表に入れる')).toBeDefined();
  });

  it('出したのが今のやり方の勧めだけで、それを後で直した時は、「案を出さなかった」と言わず、使える案が無いと言う', async () => {
    const t = setup({ ...OUTPUT, drafts: [] });
    await step(() => root.render(<WayIdeasScreen ctx={t.ctx} arrangementKey={t.key} />));
    await step(() => button('案を出す（Claude が読みます）')?.click());
    expect(host.textContent).toContain('祖母に来てもらう手立てが、もうある');
    expect(host.textContent).not.toContain('今ここで使える案はありません。');
    const after = t.ctxOf(
      eventsWith([], (h) => {
        const way = h.ways.find((w) => w.id === 'way-grandma');
        if (way) way.name = '別の窓口に電話する';
      }),
    );
    await step(() => root.render(<WayIdeasScreen ctx={after} arrangementKey={t.key} />));
    expect(host.textContent).toContain('Claude が出した後に直したやり方は、ここには出しません');
    expect(host.textContent).toContain('今ここで使える案はありません。');
    expect(host.textContent).not.toContain('Claude は案を出しませんでした。');
    expect(link('自分でやり方を足す')).toBeDefined();
  });

  it('案が無い時は、Claude が足りないと言ったことと、自分で足す道を出す', async () => {
    const t = setup({ drafts: [], reuse: [], missing: ['だれが出られるか'] });
    await step(() => root.render(<WayIdeasScreen ctx={t.ctx} arrangementKey={t.key} />));
    await step(() => button('案を出す（Claude が読みます）')?.click());
    expect(host.textContent).toContain('Claude は案を出しませんでした。');
    expect(host.textContent).toContain('だれが出られるか');
    await step(() => link('自分でやり方を足す')?.click());
    expect(t.went).toEqual([{ name: 'way', from: t.key }]);
  });

  it('操作 ID：分からない・混んでいる・上限は同じ ID で送り直す。古い・失われた・失敗・手配が無い・考えを替えたは新しい ID', async () => {
    const t = setup();
    const script: WayIdeasResult['status'][] = [
      'uncertain',
      'busy',
      'limit',
      'stale',
      'lost',
      'failed',
      'needGone',
    ];
    const ids: string[] = [];
    const ctx: Ctx = {
      ...t.ctx,
      wayIdeas: async (request) => {
        ids.push(request.operationId);
        const status = script[ids.length - 1] ?? 'failed';
        return status === 'ok' ? { status: 'failed' } : ({ status } as WayIdeasResult);
      },
    };
    await step(() => root.render(<WayIdeasScreen ctx={ctx} arrangementKey={t.key} />));
    for (let i = 0; i < script.length; i += 1) {
      await step(() => button('案を出す（Claude が読みます）')?.click());
    }
    const [uncertain, busy, limit, stale, lost, failed, gone] = ids;
    // 分からない・混んでいる・上限の次は同じ ID（前の結果を確かめる）。
    expect(busy).toBe(uncertain);
    expect(limit).toBe(uncertain);
    expect(stale).toBe(uncertain);
    // 古い・失われた・失敗・手配が無いの次は、新しい ID。
    expect(lost).not.toBe(stale);
    expect(failed).not.toBe(lost);
    expect(gone).not.toBe(failed);
    expect(host.textContent).toContain('この「すること」は、もう要らないか、見つかりません。');
    // 考えを替えたら、同じ中身の送り直しではないので新しい ID。
    script.push('uncertain', 'uncertain');
    await step(() => button('案を出す（Claude が読みます）')?.click());
    const kept = ids.at(-1);
    await step(() => enter(field<HTMLTextAreaElement>('家族の考え（任意）'), '夫が休めるかも。'));
    await step(() => button('案を出す（Claude が読みます）')?.click());
    expect(ids.at(-1)).not.toBe(kept);
  });

  it('「すること」の画面の入口は、案を出せる時だけ出す', async () => {
    const t = setup();
    await step(() => root.render(<NeedScreen ctx={t.ctx} arrangementKey={t.key} />));
    await step(() => link('Claude に案を出してもらう')?.click());
    expect(t.went).toEqual([{ name: 'wayIdeas', key: t.key }]);
    const { wayIdeas: _w, ...without } = t.ctx;
    await step(() => root.render(<NeedScreen ctx={without} arrangementKey={t.key} />));
    expect(link('Claude に案を出してもらう')).toBeUndefined();
  });
});

// ── 案を表に写す ──────────────────────────────

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
const shownPreview: HouseholdPreview = {
  changes: NONE,
  issues: [],
  unverified: [],
  seen: 'S-1',
  throughSeq: 9,
};

function formCtx(h: Household = household) {
  const looked: Household[] = [];
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
    },
    today: { main: [], quiet: [] },
    items: [],
    sources: new Map(),
    readings: [],
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async () => ({ status: 'ok' }),
    previewHousehold: async (edited: Household) => {
      looked.push(edited);
      return { preview: shownPreview };
    },
    go: () => {},
  } as unknown as Ctx;
  return { ctx, looked };
}

const IDEA: CheckedDraft = {
  name: '祖母に出てもらう',
  why: '祖母が交流会に出る',
  steps: [
    {
      name: '祖母に出てもらえるか聞く',
      quote: '祖母に頼めるかも',
      quoteFrom: 'words',
      assignee: { kind: 'unknown' },
      counterpart: { kind: 'helper', id: 'g' },
      place: { kind: 'none' },
      minutes: 5,
      segments: ['home', 'commute', 'work'],
      cover: null,
    },
  ],
  covers: 'unknown',
  cost: { leaveMinutes: 90, helperRequests: 1, extraTasks: null },
  unclear: ['祖母が出てよい会か、書かれていません'],
  notes: [{ code: 'nameNotInText', value: 'みらい橋ファミリーサポート' }],
};
const LOOK = 'この変更で変わることを見る';

describe('Claude の案を表に写す', () => {
  it('分からない欄と外の事実の欄は、家族が選ぶまで見せない（既定値で埋めない）。選んだ値で見せる', async () => {
    const { ctx, looked } = formCtx();
    await step(() => root.render(<WayScreen ctx={ctx} from="arr:need:x" idea={IDEA} />));
    const text = host.textContent ?? '';
    expect(text).toContain('Claude の案（推定）');
    expect(text).toContain('いつまでに・返事までに見込む時間・費用・受け持てる時間は');
    expect(text).toContain('祖母が出てよい会か、書かれていません');
    expect(text).toContain(
      '元の文と考えに無い名前（みらい橋ファミリーサポート）。新しく登録しません',
    );
    expect(text).toContain('家族の考えから：「祖母に頼めるかも」');
    expect(field<HTMLInputElement>('やり方の名前')?.value).toBe('祖母に出てもらう');
    expect(field<HTMLSelectElement>('だれがする')?.value).toBe('?');
    expect(field<HTMLSelectElement>('外の相手に頼むか')?.value).toBe('g');
    expect(field<HTMLSelectElement>('返事までに見込む時間')?.value).toBe('');
    expect(field<HTMLSelectElement>('いつまでに')?.value).toBe('');
    expect(field<HTMLInputElement>('かかる時間（分）')?.value).toBe('5');
    expect(field<HTMLSelectElement>(ctx.t('way.cover'))?.value).toBe('');
    const covers = host.querySelector<HTMLSelectElement>(
      `select[aria-label="${ctx.t('way.covers')}"]`,
    );
    expect(covers?.value).toBe('');
    const cost = (label: string) =>
      host.querySelector<HTMLInputElement>(`input[type="number"][aria-label="${label}"]`);
    expect(cost('休み（時間）')?.value).toBe('1.5');
    expect(cost('人に頼む回数')?.value).toBe('1');
    expect(cost('費用（円）')?.disabled).toBe(true);
    expect(cost('増える作業（数）')?.disabled).toBe(true);
    // 一つずつ選ぶ。全部を選ぶまで見せない。
    const choices: [() => Element | null | undefined, string][] = [
      [() => field<HTMLSelectElement>('だれがする'), 'b'],
      [() => field<HTMLSelectElement>('返事までに見込む時間'), '1440'],
      [() => field<HTMLSelectElement>('いつまでに'), 'none'],
      [() => field<HTMLSelectElement>(ctx.t('way.cover')), 'yes'],
    ];
    for (const [get, value] of choices) {
      expect(button(LOOK)?.disabled).toBe(true);
      await step(() => enter(get() as HTMLSelectElement, value));
    }
    expect(button(LOOK)?.disabled).toBe(true);
    // 一部の時間を選んだら、時刻を入れるまで見せない。
    await step(() =>
      enter(host.querySelector(`select[aria-label="${ctx.t('way.covers')}"]`), 'part'),
    );
    expect(button(LOOK)?.disabled).toBe(true);
    await step(() =>
      enter(host.querySelector(`select[aria-label="${ctx.t('way.covers')}"]`), 'whole'),
    );
    expect(button(LOOK)?.disabled).toBe(false);
    await step(() => button(LOOK)?.click());
    const added = looked[0]?.ways.find((w) => !household.ways.some((x) => x.id === w.id));
    expect(added).toMatchObject({
      name: '祖母に出てもらう',
      steps: [
        {
          id: 's1',
          name: '祖母に出てもらえるか聞く',
          assigneeId: 'b',
          external: { to: 'g', kind: 'reply' },
          waitAfterMin: 1440,
          durationMin: 5,
          segments: ['home', 'commute', 'work'],
          cover: true,
        },
      ],
      cost: {
        leaveMinutes: 90,
        helperRequests: 1,
        yen: 0,
        extraTasks: 0,
        unknown: ['yen', 'extraTasks'],
      },
    });
    // 全部を選んだので受け持てる時間は持たない（相手の「はい」で確かめる）。決まり無しなので締切も無い。
    expect(added?.covers).toBeUndefined();
    expect(added?.steps[0]?.deadline).toBeUndefined();
    expect(added?.steps[0]?.placeId).toBeUndefined();
    expect(looked[0]?.members).toEqual(household.members);
  });

  it('一部の時間を選べば、入れた時刻を受け持てる時間にする', async () => {
    const { ctx, looked } = formCtx();
    const idea: CheckedDraft = {
      ...IDEA,
      steps: [{ ...(IDEA.steps[0] as CheckedDraft['steps'][number]), cover: true }],
    };
    await step(() => root.render(<WayScreen ctx={ctx} from="arr:need:x" idea={idea} />));
    await step(() => enter(field<HTMLSelectElement>('だれがする'), ''));
    await step(() => enter(field<HTMLSelectElement>('返事までに見込む時間'), '60'));
    await step(() => enter(field<HTMLSelectElement>('いつまでに'), 'onTheDay'));
    await step(() =>
      enter(host.querySelector(`select[aria-label="${ctx.t('way.covers')}"]`), 'part'),
    );
    await step(() =>
      enter(host.querySelector<HTMLInputElement>('input[aria-label="始まり"]'), '13:00'),
    );
    expect(button(LOOK)?.disabled).toBe(true);
    await step(() =>
      enter(host.querySelector<HTMLInputElement>('input[aria-label="終わり"]'), '13:30'),
    );
    await step(() => button(LOOK)?.click());
    const added = looked[0]?.ways.find((w) => !household.ways.some((x) => x.id === w.id));
    expect(added?.covers).toEqual({ start: '13:00', end: '13:30' });
    expect(added?.steps[0]?.assigneeId).toBeUndefined();
    expect(added?.steps[0]?.deadline).toEqual({ type: 'onTheDay', at: '21:00' });
  });

  it('人に頼む回数は、家族が直すまで手順の相手から数え直す（前の手順の数を残さない）', async () => {
    const { ctx, looked } = formCtx();
    const idea: CheckedDraft = {
      ...IDEA,
      steps: [
        {
          ...(IDEA.steps[0] as CheckedDraft['steps'][number]),
          assignee: { kind: 'adult', id: 'b' },
          counterpart: { kind: 'none' },
          cover: true,
        },
      ],
      covers: 'whole',
      cost: { leaveMinutes: null, helperRequests: 0, extraTasks: null },
    };
    await step(() => root.render(<WayScreen ctx={ctx} from="arr:need:x" idea={idea} />));
    const helpers = () =>
      host.querySelector<HTMLInputElement>('input[type="number"][aria-label="人に頼む回数"]');
    expect(helpers()?.value).toBe('0');
    expect(host.textContent).toContain('人に頼む回数は、手順の相手から数えています');
    await step(() => enter(field<HTMLSelectElement>('外の相手に頼むか'), 'g'));
    expect(helpers()?.value).toBe('1');
    await step(() => enter(field<HTMLSelectElement>('返事までに見込む時間'), '60'));
    await step(() => enter(field<HTMLSelectElement>('いつまでに'), 'none'));
    await step(() => button(LOOK)?.click());
    const added = looked[0]?.ways.find((w) => !household.ways.some((x) => x.id === w.id));
    expect(added?.cost.helperRequests).toBe(1);
    // 家族が数を直したら、それからは数え直さない。
    await step(() => enter(helpers(), '2'));
    await step(() => enter(field<HTMLSelectElement>('外の相手に頼むか'), ''));
    expect(helpers()?.value).toBe('2');
    expect(host.textContent).not.toContain('人に頼む回数は、手順の相手から数えています');
  });

  it('前からある同じ名前の人は、新しくは選べない（選んでも見せない）', async () => {
    const twins = Household.parse({
      ...householdJson,
      members: [
        ...household.members,
        { id: 'yamada', kind: 'helper', name: '山田さん', active: true },
        { id: 'yamada2', kind: 'helper', name: '山田さん', active: true },
      ],
    });
    const { ctx } = formCtx(twins);
    const idea: CheckedDraft = {
      ...IDEA,
      steps: [
        {
          ...(IDEA.steps[0] as CheckedDraft['steps'][number]),
          assignee: { kind: 'adult', id: 'b' },
          counterpart: { kind: 'unknown' },
          cover: true,
        },
      ],
      covers: 'whole',
    };
    await step(() => root.render(<WayScreen ctx={ctx} from="arr:need:x" idea={idea} />));
    const to = field<HTMLSelectElement>('外の相手に頼むか');
    const options = [...(to?.options ?? [])].filter((o) => o.value.startsWith('yamada'));
    expect(options.map((o) => [o.disabled, o.textContent])).toEqual([
      [true, '山田さん（同じ名前がほかにもあるので、新しくは選べません）'],
      [true, '山田さん（同じ名前がほかにもあるので、新しくは選べません）'],
    ]);
    await step(() => enter(to, 'yamada2'));
    await step(() => enter(field<HTMLSelectElement>('返事までに見込む時間'), '60'));
    await step(() => enter(field<HTMLSelectElement>('いつまでに'), 'none'));
    expect(button(LOOK)?.disabled).toBe(true);
    await step(() => enter(to, 'g'));
    expect(button(LOOK)?.disabled).toBe(false);
  });

  it('受け持つ手順が無ければ受け持つ時間は聞かない。相手が分からない手順は、相手を選ぶまで見せない', async () => {
    const { ctx, looked } = formCtx();
    const idea: CheckedDraft = {
      ...IDEA,
      steps: [
        {
          name: '区のホームページで申し込む',
          quote: null,
          quoteFrom: null,
          assignee: { kind: 'anyAdult' },
          counterpart: { kind: 'unknown' },
          place: { kind: 'unknown' },
          minutes: null,
          segments: null,
          cover: false,
        },
      ],
      cost: { leaveMinutes: null, helperRequests: null, extraTasks: 0 },
      unclear: [],
      notes: [],
    };
    await step(() => root.render(<WayScreen ctx={ctx} from="arr:need:x" idea={idea} />));
    expect(host.textContent).toContain('Claude の提案（元の文にも家族の考えにも書かれていません）');
    expect(host.querySelector(`select[aria-label="${ctx.t('way.covers')}"]`)).toBeNull();
    expect(field<HTMLSelectElement>('だれがする')?.value).toBe('');
    expect(field<HTMLSelectElement>('外の相手に頼むか')?.value).toBe('?');
    expect(field<HTMLSelectElement>('決まった場所')?.value).toBe('');
    expect(field<HTMLInputElement>('かかる時間（分）')?.value).toBe('');
    await step(() => enter(field<HTMLSelectElement>('外の相手に頼むか'), ''));
    await step(() => enter(field<HTMLSelectElement>('決まった場所'), '-'));
    await step(() => enter(field<HTMLSelectElement>('いつまでに'), 'none'));
    await step(() => enter(field<HTMLInputElement>('かかる時間（分）'), '15'));
    // できる時は、選ぶまで見せない（ふだんの一日の既定を置かない）。
    expect(button(LOOK)?.disabled).toBe(true);
    const home = [...host.querySelectorAll('label')].find((l) => l.textContent === '家');
    await step(() => home?.querySelector('input')?.click());
    expect(button(LOOK)?.disabled).toBe(false);
    await step(() => button(LOOK)?.click());
    const added = looked[0]?.ways.find((w) => !household.ways.some((x) => x.id === w.id));
    expect(added?.steps[0]).toMatchObject({ segments: ['home'], durationMin: 15 });
    expect(added?.steps[0]?.external).toBeUndefined();
    // 相手を「頼まない」に決めたので、頼む数は手順から 0 と数える（分からないままにしない）。
    expect(added?.cost).toMatchObject({
      helperRequests: 0,
      extraTasks: 0,
      unknown: ['leaveMinutes', 'yen'],
    });
  });
});
