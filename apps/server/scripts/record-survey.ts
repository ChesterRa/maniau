// デモの家（架空の家族。家の場所は実在の地域の、区と駅の粒度だけ）の周りの資源を、実際の Claude API（ウェブ検索と頁の
// 読み取り）で一度調べ、コードが確かめた結果を data/demo/recorded/survey.json に録る。公開のデモは、これを既定で見せる
// （作り手の決定 2026-11-05）。頁の本文は録らない（短い引用と、確かめた結果と、読んだ時刻だけ）。鍵は .env から読み、
// 表示しない。呼ぶ回数：1 回の調べ（止まった応答を続ける時は API の要求が何度かになる。中で検索と頁の読み取りを
// 何度か行う。数と使った量を表示する）。SDK の自動の再試行はしない（呼んだ数を数えられるように）。
// 実行：pnpm --filter @maniau/server record:survey
import { mkdirSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { checkSurvey, formatDateTime, type SurveyRecord } from '@maniau/core';
import { loadDemoData } from '../src/demo';
import { readSurvey, SURVEY_KINDS, surveyCandidateId, surveyInputFor } from '../src/reading/survey';

const ROOT = new URL('../../../', import.meta.url);
try {
  process.loadEnvFile(new URL('.env', ROOT));
} catch {
  // .env が無ければ、環境の変数を使う。
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY が無い（.env に置く）');
  process.exit(1);
}

const { household } = loadDemoData();
const input = surveyInputFor(household, Date.now());
if (input === 'noArea') {
  console.error('デモの家の場所に地域が無い');
  process.exit(1);
}
const started = Date.now();
const result = await readSurvey(new Anthropic({ maxRetries: 0 }), input);
const at = formatDateTime(Math.floor(Date.now() / 60_000), input.timeZone);
const checked = checkSurvey(
  result.output,
  result.pages,
  SURVEY_KINDS.map((k) => k.kind),
  surveyCandidateId,
  at,
);
const record: SurveyRecord = {
  area: input.area,
  at,
  recorded: true,
  ...checked,
  model: result.model,
  promptVersion: result.promptVersion,
  usage: result.usage,
};
mkdirSync(new URL('data/demo/recorded/', ROOT), { recursive: true });
writeFileSync(
  new URL('data/demo/recorded/survey.json', ROOT),
  `${JSON.stringify(record, null, 2)}\n`,
);
console.log(
  `周りの調べ：${result.model}、${Math.round((Date.now() - started) / 1000)} 秒、入力 ${result.usage.input_tokens}・出力 ${result.usage.output_tokens} tokens、検索 ${result.usage.web_search_requests} 回・頁 ${result.usage.web_fetch_requests} 回`,
);
console.log(
  `候補 ${checked.candidates.length} 件、外した物 ${checked.dropped.length} 件（${checked.dropped.map((d) => d.reason).join('・') || 'なし'}）。読んだ頁 ${result.pages.length}（本文 ${result.pages.filter((p) => p.kind === 'text').length}）`,
);
