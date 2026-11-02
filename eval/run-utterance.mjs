import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { instrumentUtteranceClient } from './utterance-api.mjs';
import { evaluateUtteranceCase, prepareUtteranceCase, sameSourceFingerprints } from './utterance-eval.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CASE_DIR = path.join(ROOT, 'eval', 'cases', 'spoken-updates');
const HOLDOUT_DIR = path.join(ROOT, '.local', 'eval-holdout');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const VALUE_FLAGS = new Set(['case', 'pricing-model', 'input-usd-per-million', 'output-usd-per-million', 'pricing-url', 'pricing-checked']);
const SOURCE_PATHS = [
  'apps/server/src/reading/utterance.ts',
  'apps/server/src/reading/prompts/utterance.v1.md',
  'apps/server/src/reading/extract.ts',
  'packages/core/src/reading/utterance.ts',
  'packages/core/src/index.ts',
  'packages/core/src/schema/commands.ts',
  'eval/run-utterance.mjs',
  'eval/utterance-eval.mjs',
  'eval/utterance-api.mjs',
  'eval/lib.mjs',
  'pnpm-lock.yaml',
];

class InputError extends Error {}

async function sourceFingerprints() {
  const pairs = await Promise.all(SOURCE_PATHS.map(async (name) => [name, sha256(await readFile(path.join(ROOT, name)))]));
  return Object.fromEntries(pairs);
}

function currentCommit() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; }
}

function argumentsOf(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--execute' || flag === '--help') options[flag.slice(2)] = true;
    else if (flag.startsWith('--') && VALUE_FLAGS.has(flag.slice(2)) && args[i + 1] && !args[i + 1].startsWith('--')) options[flag.slice(2)] = args[++i];
    else throw new InputError('引数を確認してください。--help で使い方を表示します。');
  }
  return options;
}

function pricingOf(options) {
  const keys = ['pricing-model', 'input-usd-per-million', 'output-usd-per-million', 'pricing-url', 'pricing-checked'];
  const count = keys.filter((key) => options[key] !== undefined).length;
  if (!count) return null;
  if (count !== keys.length) throw new InputError('単価・モデル・出典・確認日をすべて指定してください。');
  const input = Number(options[keys[1]]);
  const output = Number(options[keys[2]]);
  let url;
  try { url = new URL(options[keys[3]]); } catch { throw new InputError('料金の出典を確認してください。'); }
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0 || url.protocol !== 'https:' || !/^\d{4}-\d{2}-\d{2}$/.test(options[keys[4]])) {
    throw new InputError('単価・出典・確認日を確認してください。');
  }
  return { model: options[keys[0]], input, output, url: url.href, checked: options[keys[4]], currency: 'USD', per: 1_000_000 };
}

