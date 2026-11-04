// 写真・PDF の書き起こし：送る形（画像か文書か、モデル、effort）と、返す文（空の行を除いてつなぐ）。
// 拒否・打ち切り・形の崩れた出力は使わない。偽物の呼び先で、Claude の API は呼ばない。
import { describe, expect, it } from 'vitest';
import { ReadingError } from '../src/reading/extract';
import {
  checkPhoto,
  DEFAULT_TRANSCRIBE_MODEL,
  MAX_PHOTO_BYTES,
  MAX_TRANSCRIBE_INPUT_TOKENS,
  type PhotoInput,
  PhotoTooLarge,
  TRANSCRIBE_PROMPT_VERSION,
  transcribePhoto,
} from '../src/reading/transcribe';

type Reply = { stop_reason: string; parsed_output: { lines: string[] } | null };

function fake(reply: Reply, counted = 1200) {
  const requests: Record<string, unknown>[] = [];
  const counts: Record<string, unknown>[] = [];
  const client = {
    messages: {
      countTokens: async (request: Record<string, unknown>) => {
        counts.push(request);
        return { input_tokens: counted };
      },
      parse: async (request: Record<string, unknown>) => {
        requests.push(request);
        return {
          ...reply,
          model: 'test-model',
          usage: { input_tokens: 1200, output_tokens: 80 },
        };
      },
    },
  };
  return { client: client as never, requests, counts };
}

const jpeg: PhotoInput = { mediaType: 'image/jpeg', data: 'AAAA' };

describe('写真の書き起こし', () => {
  it('写真は画像として送り、行を空の行を除いてつなぐ', async () => {
    const { client, requests } = fake({
      stop_reason: 'end_turn',
      parsed_output: {
        lines: ['学習発表会のお知らせ', '', ' 12月5日（土）9時から ', '持ち物：上ばき'],
      },
    });
    const result = await transcribePhoto(client, jpeg);
    expect(result.text).toBe('学習発表会のお知らせ\n12月5日（土）9時から\n持ち物：上ばき');
    expect(result.promptVersion).toBe(TRANSCRIBE_PROMPT_VERSION);
    expect(result.usage).toEqual({ input_tokens: 1200, output_tokens: 80 });
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    const [request] = requests;
    expect(request?.model).toBe(DEFAULT_TRANSCRIBE_MODEL);
    expect(request?.output_config).toMatchObject({ effort: 'medium' });
    expect(request?.speed).toBe('fast');
    expect(JSON.stringify(request?.messages)).toContain(
      '"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"AAAA"}',
    );
  });

  it('PDF は文書として送る', async () => {
    const { client, requests } = fake({ stop_reason: 'end_turn', parsed_output: { lines: [] } });
    const result = await transcribePhoto(client, { mediaType: 'application/pdf', data: 'JVBE' });
    expect(result.text).toBe('');
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      '"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBE"}',
    );
  });

  it('拒否・打ち切り・形の崩れた出力は使わない', async () => {
    for (const [stop, reason] of [
      ['refusal', 'refusal'],
      ['max_tokens', 'max_tokens'],
      ['end_turn', 'unparsed'],
    ] as const) {
      const { client } = fake({
        stop_reason: stop,
        parsed_output: stop === 'end_turn' ? null : { lines: ['途中'] },
      });
      const error = await transcribePhoto(client, jpeg).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReadingError);
      expect((error as ReadingError).reason).toBe(reason);
    }
  });
});

describe('呼ぶ前の確かめ', () => {
  it('入力が多すぎる（多いページの PDF 等）時は、数えるだけで呼ばない', async () => {
    const { client, requests, counts } = fake(
      { stop_reason: 'end_turn', parsed_output: { lines: ['x'] } },
      MAX_TRANSCRIBE_INPUT_TOKENS + 1,
    );
    const error = await transcribePhoto(client, {
      mediaType: 'application/pdf',
      data: 'JVBERg==',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhotoTooLarge);
    expect(counts).toHaveLength(1);
    expect(JSON.stringify(counts[0]?.messages)).toContain('"type":"document"');
    // 構造化出力の形も入力に数えられるので、書き起こしと同じ形で数える。
    expect(JSON.stringify(counts[0]?.output_config)).toContain('"type":"json_schema"');
    expect(requests).toEqual([]);
  });

  it('形の正しい base64 で、言った形式の中身で、上限の内の物だけを通す', () => {
    const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
    expect(checkPhoto({ mediaType: 'image/jpeg', data: b64([0xff, 0xd8, 0xff, 0xe0]) })).toBe('ok');
    expect(checkPhoto({ mediaType: 'application/pdf', data: b64([0x25, 0x50, 0x44, 0x46]) })).toBe(
      'ok',
    );
    // 中身が言った形式と違う（PDF を JPEG と言う）。
    expect(checkPhoto({ mediaType: 'image/jpeg', data: b64([0x25, 0x50, 0x44, 0x46]) })).toBe(
      'badPhoto',
    );
    // 余計な = の付いた、形の崩れた base64。
    expect(checkPhoto({ mediaType: 'image/jpeg', data: `${b64([0xff, 0xd8, 0xff])}==` })).toBe(
      'badPhoto',
    );
    const big = Buffer.alloc(MAX_PHOTO_BYTES.pdf + 1);
    big.write('%PDF', 'latin1');
    expect(checkPhoto({ mediaType: 'application/pdf', data: big.toString('base64') })).toBe(
      'tooLarge',
    );
  });
});
