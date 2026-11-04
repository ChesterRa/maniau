// 品物から、駅の近くの店を地図で探す検索語の候補を、Claude が出す（推定。家族が直して「探す」を押すまで、
// 何も探さず、何も書かない）。送るのは品物の名前だけ（家族の名前・予定・場所は送らない）。Google から
// 受け取った物は送らない。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ReadingError } from './extract';
import { FAST_SPEED, PRODUCT_EFFORT, PRODUCT_MODEL } from './model';

export const STORE_KINDS_PROMPT_VERSION = 'store-kinds.v1';
const PROMPT = readFileSync(new URL('./prompts/store-kinds.v1.md', import.meta.url), 'utf8');

/** 一つの検索語の長さの上限（字）と、数の上限。 */
const MAX_QUERY_CHARS = 20;
const MAX_QUERIES = 3;

export const StoreKindsOutput = z.object({ queries: z.array(z.string()) });

export interface StoreKindsResult {
  /** 直して使う候補（空・長すぎる・重なりは落とす）。 */
  queries: string[];
  model: string;
  promptVersion: string;
  inputHash: string;
  usage: { input_tokens: number; output_tokens: number };
}

type MessagesClient = Pick<Anthropic, 'messages'>;

/** モデルの候補を、画面に出せる形にそろえる（コードで確かめる）。 */
export function cleanQueries(queries: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of queries) {
    const q = raw.trim();
    if (q === '' || [...q].length > MAX_QUERY_CHARS || out.includes(q)) continue;
    out.push(q);
    if (out.length === MAX_QUERIES) break;
  }
  return out;
}

export async function readStoreKinds(
  client: MessagesClient,
  what: string,
  options: { model?: string } = {},
): Promise<StoreKindsResult> {
  const input = JSON.stringify({ item: what });
  const response = await client.messages.parse({
    model: options.model ?? PRODUCT_MODEL,
    max_tokens: 2000,
    speed: FAST_SPEED,
    system: PROMPT,
    messages: [{ role: 'user', content: input }],
    output_config: { format: zodOutputFormat(StoreKindsOutput), effort: PRODUCT_EFFORT },
  });
  if (response.stop_reason === 'refusal') throw new ReadingError('refusal', response.stop_reason);
  if (response.stop_reason === 'max_tokens') {
    throw new ReadingError('max_tokens', response.stop_reason);
  }
  const output = response.parsed_output;
  if (!output) throw new ReadingError('unparsed', response.stop_reason);
  return {
    queries: cleanQueries(output.queries),
    model: response.model,
    promptVersion: STORE_KINDS_PROMPT_VERSION,
    inputHash: createHash('sha256').update(input).digest('hex'),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}
