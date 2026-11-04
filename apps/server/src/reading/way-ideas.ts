// 新しい「すること」に、Claude がやり方の案を出す（W4。02-foundation §3.4）。構造化出力で形を決め、ID・数・時刻・
// 引用は @maniau/core の checkWayIdeas で確かめる。拒否と打ち切りの出力は使わない。何も書かない（家族が表で確かめて
// 保存するまで、計画は変わらない）。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { type WayIdeasContext, WayIdeasOutput } from '@maniau/core';
import { ReadingError } from './extract';

export const WAY_IDEAS_PROMPT_VERSION = 'way-ideas.v1';
/**
 * 案は Sonnet 5.5（家族が画面で待つので速さを先に見る）。開発の場面で足りなければ Opus 5.5 にする（01-model §10 の表）。
 */
export const DEFAULT_WAY_IDEAS_MODEL = 'claude-sonnet-5-5';
const PROMPT = readFileSync(new URL('./prompts/way-ideas.v1.md', import.meta.url), 'utf8');

export interface WayIdeasResult {
  output: WayIdeasOutput;
  model: string;
  promptVersion: string;
  inputHash: string;
  usage: { input_tokens: number; output_tokens: number };
}

/** モデルに渡す入力（前提をそのまま JSON にする。画面にも同じ物を見せる）。 */
export const buildWayIdeasInput = (context: WayIdeasContext): string => JSON.stringify(context);

type MessagesClient = Pick<Anthropic, 'messages'>;

export async function readWayIdeas(
  client: MessagesClient,
  context: WayIdeasContext,
  options: { model?: string; effort?: 'low' | 'medium' | 'high' } = {},
): Promise<WayIdeasResult> {
  const input = buildWayIdeasInput(context);
  const response = await client.messages.parse({
    model: options.model ?? DEFAULT_WAY_IDEAS_MODEL,
    max_tokens: 8000,
    system: PROMPT,
    messages: [{ role: 'user', content: input }],
    output_config: {
      format: zodOutputFormat(WayIdeasOutput),
      // 家の人と手立てを組み合わせて考えるので medium（呼び出しごとに明示する）。
      effort: options.effort ?? 'medium',
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
    promptVersion: WAY_IDEAS_PROMPT_VERSION,
    inputHash: createHash('sha256').update(input).digest('hex'),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}
