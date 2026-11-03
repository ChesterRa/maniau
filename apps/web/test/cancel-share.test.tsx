// @vitest-environment happy-dom
// 取り消しの文：見せた文を、端末の共有（LINE など）かコピーで渡せる（送るのは家族）。頼む文と同じ渡し方。
// 共有の無い端末ではコピーして貼るよう示し、コピーもできなければそう示す。結果は、その時の文に結ぶ。
import type { ExternalRequest, Task } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { CancelCard, type Ctx, cancelDraft, cancelTwin } from '../src/screens';
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
  basis: { itemIds: ['i6'], arrangementKey: 'arr:childCare:n1:i6:c' },
} as unknown as Task;
const requestOn = (day: string) =>
  ({
    requestId: 'r-grandma',
    to: 'g',
    window: { start: `${day}T08:10+09:00`, end: `${day}T18:15+09:00` },
    basis: { itemIds: ['i6'], arrangementKey: 'arr:childCare:n1:i6:c' },
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
  it('通用の「すること」の取り消しは、送った時の控えで、どのお願いかを書く（人へは頼んだ時間と何を、所へは頼んだ時間だけ）', async () => {
    device({});
    const need = (day: string, from: string, to: string, what: string) =>
      ({
        ...requestOn(day),
        window: { start: `${day}T${from}+09:00`, end: `${day}T${to}+09:00` },
        basis: { itemIds: ['f-1:i1'], arrangementKey: 'arr:need:f-1:i1' },
        askedNeed: { what },
      }) as ExternalRequest;
    // 同じ相手に同じ日の二つのお願い：取り消す方を、時間と何をで書く（もう一つまで取り消したと読ませない）。
    const a = need('2026-11-28', '09:00', '10:00', '荷物Aを受け取る');
    const b = need('2026-11-28', '13:00', '15:00', '荷物Bを受け取る');
    expect(cancelDraft(ctx, a)).toBe(
      'お母さん、11月28日（土）の9:00〜10:00の「荷物Aを受け取る」のお願いは、予定が変わったので大丈夫になりました。ありがとう。',
    );
    expect(cancelDraft(ctx, b)).toContain('「荷物Bを受け取る」');
    // 所に頼んだ物：何を（家族の言葉で、子の名前を含みうる）を書かず、頼んだ時間だけで書く。
    const placed = {
      ...ctx,
      household: {
        ...ctx.household,
        places: [{ id: 'sick-care', kind: 'other', name: '病児保育室' }],
      },
    } as unknown as Ctx;
    const place = {
      ...a,
      to: 'sick-care',
      askedNeed: { what: '陽菜を家で見る' },
    } as ExternalRequest;
    expect(cancelDraft(placed, place)).toBe(
      '11月28日（土）の9:00〜10:00の件でお願いしていたことを、取り消します。',
    );
    // 締切の「すること」は、頼んだ時の締切（書かれた時刻があれば時刻も）で書く。
    const by = {
      ...a,
      window: undefined,
      askedNeed: { what: '資料を申し込む', deadline: '2026-11-28T17:00+09:00' },
    } as unknown as ExternalRequest;
    expect(cancelDraft(ctx, by)).toBe(
      'お母さん、11月28日（土）の17:00までの「資料を申し込む」のお願いは、予定が変わったので大丈夫になりました。ありがとう。',
    );
    // 控えに中身の無い古い依頼：今の事項から推さず、頼んだ時間だけで書き、札で確かめてもらう。
    const old = { ...a, askedNeed: undefined } as unknown as ExternalRequest;
    expect(cancelDraft(ctx, old)).toBe(
      'お母さん、11月28日（土）の9:00〜10:00のお願いは、予定が変わったので大丈夫になりました。ありがとう。',
    );
    expect(
      cancelDraft(placed, { ...old, to: 'sick-care', window: undefined } as ExternalRequest),
    ).toBe('前にお願いしていたことを、取り消します。');
    await draw(old);
    await step(() => button('伝える文を見る')?.click());
    expect(host.textContent).toContain('どのお願いかを確かめ');
    expect(button('取り消しを伝えた')).toBeDefined();
  });

  it('文だけでは同じ相手の別のお願いと見分けられない時は、推して書き足さず、どれかを書き足すよう札で添える', async () => {
    device({});
    const place = (id: string, from: string, to: string, what: string) =>
      ({
        ...requestOn('2026-11-26'),
        requestId: id,
        to: 'sick-care',
        window: { start: `2026-11-26T${from}+09:00`, end: `2026-11-26T${to}+09:00` },
        basis: { itemIds: [`f-${id}:i1`], arrangementKey: `arr:need:f-${id}:i1` },
        askedNeed: { what },
      }) as ExternalRequest;
    const one = place('r-1', '08:00', '18:00', '陽菜を家で見る');
    const two = place('r-2', '08:00', '18:00', '蒼を家で見る');
    const later = place('r-3', '13:00', '15:00', '蒼を家で見る');
    const withRequests = (requests: ExternalRequest[]) =>
      ({
        ...ctx,
        household: {
          ...ctx.household,
          places: [{ id: 'sick-care', kind: 'other', name: '病児保育室' }],
        },
        plan: { ...ctx.plan, requests },
      }) as unknown as Ctx;
    const card = async (shown: Ctx, request: ExternalRequest) => {
      await step(() => root.render(<span />));
      await step(() => root.render(<CancelCard ctx={shown} task={task} request={request} />));
      await step(() => button('伝える文を見る')?.click());
      return host.textContent ?? '';
    };
    // 同じ所に同じ時間の二つ：文が同じになる（子の名前で分けない）ので、札でどれかを書き足してもらう。
    const twins = withRequests([one, two]);
    expect(cancelDraft(twins, one)).toBe(cancelDraft(twins, two));
    expect(cancelDraft(twins, one)).not.toContain('陽菜');
    expect(cancelTwin(twins, one)).toBe(true);
    expect(await card(twins, one)).toContain('どのお願いかを書き足して');
    // 時間が違えば、文で見分けられるので、添えない。
    const apart = withRequests([one, later]);
    expect(cancelTwin(apart, one)).toBe(false);
    expect(await card(apart, one)).not.toContain('どのお願いかを書き足して');
  });

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
