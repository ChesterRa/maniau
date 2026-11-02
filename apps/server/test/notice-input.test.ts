// デモの家庭に、お知らせの文を入れる（貼る・話す）。読み取りは偽物（録った応答の文 ID を付け替えた物）で、
// Claude の API は呼ばない。読めて、読む間に前提が変わらなかった時だけ、出典と読み取りを一度に足す。
import { readFileSync } from 'node:fs';
import { type ExtractionOutput, ExtractionOutput as Output } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp, type FamilyBackend } from '../src/app';
import {
  demoSessions,
  MAX_READINGS_IN_FLIGHT,
  MAX_READINGS_PER_SESSION,
  type NoticeReader,
} from '../src/demo-sessions';
import { type ExtractRequest, ReadingError } from '../src/reading/extract';

const fromRepo = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
// 延期のお知らせの文と、それを Claude が読んだ録った応答（文 ID を、入れた出典の物に付け替える）。
const POSTPONED = fromRepo('data/demo/notices/2026-12-04-enki.txt');
const recorded = JSON.parse(fromRepo('data/demo/recorded/n2.extract.json')).output;
const readingAs = (sourceId: string) =>
  Output.parse(JSON.parse(JSON.stringify(recorded).replaceAll('"n2#', `"${sourceId}#`)));

const answer = (request: ExtractRequest, output: ExtractionOutput, model = 'test-model') => ({
  output,
  model,
  promptVersion: 'test',
  inputHash: `test-${request.source.id}`,
  usage: { input_tokens: 0, output_tokens: 0 },
});

const reader =
  (calls: ExtractRequest[] = []): NoticeReader =>
  async (request) => {
    calls.push(request);
    return answer(request, readingAs(request.source.id));
  };

/** 開けるまで待つ読み取り（読む間に別の事が起きる場面）。 */
function gated(inner: NoticeReader = reader()) {
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const read: NoticeReader = async (request) => {
    entered();
    await gate;
    return inner(request);
  };
  return { read, open, started };
}

type App = ReturnType<typeof createApp>;

async function session(app: App, stage = 'backup') {
  const made = await app.request('/api/demo/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stage }),
  });
  return (await made.json()) as { sessionId: string; canRead: boolean };
}

