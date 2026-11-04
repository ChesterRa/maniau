// 読み取りの呼び出しの組み立てと、使えない出力の扱いの試験。API は呼ばない。
// 応答は、この試験のために作った形で、モデルの出力ではない（モデルの読み取りの確かめは、録った応答で別に行う）。
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildExtractInput,
  EXTRACT_PROMPT_VERSION,
  extractNotice,
  ReadingError,
} from '../src/reading/extract';

const source = {
  id: 'n1',
  version: 1,
  receivedAt: '2026-11-25T19:30+09:00',
  sender: 'school' as const,
  language: 'ja' as const,
  medium: 'text' as const,
  sentences: [{ id: 'n1#1', text: '12月5日(土)に学習発表会を行います。' }],
};
const request = { source, schoolYear: '2026', priorItems: [], priorUnknowns: [] };
const empty = {
  items: [],
  unknowns: [],
  conditions: [],
  irrelevantSentenceIds: [],
  ambiguities: [],
};

function stub(response: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    messages: {
      parse: async (params: Record<string, unknown>) => {
        calls.push(params);
        return {
          model: 'claude-opus-5-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 50 },
          parsed_output: empty,
          ...response,
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe('読み取りの呼び出し', () => {
  it('型を固定した出力を、モデル・effort を明示して求め、版と入力のハッシュを残す', async () => {
    const { client, calls } = stub({});
    const result = await extractNotice(client, request);
    const params = calls[0] as {
      model: string;
      output_config: { effort: string; format: unknown };
      messages: { content: string }[];
    };
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.output_config.effort).toBe('medium');
    expect((params as { speed?: string }).speed).toBe('fast');
    expect(params.output_config.format).toBeDefined();
    expect(params.messages[0]?.content).toBe(buildExtractInput(request));
    expect(result.promptVersion).toBe(EXTRACT_PROMPT_VERSION);
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('拒否・打ち切り・型に合わない出力は、使えないとして投げる', async () => {
    await expect(extractNotice(stub({ stop_reason: 'refusal' }).client, request)).rejects.toThrow(
      ReadingError,
    );
    await expect(
      extractNotice(stub({ stop_reason: 'max_tokens' }).client, request),
    ).rejects.toMatchObject({ reason: 'max_tokens' });
    await expect(
      extractNotice(stub({ parsed_output: null }).client, request),
    ).rejects.toMatchObject({ reason: 'unparsed' });
  });

  it('住所や家族の名前を、入力に入れない', () => {
    const input = buildExtractInput(request);
    expect(input).not.toMatch(/豊洲|健太|彩|陽菜/);
  });
});
