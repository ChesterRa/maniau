// @vitest-environment happy-dom
// お知らせの文を入れる：貼るか、キーボードのマイクで話した文を、出どころと一緒に読みに出す。読めたら
// 「きょう」に戻る。読めない・数を使い切った時は、その旨を出す。読み取りの使えない画面には出さない。
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NoticeInput, ReadResult } from '../src/family';
import i18n from '../src/i18n';
import { type Ctx, type Route, SourcesScreen } from '../src/screens';
import { step } from './fake-fetch';

/** お知らせの画面に要る物だけの画面の材料（DOM の試験では、デモのファイルを読まない）。 */
function baseCtx(): Ctx {
  return {
    sources: new Map(),
    readings: [],
    plan: { requirements: [], tasks: [], arrangements: [], questions: [] },
    today: { main: [], quiet: [] },
    items: [],
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-11-25T19:31+09:00',
    t: i18n.getFixedT('ja'),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async () => ({ status: 'ok' }),
    go: () => {},
  } as unknown as Ctx;
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

/** React の入力欄に、打った（話した）ように文を入れる。 */
function type(element: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(element) as object;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  );
}

const OK: ReadResult = { status: 'ok', sourceId: 'u1', check: { sentenceIds: [], all: false } };

function setup(answer: ReadResult) {
  const reads: NoticeInput[] = [];
  const routes: Route[] = [];
  const ctx: Ctx = {
    ...baseCtx(),
    read: async (input: NoticeInput) => {
      reads.push(input);
      return answer;
    },
    go: (route: Route) => {
      routes.push(route);
    },
  };
  return { ctx, reads, routes };
}

const button = () =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === '読み取る') as
    | HTMLButtonElement
    | undefined;

