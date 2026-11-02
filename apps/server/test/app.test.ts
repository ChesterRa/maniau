import { DomainEvent, Household } from '@maniau/core';
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

  it('デモの段の事象を、型に合う形で返す。知らない段は 404', async () => {
    const response = await app.request('/api/demo/stage/backup');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { now: string; events: unknown[]; stages: unknown[] };
    expect(body.now).toBe('2026-11-30T18:10+09:00');
    expect(body.stages).toHaveLength(5);
    for (const event of body.events) DomainEvent.parse(event);
    expect((await app.request('/api/demo/stage/nope')).status).toBe(404);
  });
});
