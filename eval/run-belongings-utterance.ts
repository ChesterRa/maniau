// 架空の開発用場面。初期状態では偽物で形だけを確かめ、--execute の時だけ Claude API を呼ぶ。
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { readUtterance } from '../apps/server/src/reading/utterance';
import {
  type BelongingsObservation,
  belongingsCases,
  fixtureUtterance,
  passedBelongingsCase,
  runBelongingsCase,
} from './belongings-utterance';
import { instrumentUtteranceClient } from './utterance-api.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Pricing = {
  model: string;
  input: number;
  output: number;
  url: string;
  checked: string;
  currency: string;
  per: number;
};
type UtteranceClient = Parameters<typeof readUtterance>[0];
// JS の記録器は messages.parse だけを包む。readUtterance もその一つだけを使う。
const instrument = instrumentUtteranceClient as unknown as (
  client: UtteranceClient,
  options: { ledger: (entry: object) => Promise<void>; pricing: Pricing | null },
) => UtteranceClient;
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const paths = await Promise.all(
    entries.map((entry) => {
      const name = path.join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(name) : entry.isFile() ? [name] : [];
    }),
  );
  return paths.flat();
}

/** 読み取りだけでなく、前提を作るエンジン・デモの資料も前後で照らす。 */
async function fingerprints(): Promise<Record<string, string>> {
  const paths = [
    ...(await filesUnder('apps/server/src')),
    ...(await filesUnder('packages/core/src')),
    ...(await filesUnder('data/demo')),
    'eval/belongings-utterance.ts',
    'eval/run-belongings-utterance.ts',
    'eval/utterance-api.mjs',
    'eval/lib.mjs',
    'pnpm-lock.yaml',
  ].sort();
  return Object.fromEntries(
    await Promise.all(paths.map(async (p) => [p, hash(await readFile(path.join(root, p)))])),
  );
}

async function main() {
  const { values } = parseArgs({
    options: {
      execute: { type: 'boolean' },
      help: { type: 'boolean' },
      case: { type: 'string' },
      'pricing-model': { type: 'string' },
      'input-usd-per-million': { type: 'string' },
      'output-usd-per-million': { type: 'string' },
      'pricing-url': { type: 'string' },
      'pricing-checked': { type: 'string' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(
      '使い方：tsx eval/run-belongings-utterance.ts [--case ID] [--execute] [料金の指定]\n',
    );
    return;
  }
  const cases = values.case
    ? belongingsCases.filter((entry) => entry.id === values.case)
    : belongingsCases;
  if (cases.length === 0) throw new Error('指定した開発用場面がありません');
  if (!values.execute) {
    for (const scenario of cases) {
      const result = await runBelongingsCase(scenario, fixtureUtterance(scenario));
      if (!passedBelongingsCase(scenario, result)) {
        throw new Error(`形の試験を完了できません：${scenario.id}`);
      }
      process.stdout.write(
        `${scenario.id}：偽物で形を確認、記録 ${result.confirmation}（モデル・画面は未評価）\n`,
      );
    }
    return;
  }

  const prices = [
    'pricing-model',
    'input-usd-per-million',
    'output-usd-per-million',
    'pricing-url',
    'pricing-checked',
  ] as const;
  const supplied = prices.filter((name) => values[name] !== undefined).length;
  if (supplied !== 0 && supplied !== prices.length)
    throw new Error('料金のモデル・単価・出典・確認日を全て指定してください');
  let pricing: Pricing | null = null;
  if (supplied) {
    const input = Number(values['input-usd-per-million']);
    const output = Number(values['output-usd-per-million']);
    const url = new URL(values['pricing-url'] as string);
    const checked = values['pricing-checked'] as string;
    if (
      !Number.isFinite(input) ||
      input < 0 ||
      !Number.isFinite(output) ||
      output < 0 ||
      url.protocol !== 'https:' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(checked)
    )
      throw new Error('料金の指定を確認してください');
    pricing = {
      model: values['pricing-model'] as string,
      input,
      output,
      url: url.href,
      checked,
      currency: 'USD',
      per: 1_000_000,
    };
  }
  let key: string | undefined;
  try {
    key = parseEnv(await readFile(path.join(root, '.env'), 'utf8')).ANTHROPIC_API_KEY;
  } catch {
    /* 鍵を表示しない。 */
  }
  if (!key) throw new Error('.env に API 鍵を設定してください');
  const Require = createRequire(path.join(root, 'apps/server/package.json'));
  const Anthropic = Require('@anthropic-ai/sdk').default;
  const runs = path.join(root, 'eval/runs');
  await mkdir(runs, { recursive: true });
  const id = randomUUID();
  const ledgerPath = path.join(runs, `belongings-ledger-${id}.jsonl`);
  const resultPath = path.join(runs, `belongings-results-${id}.json`);
  let currentCase = '';
  const ledger = async (entry: object) =>
    appendFile(
      ledgerPath,
      `${JSON.stringify({ at: new Date().toISOString(), run_id: id, case: currentCase, ...entry })}\n`,
      { mode: 0o600 },
    );
  const before = await fingerprints();
  await ledger({ event: 'run_started', source_before: before, pricing });
  const client = instrument(
    new Anthropic({ apiKey: key, maxRetries: 0, timeout: 110_000, logLevel: 'off' }),
    { ledger, pricing },
  );
  const results: Array<Omit<BelongingsObservation, 'context'> & { contextSha256: string | null }> =
    [];
  await writeFile(resultPath, `${JSON.stringify({ complete: false, results }, null, 2)}\n`, {
    mode: 0o600,
  });
  for (const scenario of cases) {
    currentCase = scenario.id;
    const observation = await runBelongingsCase(scenario, (context) =>
      readUtterance(client, context),
    );
    const { context, ...rest } = observation;
    results.push({ ...rest, contextSha256: context ? hash(JSON.stringify(context)) : null });
    // 中断された時も、終わった場面と通信の台帳を区別できる。
    await writeFile(resultPath, `${JSON.stringify({ complete: false, results }, null, 2)}\n`, {
      mode: 0o600,
    });
    if (observation.result !== 'observed') break;
  }
  const after = await fingerprints();
  const comparable = JSON.stringify(before) === JSON.stringify(after);
  const complete =
    comparable &&
    results.length === cases.length &&
    results.every((entry) => entry.result === 'observed');
  await writeFile(resultPath, `${JSON.stringify({ complete, comparable, results }, null, 2)}\n`, {
    mode: 0o600,
  });
  await ledger({ event: 'run_finished', complete, comparable, resultPath, source_after: after });
  for (const result of results) {
    process.stdout.write(
      `${result.caseId}：${result.result}、対象 ${result.targetMatches ? '一致' : '未一致'}、記録 ${result.confirmation ?? '未実施'}、画面 ${result.screen}\n`,
    );
  }
  process.stdout.write(
    `台帳：${path.relative(root, ledgerPath)}\n結果：${path.relative(root, resultPath)}\n`,
  );
  if (
    !complete ||
    results.some((entry) => {
      const scenario = cases.find((item) => item.id === entry.caseId);
      return !scenario || !passedBelongingsCase(scenario, entry);
    })
  )
    process.exitCode = 1;
}

main().catch(() => {
  // SDK の例外に原文や鍵が含まれる可能性があるため、そのまま出さない。
  process.stderr.write(
    '一言の開発用場面を完了できませんでした。実行した場合は台帳を確認してください。\n',
  );
  process.exitCode = 1;
});
