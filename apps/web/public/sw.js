// 知らせを受けて出すだけの Service Worker（02-foundation §9）。家族の API の応答は控えない（fetch を
// 扱わないので、画面の読み書きは、いつもサーバーへ行く）。知らせから開く先は、いつも画面の入口で、
// 開いた時に今の身元で確かめ直す（知らせの中の URL は使わない）。
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'まにあう';
  const body = typeof data.body === 'string' ? data.body : '';
  const tag = typeof data.tag === 'string' && data.tag ? data.tag : 'maniau';
  event.waitUntil(self.registration.showNotification(title, { body, tag, icon: '/icon-192.png' }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          // 前から開いていた画面は、ログインが替わった後かもしれないので、身元を確かめ直させる
          // （確かめる間、前の人の画面は出さない）。
          client.postMessage({ type: 'maniau:opened' });
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow('/');
    })(),
  );
});
