// @vitest-environment happy-dom
// 一言の候補の記録：届いたか分からない前の操作が残る間は送らない（後から届いた前の操作が、記録を上書き
// しないように。命令の送り方と同じ）。
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { useDemoSession } from '../src/family';
import { installFetch, step, take } from './fake-fetch';

let demo: ReturnType<typeof useDemoSession> | undefined;
function Probe() {
  demo = useDemoSession('chase', 'b');
  return null;
}

it('届いたか不明な操作を確かめる前に、一言の候補を新しい操作として記録しない', async () => {
  const calls = installFetch();
  const root = createRoot(document.createElement('div'));
  await step(() => root.render(<Probe />));
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
  await step(() => {
    void demo?.send({ type: 'recordReply', requestId: 'r-grandma', reply: 'no' });
  });
  await step(() => take(calls, (c) => c.url.endsWith('/commands')).drop());
  expect(demo?.notice).toBe('uncertain');
  await step(() => {
    void demo?.confirm('p1', 'confirm-1');
  });
  expect(calls.filter((c) => c.url.endsWith('/proposals/p1'))).toHaveLength(0);
  await step(() => root.unmount());
});

it('一言の記録が届いたか分からない間は、ほかの命令も新しい記録も送らず、送り直しは同じ ID で行う', async () => {
  const calls = installFetch();
  const root = createRoot(document.createElement('div'));
  await step(() => root.render(<Probe />));
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
  await step(() => {
    void demo?.confirm('p1', 'confirm-1');
  });
  await step(() => take(calls, (c) => c.url.endsWith('/proposals/p1')).drop());
  expect(demo?.notice).toBe('uncertain');
  // 新しい命令と、別の候補の記録は送らない（後から届いた前の記録と、順番を入れ替えない）。
  await step(() => {
    void demo?.send({ type: 'recordReply', requestId: 'r-grandma', reply: 'no' });
    void demo?.confirm('p2', 'confirm-2');
  });
  expect(calls.filter((c) => c.url.endsWith('/commands'))).toHaveLength(0);
  expect(calls.filter((c) => c.url.endsWith('/proposals/p2'))).toHaveLength(0);
  // 上の知らせの「もう一度送る」は、同じ候補を同じ操作 ID で送り直す。
  await step(() => {
    void demo?.retry();
  });
  const again = take(calls, (c) => c.url.endsWith('/proposals/p1'));
  expect(again.body?.operationId).toBe('confirm-1');
  await step(() => again.respond(200, { view: { throughSeq: 13 } }));
  expect(demo?.notice).toBeUndefined();
  // 確かめた後は、新しい命令を送れる。
  await step(() => {
    void demo?.send({ type: 'recordReply', requestId: 'r-grandma', reply: 'no' });
  });
  expect(calls.filter((c) => c.url.endsWith('/commands'))).toHaveLength(1);
  await step(() => root.unmount());
});
