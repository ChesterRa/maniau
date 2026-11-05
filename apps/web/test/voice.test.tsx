// @vitest-environment happy-dom
// 声で欄に入れる：ブラウザの音声認識（試験では偽の物）で一回の発話を文字にし、欄の今の文字の後ろに一度だけ足す。
// 送らない・読まない（押すのは家族）。押す前に、声を文字にするのはブラウザや端末の認識だと読める。止めた・送った・
// 画面を離れた後に届いた知らせは使わない。失敗の時の途中の文字は入れず、キーボードのマイクへ案内する。使えない
// ブラウザでは押しボタンを出さない。偽の認識で確かめるのは、押した後の動きと順だけ（どの端末で認識できるかではない）。
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HearResult, NoticeInput, ReadResult } from '../src/family';
import i18n from '../src/i18n';
import { type Ctx, SayCard, SourcesScreen } from '../src/screens';
import { appendHeard } from '../src/voice';
import { step } from './fake-fetch';

class FakeRecognition {
  static all: FakeRecognition[] = [];
  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null =
    null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  calls: string[] = [];
  constructor() {
    FakeRecognition.all.push(this);
  }
  start() {
    this.calls.push('start');
  }
  stop() {
    this.calls.push('stop');
  }
  abort() {
    this.calls.push('abort');
  }
  /** 聞き取った途中・終わりの文字（一回の発話の結果の並び）。 */
  hear(...parts: string[]) {
    this.onresult?.({ results: parts.map((transcript) => [{ transcript }]) });
  }
  end() {
    this.onend?.();
  }
  fail(error: string) {
    this.onerror?.({ error });
  }
}
const last = () => {
  const r = FakeRecognition.all.at(-1);
  if (!r) throw new Error('認識が始まっていない');
  return r;
};
const g = globalThis as { webkitSpeechRecognition?: unknown };

