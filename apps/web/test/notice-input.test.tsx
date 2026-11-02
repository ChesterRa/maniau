// @vitest-environment happy-dom
// お知らせの文を入れる：貼るか、キーボードのマイクで話した文を、出どころと一緒に読みに出す。読めたら
// 「きょう」に戻る。読めない・数を使い切った時は、その旨を出す。読み取りの使えない画面には出さない。
// 写真・PDF は書き起こして文の欄に入れ、家族が見比べて直してから、写真の印を付けて読む。
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoticeInput, PhotoResult, PhotoUpload, ReadResult } from '../src/family';
import i18n from '../src/i18n';
import { type Ctx, type Route, SourcesScreen } from '../src/screens';
import { step } from './fake-fetch';

// 写真を縮める間を止められるようにし、写真は端末の画像処理を使わずに送る形にする（試験の環境は絵を描けない）。
const conversion = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }));
vi.mock('../src/photo', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/photo')>();
  return {
    ...real,
    toUploadable: async (file: File) => {
      if (conversion.gate) await conversion.gate;
      return file.type.startsWith('image/')
        ? { mediaType: 'image/jpeg' as const, data: '/9j/' }
        : real.toUploadable(file);
    },
  };
});

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
      {
        text: '12月10日(木)の練習は中止です。',
        sender: 'club',
        medium: 'text',
        operationId: expect.any(String),
      },
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

describe('写真・PDF から書き起こす', () => {
  /** ファイルを選んだように、選ぶ欄に一つ入れる。 */
  const choose = async (file: File) => {
    const input = host.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await step(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    await step();
  };
  const pdf = () =>
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'oshirase.pdf', {
      type: 'application/pdf',
    });

  it('書き起こした文を欄に入れ、見比べてから、写真の印を付けて読む', async () => {
    const { ctx, reads } = setup(OK);
    const photos: PhotoUpload[] = [];
    const withPhoto: Ctx = {
      ...ctx,
      transcribe: async (input) => {
        photos.push(input);
        return { status: 'ok', text: '12月7日(月)は通常授業です。' };
      },
    };
    await step(() => root.render(<SourcesScreen ctx={withPhoto} />));
    expect(host.textContent).toContain('写真・PDF から書き起こす');
    expect(host.textContent).toContain('このアプリは写真を残しません');
    await choose(pdf());
    expect(photos).toEqual([
      { mediaType: 'application/pdf', data: 'JVBERg==', operationId: expect.any(String) },
    ]);
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      '12月7日(月)は通常授業です。',
    );
    expect(host.textContent).toContain('PDF を開く：oshirase.pdf');
    expect(host.textContent).toContain('PDF を開いて見比べ');
    await step(() => button()?.click());
    expect(reads).toEqual([
      {
        text: '12月7日(月)は通常授業です。',
        sender: 'school',
        medium: 'photo',
        operationId: expect.any(String),
      },
    ]);
  });

  it('文字が読めなかった時は、欄を変えずにその旨を出す。書き起こしの口が無ければ、選ぶ欄を出さない', async () => {
    const { ctx } = setup(OK);
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    expect(host.querySelector('input[type=file]')).toBeNull();
    const empty: Ctx = { ...ctx, transcribe: async () => ({ status: 'ok', text: '  ' }) };
    await step(() => root.render(<SourcesScreen ctx={empty} />));
    await choose(pdf());
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
    expect(host.textContent).toContain('文字を読み取れませんでした');
  });
});

