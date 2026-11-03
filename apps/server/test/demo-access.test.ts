// デモだけのサーバーを Access の後ろに置く時：/api/* の要求ごとに Access のトークンを確かめ、無い・確かめ
// られない要求は断る（Access を通らずに届いた要求も止まる）。/api/health だけは中身が無いので除く。
// 設定しないサーバー（手元のデモ）は、前のとおりトークン無しで使える。身元の確かめは偽物に差し替える。

import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ACCESS_HEADER, type AccessVerifier } from '../src/auth/access';

const verifier: AccessVerifier = async (token) =>
  token === 'good' ? { issuer: 'https://team.example', subject: 'someone' } : undefined;

const json = { 'content-type': 'application/json' };
const ARR = 'arr:childCare:n1:i6:c';

describe('デモの入口で身元を確かめる', () => {
  const app = createApp({ demoAccess: verifier });

  it('トークンが無い・確かめられない要求は、会話を作らせず、見る物も返さない', async () => {
    for (const headers of [json, { ...json, [ACCESS_HEADER]: 'forged' }]) {
      const created = await app.request('/api/demo/sessions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ stage: 'arrived' }),
      });
      expect(created.status).toBe(401);
      expect(await created.json()).toEqual({ error: 'unauthenticated' });
    }
    const me = await app.request('/api/me');
    expect(me.status).toBe(401);
  });

  it('確かめたトークンなら、会話の作成・見る物・選んだら・命令が通る', async () => {
    const headers = { ...json, [ACCESS_HEADER]: 'good' };
    const created = await app.request('/api/demo/sessions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ stage: 'arrived' }),
    });
    expect(created.status).toBe(200);
    const { sessionId } = (await created.json()) as { sessionId: string };
    const view = await app.request(`/api/demo/sessions/${sessionId}/view?member=b`, { headers });
    expect(view.status).toBe(200);
    const preview = await app.request(
      `/api/demo/sessions/${sessionId}/preview?member=b&arrangement=${encodeURIComponent(ARR)}`,
      { headers },
    );
    expect(preview.status).toBe(200);
    const command = await app.request(`/api/demo/sessions/${sessionId}/commands`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        memberId: 'b',
        operationId: 'access-1',
        command: { type: 'advanceClock', to: '2026-11-26T19:31+09:00' },
      }),
    });
    expect(command.status).toBe(200);
    // 会話の ID を知っていても、確かめられないトークンでは見られない。
    const forged = await app.request(`/api/demo/sessions/${sessionId}/view?member=b`, {
      headers: { [ACCESS_HEADER]: 'forged' },
    });
    expect(forged.status).toBe(401);
    expect((await app.request('/api/me', { headers })).status).toBe(200);
  });

  it('/api/health は、トークン無しでも生存だけを返す（置き場所の healthcheck のため）', async () => {
    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });
});

it('設定しないサーバー（手元のデモ）は、前のとおりトークン無しで使える', async () => {
  const app = createApp();
  const created = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ stage: 'arrived' }),
  });
  expect(created.status).toBe(200);
});

it('デモの入口の確かめと家族の家庭は、同じサーバーで同時に使わない', () => {
  expect(() => createApp({ demoAccess: verifier, family: {} as never })).toThrow(
    '同じサーバーで同時に使わない',
  );
});
