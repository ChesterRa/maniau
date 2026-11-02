// 知らせの Service Worker：押されたら画面を開く。前から開いていた画面には、身元を確かめ直させる
// （ログインが替わった後かもしれない）。偽の self で public/sw.js を動かす。
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const code = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

function worker(windows: unknown[]) {
  const listeners = new Map<string, (event: unknown) => void>();
  const opened: string[] = [];
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
      },
    },
    registration: { showNotification: async () => {} },
  };
  runInNewContext(code, { self });
  const click = async () => {
    let waited: Promise<unknown> = Promise.resolve();
    let closed = false;
    listeners.get('notificationclick')?.({
      notification: {
        close: () => {
          closed = true;
        },
      },
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise;
      },
    });
    await waited;
    return closed;
  };
  return { click, opened };
}

describe('知らせの Service Worker', () => {
  it('前から開いていた画面は、前に出す時に、身元を確かめ直させる', async () => {
    const posted: string[] = [];
    let focused = 0;
    const client = {
      postMessage: (message: { type: string }) => posted.push(message.type),
      focus: async () => {
        focused += 1;
      },
    };
    const sw = worker([client]);
    expect(await sw.click()).toBe(true);
    expect(posted).toEqual(['maniau:opened']);
    expect(focused).toBe(1);
    expect(sw.opened).toEqual([]);
  });

  it('開いた画面が無ければ、入口を開く（知らせの中の URL は使わない）', async () => {
    const sw = worker([]);
    expect(await sw.click()).toBe(true);
    expect(sw.opened).toEqual(['/']);
  });
});