async function readCase(name) {
  if (!name) throw new InputError('--case で架空の場面を指定してください。');
  let target;
  try {
    target = await realpath(path.resolve(ROOT, name));
  } catch { throw new InputError('場面のファイルが見つかりません。'); }
  const [publicRoot, privateRoot] = await Promise.all([CASE_DIR, HOLDOUT_DIR].map(async (dir) => {
    try { return await realpath(dir); } catch { return null; }
  }));
  const belongs = (dir) => dir && target.startsWith(`${dir}${path.sep}`);
  const isPrivate = belongs(privateRoot);
  if ((!belongs(publicRoot) && !isPrivate) || !target.endsWith('.json')) throw new InputError('一言の架空の評価場面だけを指定してください。');
  const content = await readFile(target, 'utf8');
  return { scenario: JSON.parse(content), content, isPrivate, privateRoot };
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('node eval/run-utterance.mjs --case PATH [--execute] [料金の指定]\n');
    return;
  }
  const { scenario, content, isPrivate, privateRoot } = await readCase(options.case);
  const pricing = pricingOf(options);
  const prepared = prepareUtteranceCase(scenario);
  const unsupported = scenario.expected.classification === 'one_day_exception';
  if (!options.execute) {
    const label = isPrivate ? '保留場面' : scenario.id;
    process.stdout.write(`${label}: 準備確認、欠けた情報 ${prepared.omissions.length} 件${unsupported ? '、操作は未対応' : ''}。通信と鍵の読み込みはしていません。\n`);
    return;
  }

  // 保留場面の生出力と台帳は、開発用の記録とは別に置く。
  const runs = isPrivate ? path.join(privateRoot, 'utterance-runs') : path.join(ROOT, 'eval', 'runs');
  await mkdir(runs, { recursive: true });
  const runId = randomUUID();
  const runPath = path.join(runs, `utterance-${runId}.json`);
  const common = {
    run_id: runId, case_id: scenario.id, case_sha256: sha256(content),
    context_sha256: sha256(JSON.stringify(prepared.context)), pricing,
  };
  let requestsStarted = 0;
  const ledger = async (entry) => {
    await appendFile(path.join(runs, 'utterance-ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...common, ...entry })}\n`, { mode: 0o600 });
    if (entry.event === 'request_started') requestsStarted += 1;
  };
  const save = async (state) => writeFile(runPath, `${JSON.stringify({ ...common, ...state }, null, 2)}\n`, { mode: 0o600 });
  await ledger({ event: 'run_started' });
  await save({ status: 'running', requests_started: 0 });

  try {
    if (unsupported) {
      const result = await evaluateUtteranceCase(scenario, {});
      await save({ status: 'not_run', requests_started: 0, expected: scenario.expected, report: result.report });
      await ledger({ event: 'run_finished', status: 'not_run', requests_started: 0 });
      process.stdout.write('未実施：一日だけの作息変更に対応していません。API は呼んでいません。\n');
      return;
    }
    const sourceBefore = await sourceFingerprints();
    const commit = currentCommit();
    await ledger({ event: 'source_fingerprint', commit, files: sourceBefore });
    // 製品の読み取りを使う。TypeScript の実行には server の tsx を使う。
    const reader = await import(pathToFileURL(path.join(ROOT, 'apps/server/src/reading/utterance.ts')).href);
    const core = await import(pathToFileURL(path.join(ROOT, 'packages/core/src/reading/utterance.ts')).href);
    if (typeof reader.readUtterance !== 'function' || typeof core.toUtteranceReply !== 'function') {
      throw new InputError('製品の読み取りがまだ利用できません。');
    }
    let envText;
    try { envText = await readFile(path.join(ROOT, '.env'), 'utf8'); } catch { throw new InputError('.env を読み込めませんでした。'); }
    let key;
    try { key = parseEnv(envText).ANTHROPIC_API_KEY; } catch { throw new InputError('.env の形式を確認してください。'); }
    if (!key) throw new InputError('.env に ANTHROPIC_API_KEY が必要です。');
    const require = createRequire(path.join(ROOT, 'apps/server/package.json'));
    const Anthropic = require('@anthropic-ai/sdk').default;
    const api = instrumentUtteranceClient(new Anthropic({ apiKey: key, maxRetries: 0, timeout: 110_000 }), { ledger, pricing });
    let rawOutput;
    let readingMetadata;
    const result = await evaluateUtteranceCase(scenario, {
      read: async (context) => {
        const reading = await reader.readUtterance(api, context);
        if (!reading?.output) throw new Error('unparsed');
        rawOutput = reading.output;
        readingMetadata = { model: reading.model ?? null, prompt_version: reading.promptVersion ?? null, input_hash: reading.inputHash ?? null };
        return rawOutput;
      },
      toReply: (output, context) => core.toUtteranceReply(output, context, randomUUID),
    });
    let sourceAfter = null;
    try { sourceAfter = await sourceFingerprints(); } catch { /* 試行中に読み取れなくなった場合も比較不能。 */ }
    const status = !sameSourceFingerprints(sourceBefore, sourceAfter) ? 'incomparable' : result.report.status;
    await save({ status, requests_started: requestsStarted, commit, source_before: sourceBefore, source_after: sourceAfter, reading: readingMetadata, context: result.context, output: rawOutput, reply: result.reply, expected: scenario.expected, report: result.report });
    await ledger({ event: 'run_finished', status, requests_started: requestsStarted });
    if (status === 'incomparable') {
      process.stdout.write('試行中にコードが変わったため比較不能として記録しました。\n');
      process.exitCode = 1;
    } else if (status === 'observed') {
      process.stdout.write(`記録しました：分類 ${result.report.classification}、参照命令 ${result.report.commands}。画面の確認項目は未判定です。\n`);
    } else {
      process.stderr.write('有効な応答を得られなかったため、未完了として記録しました。\n');
      process.exitCode = 1;
    }
  } catch (error) {
    const reason = ['refusal', 'max_tokens', 'unparsed'].includes(error?.reason) ? error.reason : 'execution_error';
    await save({ status: 'incomplete', reason, requests_started: requestsStarted });
    await ledger({ event: 'run_finished', status: 'incomplete', reason, requests_started: requestsStarted });
    process.stderr.write(error instanceof InputError ? `${error.message}\n` : '試行を完了できませんでした。通信回数と費用の有無は台帳を確認してください。\n');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(error instanceof InputError ? `${error.message}\n` : '実行の準備を完了できませんでした。\n');
  process.exitCode = 1;
});
