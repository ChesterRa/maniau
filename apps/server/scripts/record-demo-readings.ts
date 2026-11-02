// デモのお知らせ（架空）を、実際の Claude API で読み取り、応答を data/demo/recorded/ に録る。
// 試験とデモは、録った応答で API なしに走る。鍵は .env から読み、表示しない。
// 実行：pnpm --filter @maniau/server record:demo （呼ぶ回数：お知らせ2通で2回）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { type Extraction, type Source, splitSentences, toExtraction } from '@maniau/core';
import { extractNotice } from '../src/reading/extract';

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

const notices: { id: string; file: string; receivedAt: string; title: string }[] = [
  {
    id: 'n1',
    file: '2026-11-25-happyokai.txt',
    receivedAt: '2026-11-25T19:30+09:00',
    title: '学習発表会のお知らせ',
  },
  {
    id: 'n2',
    file: '2026-12-04-enki.txt',
    receivedAt: '2026-12-04T17:52+09:00',
    title: '学習発表会の延期について',
  },
];

const client = new Anthropic();
const outDir = new URL('data/demo/recorded/', ROOT);
mkdirSync(outDir, { recursive: true });

let prior: Extraction[] = [];
for (const notice of notices) {
  const text = readFileSync(new URL(`data/demo/notices/${notice.file}`, ROOT), 'utf8');
  const source: Source = {
    id: notice.id,
    version: 1,
    receivedAt: notice.receivedAt,
    sender: 'school',
    senderPlaceId: 'school',
    language: 'ja',
    medium: 'text',
    title: notice.title,
    sentences: splitSentences(text, notice.id),
  };
  const result = await extractNotice(client, {
    source,
    schoolYear: '2026',
    priorItems: prior.flatMap((e) => e.items),
    priorUnknowns: prior.flatMap((e) => e.unknowns),
  });
  const { extraction, issues } = toExtraction(result.output, source, {
    priorItems: prior.flatMap((e) => e.items),
    priorUnknowns: prior.flatMap((e) => e.unknowns),
  });
  prior = [...prior, extraction];
  const record = {
    note: '架空のお知らせを、実際の Claude API で読み取った応答（録った物）',
    recordedAt: new Date().toISOString(),
    sourceId: source.id,
    model: result.model,
    promptVersion: result.promptVersion,
    inputHash: result.inputHash,
    usage: result.usage,
    output: result.output,
    issues,
  };
  writeFileSync(
    new URL(`${notice.id}.extract.json`, outDir),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  console.log(
    `${notice.id}: 事項 ${extraction.items.length}、問題 ${issues.length}、入力 ${result.usage.input_tokens}・出力 ${result.usage.output_tokens} トークン（${result.model}）`,
  );
}
