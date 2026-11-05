// @vitest-environment happy-dom
// 答えるリンク：家族の画面で出した鍵は、その時だけ頁の URL として見せる。相手の頁は、鍵を断片から sessionStorage に
// 移して断片を消し、Bearer で読み書きする。DOM の試験では、デモのファイルを読まず、要る物だけの材料で組む。
import type { Household, NeedWhen, PlanResult } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerRoot } from '../src/answer';
import i18n from '../src/i18n';
import type { Ctx } from '../src/screens';
import { WhenScreen } from '../src/when';
import { step } from './fake-fetch';

const WHEN: NeedWhen = {
  candidates: [
    {
      id: 'c1',
      rev: 1,
      date: '2026-12-12',
      start: '2026-12-12T13:00+09:00',
      end: '2026-12-12T15:00+09:00',
      yes: 0,
      possible: 1,
      requiredNo: [],
      requiredOpen: [],
      condition: 'open',
      pivotal: ['g-sato'],
      ways: [],
      flags: ['waysUndecided'],
    },
    {
      id: 'c2',
      rev: 1,
      date: '2026-12-13',
      start: '2026-12-13T13:00+09:00',
      end: '2026-12-13T15:00+09:00',
      yes: 0,
      possible: 1,
      requiredNo: [],
      requiredOpen: [],
      condition: 'open',
      pivotal: ['g-sato'],
      ways: [],
      flags: ['waysUndecided'],
    },
  ],
  people: [{ id: 'g-sato', kind: 'guest', name: '近所のサトウさん（架空）' }],
  required: [],
  minCount: 1,
  answers: [],
  links: [{ personId: 'g-sato', active: true }],
  inUse: false,
};

function linkCtx(send: Ctx['send']): { ctx: Ctx; key: string } {
  const key = 'req:need:f-1:i1';
  const plan = {
    requirements: [
      {
        key,
        kind: 'need',
        what: '陽菜を見てもらう',
        nature: 'required',
        basis: { itemIds: ['f-1:i1'], requirementKey: key },
        live: true,
        when: WHEN,
      },
    ],
    arrangements: [],
    tasks: [],
    requests: [],
  } as unknown as PlanResult;
  const household = {
    id: 'h',
    timeZone: 'Asia/Tokyo',
    members: [{ id: 'b', kind: 'adult', name: '彩', active: true }],
    ways: [],
  } as unknown as Household;
  const ctx = {
    plan,
    household,
    items: [],
    me: household.members[0],
    lang: 'ja',
    tz: 'Asia/Tokyo',
    now: '2026-12-05T21:00+09:00',
    t: i18n.getFixedT('ja'),
    send,
    go: () => {},
  } as unknown as Ctx;
  return { ctx, key };
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
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

describe('一人ずつのリンク（家族の画面）', () => {
  it('出した鍵は、その時だけ頁の URL として見せ、漏れた時の注意を添える', async () => {
    const sent: unknown[] = [];
    const token = 'T'.repeat(43);
    const { ctx, key } = linkCtx(async (command) => {
      sent.push(command);
      return { status: 'ok', answerLink: { personId: 'g-sato', token } };
    });
    await step(() => root.render(<WhenScreen ctx={ctx} requirementKey={key} />));
    expect(host.textContent).toContain('近所のサトウさん（架空）：リンクを出しています');
    const reissue = [...host.querySelectorAll('button')].find((b) => b.textContent === '出し直す');
    await step(() => reissue?.click());
    expect(sent).toEqual([{ type: 'issueAnswerLink', itemId: 'f-1:i1', personId: 'g-sato' }]);
    const shown = host.querySelector<HTMLInputElement>('input[readonly]');
    expect(shown?.value).toBe(`${window.location.origin}/answer#${token}`);
    expect(host.textContent).toContain('このリンクを持つ人はだれでも答えられます。');
  });
});

describe('答えるリンクの頁', () => {
  const view = {
    what: '陽菜を見てもらう',
    name: '近所のサトウさん（架空）',
    language: 'ja',
    candidates: [
      { id: 'c1', rev: 1, date: '2026-12-12', startTime: '13:00', endTime: '15:00', seenSeq: 0 },
      {
        id: 'c2',
        rev: 1,
        date: '2026-12-13',
        startTime: '13:00',
        endTime: '15:00',
        answer: 'maybe',
        note: '2時までなら',
        seenSeq: 12,
      },
    ],
  };

  it('断片の鍵をこのタブに移して断片を消し、Bearer で読み、答えを送る', async () => {
    const token = 'A'.repeat(43);
    window.history.replaceState(null, '', `/answer#${token}`);
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) });
        if (init?.method === 'POST') {
          const answered = {
            ...view,
            candidates: [{ ...view.candidates[0], answer: 'yes', seenSeq: 20 }, view.candidates[1]],
          };
          return new Response(JSON.stringify({ status: 'ok', view: answered }), { status: 200 });
        }
        return new Response(JSON.stringify({ view }), { status: 200 });
      }),
    );
    await step(() => root.render(<AnswerRoot />));
    await step(async () => {});
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('maniau.answerToken')).toBe(token);
    expect(calls[0]?.init?.headers).toEqual({ authorization: `Bearer ${token}` });
    expect(host.textContent).toContain('近所のサトウさん（架空）へ');
    expect(host.textContent).toContain('今の答え：たぶん（2時までなら）');
    expect(host.textContent).toContain('このリンクを持つ人はだれでも答えられます。');
    await step(() => button('○ はい')?.click());
    await step(async () => {});
    const post = calls.find((c) => c.init?.method === 'POST');
    expect(post?.init?.headers).toEqual({
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    });
    const body = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ candidateId: 'c1', rev: 1, seenSeq: 0, answer: 'yes' });
    expect(typeof body.operationId).toBe('string');
    expect(host.textContent).toContain('答えを送りました。');
  });

  it('鍵が無ければ、受け取ったリンクを開き直すよう言う。効かない鍵は、止められたか出し直されたと言う', async () => {
    window.history.replaceState(null, '', '/answer');
    await step(() => root.render(<AnswerRoot />));
    // 家族の決めた言葉が届く前は、端末の言葉（この試験の端末は英語）。
    expect(host.textContent).toContain('No link found. Please open the link you received again.');
    await step(() => root.unmount());
    root = createRoot(host);
    sessionStorage.setItem('maniau.answerToken', 'B'.repeat(43));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'linkInvalid' }), { status: 401 })),
    );
    await step(() => root.render(<AnswerRoot />));
    await step(async () => {});
    expect(host.textContent).toContain('This link can’t be used');
  });
});