describe('写真・PDF：選び直し・送り直し・閉じた時', () => {
  const choose = async (file: File) => {
    const input = host.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await step(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    await step();
  };
  const pdf = (name: string) =>
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: 'application/pdf' });
  const image = (name: string) =>
    new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: 'image/jpeg' });
  const area = () => host.querySelector('textarea') as HTMLTextAreaElement;
  const fileInput = () => host.querySelector('input[type=file]') as HTMLInputElement;
  const urls = { made: [] as string[], revoked: [] as string[] };
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  beforeEach(() => {
    urls.made = [];
    urls.revoked = [];
    URL.createObjectURL = () => {
      const url = `blob:test/${urls.made.length + 1}`;
      urls.made.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      urls.revoked.push(url);
    };
  });
  afterEach(() => {
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
    conversion.gate = undefined;
  });
  const hold = () => {
    let open = () => {};
    conversion.gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return async () => {
      open();
      conversion.gate = undefined;
      await step();
      await step();
    };
  };
  const transcribing = (answers: PhotoResult[], calls: PhotoUpload[] = []) => {
    const { ctx, reads } = setup(OK);
    const withPhoto: Ctx = {
      ...ctx,
      transcribe: async (input) => {
        calls.push(input);
        return answers.shift() ?? { status: 'failed' };
      },
    };
    return { ctx: withPhoto, reads, calls };
  };

  it('縮める間から、もう一枚は選べない。縮め終えてから送り、写真と文を一緒に出す', async () => {
    const calls: PhotoUpload[] = [];
    const { ctx } = transcribing([{ status: 'ok', text: 'A の文' }], calls);
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    const open = hold();
    await choose(image('a.jpg'));
    expect(fileInput().disabled).toBe(true);
    expect(calls).toHaveLength(0);
    await open();
    expect(calls).toHaveLength(1);
    expect(fileInput().disabled).toBe(false);
    expect(area().value).toBe('A の文');
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:test/1');
  });

  it('二枚目を書き起こせなかった時は、一枚目の写真・文・写真の印をそのまま残す', async () => {
    const { ctx, reads } = transcribing([
      { status: 'ok', text: 'A の文' },
      { status: 'failed', reason: 'readingFailed' },
    ]);
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    await choose(pdf('a.pdf'));
    await choose(pdf('b.pdf'));
    expect(area().value).toBe('A の文');
    expect(host.textContent).toContain('PDF を開く：a.pdf');
    expect(host.textContent).not.toContain('PDF を開く：b.pdf');
    expect(host.textContent).toContain('書き起こせませんでした');
    await step(() => button()?.click());
    expect(reads.map((r) => r.medium)).toEqual(['photo']);
  });

  it('返事が届かなかった時は「もう一度送る」で、同じ操作 ID のまま送り直す', async () => {
    const calls: PhotoUpload[] = [];
    const { ctx } = transcribing(
      [{ status: 'uncertain' }, { status: 'ok', text: '送り直した文' }],
      calls,
    );
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    await choose(pdf('a.pdf'));
    expect(host.textContent).toContain('返事が届きませんでした');
    const retry = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'もう一度送る',
    );
    await step(() => retry?.click());
    await step();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.operationId).toBe(calls[0]?.operationId);
    expect(area().value).toBe('送り直した文');
  });

  it('縮める間に画面を閉じたら、書き起こしに送らず、写真の URL も作らない', async () => {
    const calls: PhotoUpload[] = [];
    const { ctx } = transcribing([{ status: 'ok', text: 'A の文' }], calls);
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    const open = hold();
    await choose(image('a.jpg'));
    await step(() => root.render(<div />));
    await open();
    expect(calls).toHaveLength(0);
    expect(urls.made).toEqual([]);
  });

  it('写真から書き起こした文を読み終えるか、文を消し切ったら、写真の URL を手放す', async () => {
    const { ctx } = transcribing([{ status: 'ok', text: 'A の文' }]);
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    await choose(image('a.jpg'));
    expect(urls.made).toEqual(['blob:test/1']);
    const proto = Object.getPrototypeOf(area()) as object;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(area(), '');
    await step(() => area().dispatchEvent(new Event('input', { bubbles: true })));
    expect(urls.revoked).toEqual(['blob:test/1']);
    expect(host.querySelector('img')).toBeNull();
  });
});

describe('写真・PDF：見比べる原本と、長い文・大きすぎる物', () => {
  const choose = async (file: File) => {
    const input = host.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await step(() => input.dispatchEvent(new Event('change', { bubbles: true })));
    await step();
  };
  const pdf = () =>
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'a.pdf', { type: 'application/pdf' });
  const answering = (answer: PhotoResult) => {
    const { ctx, reads } = setup(OK);
    return { ctx: { ...ctx, transcribe: async () => answer } as Ctx, reads };
  };

  it('PDF は、新しい窓で開いて見比べられる', async () => {
    const { ctx } = answering({ status: 'ok', text: '12月7日(月)は通常授業です。' });
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    await choose(pdf());
    const link = [...host.querySelectorAll('a')].find((a) => a.textContent?.includes('a.pdf'));
    expect(link?.getAttribute('href')).toMatch(/^blob:/);
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('長すぎる書き起こしは切らずに入れ、長すぎると示して、読み取りを押せなくする', async () => {
    const long = 'あ'.repeat(4001);
    const { ctx, reads } = answering({ status: 'ok', text: long });
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    await choose(pdf());
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toHaveLength(4001);
    expect(host.textContent).toContain('文が長すぎます（4,001字。4,000字まで）');
    expect(button()?.disabled).toBe(true);
    expect(reads).toEqual([]);
  });

  it('選べても読めないファイルは、送らずにその旨を出し、選び直せるようにする', async () => {
    const { ctx } = setup(OK);
    let sent = 0;
    const at = {
      ...ctx,
      transcribe: async () => {
        sent += 1;
        return { status: 'ok', text: '12月7日(月)は通常授業です。' };
      },
    } as Ctx;
    await step(() => root.render(<SourcesScreen ctx={at} />));
    const gone = pdf();
    Object.defineProperty(gone, 'arrayBuffer', {
      value: () => Promise.reject(new DOMException('gone', 'NotReadableError')),
    });
    await choose(gone);
    expect(host.textContent).toContain('ファイルを読めませんでした');
    expect((host.querySelector('input[type=file]') as HTMLInputElement).disabled).toBe(false);
    expect(sent).toBe(0);
  });

  it('大きすぎる・ページが多すぎる時は、その旨と、要るページだけにすることを示す', async () => {
    const { ctx } = answering({ status: 'tooLarge' });
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    await choose(pdf());
    expect(host.textContent).toContain('ページが多すぎます');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'もう一度送る')).toBe(
      false,
    );
  });
});
