// @vitest-environment happy-dom
// 取り消しの文：見せた文を、端末の共有（LINE など）かコピーで渡せる（送るのは家族）。頼む文と同じ渡し方。
// 共有の無い端末ではコピーして貼るよう示し、コピーもできなければそう示す。結果は、その時の文に結ぶ。
import type { ExternalRequest, Task } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { CancelCard, type Ctx, cancelDraft } from '../src/screens';
import { step } from './fake-fetch';

/** 取り消しの札に要る物だけの画面の材料（DOM の試験では、デモのファイルを読まない）。 */
const ctx = {
  household: {
    members: [
      {
        id: 'g',
        kind: 'helper',
        name: 'おばあちゃん',
        outboundLanguage: 'ja',
        addressAs: 'お母さん',
      },
    ],
    places: [],
  },
  plan: { requirements: [], tasks: [], arrangements: [], questions: [], requests: [] },
  lang: 'ja',
  tz: 'Asia/Tokyo',
  now: '2026-12-04T19:00+09:00',
  t: i18n.getFixedT('ja'),
  outbound: (lng: string) => i18n.getFixedT(lng),
  send: async () => ({ status: 'ok' }),
  go: () => {},
} as unknown as Ctx;
const task = {
  key: 'task:cancel:r-grandma',
  titleKey: 'task.cancelRequest',
  titleParams: { to: 'g' },
} as unknown as Task;
const requestOn = (day: string) =>
  ({
    requestId: 'r-grandma',
    to: 'g',
    window: { start: `${day}T08:10+09:00`, end: `${day}T18:15+09:00` },
  }) as unknown as ExternalRequest;
const request = requestOn('2026-12-07');

let root: Root;
let host: HTMLDivElement;
let written: string[] = [];
let shared: ShareData[] = [];

/** 端末の共有とコピー（無い・断る・遅れて終わるを選べる）。 */
function device(options: {
  share?: 'ok' | 'abort' | 'refuse' | 'none';
  clipboard?: 'ok' | 'refuse' | Promise<void>;
}) {
  const share = options.share ?? 'ok';
  Object.defineProperty(navigator, 'share', {
    value:
      share === 'none'
        ? undefined
        : async (data: ShareData) => {
            if (share === 'abort') throw new DOMException('やめた', 'AbortError');
            if (share === 'refuse') throw new DOMException('使えない', 'NotAllowedError');
            shared.push(data);
          },
    configurable: true,
  });
  const clipboard = options.clipboard ?? 'ok';
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: async (text: string) => {
        if (clipboard === 'refuse') throw new DOMException('使えない', 'NotAllowedError');
        if (clipboard !== 'ok') await clipboard;
        written.push(text);
      },
    },
    configurable: true,
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  written = [];
  shared = [];
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
const draw = (shown: ExternalRequest) =>
  step(() => root.render(<CancelCard ctx={ctx} task={task} request={shown} />));
const open = async (shown = request) => {
  await draw(shown);
  await step(() => button('伝える文を見る')?.click());
};

describe('取り消しの文を渡す', () => {
  it('文を開いた後に、共有かコピーで、見せた文と同じ文を渡す', async () => {
    device({});
    const draft = cancelDraft(ctx, request);
    expect(draft).toContain('12月7日');
    await draw(request);
    // 文を見る前は、送る手段を出さない（何を送るか見てから渡す）。
    expect(button('コピー')).toBeUndefined();
    await step(() => button('伝える文を見る')?.click());
    await step(() => button('LINE などで送る')?.click());
    await step(() => button('コピー')?.click());
    expect(shared).toEqual([{ text: draft }]);
    expect(written).toEqual([draft]);
    expect(button('コピーしました')).toBeDefined();
  });

  it('共有の無い・使えない端末では、コピーして、貼って送るよう示す', async () => {
    for (const share of ['none', 'refuse'] as const) {
      device({ share });
      written = [];
      await open();
      await step(() => button('LINE などで送る')?.click());
      expect(written).toEqual([cancelDraft(ctx, request)]);
      expect(host.textContent).toContain('貼り付けて送ってください');
      await step(() => root.render(<span />));
    }
  });

  it('共有が中断された時（やめた・送れる先が無い）は、何も出さず、勝手にコピーもしない', async () => {
    device({ share: 'abort' });
    await open();
    await step(() => button('LINE などで送る')?.click());
    expect(written).toEqual([]);
    expect(host.textContent).not.toContain('貼り付けて');
    expect(host.textContent).not.toContain('コピーできませんでした');
  });

  it('コピーもできない端末では、そう示し、文を選んでコピーするよう示す', async () => {
    device({ share: 'none', clipboard: 'refuse' });
    await open();
    await step(() => button('コピー')?.click());
    expect(host.textContent).toContain('コピーできませんでした');
    expect(button('コピーしました')).toBeUndefined();
  });

  it('コピーした後に文が替わったら、「コピーしました」を新しい文に付けない（遅れて終わった時も）', async () => {
    device({});
    await open();
    await step(() => button('コピー')?.click());
    expect(button('コピーしました')).toBeDefined();
    await draw(requestOn('2026-12-14'));
    expect(button('コピーしました')).toBeUndefined();
    expect(button('コピー')).toBeDefined();

    let finish = () => {};
    device({
      clipboard: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    });
    written = [];
    await step(() => button('コピー')?.click());
    await draw(requestOn('2026-12-21'));
    await step(() => finish());
    expect(written).toEqual([cancelDraft(ctx, requestOn('2026-12-14'))]);
    expect(button('コピーしました')).toBeUndefined();
  });
});