function ctxFor(lang: 'ja' | 'en' = 'ja'): Ctx {
  return {
    sources: new Map(),
    readings: [],
    plan: {
      throughSeq: 3,
      requirements: [],
      tasks: [],
      arrangements: [],
      questions: [],
      requests: [],
    },
    today: { main: [], quiet: [] },
    items: [],
    lang,
    tz: 'Asia/Tokyo',
    now: '2026-12-01T19:31+09:00',
    t: i18n.getFixedT(lang),
    outbound: (lng: string) => i18n.getFixedT(lng),
    send: async () => ({ status: 'ok' }),
    go: () => {},
  } as unknown as Ctx;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeRecognition.all = [];
  g.webkitSpeechRecognition = FakeRecognition;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
  delete g.webkitSpeechRecognition;
});

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const area = () => {
  const found = host.querySelector('textarea');
  if (!found) throw new Error('欄が無い');
  return found;
};
function type(value: string) {
  const input = area();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 一言の欄。hear は押された時の文を残し、gate を渡すと答えを止めておける。 */
async function sayCard(lang: 'ja' | 'en' = 'ja', gate?: Promise<void>) {
  const heard: string[] = [];
  const hear = async (text: string): Promise<HearResult> => {
    heard.push(text);
    if (gate) await gate;
    return { status: 'ok', reply: { kind: 'unsupported', reason: 'routineChange' }, throughSeq: 3 };
  };
  await step(() =>
    root.render(
      <SayCard ctx={ctxFor(lang)} hear={hear} confirm={async () => ({ status: 'ok' })} />,
    ),
  );
  return { heard };
}

describe('文字の足し方', () => {
  it('前の文字は消さず、空白を一つ挟んで後ろに足す（長くても切らない・空の聞き取りは足さない）', () => {
    expect(appendHeard('', ' 12月19日は会議 ')).toBe('12月19日は会議');
    expect(appendHeard('おばあちゃん', '大丈夫だって')).toBe('おばあちゃん 大丈夫だって');
    expect(appendHeard('おばあちゃん ', '大丈夫')).toBe('おばあちゃん 大丈夫');
    expect(appendHeard('a'.repeat(499), 'bcd')).toHaveLength(503);
    expect(appendHeard('abc', '  ')).toBe('abc');
  });
});

describe('ひとことの欄', () => {
  it('押す前に注記が読め、押すと画面の言葉で一回だけ聞き、終わりに欄の後ろへ足す（送らない）', async () => {
    const { heard } = await sayCard();
    expect(host.textContent).toContain('ブラウザや端末の音声認識が、声を文字にします');
    expect(host.textContent).toContain('アプリには文字だけが届きます');
    await step(() => type('おばあちゃん'));
    await step(() => button('話す')?.click());
    const r = last();
    expect(r.calls).toEqual(['start']);
    expect([r.lang, r.continuous, r.interimResults]).toEqual(['ja-JP', false, true]);
    expect(button('止める')).toBeDefined();
    expect(host.textContent).toContain('聞いています');
    expect(host.textContent).toContain(
      '入った文字は、「伝える」を押すまで、このアプリからは送りません。',
    );
    await step(() => r.hear('12月7日は'));
    expect(host.textContent).toContain('聞き取り中：12月7日は');
    await step(() => r.hear('12月7日は', '大丈夫だって'));
    await step(() => r.end());
    expect(area().value).toBe('おばあちゃん 12月7日は大丈夫だって');
    expect(button('話す')).toBeDefined();
    expect(host.textContent).not.toContain('聞いています');
    expect(heard).toEqual([]);
    // 足した文は、押した時に送る。
    await step(() => button('伝える')?.click());
    expect(heard).toEqual(['おばあちゃん 12月7日は大丈夫だって']);
  });

  it('聞いている間に打った文字の後ろに足し、同じ発話の知らせが重なっても一度だけ足す', async () => {
    await sayCard();
    await step(() => button('話す')?.click());
    const r = last();
    await step(() => type('打った'));
    await step(() => r.hear('話した'));
    await step(() => r.hear('話した'));
    await step(() => r.end());
    await step(() => r.end());
    expect(area().value).toBe('打った 話した');
  });

  it('押して止めると、そこまでの文字を足す。話す前に止めても失敗とは出さない', async () => {
    await sayCard();
    await step(() => button('話す')?.click());
    await step(() => button('止める')?.click());
    const r = last();
    expect(r.calls).toEqual(['start', 'stop']);
    await step(() => r.hear('ここまで'));
    await step(() => r.end());
    expect(area().value).toBe('ここまで');
    await step(() => button('話す')?.click());
    await step(() => button('止める')?.click());
    const quiet = last();
    await step(() => quiet.fail('no-speech'));
    await step(() => quiet.end());
    expect(area().value).toBe('ここまで');
    expect(host.textContent).not.toContain('聞き取れませんでした');
    expect(host.textContent).not.toContain('声が聞き取れませんでした');
  });

  it('失敗の時は途中の文字を入れず、理由とキーボードのマイクを案内する', async () => {
    await sayCard();
    const cases: [string, string][] = [
      ['not-allowed', 'マイクを使う許可がありません'],
      ['service-not-allowed', 'ここでは音声認識を使えませんでした'],
      ['network', '音声認識につながりませんでした'],
      ['no-speech', '声が聞き取れませんでした'],
      ['audio-capture', 'マイクが見つかりませんでした'],
      ['bad-grammar', '聞き取れませんでした。もう一度押すか'],
    ];
    for (const [error, text] of cases) {
      await step(() => button('話す')?.click());
      const r = last();
      await step(() => r.hear('途中'));
      await step(() => r.fail(error));
      await step(() => r.end());
      expect(area().value).toBe('');
      expect(host.textContent).toContain(text);
    }
    // もう一度押せば、前の失敗の文は消える。
    await step(() => button('話す')?.click());
    expect(host.textContent).not.toContain('聞き取れませんでした。もう一度押すか');
  });

  it('聞いている間に「伝える」を押したら、聞いている物を捨て、押した時の文字で送る（後から届いても足さない）', async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { heard } = await sayCard('ja', gate);
    await step(() => type('おばあちゃん大丈夫'));
    await step(() => button('話す')?.click());
    const r = last();
    await step(() => r.hear('あと'));
    await step(() => button('伝える')?.click());
    expect(r.calls).toEqual(['start', 'abort']);
    expect(heard).toEqual(['おばあちゃん大丈夫']);
    await step(() => r.hear('あと一言'));
    await step(() => r.fail('aborted'));
    await step(() => r.end());
    expect(area().value).toBe('おばあちゃん大丈夫');
    expect(host.textContent).not.toContain('聞き取れませんでした');
    await step(() => open());
  });

  it('画面を離れたら捨てる（後から届いた知らせで何も起きない）', async () => {
    await sayCard();
    await step(() => button('話す')?.click());
    const r = last();
    await step(() => root.unmount());
    expect(r.calls).toEqual(['start', 'abort']);
    r.hear('遅れて');
    r.end();
    root = createRoot(host);
  });

  it('話して長くなっても切らず、長すぎることを示して送らせない（消して短くすれば送れる）', async () => {
    for (const lang of ['ja', 'en'] as const) {
      const { heard } = await sayCard(lang);
      const speak = lang === 'ja' ? '話す' : 'Speak';
      const send = lang === 'ja' ? '伝える' : 'Send';
      await step(() => type('あ'.repeat(498)));
      await step(() => button(speak)?.click());
      const r = last();
      await step(() => r.hear('いうえお'));
      await step(() => r.end());
      expect(area().value).toBe(`${'あ'.repeat(498)} いうえお`);
      expect(host.textContent).toContain(
        lang === 'ja'
          ? '文が長すぎます（503字。500字まで）'
          : 'The text is too long (503 characters; up to 500)',
      );
      expect(button(send)?.disabled).toBe(true);
      await step(() => type(area().value.slice(0, 500)));
      expect(host.textContent).not.toContain(lang === 'ja' ? '長すぎます' : 'too long');
      expect(button(send)?.disabled).toBe(false);
      await step(() => button(send)?.click());
      expect(heard).toEqual([`${'あ'.repeat(498)} い`]);
      await step(() => root.unmount());
      root = createRoot(host);
    }
  });

  it('使えないブラウザでは押しボタンを出さず、キーボードのマイクを案内する', async () => {
    delete g.webkitSpeechRecognition;
    await sayCard();
    expect(button('話す')).toBeUndefined();
    expect(host.textContent).toContain(
      'キーボードにマイクがあれば、話して入れられます。入った文字を確かめてから「伝える」を押してください',
    );
    expect(host.textContent).not.toContain('ブラウザや端末の音声認識が、声を文字にします');
  });

  it('英語の画面では英語で聞き、英語で書く', async () => {
    await sayCard('en');
    expect(host.textContent).toContain('The app gets only the text.');
    await step(() => button('Speak')?.click());
    expect(last().lang).toBe('en-US');
    expect(host.textContent).toContain('The text stays in the box until you press “Send”.');
    await step(() => button('Stop')?.click());
  });
});

