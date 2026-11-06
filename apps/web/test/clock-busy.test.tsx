// @vitest-environment happy-dom
// 試用の時計：進める命令の返事を待つ間は「+1時間」「+1日」を押せなくする（待つ間に押しても、送られずに消える
// ので、押せないと見せる）。返事が来たら押せるようにし、次は進んだ時計から進める。「操作」を閉じて開き直しても、
// 待つ間は押せない。返事が届かなかった時も押せるように戻し、届いたか分からない操作の知らせは今までどおり出す。
// 架空の家族だけ（DOM の試験では、ファイルを読むデモの組み立てを使わない）。
import { DomainEvent, Household } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { viewFor } from '../../server/src/views';
import { App } from '../src/App';
import i18n from '../src/i18n';
import { type Call, installFetch, step, take } from './fake-fetch';

const NOW = '2026-11-25T19:31+09:00';
const NEXT_DAY = '2026-11-26T19:31+09:00';
const DAY_AFTER = '2026-11-27T19:31+09:00';
const SET_AT = '2026-11-24T21:00+09:00';
const household = Household.parse({
  id: 'trial-own',
  region: 'JP',
  timeZone: 'Asia/Tokyo',
  members: [
    { id: 'a1', kind: 'adult', name: '大人A' },
    { id: 'c1', kind: 'child', name: '子H' },
  ],
  places: [],
  routines: [],
  careOptions: [],
});
const events = [
  DomainEvent.parse({
    id: 'trial-1',
    householdId: household.id,
    seq: 1,
    version: 1,
    occurredAt: SET_AT,
    recordedAt: SET_AT,
    actorId: 'a1',
    type: 'householdSet',
    household,
  }),
];
const viewAt = (at: string) => viewFor(events, 'a1', at);

let calls: Call[] = [];
let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  calls = installFetch();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await i18n.changeLanguage('ja');
  try {
    localStorage.clear();
  } catch {
    // 試験の環境に端末の保存が無くても続ける。
  }
});
afterEach(async () => {
  await step(() => root.unmount());
  host.remove();
});

const t = (key: string) => i18n.t(key);
const button = (label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === label);
const press = async (label: string) => {
  const found = button(label);
  if (!found) throw new Error(`押す物が無い：${label}`);
  await step(() => found.click());
};
const commands = () => calls.filter((c) => c.url === '/api/demo/sessions/s1/commands');
const answer = (at: string) =>
  step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions/s1/commands').respond(200, {
      result: { status: 'ok', throughSeq: 2 },
      view: viewAt(at),
    }),
  );

/** 試用（見本の家族として始め、中身は架空の小さな家族）を始め、「操作」を開く。 */
async function begin() {
  await step(() => root.render(<App />));
  await step(() => take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'demo' }));
  await press(t('start.sample'));
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions' && c.method === 'POST').respond(200, {
      sessionId: 's1',
      trial: 'sample',
      household,
      readings: [],
      stages: [{ id: 'arrived', now: NOW, viewer: 'a1' }],
    }),
  );
  await step(() =>
    take(calls, (c) => c.url.startsWith('/api/demo/sessions/s1/view')).respond(200, viewAt(NOW)),
  );
  await press(t('trial.controls'));
}

it('返事を待つ間は押せず、閉じて開き直しても同じ。返事の後は、進んだ時計から進める', async () => {
  await begin();
  const plusDay = () => button(t('demo.plusDay'));
  const plusHour = () => button(t('demo.plusHour'));
  expect(plusDay()?.disabled).toBe(false);

  await press(t('demo.plusDay'));
  expect(commands().map((c) => c.body?.command)).toEqual([{ type: 'advanceClock', to: NEXT_DAY }]);
  expect(plusDay()?.disabled).toBe(true);
  expect(plusHour()?.disabled).toBe(true);
  // 押せない間に押しても、送らない。
  await step(() => plusDay()?.click());
  await step(() => plusHour()?.click());
  expect(commands()).toHaveLength(1);

  // 「操作」を閉じて開き直しても、返事を待つ間は押せない。
  await press(t('trial.close'));
  expect(plusDay()).toBeUndefined();
  await press(t('trial.controls'));
  expect(plusDay()?.disabled).toBe(true);

  // 返事が来たら押せる。次は進んだ時計（翌日）から、もう一日進める。
  await answer(NEXT_DAY);
  expect(plusDay()?.disabled).toBe(false);
  expect(plusHour()?.disabled).toBe(false);
  await press(t('demo.plusDay'));
  expect(commands().at(-1)?.body?.command).toEqual({ type: 'advanceClock', to: DAY_AFTER });
  expect(commands()).toHaveLength(2);
});

it('返事が届かなかった時も押せるように戻し、届いたか分からない操作の知らせを出す', async () => {
  await begin();
  await press(t('demo.plusHour'));
  expect(button(t('demo.plusHour'))?.disabled).toBe(true);
  await step(() => take(calls, (c) => c.url === '/api/demo/sessions/s1/commands').drop());
  expect(button(t('demo.plusHour'))?.disabled).toBe(false);
  expect(button(t('demo.plusDay'))?.disabled).toBe(false);
  expect(host.textContent).toContain(t('notice.uncertain'));
});

it('別の場面に替えたら、前の試用の返事を待たない。前の返事が後から届いても、今の待ちは解かない', async () => {
  await begin();
  const plusDay = () => button(t('demo.plusDay'));
  const commandsOf = (id: string) =>
    calls.filter((c) => c.url === `/api/demo/sessions/${id}/commands`);
  // 前の試用で時計を進め、返事を待つ間に、用意した場面へ替える。
  await press(t('demo.plusDay'));
  expect(plusDay()?.disabled).toBe(true);
  await press(t('trial.scenes'));
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions' && c.method === 'POST').respond(200, {
      sessionId: 's2',
      household,
      readings: [],
      stages: [{ id: 'arrived', now: NOW, viewer: 'a1' }],
    }),
  );
  await step(() =>
    take(calls, (c) => c.url.startsWith('/api/demo/sessions/s2/view')).respond(200, viewAt(NOW)),
  );
  // 新しい場面の時計は、前の試用の返事を待たずに押せる。
  expect(plusDay()?.disabled).toBe(false);
  await press(t('demo.plusDay'));
  expect(commandsOf('s2').map((c) => c.body?.command)).toEqual([
    { type: 'advanceClock', to: NEXT_DAY },
  ]);
  expect(plusDay()?.disabled).toBe(true);
  // 前の試用の返事が後から届いても、新しい場面の待ちは解かない。
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions/s1/commands').respond(200, {
      result: { status: 'ok', throughSeq: 2 },
      view: viewAt(NEXT_DAY),
    }),
  );
  expect(plusDay()?.disabled).toBe(true);
  // 新しい場面の返事で、押せるように戻る。
  await step(() =>
    take(calls, (c) => c.url === '/api/demo/sessions/s2/commands').respond(200, {
      result: { status: 'ok', throughSeq: 2 },
      view: viewAt(NEXT_DAY),
    }),
  );
  expect(plusDay()?.disabled).toBe(false);
  expect(commandsOf('s1')).toHaveLength(1);
});
