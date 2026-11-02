// @vitest-environment happy-dom
// 画面とサーバーの返事の行き違い（遅れた返事・使う人の切り替え・通信の途切れ）を、偽の fetch で順に
// 起こす。隔離したブラウザでの確かめで見つかった例を、ここで固定する。
import type { Command } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PhotoResult, type SendResult, type SessionView, useDemoSession } from '../src/family';
import { type Call, installFetch, step, take as takeFrom } from './fake-fetch';

type Demo = ReturnType<typeof useDemoSession>;

const COMMAND = { type: 'answer', unknownId: 'u', value: 'yes' } as Command;
const view = (throughSeq: number) => ({ throughSeq }) as SessionView;
const ok = (seen: SessionView) => ({
  result: { status: 'ok', throughSeq: seen.throughSeq },
  view: seen,
});

let calls: Call[] = [];
let root: Root;
let demo: Demo | undefined;

function Probe({ member }: { member: string }) {
  demo = useDemoSession('arrived', member);
  return null;
}

const render = (member: string) => step(() => root.render(<Probe member={member} />));

const isSession = (c: Call) => c.url === '/api/demo/sessions';
const isView = (member: string) => (c: Call) => c.url.endsWith(`/view?member=${member}`);
const isCommand = (c: Call) => c.url.endsWith('/commands');
const take = (match: (c: Call) => boolean) => takeFrom(calls, match);
function send(): { result: () => SendResult | undefined } {
  let result: SendResult | undefined;
  void demo?.send(COMMAND).then((r) => {
    result = r;
  });
  return { result: () => result };
}

beforeEach(async () => {
  calls = installFetch();
  root = createRoot(document.createElement('div'));
  await render('a');
  await step(() =>
    take(isSession).respond(200, {
      sessionId: 's1',
      household: { members: [] },
      readings: [],
      stages: [],
    }),
  );
});

afterEach(async () => {
  await step(() => root.unmount());
  demo = undefined;
});

describe('画面の返事の行き違い', () => {
  it('A→B→A と戻っても、替える前に送った命令の返事は使わず、移る等もさせない（読み直す）', async () => {
    await step(() => take(isView('a')).respond(200, view(12)));
    let sent: ReturnType<typeof send> | undefined;
    await step(() => {
      sent = send();
    });
    const command = take(isCommand);
    await render('b');
    await step(() => take(isView('b')).respond(200, view(12)));
    await render('a');
    const fresh = view(12);
    await step(() => take(isView('a')).respond(200, fresh));
    // 替える前の A の命令の返事が、遅れて届く。
    await step(() => command.respond(200, ok(view(13))));
    expect(sent?.result()).toEqual({ status: 'failed', reason: 'stale' });
    expect(demo?.view).toBe(fresh);
    expect(demo?.notice).toBeUndefined();
    // 今の画面は読み直す。
    const reread = view(13);
    await step(() => take(isView('a')).respond(200, reread));
    expect(demo?.view).toBe(reread);
  });

  it('返事の中身を読む間に使う人を替えたら、その中身で今の人の画面を消さない', async () => {
    await step(() => take(isView('a')).respond(200, view(12)));
    let sent: ReturnType<typeof send> | undefined;
    await step(() => {
      sent = send();
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 見出しは届いたが、中身はまだ。
    await step(() => take(isCommand).respond(200, ok(view(13)), gate));
    await render('b');
    const forB = view(13);
    await step(() => take(isView('b')).respond(200, forB));
    expect(demo?.view).toBe(forB);
    await step(release);
    expect(sent?.result()).toEqual({ status: 'failed', reason: 'stale' });
    expect(demo?.view).toBe(forB);
  });

  it('同じ人の画面で、遅れて届いた古い読み直しが、後の命令の返事を上書きしない', async () => {
    await step(() => take(isView('a')).respond(200, view(12)));
    await step(() => {
      send();
    });
    // 命令の返事が途切れ、読み直しが始まる（読み直しは遅れる）。
    await step(() => take(isCommand).drop());
    expect(demo?.notice).toBe('uncertain');
    const slow = take(isView('a'));
    // 同じ操作を送り直すと、新しい見せる物が返る。
    await step(() => {
      void demo?.retry();
    });
    const newer = view(14);
    await step(() => take(isCommand).respond(200, ok(newer)));
    expect(demo?.view).toBe(newer);
    // 古い読み直しが後から届いても、新しい物を残す。
    await step(() => slow.respond(200, view(13)));
    expect(demo?.view).toBe(newer);
  });

  it('途切れた後は同じ操作 ID で送り直し、届いたら、読めなかった知らせも消す', async () => {
    await step(() => take(isView('a')).respond(200, view(12)));
    await step(() => {
      send();
    });
    const first = take(isCommand);
    await step(() => first.drop());
    // 読み直しも途切れる。
    await step(() => take(isView('a')).drop());
    expect(demo?.notice).toBe('uncertain');
    expect(demo?.failed).toBe(true);
    // 新しい操作は、届いたか分からない操作を確かめるまで送らない。
    await step(() => {
      send();
    });
    expect(calls.filter(isCommand)).toHaveLength(1);
    await step(() => {
      void demo?.retry();
    });
    const again = take(isCommand);
    expect(again.body?.operationId).toBe(first.body?.operationId);
    const seen = view(13);
    await step(() => again.respond(200, ok(seen)));
    expect(demo?.view).toBe(seen);
    expect(demo?.notice).toBeUndefined();
    expect(demo?.failed).toBe(false);
  });

  it('使う人を替えたら、前の人の届いたか分からない操作は送り直さない', async () => {
    await step(() => take(isView('a')).respond(200, view(12)));
    await step(() => {
      send();
    });
    await step(() => take(isCommand).drop());
    expect(demo?.notice).toBe('uncertain');
    await render('b');
    expect(demo?.notice).toBeUndefined();
    await step(() => {
      void demo?.retry();
    });
    expect(calls.filter(isCommand)).toHaveLength(1);
  });
});

describe('写真の書き起こしの返事', () => {
  it('大きすぎて断られたら、途中の中継が JSON でない物を返しても、大きすぎると示す', async () => {
    await step(() => take(isView('a')).respond(200, view(12)));
    let result: PhotoResult | undefined;
    await step(() => {
      void demo
        ?.transcribe({ mediaType: 'image/jpeg', data: '/9j/', operationId: 'p-1' })
        .then((r) => {
          result = r;
        });
    });
    const notJson = Promise.reject(new SyntaxError('Unexpected token <'));
    notJson.catch(() => {});
    await step(() => take((c) => c.url.endsWith('/photos')).respond(413, undefined, notJson));
    expect(result).toEqual({ status: 'tooLarge' });
  });
});