describe('お知らせの文を入れる', () => {
  it('入れた文と出どころを読みに出し、読めたら、そのお知らせの文ごとの結果を開く', async () => {
    const { ctx, reads, routes } = setup(OK);
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    expect(host.textContent).toContain('お知らせを入れる');
    expect(host.textContent).not.toMatch(/\binput\.[a-z]/);
    // 空のうちは押せない。
    expect(button()?.disabled).toBe(true);
    const area = host.querySelector('textarea') as HTMLTextAreaElement;
    const select = host.querySelector('select') as HTMLSelectElement;
    await step(() => type(select, 'club'));
    await step(() => type(area, '12月10日(木)の練習は中止です。'));
    expect(button()?.disabled).toBe(false);
    await step(() => button()?.click());
    expect(reads).toEqual([
      { text: '12月10日(木)の練習は中止です。', sender: 'club', operationId: expect.any(String) },
    ]);
    expect(routes).toEqual([{ name: 'sources', sourceId: 'u1' }]);
    // 「あした」の基準（デモの時計）と、送る先を、入れる前に見せる。
    expect(host.textContent).toContain('デモの時計');
    expect(host.textContent).toContain('Anthropic の Claude API');
  });

  it('読む間は、文と出どころを変えられない（読み終えた時に、後から打った文を消さない）', async () => {
    let finish = (_: ReadResult) => {};
    const { ctx } = setup(OK);
    const read = () =>
      new Promise<ReadResult>((resolve) => {
        finish = resolve;
      });
    await step(() => root.render(<SourcesScreen ctx={{ ...ctx, read }} />));
    const area = host.querySelector('textarea') as HTMLTextAreaElement;
    await step(() => type(area, '（架空）一つ目'));
    await step(() => button()?.click());
    expect(area.readOnly).toBe(true);
    expect((host.querySelector('select') as HTMLSelectElement).disabled).toBe(true);
    await step(() => finish({ status: 'failed' }));
    expect(area.readOnly).toBe(false);
    expect(area.value).toBe('（架空）一つ目');
  });

  it('返事が届かなかった送り直しは同じ操作 ID で送る。文を変えたら新しい操作', async () => {
    const answers: ReadResult[] = [{ status: 'uncertain' }, { status: 'uncertain' }, OK];
    const { ctx, reads } = setup(OK);
    const read = async (input: NoticeInput) => {
      reads.push(input);
      return answers.shift() ?? OK;
    };
    await step(() => root.render(<SourcesScreen ctx={{ ...ctx, read }} />));
    const area = host.querySelector('textarea') as HTMLTextAreaElement;
    await step(() => type(area, '（架空）一つ目'));
    await step(() => button()?.click());
    await step(() => button()?.click());
    await step(() => type(area, '（架空）二つ目'));
    await step(() => button()?.click());
    expect(reads.map((r) => r.text)).toEqual([
      '（架空）一つ目',
      '（架空）一つ目',
      '（架空）二つ目',
    ]);
    expect(reads[1]?.operationId).toBe(reads[0]?.operationId);
    expect(reads[2]?.operationId).not.toBe(reads[0]?.operationId);
  });

  it('数を使い切った時・混んでいる時・返事が分からない時・読めなかった時は、その旨を出す（戻らない）', async () => {
    for (const [answer, message] of [
      [{ status: 'limit' }, '読める数を使い切りました'],
      [{ status: 'busy' }, 'いま他の読み取りの途中です'],
      [{ status: 'uncertain' }, '返事が届きませんでした'],
      [{ status: 'stale' }, '読む間に、前に読んだ事項が変わりました'],
      [{ status: 'failed', reason: 'readingFailed' }, '読み取れませんでした'],
    ] as const) {
      const { ctx, routes } = setup(answer);
      await step(() => root.render(<SourcesScreen ctx={ctx} />));
      await step(() => type(host.querySelector('textarea') as HTMLTextAreaElement, '（架空）'));
      await step(() => button()?.click());
      expect(host.textContent, message).toContain(message);
      expect(routes).toEqual([]);
    }
  });

  it('原文の文ごとに、計画に入れたか・よていに出すか・読んだだけか・確かめてほしいかを示す', async () => {
    const source = {
      id: 'u1',
      version: 1,
      receivedAt: '2026-11-25T19:31+09:00',
      sender: 'school',
      language: 'ja',
      medium: 'text',
      title: '（架空）お知らせ',
      sentences: [
        { id: 'u1#1', text: '12月3日(木)は漢字テストです。' },
        { id: 'u1#2', text: '音読カードにサインをお願いします。' },
        { id: 'u1#3', text: 'よろしくお願いします。' },
        { id: 'u1#4', text: '持ち物は、後日お知らせします。' },
        { id: 'u1#5', text: '12月1日までに空き箱を持たせてください。' },
        { id: 'u1#6', text: '12月2日までに体操服を用意してください。' },
      ],
    };
    const item = (id: string, sentence: string, kind: string, date?: string) => ({
      item: {
        id,
        sourceId: 'u1',
        sentenceIds: [sentence],
        kind,
        written: '',
        interpretation: date ? { date } : {},
        evidence: 'stated',
        effects: [],
      },
      live: true,
      conditional: false,
      trusted: true,
    });
    const ctx = {
      ...baseCtx(),
      sources: new Map([['u1', source]]),
      readings: [{ sourceId: 'u1', origin: 'live', model: 'm', check: ['u1#4'], checkAll: false }],
      items: [
        item('u1:i1', 'u1#1', 'test', '2026-12-03'),
        item('u1:i2', 'u1#2', 'homework'),
        item('u1:i3', 'u1#5', 'belongings'),
        item('u1:i4', 'u1#6', 'belongings'),
      ],
      // 空き箱：まだ判断できない手配だけ（次の一歩が無い）。体操服：選べる手配がある。
      plan: {
        requirements: [
          { key: 'req:box', live: true, basis: { itemIds: ['u1:i3'] } },
          { key: 'req:gym', live: true, basis: { itemIds: ['u1:i4'] } },
        ],
        arrangements: [
          { key: 'arr:box', live: true, requirementKey: 'req:box', status: 'undetermined' },
          { key: 'arr:gym', live: true, requirementKey: 'req:gym', status: 'decidable' },
        ],
        tasks: [],
        questions: [],
      },
    } as unknown as Ctx;
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    const line = (text: string) =>
      [...host.querySelectorAll('p')].find((p) => p.textContent?.startsWith(text))?.textContent;
    expect(line('12月3日')).toContain('よていに出します');
    expect(line('音読カード')).toContain('読んだだけ（まだ知らせません）');
    expect(line('よろしく')).toBe('よろしくお願いします。');
    expect(line('持ち物は')).toContain('要確認');
    expect(line('12月1日までに空き箱')).toContain('読んだだけ');
    expect(line('12月2日までに体操服')).toContain('計画に入れました');
    expect(host.textContent).toContain('1文を確かめてください');
  });

  it('読み取りの使えない画面（鍵の無いサーバー・家族の家庭）では、入れる欄を出さない', async () => {
    await step(() => root.render(<SourcesScreen ctx={baseCtx()} />));
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.textContent).toContain('撮る');
  });
});
