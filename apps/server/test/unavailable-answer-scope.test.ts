// 架空の予定のリンクから、家族の「手が離せない時間」が相手の頁に出ないことを確認する。
import type { Household, HouseholdPreview, PlanResult } from '@maniau/core';
import { expect, it } from 'vitest';
import type { AnswerView } from '../src/answer-link';
import { createApp } from '../src/app';

it('候補と重なる占用を家族に出しても、相手にはその人の答えだけを返す', async () => {
  const app = createApp();
  const headers = { 'content-type': 'application/json' };
  const created = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ stage: 'club' }),
  });
  expect(created.status).toBe(200);
  const { sessionId } = (await created.json()) as { sessionId: string };
  const base = `/api/demo/sessions/${sessionId}`;
  const view = (await (await app.request(`${base}/view?member=a`)).json()) as {
    household: Household;
  };
  const edit = {
    ...view.household,
    unavailable: [
      { id: 'u-private', memberId: 'a', date: '2026-12-19', start: '09:30', end: '10:30' },
    ],
  };
  const previewResult = await app.request(`${base}/household-preview`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ memberId: 'a', household: edit }),
  });
  expect(previewResult.status).toBe(200);
  const { preview } = (await previewResult.json()) as { preview: HouseholdPreview };
  const command = async (operationId: string, body: unknown) =>
    app.request(`${base}/commands`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ memberId: 'a', operationId, command: body }),
    });
  const saved = await command('busy-save', {
    type: 'updateHousehold',
    household: edit,
    seen: { throughSeq: preview.throughSeq, changes: preview.seen },
  });
  expect(saved.status).toBe(200);
  const owner = (await saved.json()) as { view: { plan: PlanResult } };
  const c2 = owner.view.plan.requirements
    .find((r) => r.key === 'req:need:f-demo-club:i1')
    ?.when?.candidates.find((c) => c.id === 'c2');
  expect(c2?.unavailable).toEqual([
    {
      personId: 'a',
      unavailableId: 'u-private',
      start: '2026-12-19T09:30+09:00',
      end: '2026-12-19T10:30+09:00',
    },
  ]);
  const linkResponse = await command('busy-link', {
    type: 'issueAnswerLink',
    itemId: 'f-demo-club:i1',
    personId: 'g-coach',
  });
  expect(linkResponse.status).toBe(200);
  const link = (await linkResponse.json()) as { result: { answerLink?: { token: string } } };
  const token = link.result.answerLink?.token;
  if (!token) throw new Error('架空の相手の鍵が無い');
  const get = () => app.request('/api/answer', { headers: { authorization: `Bearer ${token}` } });
  const read = await get();
  expect(read.status).toBe(200);
  const guest = (await read.json()) as { view: AnswerView };
  expect(guest.view.candidates).toHaveLength(2);
  for (const secret of ['u-private', 'unavailable', '健太', '彩', 'sessionId', 'tokenHash'])
    expect(JSON.stringify(guest).includes(secret)).toBe(false);
  const candidate = guest.view.candidates.find((c) => c.id === 'c2');
  if (!candidate) throw new Error('架空の候補が無い');
  const reply = await app.request('/api/answer', {
    method: 'POST',
    headers: {
      ...headers,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      operationId: 'guest-response',
      candidateId: candidate.id,
      rev: candidate.rev,
      seenSeq: candidate.seenSeq,
      answer: 'yes',
    }),
  });
  expect(reply.status).toBe(200);
  const returned = (await reply.json()) as { status: string };
  expect(returned.status).toBe('ok');
  for (const secret of ['u-private', 'unavailable', '健太', '彩', 'sessionId', 'tokenHash'])
    expect(JSON.stringify(returned).includes(secret)).toBe(false);
});
