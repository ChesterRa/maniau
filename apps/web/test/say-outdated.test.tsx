// @vitest-environment happy-dom
// ひとこと：答えは読んだ時の計画の版と一緒に持ち、計画が先へ進んだら閉じる（古い答えを今も有効な物と
// して残さない）。記録が届いたか分からない時も答えを閉じ、送り直しは画面の上の表示に任せる。
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ConfirmResult, HearResult } from '../src/family';
import i18n from '../src/i18n';
import { type Ctx, SayCard } from '../src/screens';
import { step } from './fake-fetch';

/** 一言の欄に要る物だけの画面の材料（DOM の試験では、デモのファイルを読まない）。 */
function ctxAt(throughSeq: number): Ctx {
  return {
    sources: new Map(),
    readings: [],
    plan: {
      throughSeq,
      requirements: [],
      tasks: [],
      arrangements: [],
      questions: [],
      requests: [],
    },
    items: [],
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-12-01T19:31+09:00',
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

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);

async function say(
  ctx: Ctx,
  heard: HearResult,
  confirm: () => Promise<ConfirmResult> = async () => ({ status: 'ok' }),
) {
  const draw = (at: Ctx) => <SayCard ctx={at} hear={async () => heard} confirm={confirm} />;
  await step(() => root.render(draw(ctx)));
  const input = host.querySelector('textarea');
  if (!input) throw new Error('欄が無い');
  await step(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      input,
      '来週からお迎えは火曜も私',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await step(() => button('伝える')?.click());
  return (at: Ctx) => step(() => root.render(draw(at)));
}

it('答えを出した後に計画が先へ進んだら、その答えを閉じて、もう一度伝えてもらう', async () => {
  const redraw = await say(ctxAt(5), {
    status: 'ok',
    reply: { kind: 'unsupported', reason: 'routineChange' },
    throughSeq: 5,
  });
  expect(host.textContent).toContain(
    'ずっと続く変更、二人以上・二日以上の話、お迎えや送りだけの話、在宅勤務は、まだ一言では受け付けられません。',
  );
  // 同じ画面に、先へ進んだ計画が届く（もう一人の記録など）。
  await redraw(ctxAt(6));
  expect(host.textContent).not.toContain('ふだんの週');
  expect(host.textContent).toContain('計画が変わったので、前の答えを閉じました。');
});

it('記録が届いたか分からない時は、答えを閉じ、確かめるのは画面の上の表示に任せる', async () => {
  await say(
    ctxAt(5),
    {
      status: 'ok',
      reply: {
        kind: 'change',
        proposals: [
          {
            id: 'p1',
            command: { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' },
            label: '開催日',
          },
        ],
      },
      throughSeq: 5,
    },
    async () => ({ status: 'uncertain' }),
  );
  expect(host.textContent).toContain('これを記録しますか？');
  await step(() => button('記録する')?.click());
  expect(button('記録する')).toBeUndefined();
  // 送り直しと手放しは画面の上の表示だけで行う（片付いた後に、この欄に古い「分からない」を残さない）。
  expect(host.textContent).not.toContain('分かりません');
  expect(host.textContent).not.toContain('結果が分かりませんでした');
});
