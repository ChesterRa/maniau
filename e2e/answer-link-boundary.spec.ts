// 架空デモの実際のブラウザ二つ。相手ごとの範囲と作り直しを、相手の画面とは別に確かめる。
import { expect, test } from '@playwright/test';

test('二つの独立したブラウザから、自分のリンクの範囲だけを書き、作り直した前の鍵は使えない', async ({ browser, request }) => {
  const origin = 'http://127.0.0.1:18797';
  const made = await request.post(`${origin}/api/demo/sessions`, { data: { stage: 'arrived' } });
  expect(made.status()).toBe(200);
  const { sessionId } = await made.json() as { sessionId: string };
  const base = `${origin}/api/demo/sessions/${sessionId}`;
  let seq = 0;
  const command = async (value: Record<string, unknown>) => {
    const response = await request.post(`${base}/commands`, { data: { memberId: 'a', operationId: `guest-browser-${++seq}`, command: value } });
    expect(response.status()).toBe(200);
    return response.json();
  };
  const save = async (value: Record<string, unknown>) => {
    const response = await request.post(`${base}/change-preview`, { data: { memberId: 'a', command: value } });
    expect(response.status()).toBe(200);
    const { preview } = await response.json();
    return command({ ...value, seen: { throughSeq: preview.throughSeq, changes: preview.seen } });
  };
  const stated = await save({ type: 'stateNeed', text: '架空の集まり',
    interpretation: { what: '架空の集まり', shape: 'window', holdNeeded: false },
    candidates: [{ date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
      { date: '2026-12-11', startTime: '13:00', endTime: '15:00' }] });
  const itemId = stated.view.plan.requirements.find((r: { when?: unknown }) => r.when)?.basis.itemIds[0] as string | undefined;
  if (!itemId) throw new Error('item missing');
  const listed = await command({ type: 'setNeedPeople', itemId, members: [],
    guests: [{ name: '架空の相手 A' }, { name: '架空の相手 B' }], required: [], minCount: 1 });
  const persons = listed.view.plan.requirements.find((r: { when?: unknown }) => r.when)?.when.people as { id: string; name?: string }[];
  const personA = persons.find((p) => p.name === '架空の相手 A')?.id;
  const personB = persons.find((p) => p.name === '架空の相手 B')?.id;
  if (!personA || !personB) throw new Error('persons missing');
  const firstA = await command({ type: 'issueAnswerLink', itemId, personId: personA });
  const firstB = await command({ type: 'issueAnswerLink', itemId, personId: personB });
  const tokenA = firstA.result.answerLink?.token as string | undefined;
  const tokenB = firstB.result.answerLink?.token as string | undefined;
  if (!tokenA || !tokenB) throw new Error('test tokens missing');
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  try {
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto(`${origin}/api/answer`);
    await pageB.goto(`${origin}/api/answer`);
    const call = (page: typeof pageA, token: string, body?: Record<string, unknown>) =>
      page.evaluate(async ({ token, body }) => {
        const response = await fetch('/api/answer', {
          method: body ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, text: await response.text() };
      }, { token, body });
    const a = await call(pageA, tokenA);
    const b = await call(pageB, tokenB);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.text.includes('架空の相手 A')).toBe(true);
    expect(a.text.includes('架空の相手 B')).toBe(false);
    expect(b.text.includes('架空の相手 B')).toBe(true);
    expect(b.text.includes('架空の相手 A')).toBe(false);
    expect([a.text, b.text].some((s) => s.includes(sessionId) || s.includes(tokenA) || s.includes(tokenB))).toBe(false);
    const forged = await call(pageB, tokenB, { operationId: 'forged', candidateId: 'c1', rev: 1, seenSeq: 0, answer: 'yes', personId: personA });
    expect(forged.status).toBe(400);
    const replyA = await call(pageA, tokenA, { operationId: 'a-1', candidateId: 'c1', rev: 1, seenSeq: 0, answer: 'maybe', note: '午後なら' });
    const replyB = await call(pageB, tokenB, { operationId: 'b-1', candidateId: 'c1', rev: 1, seenSeq: 0, answer: 'yes' });
    expect([replyA.status, replyB.status]).toEqual([200, 200]);
    const owner = await (await request.get(`${base}/view?member=a`)).json();
    const answers = owner.plan.requirements.find((r: { when?: unknown }) => r.when)?.when.answers as { personId: string; value: string }[];
    expect(answers.find((x) => x.personId === personA)?.value).toBe('maybe');
    expect(answers.find((x) => x.personId === personB)?.value).toBe('yes');
    const replacement = await command({ type: 'issueAnswerLink', itemId, personId: personA });
    const next = replacement.result.answerLink?.token as string | undefined;
    if (!next) throw new Error('replacement missing');
    expect((await call(pageA, tokenA)).status).toBe(401);
    expect((await call(pageA, next)).status).toBe(200);
    expect((await command({ type: 'revokeAnswerLink', itemId, personId: personB })).result.status).toBe('ok');
    expect((await call(pageB, tokenB)).status).toBe(401);
    const noOwner = await pageB.evaluate(async (token) => {
      const response = await fetch(`/api/demo/sessions/${token}/view?member=a`, { headers: { authorization: `Bearer ${token}` } });
      return response.status;
    }, tokenB);
    expect(noOwner).toBe(404);
    expect(await (await request.get('http://127.0.0.1:18798/__count')).json()).toEqual({ calls: 0 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
