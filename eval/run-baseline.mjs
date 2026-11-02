import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { callClaude } from './api.mjs';
import { runConversation } from './conversation.mjs';
import { resolveInterview } from './interview.mjs';
import { buildRequest, TOOLS } from './lib.mjs';

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(EVAL_DIR);
const RUNS = path.join(EVAL_DIR, 'runs');
const VALUE_FLAGS = new Set(['case', 'input', 'prompt', 'model', 'effort', 'max-tokens', 'input-usd-per-million', 'output-usd-per-million', 'pricing-url', 'pricing-checked']);

class InputError extends Error {}

function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '--execute' || flag === '--help') {
      options[flag.slice(2)] = true;
    } else if (flag.startsWith('--') && VALUE_FLAGS.has(flag.slice(2)) && args[i + 1] && !args[i + 1].startsWith('--')) {
      options[flag.slice(2)] = args[++i];
    } else {
      throw new InputError('引数を確認してください。--help で使い方を表示します。');
    }
  }
  return options;
}

function parsePricing(options) {
  const keys = ['input-usd-per-million', 'output-usd-per-million', 'pricing-url', 'pricing-checked'];
  const provided = keys.filter((key) => options[key] !== undefined).length;
  if (provided === 0) return null;
  if (provided !== keys.length) throw new InputError('料金を記録するには単価・出典・確認日をすべて指定してください。');
  const input = Number(options[keys[0]]);
  const output = Number(options[keys[1]]);
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) throw new InputError('単価は 0 以上の数値で指定してください。');
  let url;
  try { url = new URL(options[keys[2]]); } catch { throw new InputError('料金の出典は HTTPS の URL で指定してください。'); }
  if (url.protocol !== 'https:' || !/^\d{4}-\d{2}-\d{2}$/.test(options[keys[3]])) throw new InputError('料金の出典は HTTPS、確認日は YYYY-MM-DD で指定してください。');
  return { input, output, url: url.href, checked: options[keys[3]], currency: 'USD', per: 1_000_000 };
}

async function approvedCase(file) {
  if (!file) throw new InputError('--case が必要です。');
  let target;
  try { target = await realpath(path.resolve(ROOT, file)); } catch { throw new InputError('場面のファイルが見つかりません。'); }
  const roots = await Promise.all([path.join(EVAL_DIR, 'cases'), path.join(ROOT, '.local', 'eval-holdout')].map(async (dir) => {
    try { return await realpath(dir); } catch { return null; }
  }));
  if (!roots.some((dir) => dir && target.startsWith(`${dir}${path.sep}`)) || !target.endsWith('.json')) {
    throw new InputError('場面は架空の eval/cases/ または .local/eval-holdout/ の JSON に限ります。');
  }
  return target;
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('node eval/run-baseline.mjs --case PATH --input raw|facts --prompt 1|2|3 --model MODEL_ID [--effort high] [--max-tokens 16384] [--execute] [料金の指定]\n');
    return;
  }
  if (!['1', '2', '3'].includes(options.prompt) || !['raw', 'facts'].includes(options.input) || !options.model) {
    throw new InputError('--input raw|facts、--prompt 1|2|3、--model を指定してください。');
  }
  const casePath = await approvedCase(options.case);
  const caseText = await readFile(casePath, 'utf8');
  const scenario = JSON.parse(caseText);
  const promptText = await readFile(path.join(EVAL_DIR, 'prompts', `${options.prompt}.md`), 'utf8');
  const pricing = parsePricing(options);
  const request = buildRequest({ scenario, input: options.input, prompt: promptText, model: options.model, effort: options.effort, maxTokens: options['max-tokens'] === undefined ? 16384 : Number(options['max-tokens']) });
  if (!options.execute) {
    process.stdout.write('準備確認: 入力とプロンプトを読めました。API 通信と鍵の読み込みはしていません。\n');
    return;
  }
  let envText;
  try { envText = await readFile(path.join(ROOT, '.env'), 'utf8'); } catch { throw new InputError('.env を読み込めませんでした。'); }
  let key;
  try { key = parseEnv(envText).ANTHROPIC_API_KEY; } catch { throw new InputError('.env の形式を確認してください。'); }
  if (!key) throw new InputError('.env に ANTHROPIC_API_KEY が必要です。');

  await mkdir(RUNS, { recursive: true });
  const runId = randomUUID();
  const runPath = path.join(RUNS, `${runId}.json`);
  const common = {
    run_id: runId,
    case_id: scenario.id,
    case_sha256: hash(caseText),
    input: options.input,
    prompt: options.prompt,
    prompt_sha256: hash(promptText),
    tool_definitions_sha256: hash(JSON.stringify(TOOLS)),
    requested_model: options.model,
    effort: options.effort ?? 'model_default',
    max_tokens: request.max_tokens,
    interview_mode: process.stdin.isTTY ? 'human' : 'rules',
    pricing,
  };
  let requestsStarted = 0;
  const ledger = async (entry) => {
    await appendFile(path.join(RUNS, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...common, ...entry })}\n`);
    if (entry.event === 'request_started') requestsStarted += 1;
  };
  const interviewAudit = [];
  const persist = async (state) => writeFile(runPath, `${JSON.stringify({ ...common, ...state, interview_audit: interviewAudit }, null, 2)}\n`);
  let lastState = { status: 'running', requests: 0, messages: request.messages };
  const save = async (state) => { lastState = state; await persist(state); };
  await ledger({ event: 'run_started' });
  await save(lastState);

  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const answer = async (question) => {
    if (!rl) {
      const result = resolveInterview(question, scenario.interview);
      interviewAudit.push({ question, mode: 'rules', ...result });
      return result.answer;
    }
    const response = (await rl.question(`\n家族への質問: ${question}\n場面の回答（未記載は「分かりません」）: `)).trim() || '分かりません。';
    interviewAudit.push({ question, mode: 'human', answer: response });
    return response;
  };
  const send = async (payload, number) => {
    return callClaude({ payload, number, key, pricing, ledger });
  };
  try {
    const result = await runConversation({ request, send, answer, onUpdate: save });
    await ledger({ event: 'run_finished', status: result.status, reason: result.reason, requests_started: requestsStarted });
    process.stdout.write(`試行 ${result.status}。対話と台帳は eval/runs/ に保存しました。\n`);
    if (result.status !== 'completed') process.exitCode = 1;
  } catch (error) {
    await save({ ...lastState, status: 'incomplete', reason: 'execution_error' });
    await ledger({ event: 'run_finished', status: 'incomplete', reason: 'execution_error', requests_started: requestsStarted });
    process.stderr.write(`${error instanceof Error ? error.message : '試行を完了できませんでした。'}\n`);
    process.exitCode = 1;
  } finally {
    rl?.close();
  }
}

main().catch((error) => {
  const message = error instanceof InputError ? error.message : '実行の準備を完了できませんでした。引数・場面・料金の指定を確認してください。';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
