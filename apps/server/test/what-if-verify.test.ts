// 「断られたら？」の仮の計算を、計画のエンジンと別に書いた検証器で確かめる：仮の返事は元の事象の列を変えず、
// 仮の事象と組んだ計画は違反が無く、仮の計画を本当の事象だけと組むと違反として見つかる（取り違えれば分かる）。

import { verifyPlan } from '@maniau/verify';
import { expect, it } from 'vitest';
import { previewCommand } from '../src/commands';
import { DEMO_STAGES, demoEvents, demoPlan } from '../src/demo';
import { previewChange } from '../src/preview';

for (const stage of ['asked', 'chase', 'backup'] as const) {
  it(`${stage}: 仮の返事は独立の事象列にのみ入り、その計画は検証器が見られる`, () => {
    const events = [...demoEvents(stage)];
    const original = JSON.stringify(events);
    const at = DEMO_STAGES.find((s) => s.id === stage)?.now;
    if (!at) throw new Error('clock missing');
    const result = previewCommand(
      events,
      { memberId: 'b', now: at },
      { type: 'recordReply', requestId: 'r-grandma', reply: 'no' },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(JSON.stringify(events)).toBe(original);
    expect(result.added.filter((event) => event.type === 'externalReplyRecorded')).toHaveLength(1);
    expect(result.before.requests.find((r) => r.requestId === 'r-grandma')?.state).toBe(
      'awaitingReply',
    );
    expect(result.after.requests.find((r) => r.requestId === 'r-grandma')?.state).toBe(
      'turnedDown',
    );
    const shown = previewChange(
      events,
      { memberId: 'b', now: at },
      { type: 'recordReply', requestId: 'r-grandma', reply: 'no' },
    );
    if ('reason' in shown) throw new Error(shown.reason);
    const key = result.before.requests.find((r) => r.requestId === 'r-grandma')?.basis
      .arrangementKey;
    expect(shown.arrangement).toEqual(
      result.after.arrangements.find((a) => a.live && a.key === key),
    );
    const verification = verifyPlan({
      household: demoPlan(stage).household,
      plan: result.after,
      events: [...events, ...result.added],
    });
    expect(verification.issues.filter((issue) => issue.kind === 'violation')).toEqual([]);
    const mixed = verifyPlan({ household: demoPlan(stage).household, plan: result.after, events });
    expect(mixed.issues.some((issue) => issue.kind === 'violation')).toBe(true);
  });
}
