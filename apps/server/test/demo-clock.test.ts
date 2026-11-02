// デモの時計：画面の上のデモの操作から進めると、その家庭の画面の今が進み、計画はその時刻で解き直す。戻せない。
import { expect, it } from 'vitest';
import { demoSessions } from '../src/demo-sessions';

it('デモの家庭で時計を進めると、画面の今が進む（戻すのは断る）', async () => {
  const sessions = demoSessions();
  const id = sessions.create('asked');
  const before = await sessions.view(id, 'a');
  expect(before?.now).toBe('2026-11-26T12:10+09:00');
  const later = '2026-11-27T12:10+09:00';
  const moved = await sessions.command(id, 'a', 'clock-1', { type: 'advanceClock', to: later });
  expect(moved?.result.status).toBe('ok');
  expect(moved?.view.now).toBe(later);
  expect(moved?.view.plan.now).toBe(later);
  const back = await sessions.command(id, 'a', 'clock-2', {
    type: 'advanceClock',
    to: '2026-11-26T12:10+09:00',
  });
  expect(back?.result).toMatchObject({ status: 'invalid', reason: 'clockBackwards' });
});
