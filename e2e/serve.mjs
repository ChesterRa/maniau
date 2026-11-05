// 画面とデモを別ポートで起こす。外部 API の代わりに、呼ばれたら失敗する手元の入口を使う。
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const serverDir = fileURLToPath(new URL('../apps/server/', import.meta.url));
const webDir = fileURLToPath(new URL('../apps/web/', import.meta.url));
const vite = fileURLToPath(new URL('../apps/web/node_modules/vite/bin/vite.js', import.meta.url));
const config = fileURLToPath(new URL('./vite.config.ts', import.meta.url));
await mkdir(new URL('../.local/e2e-empty-env/', import.meta.url), { recursive: true });

let modelCalls = 0;
const children = [];
const fakeModel = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/__count') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ calls: modelCalls }));
    return;
  }
  modelCalls += 1;
  response.writeHead(503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'e2eでは外部の読み取りを使わない' }));
});
fakeModel.on('error', () => stop(1));
await new Promise((resolve) => fakeModel.listen(18798, '127.0.0.1', resolve));

// 親の環境を引き継がない。通常は SDK の送信先を手元に固定し、試用の入力試験では関数を差し替える。
const mode = process.env.MANIAU_E2E_MODE;
const env = { PATH: process.env.PATH ?? '', NODE_ENV: 'test', LANG: 'C.UTF-8', NO_COLOR: '1',
  ...(mode ? { MANIAU_E2E_MODE: mode } : {}),
};
children.push(
  spawn(process.execPath, ['--import', 'tsx', mode ? 'test/support/trial-server.ts' : 'src/main.ts'], {
    cwd: serverDir,
    env: {
      ...env,
      PORT: '18797',
      ...(mode ? {} : {
        ANTHROPIC_API_KEY: 'e2e-only',
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:18798',
      }),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
  spawn(process.execPath, [vite, '--config', config], {
    cwd: webDir,
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  fakeModel.close();
  for (const child of children) child.kill('SIGTERM');
  const fallback = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
  }, 3000);
  Promise.all(children.map((child) => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve)))).finally(() => {
    clearTimeout(fallback);
    process.exit(code);
  });
}
const ready = [false, false];
for (const [index, child] of children.entries()) {
  createInterface({ input: child.stdout }).on('line', (line) => {
    console.log(line);
    if (index === 0 && line.includes('まにあう：http://localhost:18797')) ready[0] = true;
    if (index === 1 && line.includes('http://127.0.0.1:15183/')) ready[1] = true;
    if (ready.every(Boolean)) {
      ready[0] = false;
      ready[1] = false;
      console.log('E2E_SERVICES_READY');
    }
  });
  child.once('error', () => stop(1));
  child.once('exit', (code) => { if (!stopping) stop(code || 1); });
}
process.once('SIGTERM', () => stop(0));
process.once('SIGINT', () => stop(0));
