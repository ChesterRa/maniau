import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

describe('API', () => {
  const app = createApp();

  it('動いていることを返す', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('デモの家庭は、知らない段では作らない', async () => {
    const response = await app.request('/api/demo/sessions', {
      method: 'POST',
      body: JSON.stringify({ stage: 'nope' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.status).toBe(400);
  });
});
