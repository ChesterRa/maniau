// お知らせの写真・PDF の書き起こし（01-model §10）。Claude に、書かれた文字を読む順にそのまま書き起こさせる。
// 書き起こした文は、家族が写真と並べて確かめ、直してから、文の読み取り（extract）に渡す。ここでは何も
// 記録せず、写真も残さない。拒否（refusal）と打ち切り（max_tokens）の出力は使わない。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ReadingError } from './extract';

export const TRANSCRIBE_PROMPT_VERSION = 'transcribe.v1';
/**
 * 書き起こしは Opus 5.5（手書き・小さい字・表を落とさないため）。考えることは少ないので effort は low
 * （Opus 5.5 は思考を切れない）。
 */
export const DEFAULT_TRANSCRIBE_MODEL = 'claude-opus-5-5';
const PROMPT = readFileSync(new URL('./prompts/transcribe.v1.md', import.meta.url), 'utf8');

export const PhotoMediaType = z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
export type PhotoMediaType = z.infer<typeof PhotoMediaType>;

export interface PhotoInput {
  mediaType: PhotoMediaType;
  /** base64 で書いた中身。 */
  data: string;
}

export const TranscriptOutput = z.object({ lines: z.array(z.string()) });

/** 送れる大きさ（写真は API の一枚の上限、PDF は画面と同じ上限）。 */
export const MAX_PHOTO_BYTES = { image: 5 * 1024 * 1024, pdf: 4 * 1024 * 1024 } as const;
/**
 * 一回の書き起こしの入力の上限（tokens の見積もり）。ファイルの大きさでは、PDF のページ数（ページごとに画像の
 * 分がかかる）を抑えられないので、書き起こしを呼ぶ前に、同じ要求で数える（数える口は無料。ただし写真も
 * Anthropic に送る）。数は見積もりで、実際の入力と少し違うことがある。写真 1 枚と、5 ページほどの PDF が入る
 * 大きさにする（11/3 に数えた量は docs/dev/claude-usage.md）。
 */
export const MAX_TRANSCRIBE_INPUT_TOKENS = 12_000;

/** 入力が多すぎて、呼ばなかった（費用を使っていない）。 */
export class PhotoTooLarge extends Error {
  constructor(readonly inputTokens: number) {
    super(`書き起こしの入力が多すぎる：${inputTokens} tokens`);
  }
}

const SIGNATURES: Record<PhotoMediaType, (bytes: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])),
  'image/webp': (b) =>
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 4).toString('latin1') === '%PDF',
};

/**
 * 呼ぶ前の確かめ：形の正しい base64 か（足りない・余計な字は断る）、言った形式の中身か、大きさが上限の内か。
 */
export function checkPhoto(photo: PhotoInput): 'ok' | 'badPhoto' | 'tooLarge' {
  const bytes = Buffer.from(photo.data, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== photo.data) return 'badPhoto';
  const max = photo.mediaType === 'application/pdf' ? MAX_PHOTO_BYTES.pdf : MAX_PHOTO_BYTES.image;
  if (bytes.length > max) return 'tooLarge';
  return SIGNATURES[photo.mediaType](bytes) ? 'ok' : 'badPhoto';
}

export interface TranscribeResult {
  /** 書き起こした文（行を改行でつなぐ。空の行は除く）。 */
  text: string;
  model: string;
  promptVersion: string;
  /** 送った中身の要約（中身は残さない）。 */
  inputHash: string;
  usage: { input_tokens: number; output_tokens: number };
}

type MessagesClient = Pick<Anthropic, 'messages'>;

export async function transcribePhoto(
  client: MessagesClient,
  photo: PhotoInput,
  options: { model?: string; effort?: 'low' | 'medium' | 'high'; maxInputTokens?: number } = {},
): Promise<TranscribeResult> {
  const block =
    photo.mediaType === 'application/pdf'
      ? {
          type: 'document' as const,
          source: { type: 'base64' as const, media_type: photo.mediaType, data: photo.data },
        }
      : {
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: photo.mediaType, data: photo.data },
        };
  const model = options.model ?? DEFAULT_TRANSCRIBE_MODEL;
  const messages = [
    {
      role: 'user' as const,
      content: [block, { type: 'text' as const, text: '書き起こしてください。' }],
    },
  ];
  // 構造化出力の形も入力に数えられるので、書き起こしと同じ形で数える。
  const output_config = {
    format: zodOutputFormat(TranscriptOutput),
    effort: options.effort ?? 'low',
  };
  // 書き起こしを呼ぶ前に入力の量を見積もり、多すぎれば呼ばない（多いページの PDF などで、費用が膨らまない
  // ように）。
  const counted = await client.messages.countTokens({
    model,
    system: PROMPT,
    messages,
    output_config,
  });
  if (counted.input_tokens > (options.maxInputTokens ?? MAX_TRANSCRIBE_INPUT_TOKENS)) {
    throw new PhotoTooLarge(counted.input_tokens);
  }
  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    system: PROMPT,
    messages,
    output_config,
  });
  if (response.stop_reason === 'refusal') throw new ReadingError('refusal', response.stop_reason);
  if (response.stop_reason === 'max_tokens') {
    throw new ReadingError('max_tokens', response.stop_reason);
  }
  const output = response.parsed_output;
  if (!output) throw new ReadingError('unparsed', response.stop_reason);
  return {
    text: output.lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n'),
    model: response.model,
    promptVersion: TRANSCRIBE_PROMPT_VERSION,
    inputHash: createHash('sha256').update(photo.mediaType).update(photo.data).digest('hex'),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    },
  };
}
