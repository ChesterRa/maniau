// @vitest-environment happy-dom
// デモの帯の「知らせの候補」：サーバーが作った候補を、閉じたまとめ（だれに何件か）と、開いた中のロック画面の文で
// 出す（送らない）。候補も止めた物も無ければ何も出さない。知らせの無い大人は「なし」、夜は朝の時刻、検証器が
// 止めた物は止めたと書く。
import type { Household } from '@maniau/core';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { DemoNotifications } from '../src/demo-notify';
import type { NotificationPreview } from '../src/family';
import i18n from '../src/i18n';
import { step } from './fake-fetch';

const household = {
  timeZone: 'Asia/Tokyo',
  members: [
    { id: 'a', kind: 'adult', name: '健太', active: true },
    { id: 'b', kind: 'adult', name: '彩', active: true },
  ],
} as unknown as Household;

async function render(preview: NotificationPreview | undefined, lang: 'ja' | 'en' = 'ja') {
  await i18n.changeLanguage(lang);
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() =>
    root.render(<DemoNotifications preview={preview} household={household} lang={lang} />),
  );
  return { host, root, summary: host.querySelector('summary')?.textContent ?? '' };
}

afterEach(async () => {
  await i18n.changeLanguage('ja');
});

it('返事待ちの場面：閉じたまとめに彩へ 1 件、開くとロック画面の文と、健太は「なし」', async () => {
  const { host, root, summary } = await render({
    blockedAll: false,
    members: [
      { memberId: 'a', now: [], blocked: 0 },
      { memberId: 'b', now: ['notify.backup'], blocked: 0 },
    ],
  });
  // 閉じて出す（帯を高くしない）。閉じたままで、送らないこと・だれに何件かが分かる。開くと、まだ送っていないとした時の物だと分かる。
  expect(host.querySelector('details')?.open).toBe(false);
  expect(summary).toBe('知らせの候補（デモでは送りません）：彩さんへ 1 件');
  expect(host.textContent).toContain(
    'まだ送っていないとした時の物です。夜は朝まで待たせ、検証器の門を通しています。',
  );
  expect(host.textContent).toContain(
    '彩さんへ：「返事を待つ間に、予備の案を押さえるか決める時が近づいています。」',
  );
  expect(host.textContent).toContain('健太さん：なし');
  await step(() => root.unmount());
});

it('候補も止めた物も無い時は、何も出さない', async () => {
  const none = await render({
    blockedAll: false,
    members: [
      { memberId: 'a', now: [], blocked: 0 },
      { memberId: 'b', now: [], blocked: 0 },
    ],
  });
  expect(none.host.textContent).toBe('');
  await step(() => none.root.unmount());
  const missing = await render(undefined);
  expect(missing.host.textContent).toBe('');
  await step(() => missing.root.unmount());
});

it('夜は朝の時刻を、二つ以上は件数の文を、止めた物は止めたと書く（日本語と英語）', async () => {
  const preview: NotificationPreview = {
    blockedAll: false,
    members: [
      { memberId: 'a', now: ['notify.cancel', 'notify.check'], blocked: 1 },
      {
        memberId: 'b',
        now: [],
        morning: { at: '2026-11-30T07:00+09:00', titles: ['notify.backup'] },
        blocked: 0,
      },
    ],
  };
  const ja = await render(preview);
  expect(ja.summary).toBe(
    '知らせの候補（デモでは送りません）：健太さんへ 2 件、彩さんへ 1 件、検証器が止めた 1 件',
  );
  expect(ja.host.textContent).toContain('健太さんへ：「確かめてほしいことが 2 件あります。」');
  expect(ja.host.textContent).toContain('健太さんへの 1 件は、検証器が止めました（送りません）');
  expect(ja.host.textContent).toMatch(/彩さんへ（夜なので 11\/30.*7:00 に）：「返事を待つ間に/);
  expect(ja.host.textContent).not.toContain('なし');
  await step(() => ja.root.unmount());
  const en = await render(preview, 'en');
  expect(en.summary).toBe(
    'Notifications (the demo sends none): 2 to 健太, 1 to 彩, and 1 stopped by the verifier',
  );
  expect(en.host.textContent).toContain('To 健太: “2 things need your attention.”');
  expect(en.host.textContent).toContain('1 for 健太 stopped by the verifier (not sent)');
  expect(en.host.textContent).toMatch(
    /To 彩 \(held for the night until .*7:00.*\): “While you wait/,
  );
  expect(en.host.textContent).not.toMatch(/demo\.notify/);
  await step(() => en.root.unmount());
});

it('計画の検証で全部を止めた時は、止めたと書く（「なし」だけにしない）', async () => {
  const { host, root, summary } = await render({
    blockedAll: true,
    members: [
      { memberId: 'a', now: [], blocked: 0 },
      { memberId: 'b', now: [], blocked: 0 },
    ],
  });
  expect(summary).toBe('知らせの候補（デモでは送りません）：検証器が全部を止めています');
  expect(host.textContent).toContain('計画の検証で問題が見つかったので、知らせを全部止めています');
  await step(() => root.unmount());
});
