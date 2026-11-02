// @vitest-environment happy-dom
// 知らせの登録：この端末を今の大人の宛先にする。iPhone はホーム画面に追加した時だけ。許可は押した時だけ
// 求める。宛先は、見ている大人と言葉を添えてサーバーに渡す。端末は偽物（本物の Push には触れない）。
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyBytes, type PushEnv, type PushSubscriptionLike, usePush } from '../src/push';
import { type Call, installFetch, step, take } from './fake-fetch';

const KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

let calls: Call[] = [];
let root: Root;
let push: ReturnType<typeof usePush> | undefined;
/** 画面に身元を確かめ直させた回数。 */
let switched = 0;

function fakeSubscription(endpoint: string): PushSubscriptionLike & { removed: boolean } {
  return {
    endpoint,
    removed: false,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'x' } }),
    async unsubscribe() {
      this.removed = true;
      return true;
    },
  };
}

function fakeEnv(options: {
  permission?: NotificationPermission;
  answer?: NotificationPermission;
  existing?: PushSubscriptionLike | null;
  needsInstall?: boolean;
}) {
  let permission = options.permission ?? 'default';
  let current = options.existing ?? null;
  const env = {
    supported: true,
    needsInstall: options.needsInstall ?? false,
    asked: 0,
    subscribedWith: undefined as Uint8Array | undefined,
    permission: () => permission,
    requestPermission: async () => {
      env.asked += 1;
      permission = options.answer ?? 'granted';
      return permission;
    },
    subscription: async () => current,
    subscribe: async (key: Uint8Array) => {
      env.subscribedWith = key;
      current = fakeSubscription('https://web.push.apple.com/new');
      return current;
    },
  };
  return env satisfies PushEnv;
}

function Probe({ env, member, lang }: { env: PushEnv; member: string; lang: 'ja' | 'en' }) {
  push = usePush(member, KEY, lang, {
    env,
    onSwitched: () => {
      switched += 1;
    },
  });
  return null;
}
const render = (env: PushEnv, member = 'b', lang: 'ja' | 'en' = 'ja') =>
  step(() => root.render(<Probe env={env} member={member} lang={lang} />));
const isRegister = (c: Call) => c.url === '/api/push/subscriptions' && c.method === 'POST';

beforeEach(() => {
  switched = 0;
  calls = installFetch();
  root = createRoot(document.createElement('div'));
});
afterEach(async () => {
  await step(() => root.unmount());
  push = undefined;
});

