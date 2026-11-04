import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const runner = new URL('../run-utterance.mjs', import.meta.url);
const validCase = new URL('../cases/spoken-updates/02-helper-reply.json', import.meta.url);

test('準備確認は通信せず、発言や正解を表示しない', async () => {
  const { stdout, stderr } = await exec(process.execPath, [runner.pathname, '--case', validCase.pathname]);
  assert.match(stdout, /通信と鍵の読み込みはしていません/);
  assert.match(stdout, /欠けた情報 2 件/);
  assert.ok(!stdout.includes('おばあちゃん'));
  assert.ok(!stdout.includes('r-grandma-1207'));
  assert.equal(stderr, '');
});

test('指定した評価ディレクトリ以外のファイルは受け付けない', async () => {
  await assert.rejects(
    exec(process.execPath, [runner.pathname, '--case', new URL('../../README.md', import.meta.url).pathname]),
    (error) => error.code === 1 && error.stderr.includes('評価場面だけ'),
  );
});

test('単価を指定する時は速度も指定する（準備確認で通信しない）', async () => {
  const pricing = [
    '--pricing-model', 'claude-opus-5-5', '--input-usd-per-million', '8',
    '--output-usd-per-million', '40', '--pricing-url', 'https://example.test/pricing',
    '--pricing-checked', '2026-11-04',
  ];
  await assert.rejects(exec(process.execPath, [runner.pathname, '--case', validCase.pathname, ...pricing]),
    (error) => error.code === 1 && error.stderr.includes('速度'));
  const { stdout } = await exec(process.execPath, [runner.pathname, '--case', validCase.pathname, ...pricing, '--pricing-speed', 'fast']);
  assert.match(stdout, /通信と鍵の読み込みはしていません/);
});
