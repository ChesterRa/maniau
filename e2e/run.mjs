// 普段の開発サーバーや .env を使わず、専用の二つのサーバーとブラウザを起動して止める。
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const home = fileURLToPath(new URL('../.local/e2e-home/', import.meta.url));
const browsers = fileURLToPath(new URL('../.local/e2e-browsers/', import.meta.url));
await mkdir(home, { recursive: true });
const env = {
  PATH: process.env.PATH ?? '',
  HOME: home,
  LANG: 'C.UTF-8',
  CI: 'true',
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? browsers,
  ...(process.env.MANIAU_E2E_BROWSER ? { MANIAU_E2E_BROWSER: process.env.MANIAU_E2E_BROWSER } : {}),
};

// 使用中のポートを借りずに失敗する。サーバーも起動時に bind するので、競合を再度検出する。
for (const port of [15183, 18797, 18798]) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  }).catch(() => {
    throw new Error(`試験用ポート ${port} を使えません。別のサーバーは使わず終了します。`);
  });
}

const server = spawn(process.execPath, ['e2e/serve.mjs'], {
  cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'],
});
let runner;
let interrupted = false;
function stop() {
  interrupted = true;
  runner?.kill('SIGTERM');
  server.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('試験サーバーの起動を待てませんでした。')), 30_000);
    const lines = createInterface({ input: server.stdout });
    lines.on('line', (line) => {
      console.log(line);
      if (line === 'E2E_SERVICES_READY') {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.once('error', reject);
    server.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('試験サーバーが起動前に終了しました。'));
    });
  });
  runner = spawn(process.execPath, [
    'node_modules/@playwright/test/cli.js', 'test', '--config', 'e2e/playwright.config.ts',
    ...process.argv.slice(2),
  ], { cwd: root, env, stdio: 'inherit' });
  const result = await new Promise((resolve, reject) => {
    runner.once('error', reject);
    runner.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    server.once('exit', () => {
      if (!interrupted) {
        runner.kill('SIGTERM');
        reject(new Error('試験サーバーが途中で終了しました。'));
      }
    });
  });
  process.exitCode = result;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
  if (server.exitCode === null && server.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.kill('SIGKILL');
        resolve();
      }, 5000);
      server.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