describe('知らせの登録', () => {
  it('iPhone でホーム画面に追加していなければ、追加を案内する（許可は求めない）', async () => {
    const env = fakeEnv({ needsInstall: true });
    await render(env);
    expect(push?.state).toBe('needsInstall');
    expect(env.asked).toBe(0);
    expect(calls).toEqual([]);
  });

  it('許可は押した時だけ求め、購読して、見ている大人と言葉を添えて登録する', async () => {
    const env = fakeEnv({});
    await render(env);
    expect(push?.state).toBe('off');
    expect(env.asked).toBe(0);
    await step(() => push?.enable());
    expect(env.asked).toBe(1);
    expect(env.subscribedWith).toEqual(keyBytes(KEY));
    const call = take(calls, isRegister);
    expect(call.body).toEqual({
      as: 'b',
      subscription: {
        endpoint: 'https://web.push.apple.com/new',
        keys: { p256dh: 'p', auth: 'x' },
      },
      language: 'ja',
      requestedAt: expect.any(Number),
    });
    await step(() => call.respond(200, { ok: true }));
    expect(push?.state).toBe('on');
  });

  it('許可されなければ、登録しない', async () => {
    const env = fakeEnv({ answer: 'denied' });
    await render(env);
    await step(() => push?.enable());
    expect(push?.state).toBe('denied');
    expect(calls).toEqual([]);
  });

  it('前から購読していれば、開いた時に今の大人と言葉で登録し直す（言葉を替えても）', async () => {
    const env = fakeEnv({
      permission: 'granted',
      existing: fakeSubscription('https://web.push.apple.com/old'),
    });
    await render(env, 'a');
    const first = take(calls, isRegister);
    expect(first.body?.as).toBe('a');
    await step(() => first.respond(200, { ok: true }));
    expect(push?.state).toBe('on');
    await render(env, 'a', 'en');
    const again = take(calls, isRegister);
    expect(again.body?.language).toBe('en');
    await step(() => again.respond(200, { ok: true }));
    expect(push?.state).toBe('on');
  });

  it('止めると、サーバーから外してから、端末の購読も外す', async () => {
    const existing = fakeSubscription('https://web.push.apple.com/old');
    const env = fakeEnv({ permission: 'granted', existing });
    await render(env);
    await step(() => take(calls, isRegister).respond(200, { ok: true }));
    await step(() => push?.disable());
    const call = take(calls, (c) => c.url === '/api/push/subscriptions' && c.method === 'DELETE');
    expect(call.body).toEqual({ as: 'b', endpoint: 'https://web.push.apple.com/old' });
    expect(existing.removed).toBe(false);
    await step(() => call.respond(200, { ok: true }));
    expect(existing.removed).toBe(true);
    expect(push?.state).toBe('off');
  });

  it('サーバーが断れば、オンとは見せない。使う人が替わったと言われた時だけ、身元を確かめ直させる', async () => {
    const env = fakeEnv({});
    await render(env);
    await step(() => push?.enable());
    await step(() => take(calls, isRegister).respond(409, { error: 'identityChanged' }));
    expect(push?.state).toBe('failed');
    expect(switched).toBe(1);
    // 同じ端末で、後から頼まれた登録が先に済んでいた：確かめ直しを繰り返させない。
    await step(() => push?.enable());
    await step(() => take(calls, isRegister).respond(409, { error: 'staleRegistration' }));
    expect(push?.state).toBe('failed');
    expect(switched).toBe(1);
  });

  it('止める時、サーバーが外したと答えなければ、端末の購読は外さない', async () => {
    const isDelete = (c: Call) => c.url === '/api/push/subscriptions' && c.method === 'DELETE';
    const existing = fakeSubscription('https://web.push.apple.com/old');
    const env = fakeEnv({ permission: 'granted', existing });
    await render(env);
    await step(() => take(calls, isRegister).respond(200, { ok: true }));
    for (const [status, error, recheck] of [
      [409, 'identityChanged', 1],
      [403, 'notAMember', 0],
      [500, undefined, 0],
    ] as const) {
      switched = 0;
      await step(() => push?.disable());
      await step(() => take(calls, isDelete).respond(status, { error }));
      expect(existing.removed, String(status)).toBe(false);
      expect(push?.state, String(status)).toBe('failed');
      expect(switched, String(status)).toBe(recheck);
    }
  });

  it('止める返事を待つ間に使う人が替われば、前の人の返事が後から届いても、端末の購読は外さない', async () => {
    const isDelete = (c: Call) => c.url === '/api/push/subscriptions' && c.method === 'DELETE';
    const existing = fakeSubscription('https://web.push.apple.com/old');
    const env = fakeEnv({ permission: 'granted', existing });
    await render(env, 'a');
    await step(() => take(calls, isRegister).respond(200, { ok: true }));
    await step(() => push?.disable());
    const late = take(calls, isDelete);
    // 同じ端末で彩に替わり、同じ購読を彩の物として登録し直す。
    await render(env, 'b');
    const again = take(calls, isRegister);
    expect(again.body?.as).toBe('b');
    await step(() => again.respond(200, { ok: true }));
    // 健太の「外した」が遅れて届く。
    await step(() => late.respond(200, { ok: true }));
    expect(existing.removed).toBe(false);
    expect(push?.state).toBe('on');
  });

  it('開いた時の購読の確かめを待つ間に使う人が替われば、前の人としては登録しない', async () => {
    const existing = fakeSubscription('https://web.push.apple.com/old');
    const waiting: (() => void)[] = [];
    const env = {
      ...fakeEnv({ permission: 'granted', existing }),
      subscription: () =>
        new Promise<PushSubscriptionLike | null>((resolve) => {
          waiting.push(() => resolve(existing));
        }),
    };
    await render(env, 'a');
    await render(env, 'b');
    // 健太の確かめが、彩の確かめより後に返る。
    await step(() => waiting[1]?.());
    await step(() => waiting[0]?.());
    expect(calls.filter(isRegister).map((c) => c.body?.as)).toEqual(['b']);
  });

  it('購読の確かめを待つ間に閉じたら、新しい購読を作らない', async () => {
    let release: (s: PushSubscriptionLike | null) => void = () => {};
    let lookups = 0;
    let subscribed = 0;
    const env = {
      ...fakeEnv({ answer: 'granted' }),
      // 開いた時の確かめはすぐ「無い」と返し、押した後の確かめは待たせる。
      subscription: () => {
        lookups += 1;
        if (lookups === 1) return Promise.resolve(null);
        return new Promise<PushSubscriptionLike | null>((resolve) => {
          release = resolve;
        });
      },
      subscribe: async () => {
        subscribed += 1;
        return fakeSubscription('https://web.push.apple.com/new');
      },
    };
    await render(env);
    await step(() => push?.enable());
    expect(lookups).toBe(2);
    await step(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await step(() => release(null));
    expect(subscribed).toBe(0);
    expect(calls.filter(isRegister)).toEqual([]);
  });

  it('閉じた後に許可の返事が来ても、購読も登録もしない', async () => {
    let answer: (p: NotificationPermission) => void = () => {};
    const env = {
      ...fakeEnv({}),
      requestPermission: () =>
        new Promise<NotificationPermission>((resolve) => {
          answer = resolve;
        }),
    };
    let subscribed = 0;
    env.subscribe = async () => {
      subscribed += 1;
      return fakeSubscription('https://web.push.apple.com/new');
    };
    await render(env);
    await step(() => push?.enable());
    await step(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await step(() => answer('granted'));
    expect(subscribed).toBe(0);
    expect(calls.filter(isRegister)).toEqual([]);
  });
});
