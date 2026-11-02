import { Household } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';

describe('API', () => {
  const app = createApp();

  it('動いていることを返す', async () => {
    const response = await app.request('/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('デモの家族を、型に合う形で返す', async () => {
    const response = await app.request('/api/demo/household');
    expect(response.status).toBe(200);
    const household = Household.parse(await response.json());
    expect(household.members.map((m) => m.id)).toEqual(['a', 'b', 'c', 'g']);
  });
});
