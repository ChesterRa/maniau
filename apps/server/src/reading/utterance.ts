// 家族の一言の読み取り（01-model §10）。Claude の構造化出力で形を決め、対象と権限は
// @maniau/core の toUtteranceReply で確かめる。拒否と打ち切りの出力は使わない。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { type UtteranceContext, UtteranceOutput } from '@maniau/core';
import { ReadingError } from './extract';

export const UTTERANCE_PROMPT_VERSION = 'utterance.v1';
/**
 * 一言の解釈は Sonnet 5.5（01-model §10 の表）。同じ七つの一言で Opus 5.5 と同じ答えを返し、
 * 待つ時間が短かった（話した後すぐ答えたい）。
 */
export const DEFAULT_UTTERANCE_MODEL = 'claude-sonnet-5-5';
const PROMPT = readFileSync(new URL('./prompts/utterance.v1.md', import.meta.url), 'utf8');

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
    system: PROMPT,
    messages: [{ role: 'user', content: input }],
    output_config: {
      format: zodOutputFormat(UtteranceOutput),
      // 話した後すぐ答えたいので low（Sonnet 5.5 の初期値は high。呼び出しごとに明示する）。
      effort: options.effort ?? 'low',
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
