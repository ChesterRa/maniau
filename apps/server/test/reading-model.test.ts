// 製品の Claude の呼び出しは、どれも Opus 5.5・effort medium・速いモード（作り手の指示 2026-11-04。model.ts）。
// 偽物の呼び先で、送る形だけを確かめる（Claude の API は呼ばない）。
import type { UtteranceContext, WayIdeasContext } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXTRACT_MODEL } from '../src/reading/extract';
import { FAST_SPEED, PRODUCT_EFFORT, PRODUCT_MODEL } from '../src/reading/model';
import { DEFAULT_TRANSCRIBE_MODEL } from '../src/reading/transcribe';
import { DEFAULT_UTTERANCE_MODEL, readUtterance } from '../src/reading/utterance';
import { DEFAULT_WAY_IDEAS_MODEL, readWayIdeas } from '../src/reading/way-ideas';

function fake(parsed: unknown) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    messages: {
      parse: async (request: Record<string, unknown>) => {
        requests.push(request);
        return {
          model: 'claude-opus-5-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
          parsed_output: parsed,
        };
      },
    },
  };
  return { client: client as never, requests };
}

describe('製品の呼び出しのモデルと速さ', () => {
  it('四つの呼び出しの初めのモデルは、どれも Opus 5.5', () => {
    expect(PRODUCT_MODEL).toBe('claude-opus-5-5');
    expect([
      DEFAULT_EXTRACT_MODEL,
      DEFAULT_TRANSCRIBE_MODEL,
      DEFAULT_UTTERANCE_MODEL,
      DEFAULT_WAY_IDEAS_MODEL,
    ]).toEqual(Array(4).fill('claude-opus-5-5'));
  });

  it('一言とやり方の案も、effort medium・速いモードで呼ぶ', async () => {
    const utterance = fake({
      kind: 'unsupported',
      actions: [],
      refs: { taskKeys: [], requestIds: [], itemIds: [] },
      unsupported: 'other',
    });
    await readUtterance(utterance.client, {} as UtteranceContext);
    const ideas = fake({ ideas: [], none: null });
    await readWayIdeas(ideas.client, {} as WayIdeasContext);
    for (const request of [utterance.requests[0], ideas.requests[0]]) {
      expect(request?.model).toBe('claude-opus-5-5');
      expect(request?.speed).toBe(FAST_SPEED);
      expect(request?.output_config).toMatchObject({ effort: PRODUCT_EFFORT });
    }
    expect(PRODUCT_EFFORT).toBe('medium');
    expect(FAST_SPEED).toBe('fast');
  });
});
