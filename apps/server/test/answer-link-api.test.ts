// 相手の頁の口（/api/answer）：デモの家庭で、家族が出した一人ずつのリンクの鍵（Bearer）で読み書きする。効かない
// 鍵は、どれが違うかを言わずに同じ形で断る。別のサイトからの要求・JSON でない書き込み・数の上限も断る。
import type { PlanResult } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { MAX_LINK_REQUESTS_PER_MINUTE } from '../src/demo-sessions';

const JSON_HEADERS = { 'content-type': 'application/json' };

async function demo() {
  const app = createApp();
  const created = await app.request('/api/demo/sessions', {
    method: 'POST',
    body: JSON.stringify({ stage: 'arrived' }),
    headers: JSON_HEADERS,
  });
  const { sessionId } = (await created.json()) as { sessionId: string };
  const base = `/api/demo/sessions/${sessionId}`;
  let sequence = 0;
  const command = async (command: Record<string, unknown>) => {
    const response = await app.request(`${base}/commands`, {
      method: 'POST',
      body: JSON.stringify({ memberId: 'a', operationId: `api-${++sequence}`, command }),
      headers: JSON_HEADERS,
    });
    return (await response.json()) as {
      result: { status: string; reason?: string; answerLink?: { personId: string; token: string } };
      view: { plan: PlanResult };
    };
  };
  const save = async (asked: Record<string, unknown>) => {
    const shown = await app.request(`${base}/change-preview`, {
      method: 'POST',
      body: JSON.stringify({ memberId: 'a', command: asked }),
      headers: JSON_HEADERS,
    });
    const { preview } = (await shown.json()) as { preview: { throughSeq: number; seen: string } };
    return command({ ...asked, seen: { throughSeq: preview.throughSeq, changes: preview.seen } });
  };
  const answer = (token: string | undefined, init: RequestInit = {}) =>
    app.request('/api/answer', {
      ...init,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  return { command, save, answer };
}

async function withLink() {
  const d = await demo();
  const stated = await d.save({
    type: 'stateNeed',
    text: '12/9 か 12/11 の 13 時から 15 時、陽菜を見てもらう。',
    interpretation: { what: '陽菜を見てもらう', shape: 'window', forMemberId: 'c' },
    candidates: [
      { date: '2026-12-09', startTime: '13:00', endTime: '15:00' },
      { date: '2026-12-11', startTime: '13:00', endTime: '15:00' },
    ],
  });
  expect(stated.result.status).toBe('ok');
  const itemId = stated.view.plan.requirements.find((r) => r.when !== undefined)?.basis.itemIds[0];
  if (!itemId) throw new Error('候補の「すること」が無い');
  const listed = await d.command({
    type: 'setNeedPeople',
    itemId,
    members: ['g'],
    guests: [{ name: '近所のサトウさん' }],
    required: [],
    minCount: 1,
  });
  const guest = listed.view.plan.requirements
    .find((r) => r.when !== undefined)
    ?.when?.people.find((p) => p.kind === 'guest')?.id;
  if (!guest) throw new Error('名前だけの相手が無い');
  const issued = await d.command({ type: 'issueAnswerLink', itemId, personId: guest });
  const token = issued.result.answerLink?.token;
  if (!token) throw new Error('鍵が無い');
  // 家族の View にも、鍵とそのハッシュは出さない。
  expect(JSON.stringify(issued.view)).not.toContain(token);
  return { ...d, itemId, guest, token };
}

describe('相手の頁の口（/api/answer）', () => {
  it('鍵で読み、その人の物だけを見せる。効かない鍵は同じ形で断る', async () => {
    const d = await withLink();
    const read = await d.answer(d.token);
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('no-store');
    expect(read.headers.get('referrer-policy')).toBe('no-referrer');
    const body = (await read.json()) as { view: { name: string; candidates: unknown[] } };
    expect(body.view.name).toBe('近所のサトウさん');
    expect(body.view.candidates).toHaveLength(2);
    const text = JSON.stringify(body);
    for (const hidden of ['おばあちゃん', '健太', '彩', 'sessionId', 'tokenHash']) {
      expect(text).not.toContain(hidden);
    }
    const missing = await d.answer(undefined);
    const wrong = await d.answer('A'.repeat(43));
    const malformed = await d.answer('short');
    for (const response of [missing, wrong, malformed]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'linkInvalid' });
    }
  });

  it('書く：JSON だけ、同じサイトからだけ。見た後の別の答えは今の物を返して断る。止めたら効かない', async () => {
    const d = await withLink();
    const post = (body: unknown, headers: Record<string, string> = JSON_HEADERS) =>
      d.answer(d.token, { method: 'POST', body: JSON.stringify(body), headers });
    const yes = { operationId: 'p-1', candidateId: 'c1', rev: 1, seenSeq: 0, answer: 'yes' };
    expect((await post(yes, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(yes, { ...JSON_HEADERS, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ ...yes, extra: 1 })).status).toBe(400);
    const written = await post(yes);
    expect(written.status).toBe(200);
    const done = (await written.json()) as {
      status: string;
      view: { candidates: { id: string; answer?: string; seenSeq: number }[] };
    };
    expect(done.status).toBe('ok');
    expect(done.view.candidates[0]).toMatchObject({ id: 'c1', answer: 'yes' });
    const stale = await post({ ...yes, operationId: 'p-2', answer: 'no' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: 'answerChanged',
      view: { candidates: [{ id: 'c1', answer: 'yes' }, { id: 'c2' }] },
    });
    // 家族の計画では「リンクから」の答えとして数える。
    const revoked = await d.command({
      type: 'revokeAnswerLink',
      itemId: d.itemId,
      personId: d.guest,
    });
    const when = revoked.view.plan.requirements.find((r) => r.when !== undefined)?.when;
    expect(when?.answers.find((a) => a.personId === d.guest)?.sources[0]?.source).toBe('link');
    expect(when?.links).toContainEqual({ personId: d.guest, active: false });
    expect((await d.answer(d.token)).status).toBe(401);
    expect(
      (await post({ ...yes, operationId: 'p-3', seenSeq: done.view.candidates[0]?.seenSeq }))
        .status,
    ).toBe(401);
  });

  it('一つの鍵で受ける数に、一分あたりの上限がある', async () => {
    const d = await withLink();
    for (let i = 0; i < MAX_LINK_REQUESTS_PER_MINUTE; i++) {
      expect((await d.answer(d.token)).status).toBe(200);
    }
    const over = await d.answer(d.token);
    expect(over.status).toBe(429);
  });

  it('家族の画面の言明と同じ口でなければ、リンクを出せない人がいる（名簿の外）', async () => {
    const d = await withLink();
    const outside = await d.command({ type: 'issueAnswerLink', itemId: d.itemId, personId: 'b' });
    expect(outside.result).toMatchObject({ status: 'invalid', reason: 'personUnknown' });
  });
});