let op = 0;
const post = (app: App, sid: string, body: Record<string, unknown>) =>
  app.request(`/api/demo/sessions/${sid}/notices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: `op-${++op}`, ...body }),
  });

const command = (app: App, sid: string, body: unknown) =>
  app.request(`/api/demo/sessions/${sid}/commands`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ memberId: 'b', operationId: `cmd-${++op}`, command: body }),
  });

interface ViewBody {
  sources: { id: string }[];
  readings: { sourceId: string; model: string; check: string[]; checkAll: boolean }[];
  items: { item: { id: string; interpretation: { what?: string } }; live: boolean }[];
  changes?: { sourceId: string; gone: { undo: { request: { requestId: string } }[] }[] };
  today: { main: { kind: string }[] };
}

const viewOf = async (app: App, sid: string) =>
  (await (await app.request(`/api/demo/sessions/${sid}/view?member=b`)).json()) as ViewBody;

describe('お知らせの文を入れる', () => {
  it('延期のお知らせを貼ると、読んで計画に入れ、変わったことと取り消しが出る', async () => {
    const calls: ExtractRequest[] = [];
    const app = createApp({ reader: reader(calls) });
    const { sessionId, canRead } = await session(app);
    expect(canRead).toBe(true);
    const response = await post(app, sessionId, { memberId: 'b', text: POSTPONED });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      view: ViewBody;
      sourceId: string;
      check: { sentenceIds: string[]; all: boolean };
    };
    expect(calls.map((c) => c.source.id)).toEqual(['u1']);
    expect(body.sourceId).toBe('u1');
    expect(body.check).toEqual({ sentenceIds: [], all: false });
    const { view } = body;
    expect(view.sources.map((s) => s.id)).toContain('u1');
    expect(view.readings).toContainEqual({
      sourceId: 'u1',
      model: 'test-model',
      check: [],
      checkAll: false,
    });
    expect(view.changes?.sourceId).toBe('u1');
    expect(view.changes?.gone[0]?.undo.map((u) => u.request.requestId).sort()).toEqual([
      'r-gakudo',
      'r-grandma',
    ]);
    expect(view.today.main.map((c) => c.kind)).toContain('cancel');
  });

  it('読み取りの鍵の無いサーバーと、家族の家庭を出すサーバーでは入れられない', async () => {
    for (const app of [
      createApp(),
      // 家族の家庭を出すアプリでは、鍵があってもデモの読み取りを開けない（ログインの無い道で費用を使わせない）。
      createApp({ family: {} as FamilyBackend, reader: reader() }),
    ]) {
      const { sessionId, canRead } = await session(app);
      expect(canRead).toBe(false);
      expect((await post(app, sessionId, { memberId: 'b', text: POSTPONED })).status).toBe(503);
    }
  });

  it('読めなかった時（拒否・足す途中の失敗）は、出典も読み取りも足さない', async () => {
    const refusal: NoticeReader = async () => {
      throw new ReadingError('refusal', 'refusal');
    };
    // 形の合わない記録（モデル名が空）：前半を足した後に投げても、全部を戻す。
    const badRecord: NoticeReader = async (request) =>
      answer(request, readingAs(request.source.id), '');
    for (const read of [refusal, badRecord]) {
      const app = createApp({ reader: read });
      const { sessionId } = await session(app);
      const response = await post(app, sessionId, { memberId: 'b', text: POSTPONED });
      expect(response.status).toBe(502);
      expect(((await response.json()) as { error: string }).error).toBe('readingFailed');
      expect((await viewOf(app, sessionId)).sources.map((s) => s.id)).toEqual(['n1']);
    }
  });

  it('一つのデモで読める数を超えたら断る。家族の大人でない人・空の文も断る', async () => {
    const app = createApp({ reader: reader() });
    const { sessionId } = await session(app, 'arrived');
    expect((await post(app, sessionId, { memberId: 'g', text: '（架空）' })).status).toBe(400);
    expect((await post(app, sessionId, { memberId: 'b', text: '   ' })).status).toBe(400);
    for (let n = 0; n < MAX_READINGS_PER_SESSION; n += 1) {
      expect((await post(app, sessionId, { memberId: 'b', text: POSTPONED })).status).toBe(200);
    }
    expect((await post(app, sessionId, { memberId: 'b', text: POSTPONED })).status).toBe(429);
  });

  it('同じ操作の送り直しは読み直さず、同じ結果を返す（数の上限の後でも）。中身が違えば断る', async () => {
    const calls: ExtractRequest[] = [];
    const app = createApp({ reader: reader(calls) });
    const { sessionId } = await session(app);
    const send = (operationId: string, text = POSTPONED) =>
      post(app, sessionId, { memberId: 'b', text, operationId });
    for (let n = 1; n <= MAX_READINGS_PER_SESSION; n += 1) {
      expect((await send(`same-${n}`)).status).toBe(200);
    }
    // 最後の一回の返事が届かなかった送り直し：数を使い切っていても、読まずに同じ結果を返す。
    const again = await send(`same-${MAX_READINGS_PER_SESSION}`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { sourceId: string }).sourceId).toBe(
      `u${MAX_READINGS_PER_SESSION}`,
    );
    expect(calls).toHaveLength(MAX_READINGS_PER_SESSION);
    expect((await viewOf(app, sessionId)).sources).toHaveLength(1 + MAX_READINGS_PER_SESSION);
    expect((await send('same-1', `${POSTPONED}（違う文）`)).status).toBe(409);
  });

  it('読む間に家族が事項を直したら、古い前提の読み取りを足さない。送り直すと、今の事項で読み直す', async () => {
    const calls: ExtractRequest[] = [];
    const { read, open, started } = gated(reader(calls));
    const app = createApp({ reader: read });
    const { sessionId } = await session(app);
    const reading = post(app, sessionId, {
      memberId: 'b',
      text: POSTPONED,
      operationId: 'while-correcting',
    });
    await started;
    const corrected = await command(app, sessionId, {
      type: 'correctItem',
      itemId: 'n1:i5',
      interpretation: { what: '青いシャツ' },
    });
    expect(corrected.status).toBe(200);
    open();
    const stale = await reading;
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'readingStale' });
    expect((await viewOf(app, sessionId)).sources.map((s) => s.id)).toEqual(['n1']);
    // 送り直すと、家族の直しを重ねた事項を前提に読む。
    const retried = await post(app, sessionId, {
      memberId: 'b',
      text: POSTPONED,
      operationId: 'while-correcting',
    });
    expect(retried.status).toBe(200);
    const shirt = calls.at(-1)?.priorItems.find((i) => i.id === 'n1:i5');
    expect(shirt?.interpretation.what).toBe('青いシャツ');
  });

  it('読む間に家族が未定の値に答えたら、古い前提の読み取りを足さない（答えを、お知らせの作用で上書きしない）', async () => {
    const { read, open, started } = gated();
    const app = createApp({ reader: read });
    const { sessionId } = await session(app, 'arrived');
    const reading = post(app, sessionId, { memberId: 'b', text: POSTPONED });
    await started;
    const answered = await command(app, sessionId, {
      type: 'answer',
      unknownId: 'n1:u1',
      value: '2026-12-05',
    });
    expect(answered.status).toBe(200);
    open();
    const stale = await reading;
    expect(stale.status).toBe(409);
    expect((await viewOf(app, sessionId)).sources.map((s) => s.id)).toEqual(['n1']);

    // 読む前に答えてあった同じ値を、読む間に答え直した時も、後からの事実として扱う。
    const again = gated();
    const app2 = createApp({ reader: again.read });
    const second = await session(app2, 'arrived');
    const answer = { type: 'answer', unknownId: 'n1:u1', value: '2026-12-05' };
    expect((await command(app2, second.sessionId, answer)).status).toBe(200);
    const rereading = post(app2, second.sessionId, { memberId: 'b', text: POSTPONED });
    await again.started;
    expect((await command(app2, second.sessionId, answer)).status).toBe(200);
    again.open();
    expect((await rereading).status).toBe(409);
  });

  it('原文に無い言葉を根拠にした取り消しは効かせず、その文を確かめてもらう', async () => {
    const app = createApp({
      reader: async (request) => {
        const base = readingAs(request.source.id).items[0];
        if (!base) throw new Error('録った応答に事項が無い');
        return answer(request, {
          unknowns: [],
          conditions: [],
          items: [
            {
              ...base,
              id: 'x1',
              kind: 'belongings',
              sentenceIds: [`${request.source.id}#1`],
              written: '白い長袖シャツは不要です。',
              conditionNodeId: null,
              effects: [{ type: 'cancel', itemId: 'n1:i5', unknownId: null, value: null }],
            },
          ],
          irrelevantSentenceIds: [],
          ambiguities: [],
        });
      },
    });
    const { sessionId } = await session(app, 'arrived');
    const response = await post(app, sessionId, {
      memberId: 'b',
      text: '図書室よりお知らせです。',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      view: ViewBody;
      check: { sentenceIds: string[]; all: boolean };
    };
    expect(body.check.sentenceIds).toEqual(['u1#1']);
    // 白いシャツは今の事項のまま（取り消されていない）。
    expect(body.view.items.some((e) => e.item.id === 'n1:i5' && e.live)).toBe(true);
  });

  it('読んでいる間は、同じデモの次の読み取りも、サーバー全体で上限を超える読み取りも断る', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    let allIn = () => {};
    const inFlight = new Promise<void>((resolve) => {
      allIn = resolve;
    });
    const fast = reader();
    const app = createApp({
      reader: async (request) => {
        entered += 1;
        if (entered === MAX_READINGS_IN_FLIGHT) allIn();
        await gate;
        return fast(request);
      },
    });
    const demos = [];
    for (let n = 0; n <= MAX_READINGS_IN_FLIGHT; n += 1) demos.push(await session(app));
    const waiting = demos
      .slice(0, MAX_READINGS_IN_FLIGHT)
      .map((d) => post(app, d.sessionId, { memberId: 'b', text: POSTPONED }));
    await inFlight;
    const busy = async (sid: string) => {
      const response = await post(app, sid, { memberId: 'b', text: POSTPONED });
      return { status: response.status, body: await response.json() };
    };
    const refused = { status: 429, body: { error: 'readingBusy' } };
    expect(await busy(demos[0]?.sessionId ?? '')).toEqual(refused);
    expect(await busy(demos[MAX_READINGS_IN_FLIGHT]?.sessionId ?? '')).toEqual(refused);
    release();
    expect((await Promise.all(waiting)).map((r) => r.status)).toEqual(
      demos.slice(0, MAX_READINGS_IN_FLIGHT).map(() => 200),
    );
    // 読み終えたら、また読める（断った分は数えない）。
    const next = await post(app, demos[0]?.sessionId ?? '', { memberId: 'b', text: POSTPONED });
    expect(next.status).toBe(200);
    expect(entered).toBe(MAX_READINGS_IN_FLIGHT + 1);
  });
});