describe('同じタブで別のリンクを開く', () => {
  const viewOf = (name: string) => ({
    what: '練習',
    name,
    language: 'ja',
    candidates: [
      { id: 'c1', rev: 1, date: '2026-12-12', startTime: '09:00', endTime: '12:00', seenSeq: 0 },
    ],
  });
  const tokenA = 'a'.repeat(43);
  const tokenB = 'b'.repeat(43);
  const bearer = (init?: RequestInit) =>
    String((init?.headers as Record<string, string> | undefined)?.authorization ?? '');

  it('A の後に B のリンクを開くと、B の頁に作り直し、B の鍵で送る（A の入力・遅れた返事を残さない）', async () => {
    let releaseA: (() => void) | undefined;
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        const who = bearer(init).endsWith(tokenA) ? 'A' : 'B';
        if (init?.method === 'POST') {
          posts.push(who);
          return new Response(JSON.stringify({ status: 'ok', view: viewOf(`${who}さん`) }), {
            status: 200,
          });
        }
        // A の読み込みは遅れて届く（B に替えた後）。
        if (who === 'A') await new Promise<void>((resolve) => (releaseA = resolve));
        return new Response(JSON.stringify({ view: viewOf(`${who}さん`) }), { status: 200 });
      }),
    );
    window.history.replaceState(null, '', `/answer#${tokenA}`);
    await step(() => root.render(<AnswerRoot />));
    // A の頁は読み込み中のまま、同じタブで B のリンクを開く（断片だけが替わる）。
    window.location.hash = tokenB;
    await step(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await step(async () => {});
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('maniau.answerToken')).toBe(tokenB);
    expect(host.textContent).toContain('Bさんへ');
    // 遅れて届いた A の返事は、作り直した頁に当てない。
    await step(async () => releaseA?.());
    await step(async () => {});
    expect(host.textContent).toContain('Bさんへ');
    expect(host.textContent).not.toContain('Aさんへ');
    await step(() => button('○ はい')?.click());
    await step(async () => {});
    expect(posts).toEqual(['B']);
  });

  it('鍵の形でない断片を開くと、前の鍵を捨て、受け取ったリンクを開き直すよう言う', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ view: viewOf('Aさん') }), { status: 200 })),
    );
    window.history.replaceState(null, '', `/answer#${tokenA}`);
    await step(() => root.render(<AnswerRoot />));
    await step(async () => {});
    expect(host.textContent).toContain('Aさんへ');
    window.location.hash = 'broken';
    await step(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    expect(sessionStorage.getItem('maniau.answerToken')).toBeNull();
    expect(host.textContent).not.toContain('Aさんへ');
    expect(host.textContent).toContain('No link found');
  });
});

describe('送りの結果が分からない時', () => {
  it('サーバーの途中の失敗（503）は、届いたか分からないと言い、同じ答えの送り直しは同じ操作 ID で確かめる', async () => {
    const token = 'c'.repeat(43);
    const one = {
      what: '練習',
      name: 'Cさん',
      language: 'ja',
      candidates: [
        { id: 'c1', rev: 1, date: '2026-12-12', startTime: '09:00', endTime: '12:00', seenSeq: 0 },
      ],
    };
    const ops: string[] = [];
    let first = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          ops.push(String((JSON.parse(String(init.body)) as { operationId: string }).operationId));
          if (first) {
            first = false;
            return new Response('', { status: 503 });
          }
          const saved = {
            ...one,
            candidates: [{ ...one.candidates[0], answer: 'yes', seenSeq: 9 }],
          };
          return new Response(JSON.stringify({ status: 'noop', view: saved }), { status: 200 });
        }
        return new Response(JSON.stringify({ view: one }), { status: 200 });
      }),
    );
    window.history.replaceState(null, '', `/answer#${token}`);
    await step(() => root.render(<AnswerRoot />));
    await step(async () => {});
    await step(() => button('○ はい')?.click());
    await step(async () => {});
    expect(host.textContent).toContain('届いたか分かりません');
    expect(host.textContent).not.toContain('送れませんでした');
    await step(() => button('○ はい')?.click());
    await step(async () => {});
    expect(ops).toHaveLength(2);
    expect(ops[1]).toBe(ops[0]);
    expect(host.textContent).toContain('今の答え：はい');
  });
});