describe('お知らせの欄', () => {
  function readCtx() {
    const reads: NoticeInput[] = [];
    const ctx: Ctx = {
      ...ctxFor(),
      read: async (input: NoticeInput): Promise<ReadResult> => {
        reads.push(input);
        return { status: 'ok', sourceId: 'u1', check: { sentenceIds: [], all: false } };
      },
    };
    return { ctx, reads };
  }

  it('話した文字は欄の後ろに足すだけで、読み取りは押した時だけ', async () => {
    const { ctx, reads } = readCtx();
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    expect(host.textContent).toContain('ブラウザや端末の音声認識が、声を文字にします');
    await step(() => type('12月10日の練習は中止です。'));
    await step(() => button('話す')?.click());
    const r = last();
    await step(() => r.hear('12日は通常どおりです。'));
    await step(() => r.end());
    expect(area().value).toBe('12月10日の練習は中止です。 12日は通常どおりです。');
    expect(reads).toEqual([]);
    await step(() => button('読み取る')?.click());
    expect(reads).toEqual([
      expect.objectContaining({ text: '12月10日の練習は中止です。 12日は通常どおりです。' }),
    ]);
  });

  it('使えないブラウザでは押しボタンを出さない（上の説明がキーボードのマイクを案内する）', async () => {
    delete g.webkitSpeechRecognition;
    const { ctx } = readCtx();
    await step(() => root.render(<SourcesScreen ctx={ctx} />));
    expect(button('話す')).toBeUndefined();
    expect(host.textContent).toContain('キーボードにマイクがあれば、それも使えます');
  });
});
