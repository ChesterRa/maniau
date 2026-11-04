// 家族の一言の読み取り（01-model §10）。Claude の構造化出力で形を決め、対象と権限は
// @maniau/core の toUtteranceReply で確かめる。拒否と打ち切りの出力は使わない。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { type UtteranceContext, UtteranceModelOutput, type UtteranceOutput } from '@maniau/core';
import { ReadingError } from './extract';
import { FAST_SPEED, PRODUCT_EFFORT, PRODUCT_MODEL } from './model';

export const UTTERANCE_PROMPT_VERSION = 'utterance.v3';
/**
 * 一言の解釈も、製品の呼び出しと同じ Opus 5.5・medium・速いモード（model.ts。作り手の指示 2026-11-04：読みの
 * 確かさと速さを先にする）。
 */
export const DEFAULT_UTTERANCE_MODEL = PRODUCT_MODEL;
const PROMPT = readFileSync(new URL('./prompts/utterance.v3.md', import.meta.url), 'utf8');

export interface UtteranceResult {
  output: UtteranceOutput;
  model: string;
  promptVersion: string;
  inputHash: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** モデルに渡す入力（前提をそのまま JSON にする）。 */
export const buildUtteranceInput = (context: UtteranceContext): string => JSON.stringify(context);

type MessagesClient = Pick<Anthropic, 'messages'>;

export async function readUtterance(
  client: MessagesClient,
  context: UtteranceContext,
  options: { model?: string; effort?: 'low' | 'medium' | 'high' } = {},
): Promise<UtteranceResult> {
  const input = buildUtteranceInput(context);
  const response = await client.messages.parse({
    model: options.model ?? DEFAULT_UTTERANCE_MODEL,
    max_tokens: 8000,
    speed: FAST_SPEED,
    system: PROMPT,
    messages: [{ role: 'user', content: input }],
    output_config: {
      // どの欄も必ず返させる形（使わない欄は null）。読む側の形 UtteranceOutput は、前の版の記録も読める。
      format: zodOutputFormat(UtteranceModelOutput),
      // 呼び出しごとに明示する（model.ts）。
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
    promptVersion: UTTERANCE_PROMPT_VERSION,
    inputHash: createHash('sha256').update(input).digest('hex'),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}
