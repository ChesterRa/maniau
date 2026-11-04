// お知らせの読み取り（docs/design/01-model.md §10）。Claude の構造化出力で型を固定し、
// 日付・文 ID・参照・条件は、@maniau/core の toExtraction で確かめる。
// 拒否（refusal）と打ち切り（max_tokens）の出力は、有効なデータとして扱わない。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ExtractionOutput, type Item, type Source, type Unknown } from '@maniau/core';
import { FAST_SPEED, PRODUCT_EFFORT, PRODUCT_MODEL } from './model';

export const EXTRACT_PROMPT_VERSION = 'extract.v4';
const PROMPT = readFileSync(new URL('./prompts/extract.v4.md', import.meta.url), 'utf8');

export const DEFAULT_EXTRACT_MODEL = PRODUCT_MODEL;

export interface ExtractRequest {
  source: Source;
  /** 学年度（例：2026）。日付の年を決めるのに使う。 */
  schoolYear: string;
  priorItems: readonly Item[];
  priorUnknowns: readonly Unknown[];
}

export interface ExtractResult {
  output: ExtractionOutput;
  model: string;
  promptVersion: string;
  inputHash: string;
  usage: { input_tokens: number; output_tokens: number };
}

export class ReadingError extends Error {
  constructor(
    readonly reason: 'refusal' | 'max_tokens' | 'unparsed',
    readonly stopReason: string | null,
  ) {
    super(`読み取りの出力を使えない：${reason}`);
  }
}

/**
 * モデルに渡す入力。出典の文と、関係する出典の今の事項（書かれた表現と解釈）を、そのまま送る。
 * 家族の情報（家庭の設定）からは何も足さない。ただし原文に名前や住所が書かれていれば、それも送られる。
 * 実在の家族の物は、作り手が許した範囲だけを送る（02-foundation §11）。
 */
export function buildExtractInput(request: ExtractRequest): string {
  return JSON.stringify({
    receivedAt: request.source.receivedAt,
    schoolYear: request.schoolYear,
    sender: request.source.sender,
    sentences: request.source.sentences,
    priorItems: request.priorItems.map((i) => ({
      id: i.id,
      kind: i.kind,
      written: i.written,
      interpretation: i.interpretation,
      conditionNodeId: i.conditionNodeId ?? null,
    })),
    priorUnknowns: request.priorUnknowns,
  });
}

type MessagesClient = Pick<Anthropic, 'messages'>;

export async function extractNotice(
  client: MessagesClient,
  request: ExtractRequest,
  options: { model?: string; effort?: 'low' | 'medium' | 'high' } = {},
): Promise<ExtractResult> {
  const input = buildExtractInput(request);
  const response = await client.messages.parse({
    model: options.model ?? DEFAULT_EXTRACT_MODEL,
    max_tokens: 16000,
    speed: FAST_SPEED,
    system: PROMPT,
    messages: [{ role: 'user', content: input }],
    output_config: {
      format: zodOutputFormat(ExtractionOutput),
      // Opus 5.5 は思考を切れず、effort の初期値は medium。呼び出しごとに明示する（§10・model.ts）。
      effort: options.effort ?? PRODUCT_EFFORT,
    },
  });
  if (response.stop_reason === 'refusal') throw new ReadingError('refusal', response.stop_reason);
  if (response.stop_reason === 'max_tokens') {
    throw new ReadingError('max_tokens', response.stop_reason);
  }
  const output = response.parsed_output;
  if (!output) throw new ReadingError('unparsed', response.stop_reason);
  return {
    output,
    model: response.model,
    promptVersion: EXTRACT_PROMPT_VERSION,
    inputHash: createHash('sha256').update(input).digest('hex'),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}
