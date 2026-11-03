import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVapidFile, sendVapidFile } from '../scripts/vapid-keys';

const directories: string[] = [];
function fixture(): string {
  mkdirSync(resolve('../../.local'), { recursive: true });
  const dir = mkdtempSync(resolve('../../.local/vapid-test-'));
  directories.push(dir);
  return join(dir, '.env');
}
const fake = () => ({ publicKey: 'fixture_public', privateKey: 'fixture_private' });
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('通知用の鍵の安全な受け渡し', () => {
  it('新しい .env だけに 0600 で書き、既存ファイルを上書きしない', () => {
    const file = fixture();
    createVapidFile(file, fake);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(
      'VAPID_PUBLIC_KEY=fixture_public\nVAPID_PRIVATE_KEY=fixture_private\n',
    );
    expect(() => createVapidFile(file, fake)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe(
      'VAPID_PUBLIC_KEY=fixture_public\nVAPID_PRIVATE_KEY=fixture_private\n',
    );
  });

  it('パスとシンボリックリンクを検査する', () => {
    const file = fixture();
    expect(() => createVapidFile(`${file}.txt`, fake)).toThrow();
    expect(() => createVapidFile(resolve('../../.env'), fake)).toThrow();
    symlinkSync('/dev/null', file);
    expect(() => createVapidFile(file, fake)).toThrow();
    expect(() => sendVapidFile(file, { project: 'p', environment: 'e', service: 's' })).toThrow();
  });

  it('接続先を明示し、架空の値は標準入力だけで渡す', () => {
    const file = fixture();
    createVapidFile(file, fake);
    const calls: { args: string[]; options: { cwd: string; input?: string } }[] = [];
    sendVapidFile(
      file,
      { project: 'project-id', environment: 'test-env', service: 'app-id' },
      (args, options) => {
        calls.push({ args, options });
        return true;
      },
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]?.args).toEqual([
      'link',
      '--project',
      'project-id',
      '--environment',
      'test-env',
      '--service',
      'app-id',
    ]);
    expect(calls[1]?.args).toEqual([
      'variable',
      'set',
      'VAPID_PUBLIC_KEY',
      '--stdin',
      '--environment',
      'test-env',
      '--service',
      'app-id',
      '--skip-deploys',
    ]);
    expect(calls[2]?.args).toEqual([
      'variable',
      'set',
      'VAPID_PRIVATE_KEY',
      '--stdin',
      '--environment',
      'test-env',
      '--service',
      'app-id',
      '--skip-deploys',
    ]);
    expect(calls.map((c) => c.options.input)).toEqual([
      undefined,
      'fixture_public',
      'fixture_private',
    ]);
    expect(calls.every((c) => !c.args.some((a) => a.includes('fixture_')))).toBe(true);
  });

  it('接続失敗や二つ目の失敗を成功扱いせず、ファイルを残す', () => {
    const file = fixture();
    createVapidFile(file, fake);
    let count = 0;
    expect(() =>
      sendVapidFile(file, { project: 'p', environment: 'e', service: 's' }, () => ++count < 3),
    ).toThrow();
    expect(count).toBe(3);
    expect(readFileSync(file, 'utf8')).toContain('fixture_private');
    count = 0;
    expect(() =>
      sendVapidFile(file, { project: 'p', environment: 'e', service: 's' }, () => ++count !== 1),
    ).toThrow();
    expect(count).toBe(1);
  });

  it('権限が広いファイルと不正な接続先を拒む', () => {
    const file = fixture();
    createVapidFile(file, fake);
    chmodSync(file, 0o644);
    expect(() => sendVapidFile(file, { project: 'p', environment: 'e', service: 's' })).toThrow();
    chmodSync(file, 0o600);
    expect(() =>
      sendVapidFile(file, { project: '--other', environment: '', service: 's' }),
    ).toThrow();
  });
});