describe('読み取りの数と期限（デモの家庭の置き場所）', () => {
  const input = (operationId: string) => ({
    text: POSTPONED,
    sender: 'school' as const,
    operationId,
  });

  it('一日の数は、待つ前に押さえる（同じ時に来た二つが、どちらも上限の手前を見て進まない）', async () => {
    const calls: ExtractRequest[] = [];
    const sessions = demoSessions(Date.now, { perDay: 1 });
    const one = sessions.create('backup');
    const two = sessions.create('backup');
    const results = await Promise.all([
      sessions.notice(one, 'b', input('a'), reader(calls)),
      sessions.notice(two, 'b', input('b'), reader(calls)),
    ]);
    expect(results.map((r) => r?.status)).toEqual(['ok', 'limit']);
    expect(calls).toHaveLength(1);
  });

  it('読む間に期限が切れたデモには足さない', async () => {
    let now = Date.parse('2026-11-30T09:00:00Z');
    const sessions = demoSessions(() => now);
    const id = sessions.create('backup');
    const { read, open, started } = gated();
    const reading = sessions.notice(id, 'b', input('late'), read);
    await started;
    now += 12 * 60 * 60 * 1000 + 1;
    open();
    expect(await reading).toBeUndefined();
    expect(await sessions.view(id, 'b')).toBeUndefined();
  });
});
