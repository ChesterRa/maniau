// 知らせの登録（02-foundation §9）。この端末を、今の大人の知らせの宛先にする。iPhone は、ホーム画面に
// 追加した時だけ知らせを受け取れる。登録したら、宛先をサーバーに渡す（大人ごとに一つ。同じ端末で使う
// 人が替われば、サーバーが前の人との結び付きを外す）。
import { useCallback, useEffect, useRef, useState } from 'react';

export type PushState =
  | 'checking'
  /** この端末・ブラウザでは受け取れない（または、サーバーに知らせが無い）。 */
  | 'unsupported'
  /** iPhone で、ホーム画面に追加していない。 */
  | 'needsInstall'
  /** 端末の設定で止めてある。 */
  | 'denied'
  | 'off'
  | 'on'
  | 'working'
  | 'failed';

export interface PushSubscriptionLike {
  endpoint: string;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
  unsubscribe(): Promise<boolean>;
}

/** 端末の力（試験で替える）。 */
export interface PushEnv {
  supported: boolean;
  needsInstall: boolean;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  subscription(): Promise<PushSubscriptionLike | null>;
  subscribe(applicationServerKey: Uint8Array): Promise<PushSubscriptionLike>;
}

export function browserPushEnv(): PushEnv {
  const supported =
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window;
  const ios = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as { standalone?: boolean }).standalone === true);
  let registration: Promise<ServiceWorkerRegistration> | undefined;
  const ready = () => {
    registration ??= navigator.serviceWorker
      .register('/sw.js')
      .then(() => navigator.serviceWorker.ready);
    return registration;
  };
  return {
    supported,
    needsInstall: ios && !standalone,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    subscription: async () => (await ready()).pushManager.getSubscription(),
    subscribe: async (applicationServerKey) =>
      (await ready()).pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey as BufferSource,
      }),
  };
}

/** VAPID の公開鍵（base64url）を、購読に渡すバイト列にする。 */
export function keyBytes(base64url: string): Uint8Array {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

const register = (memberId: string, language: string, subscription: PushSubscriptionLike) =>
  fetch('/api/push/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      as: memberId,
      subscription: subscription.toJSON(),
      language,
      // 頼んだ時（この端末の時計）。使う人が替わった後に、遅れて届いた前の人の登録で上書きしないため。
      requestedAt: Date.now(),
    }),
  });

/**
 * サーバーの返事。ログインの身元が画面の大人と替わっていれば switched（画面が身元を確かめ直す）。
 * それ以外の断り（外された・同じ端末の後の登録が先に済んだ・誤り）は failed。
 */
async function answer(response: Response): Promise<'ok' | 'switched' | 'failed'> {
  if (response.ok) return 'ok';
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  return response.status === 409 && body.error === 'identityChanged' ? 'switched' : 'failed';
}

/**
 * 今の大人の、この端末の知らせ。pushKey が無ければ（サーバーに知らせが無い）、出さない。言葉を
 * 替えたら、登録し直す（知らせの文の言葉）。使う人が替わった・画面を閉じた後は、前の人の操作の続き
 * （端末の購読を作る・外す）をしない。端末の購読は、同じ端末の次の人の物かもしれない。
 */
export function usePush(
  memberId: string,
  pushKey: string | undefined,
  language: 'ja' | 'en',
  options: { onSwitched?: () => void; env?: PushEnv } = {},
): { state: PushState; enable: () => void; disable: () => void } {
  const [state, setState] = useState<PushState>('checking');
  const envRef = useRef<PushEnv | undefined>(options.env);
  const device = useCallback(() => {
    envRef.current ??= browserPushEnv();
    return envRef.current;
  }, []);
  // 描画ごとに替わる関数でも、登録し直さない（最後の物を呼ぶ）。
  const switchedRef = useRef(options.onSwitched);
  switchedRef.current = options.onSwitched;
  /** 使う人・鍵・言葉が替わるたび、閉じた時に進める（前の代の続きを止める）。 */
  const epoch = useRef(0);
  /** 今の代の間だけ、状態を替え、続きをする。 */
  const scope = useCallback(() => {
    const mine = epoch.current;
    const live = () => epoch.current === mine;
    const set = (next: PushState) => {
      if (live()) setState(next);
    };
    /** サーバーが受けたか。断られたら failed にし、身元が替わっていれば、画面に確かめ直させる。 */
    const settle = async (response: Response) => {
      const result = await answer(response);
      if (!live()) return false;
      if (result === 'ok') return true;
      set('failed');
      if (result === 'switched') switchedRef.current?.();
      return false;
    };
    return { live, set, settle };
  }, []);

  useEffect(() => {
    epoch.current += 1;
    const { live, set, settle } = scope();
    const env = device();
    const stop = () => {
      epoch.current += 1;
    };
    if (!pushKey) {
      set('unsupported');
      return stop;
    }
    if (env.needsInstall) {
      set('needsInstall');
      return stop;
    }
    if (!env.supported) {
      set('unsupported');
      return stop;
    }
    if (env.permission() === 'denied') {
      set('denied');
      return stop;
    }
    set('checking');
    void (async () => {
      try {
        const subscription = await env.subscription();
        // 待つ間に使う人が替わった・画面を閉じた：前の人として登録しない（頼んだ時は新しくなるので、
        // 次の人の登録を上書きしてしまう）。
        if (!live()) return;
        if (!subscription || env.permission() !== 'granted') return set('off');
        // この端末の宛先を、今の大人と言葉で登録し直す（使う人が替わっていれば移る）。
        if (await settle(await register(memberId, language, subscription))) set('on');
      } catch {
        set('failed');
      }
    })();
    return stop;
  }, [memberId, pushKey, language, device, scope]);

  const enable = useCallback(() => {
    if (!pushKey) return;
    const env = device();
    const { live, set, settle } = scope();
    set('working');
    // 許可を求めるのは、押した時だけ（押した操作の中で呼ぶ）。
    const asked = env.requestPermission();
    void (async () => {
      try {
        const permission = await asked;
        if (!live()) return;
        if (permission !== 'granted') return set(permission === 'denied' ? 'denied' : 'off');
        // 待つたびに、使う人が替わっていないか確かめる（前の人として購読を作らない・登録しない）。
        const found = await env.subscription();
        if (!live()) return;
        const subscription = found ?? (await env.subscribe(keyBytes(pushKey)));
        if (!live()) return;
        if (await settle(await register(memberId, language, subscription))) set('on');
      } catch {
        set('failed');
      }
    })();
  }, [memberId, pushKey, language, device, scope]);

  const disable = useCallback(() => {
    const env = device();
    const { live, set, settle } = scope();
    set('working');
    void (async () => {
      try {
        const subscription = await env.subscription();
        if (!live()) return;
        if (!subscription) return set('off');
        const response = await fetch('/api/push/subscriptions', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ as: memberId, endpoint: subscription.endpoint }),
        });
        // サーバーが外したと答えた時だけ、端末の購読も外す。待つ間に使う人が替わった・画面を閉じた
        // なら、端末の購読は次の人の物かもしれないので触らない。
        if (!live() || !(await settle(response))) return;
        set((await subscription.unsubscribe()) ? 'off' : 'failed');
      } catch {
        set('failed');
      }
    })();
  }, [memberId, device, scope]);

  return { state, enable, disable };
}
