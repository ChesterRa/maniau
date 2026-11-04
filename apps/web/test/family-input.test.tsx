// @vitest-environment happy-dom
// 家族の試しの家庭で、お知らせ・一言を Claude で読む（W3）。送り先と本文（as を添え、使う人を名乗らない）、断りの
// 読み替え、読めるかどうかで欄を出す・出さない、「架空の文だけ」と送る物と上限の戻る時刻の文。架空のデモの家だけ。
import { DomainEvent } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import household from '../../../data/demo/household.json';
import { viewFor } from '../../server/src/views';
import { App } from '../src/App';
import {
  type HearResult,
  type Mode,
  type ReadResult,
  type SessionView,
  useFamilySession,
  useMode,
} from '../src/family';
import i18n from '../src/i18n';
import { type Call, installFetch, step, take } from './fake-fetch';

let calls: Call[] = [];
let root: Root;
let host: HTMLDivElement;
let live: ReturnType<typeof useFamilySession> | undefined;
let mode: Mode | undefined;

function FamilyProbe() {
  live = useFamilySession('b');
  return null;
}
function ModeProbe() {
  ({ mode } = useMode());
  return null;
}

beforeEach(async () => {
  calls = installFetch();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await i18n.changeLanguage('ja');
  try {
    localStorage.clear();
  } catch {
    // 試験の環境に端末の保存が無くても続ける。
  }
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const isView = (c: Call) => c.url === '/api/view?as=b';
const FIRST = { throughSeq: 3 } as SessionView;
const NEXT = { throughSeq: 4 } as SessionView;

async function family() {
  await step(() => root.render(<FamilyProbe />));
  await step(() => take(calls, isView).respond(200, FIRST));
}

describe('どちらの家庭か（読めるか）', () => {
  it('試しの家庭で読めるサーバーだけ、読める・聞けると持つ（true の時だけ）', async () => {
    await step(() => root.render(<ModeProbe />));
    await step(() =>
      take(calls, (c) => c.url === '/api/me').respond(200, {
        mode: 'family',
        memberId: 'b',
        canRead: true,
        canHear: 'yes',
      }),
    );
    expect(mode).toEqual({ kind: 'family', memberId: 'b', canRead: true });
  });
});

describe('家族の家庭でお知らせを読む', () => {
  const isNotice = (c: Call) => c.url === '/api/notices';
  const read = async (medium?: 'photo') => {
    let result: ReadResult | undefined;
    await step(() => {
      void live
        ?.read({
          text: '11/28 13時から倉庫の鍵を返してください。',
          sender: 'school',
          operationId: 'op-1',
          ...(medium ? { medium } : {}),
        })
        .then((r) => {
          result = r;
        });
    });
    return () => result;
  };

  it('as を添えて /api/notices へ送り、読めたら見せ直す（使う人を名乗らない・写真の印は送らない）', async () => {
    await family();
    const result = await read();
    const call = take(calls, isNotice);
    expect(call.body).toEqual({
      as: 'b',
      text: '11/28 13時から倉庫の鍵を返してください。',
      sender: 'school',
      operationId: 'op-1',
    });
    await step(() => call.respond(200, { view: NEXT, sourceId: 'u1', check: { items: [] } }));
    expect(result()).toMatchObject({ status: 'ok', sourceId: 'u1' });
    expect(live?.view).toBe(NEXT);
  });

  it('写真から書き起こした文は、家族の家庭ではまだ送らない', async () => {
    await family();
    const result = await read('photo');
    expect(result()).toEqual({ status: 'failed', reason: 'photoUnavailable' });
    expect(calls.some(isNotice)).toBe(false);
  });

  const refusals: [string, number, string, ReadResult['status']][] = [
    ['上限', 429, 'readingLimit', 'limit'],
    ['読んでいる途中', 429, 'readingBusy', 'busy'],
    ['読む間に前提が変わった', 409, 'readingStale', 'stale'],
    ['試しの家庭でない', 403, 'testHouseholdOnly', 'testOnly'],
    ['前の操作の結果が分からない', 409, 'readingUncertain', 'lost'],
  ];
  it('記録の途中の失敗は結果が分からない（同じ操作で確かめる）。モデルの失敗は、理由つきの失敗', async () => {
    await family();
    const stored = await read();
    await step(() =>
      take(calls, isNotice).respond(502, { error: 'readingFailed', reason: 'store' }),
    );
    expect(stored()).toEqual({ status: 'uncertain' });
    await step(() => take(calls, isView).respond(200, NEXT));
    const refused = await read();
    await step(() =>
      take(calls, isNotice).respond(502, { error: 'readingFailed', reason: 'refusal' }),
    );
    expect(refused()).toEqual({ status: 'failed', reason: 'refusal' });
  });
  for (const [label, status, error, expected] of refusals) {
    it(`断り：${label}`, async () => {
      await family();
      const result = await read();
      await step(() => take(calls, isNotice).respond(status, { error }));
      expect(result()?.status).toBe(expected);
    });
  }

  it('前の操作の結果が分からない時は、見せる物を読み直す（足したかもしれない）', async () => {
    await family();
    await read();
    await step(() => take(calls, isNotice).respond(409, { error: 'readingUncertain' }));
    await step(() => take(calls, isView).respond(200, NEXT));
    expect(live?.view).toBe(NEXT);
  });

  it('家族の大人でない・身元が替わった時は、前に読んだ物を見せない', async () => {
    await family();
    await read();
    await step(() => take(calls, isNotice).respond(403, { error: 'notAMember' }));
    expect(live?.denied).toBe(true);
    expect(live?.view).toBeUndefined();
  });
});

describe('家族の家庭で一言を読み、候補を記録する', () => {
  it('一言は /api/utterances へ、候補の記録は /api/proposals へ、どちらも as を添えて送る', async () => {
    await family();
    let heard: HearResult | undefined;
    await step(() => {
      void live?.hear('祖母はOKだった', 'op-h').then((r) => {
        heard = r;
      });
    });
    const utterance = take(calls, (c) => c.url === '/api/utterances');
    expect(utterance.body).toEqual({ as: 'b', operationId: 'op-h', text: '祖母はOKだった' });
    await step(() =>
      utterance.respond(200, { view: NEXT, reply: { kind: 'change', proposals: [] } }),
    );
    expect(heard).toMatchObject({ status: 'ok', throughSeq: 4 });

    let confirmed: { status: string } | undefined;
    await step(() => {
      void live?.confirm('p 1', 'op-c').then((r) => {
        confirmed = r;
      });
    });
    const proposal = take(calls, (c) => c.url === '/api/proposals/p%201');
    expect(proposal.body).toEqual({ as: 'b', operationId: 'op-c' });
    await step(() => proposal.respond(409, { error: 'proposalChanged' }));
    expect(confirmed).toEqual({ status: 'changed' });
  });

  it('一言の断り：前の操作の結果が分からない・身元が替わった', async () => {
    await family();
    let heard: HearResult | undefined;
    await step(() => {
      void live?.hear('祖母はOKだった', 'op-h').then((r) => {
        heard = r;
      });
    });
    await step(() =>
      take(calls, (c) => c.url === '/api/utterances').respond(409, { error: 'readingUncertain' }),
    );
    expect(heard).toEqual({ status: 'lost' });
    await step(() => {
      void live?.hear('祖母はOKだった', 'op-h2');
    });
    await step(() =>
      take(calls, (c) => c.url === '/api/utterances').respond(409, { error: 'identityChanged' }),
    );
    expect(live?.switched).toBe(true);
  });
});

describe('画面：読めるかどうかで欄を出し、試しの家庭の注意を書く', () => {
  // 架空のデモの家の情報だけの家庭（DOM の試験では、ファイルを読むデモの組み立てを使わない）。
  const AT = '2026-11-24T21:00+09:00';
  const view = viewFor(
    [
      DomainEvent.parse({
        id: 'e-1',
        householdId: household.id,
        seq: 1,
        version: 1,
        occurredAt: AT,
        recordedAt: AT,
        actorId: 'a',
        type: 'householdSet',
        household,
      }),
    ],
    'b',
    '2026-11-25T08:00+09:00',
  );
  const isMe = (c: Call) => c.url === '/api/me';
  const open = async (me: Record<string, unknown>) => {
    await step(() => root.render(<App />));
    await step(() => take(calls, isMe).respond(200, { mode: 'family', memberId: 'b', ...me }));
    await step(() => take(calls, isView).respond(200, view));
  };
  const say = () => host.querySelector('textarea[aria-label="ひとこと"]');

  it('読めない家庭では、一言の欄も、お知らせを入れる欄も出さない', async () => {
    await open({});
    expect(host.textContent).toContain(view.household.members.find((m) => m.id === 'b')?.name);
    expect(say()).toBeNull();
    expect(host.textContent).not.toContain('試しの家庭です');
  });

  it('読める試しの家庭では、一言の欄に「架空の文だけ」と送る物を書く', async () => {
    await open({ canRead: true, canHear: true });
    expect(say()).not.toBeNull();
    expect(host.textContent).toContain('試しの家庭です。架空の文だけを伝えてください。');
    // たたんだ時の一文にも「架空の文だけ」を残す（送る物の全文は開くと読める）。
    const summaries = [...host.querySelectorAll('summary')].map((s) => s.textContent);
    expect(summaries).toContain(
      '試しの家庭です。架空の文だけを伝えてください。一言と、家族・頼める人の名前、今の予定・頼み事が Anthropic に送られます。',
    );
    expect(host.textContent).not.toContain('このデモの予定');
  });
});
