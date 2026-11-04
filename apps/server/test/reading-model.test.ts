// 製品の Claude の呼び出しは、どれも Opus 5.5・effort medium（作り手の指示 2026-11-04）。速いモードは CLAUDE_FAST_MODE=1 の
// 時だけ（作り手の指示 2026-11-05：作る間は切り、提出の前に入れる。model.ts）。
// 偽物の呼び先で、送る形だけを確かめる（Claude の API は呼ばない）。
import type { UtteranceContext, WayIdeasContext } from '@maniau/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXTRACT_MODEL, extractNotice } from '../src/reading/extract';
import { PRODUCT_EFFORT, PRODUCT_MODEL, productSpeed } from '../src/reading/model';
import { readStoreKinds } from '../src/reading/store-kinds';
import { DEFAULT_TRANSCRIBE_MODEL, transcribePhoto } from '../src/reading/transcribe';
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

  // 手元の設定に依らないように、どの試験も切った状態から始め、終わったら戻す。
  beforeEach(() => {
    vi.stubEnv('CLAUDE_FAST_MODE', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('五つの呼び出しとも、切り替えのとおりに速さを付ける（切っていれば付けない）', async () => {
    const sent = async () => {
      const requests: Record<string, unknown>[] = [];
      const stop = async (request: Record<string, unknown>) => {
        requests.push(request);
        throw new Error('送る形だけを見る');
      };
      const client = {
        messages: { parse: stop, create: stop, countTokens: async () => ({ input_tokens: 10 }) },
      } as never;
      const source = {
        id: 'n1',
        version: 1,
        receivedAt: '2026-11-25T19:30+09:00',
        sender: 'school' as const,
        language: 'ja' as const,
        medium: 'text' as const,
        sentences: [{ id: 'n1#1', text: '12月5日(土)に学習発表会を行います。' }],
      };
      await extractNotice(client, {
        source,
        schoolYear: '2026',
        priorItems: [],
        priorUnknowns: [],
      }).catch(() => {});
      await transcribePhoto(client, { mediaType: 'image/jpeg', data: 'AAAA' }).catch(() => {});
      await readUtterance(client, {} as UtteranceContext).catch(() => {});
      await readWayIdeas(client, {} as WayIdeasContext).catch(() => {});
      await readStoreKinds(client, 'リコーダー').catch(() => {});
      return requests;
    };
    const off = await sent();
    expect(off).toHaveLength(5);
    for (const request of off) {
      expect(request.model).toBe('claude-opus-5-5');
      expect(request).not.toHaveProperty('speed');
    }
    vi.stubEnv('CLAUDE_FAST_MODE', '1');
    const on = await sent();
    expect(on).toHaveLength(5);
    for (const request of on) expect(request.speed).toBe('fast');
  });

  it('速いモードは CLAUDE_FAST_MODE=1 の時だけ（無ければ標準の速さで、欄を足さない）', () => {
    expect(productSpeed({})).toEqual({});
    expect(productSpeed({ CLAUDE_FAST_MODE: '0' })).toEqual({});
    expect(productSpeed({ CLAUDE_FAST_MODE: '1' })).toEqual({ speed: 'fast' });
  });

  it('一言とやり方の案も、effort medium で呼び、速さは切り替えのとおり', async () => {
    const call = async () => {
      const utterance = fake({
        kind: 'unsupported',
        actions: [],
        refs: { taskKeys: [], requestIds: [], itemIds: [] },
        unsupported: 'other',
      });
      await readUtterance(utterance.client, {} as UtteranceContext);
      const ideas = fake({ ideas: [], none: null });
      await readWayIdeas(ideas.client, {} as WayIdeasContext);
      return [utterance.requests[0], ideas.requests[0]];
    };
    for (const request of await call()) {
      expect(request?.model).toBe('claude-opus-5-5');
      expect(request).not.toHaveProperty('speed');
      expect(request?.output_config).toMatchObject({ effort: PRODUCT_EFFORT });
    }
    vi.stubEnv('CLAUDE_FAST_MODE', '1');
    for (const request of await call()) {
      expect(request?.speed).toBe('fast');
    }
    expect(PRODUCT_EFFORT).toBe('medium');
  });
});
