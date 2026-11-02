// @vitest-environment happy-dom
// 家族の家庭（ログインした大人）の画面とサーバー：どちらの家庭かを聞き、身元の大人として読む・送る。
// 外された（403）と分かったら、前に読んだ物も見せない。
import type { Command } from '@maniau/core';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Mode, type SessionView, useFamilySession, useMode } from '../src/family';
import { type Call, installFetch, step, take } from './fake-fetch';

let calls: Call[] = [];
let root: Root;
let mode: Mode | undefined;
let recheck: (() => void) | undefined;
let live: ReturnType<typeof useFamilySession> | undefined;

function ModeProbe() {
  ({ mode, recheck } = useMode());
  return null;
}

function FamilyProbe() {
  live = useFamilySession('b');
  return null;
}

beforeEach(() => {
  calls = installFetch();
  root = createRoot(document.createElement('div'));
});

afterEach(async () => {
  await step(() => root.unmount());
});

describe('どちらの家庭か', () => {
  const cases: [string, number, unknown, Mode][] = [
    ['家族の家庭の無いサーバーはデモ', 200, { mode: 'demo' }, { kind: 'demo' }],
    ['ログインした大人', 200, { mode: 'family', memberId: 'b' }, { kind: 'family', memberId: 'b' }],
    ['家族の大人でない', 403, { error: 'notAMember' }, { kind: 'denied' }],
    ['身元を確かめられない', 401, { error: 'unauthenticated' }, { kind: 'denied' }],
    ['サーバーの誤り', 500, {}, { kind: 'failed' }],
  ];
  for (const [label, status, payload, expected] of cases) {
    it(label, async () => {
      await step(() => root.render(<ModeProbe />));
      expect(mode).toEqual({ kind: 'loading' });
      await step(() => take(calls, (c) => c.url === '/api/me').respond(status, payload));
      expect(mode).toEqual(expected);
    });
  }
});

describe('知らせから前の画面に戻った時', () => {
  it('Service Worker が知らせたら、身元を確かめ直す（確かめる間は、前の人の画面を出さない）', async () => {
    const container = new EventTarget();
    Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
    const isMe = (c: Call) => c.url === '/api/me';
    try {
      await step(() => root.render(<ModeProbe />));
      await step(() => take(calls, isMe).respond(200, { mode: 'family', memberId: 'a' }));
      expect(mode).toEqual({ kind: 'family', memberId: 'a' });
      // 別の知らせは使わない。
      await step(() => {
        container.dispatchEvent(new MessageEvent('message', { data: { type: 'other' } }));
      });
      expect(mode).toEqual({ kind: 'family', memberId: 'a' });
      await step(() => {
        container.dispatchEvent(new MessageEvent('message', { data: { type: 'maniau:opened' } }));
      });
      expect(mode).toEqual({ kind: 'loading' });
      await step(() => take(calls, isMe).respond(200, { mode: 'family', memberId: 'b' }));
      expect(mode).toEqual({ kind: 'family', memberId: 'b' });
    } finally {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    }
  });
});

describe('家族の家庭', () => {
  const isView = (c: Call) => c.url === '/api/view?as=b';
  const isCommand = (c: Call) => c.url === '/api/commands';
  const COMMAND = { type: 'confirmItem', itemId: 'i' } as Command;

  it('身元の大人として読み、送る（本文で使う人を名乗らない）', async () => {
    await step(() => root.render(<FamilyProbe />));
    const first = { throughSeq: 3 } as SessionView;
    await step(() => take(calls, isView).respond(200, first));
    expect(live?.view).toBe(first);
    await step(() => {
      void live?.send(COMMAND);
    });
    const command = take(calls, isCommand);
    // 画面が見ている大人（as）を添える（比べるためだけ。操作する人はサーバーが身元で決める）。
    expect(command.body).toEqual({ as: 'b', operationId: expect.any(String), command: COMMAND });
    const next = { throughSeq: 4 } as SessionView;
    await step(() => command.respond(200, { result: { status: 'ok', throughSeq: 4 }, view: next }));
    expect(live?.view).toBe(next);
  });

  it('命令が「家族の大人でない」で断られたら、前に読んだ物も見せない', async () => {
    await step(() => root.render(<FamilyProbe />));
    await step(() => take(calls, isView).respond(200, { throughSeq: 3 }));
    expect(live?.view).toBeDefined();
    await step(() => {
      void live?.send(COMMAND);
    });
    await step(() => take(calls, isCommand).respond(403, { error: 'notAMember' }));
    expect(live?.denied).toBe(true);
    expect(live?.view).toBeUndefined();
  });

  it('読み直しが 401・403 なら、外されたと示す', async () => {
    await step(() => root.render(<FamilyProbe />));
    await step(() => take(calls, isView).respond(403, { error: 'notAMember' }));
    expect(live?.denied).toBe(true);
    expect(live?.view).toBeUndefined();
  });

  it('ログインの身元が替わった（409）なら、前に読んだ物を見せず、確かめ直させる', async () => {
    await step(() => root.render(<FamilyProbe />));
    await step(() => take(calls, isView).respond(200, { throughSeq: 3 }));
    await step(() => {
      void live?.send(COMMAND);
    });
    await step(() => take(calls, isCommand).respond(409, { error: 'identityChanged' }));
    expect(live?.switched).toBe(true);
    expect(live?.view).toBeUndefined();
  });
});

describe('身元の確かめ直し', () => {
  it('recheck で、もう一度どちらの家庭かを聞き、替わった身元にする', async () => {
    await step(() => root.render(<ModeProbe />));
    await step(() =>
      take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'family', memberId: 'b' }),
    );
    expect(mode).toEqual({ kind: 'family', memberId: 'b' });
    await step(() => recheck?.());
    expect(mode).toEqual({ kind: 'loading' });
    await step(() =>
      take(calls, (c) => c.url === '/api/me').respond(200, { mode: 'family', memberId: 'a' }),
    );
    expect(mode).toEqual({ kind: 'family', memberId: 'a' });
  });
});
