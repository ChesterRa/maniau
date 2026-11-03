// 起動の入口（main.ts）を子のプロセスで動かし、置き場所の設定から入口の守りまでがつながっているかを確かめる
// （createApp の試験だけでは、main.ts が設定を渡し忘れても通ってしまう）。トークンを付けないので Access の
// 公開鍵を取りに行かず、DB にもつながない。外へは通信しない。子には PATH と PORT だけを渡し、入口は手元の
// .env を読まない（.env は package.json の起動の命令が読む）ので、手元の鍵や DB の設定を拾わない。
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const TEAM = 'https://team.example.test';

/** 設定を渡して起動する。起きれば待ち受けの番号、止まれば出力を返す（どちらも 20 秒まで待つ）。 */
async function start(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd,
    // 親の設定（鍵・DB・Access）を子に渡さない。PORT=0 で空いている番号を使う。
    env: { PATH: process.env.PATH ?? '', PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let closed = false;
  child.stdout.on('data', (d) => {
    output += String(d);
  });
  child.stderr.on('data', (d) => {
    output += String(d);
  });
  child.on('close', () => {
    closed = true;
  });
  let port: number | undefined;
  for (let i = 0; i < 400 && port === undefined && !closed; i++) {
    const match = output.match(/localhost:(\d+)/);
    if (match) port = Number(match[1]);
    else await delay(50);
  }
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  return { port, output: () => output, stop };
}

const url = (port: number | undefined, path: string) => `http://127.0.0.1:${port}${path}`;
const createSession = (port: number | undefined) =>
  fetch(url(port, '/api/demo/sessions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage: 'arrived' }),
  });

describe('起動の入口と、デモの入口の守り', { timeout: 60_000 }, () => {
  it('二つそろえば、トークンの無い API を断り、生存の確かめだけを返す', async () => {
    const server = await start({ DEMO_ACCESS_TEAM_DOMAIN: TEAM, DEMO_ACCESS_AUD: 'demo-aud' });
    try {
      expect(server.port).toBeDefined();
      expect(server.output()).toContain('入口で身元を確かめる');
      expect((await fetch(url(server.port, '/api/me'))).status).toBe(401);
      expect((await createSession(server.port)).status).toBe(401);
      expect((await fetch(url(server.port, '/api/health'))).status).toBe(200);
    } finally {
      server.stop();
    }
  });

  it('一つだけなら起動しない（守りの無いデモとして黙って動かさない）', async () => {
    const server = await start({ DEMO_ACCESS_TEAM_DOMAIN: TEAM });
    try {
      expect(server.port).toBeUndefined();
      expect(server.output()).toContain('デモの入口の設定が足りない：DEMO_ACCESS_AUD');
    } finally {
      server.stop();
    }
  });

  it('家族の家庭の設定と一緒なら、DB につなぐ前に起動しない', async () => {
    const server = await start({
      DEMO_ACCESS_TEAM_DOMAIN: TEAM,
      DEMO_ACCESS_AUD: 'demo-aud',
      DATABASE_URL: 'postgres://do-not-connect.invalid/none',
    });
    try {
      expect(server.port).toBeUndefined();
      expect(server.output()).toContain('同じサーバーで同時にしない');
      expect(server.output()).not.toMatch(/ENOTFOUND|getaddrinfo|ECONNREFUSED/);
    } finally {
      server.stop();
    }
  });

  it('何も設定しなければ、前のとおり手元のデモ（トークン無しで使える）', async () => {
    const server = await start({});
    try {
      expect(server.port).toBeDefined();
      expect(server.output()).toContain('デモだけ');
      expect(server.output()).not.toContain('入口で身元を確かめる');
      // 入口が手元の .env（Claude の鍵など）を読んでいない。
      expect(server.output()).toContain('読み取りなし');
      expect((await fetch(url(server.port, '/api/me'))).status).toBe(200);
      expect((await createSession(server.port)).status).toBe(200);
    } finally {
      server.stop();
    }
  });
});
