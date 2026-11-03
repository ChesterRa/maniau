// デモの家庭で、お知らせの写真・PDF を書き起こす：文を返すだけで何も記録せず、写真も残さない。送り直しには
// もう一度呼ばずに同じ文を返し、数の上限と、同時に読む数を守る。書き起こした文は、家族が見比べて直して
// から、写真の印を付けて読む。書き起こしと読み取りは偽物で、Claude の API は呼ばない。
import { readFileSync } from 'node:fs';
import { parseStoredExtraction } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { createApp, type FamilyBackend, MAX_JSON_BODY, MAX_PHOTO_BODY } from '../src/app';
import {
  demoSessions,
  MAX_PHOTOS_PER_SESSION,
  type NoticeReader,
  type PhotoReader,
  type UtteranceReader,
} from '../src/demo-sessions';
import { ReadingError } from '../src/reading/extract';
import { MAX_PHOTO_BYTES, type PhotoInput, PhotoTooLarge } from '../src/reading/transcribe';

const fromRepo = (path: string) =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const POSTPONED = fromRepo('data/demo/notices/2026-12-04-enki.txt');
const recorded = JSON.parse(fromRepo('data/demo/recorded/n2.extract.json')).output;

const reader: NoticeReader = async (request) => ({
  output: parseStoredExtraction(
    JSON.parse(JSON.stringify(recorded).replaceAll('"n2#', `"${request.source.id}#`)),
  ),
  model: 'test-model',
  promptVersion: 'test',
  inputHash: 'test',
  usage: { input_tokens: 0, output_tokens: 0 },
});

const transcriber =
  (calls: PhotoInput[] = [], text = POSTPONED): PhotoReader =>
  async (photo) => {
    calls.push(photo);
    return {
      text,
      model: 'test-model',
      promptVersion: 'test',
      inputHash: 'test',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  };

const JPEG = { mediaType: 'image/jpeg' as const, data: '/9j/4AAQ' };

describe('写真の書き起こし（デモの家庭）', () => {
  it('文を返し、何も記録しない。送り直しには呼ばずに同じ文を返し、中身が違えば断る', async () => {
    const sessions = demoSessions();
    const id = sessions.create('backup');
    const before = await sessions.view(id, 'b');
    const calls: PhotoInput[] = [];
    const read = transcriber(calls);
    expect(await sessions.photo(id, 'b', { ...JPEG, operationId: 'p-1' }, read)).toEqual({
      status: 'ok',
      text: POSTPONED,
    });
    expect(await sessions.photo(id, 'b', { ...JPEG, operationId: 'p-1' }, read)).toEqual({
      status: 'ok',
      text: POSTPONED,
    });
    expect(calls).toHaveLength(1);
    expect(
      await sessions.photo(id, 'b', { ...JPEG, data: '/9j/4BBB', operationId: 'p-1' }, read),
    ).toEqual({ status: 'conflict' });
    const after = await sessions.view(id, 'b');
    expect(after?.plan.throughSeq).toBe(before?.plan.throughSeq);
  });

  it('家族の大人でなければ断り、数を使わない。上限を超えたら呼ばない', async () => {
    const sessions = demoSessions();
    const id = sessions.create('backup');
    const calls: PhotoInput[] = [];
    const read = transcriber(calls);
    expect(await sessions.photo(id, 'nobody', { ...JPEG, operationId: 'x' }, read)).toEqual({
      status: 'invalid',
    });
    for (let i = 0; i < MAX_PHOTOS_PER_SESSION; i++) {
      const result = await sessions.photo(id, 'b', { ...JPEG, operationId: `p-${i}` }, read);
      expect(result?.status).toBe('ok');
    }
    expect(await sessions.photo(id, 'b', { ...JPEG, operationId: 'p-last' }, read)).toEqual({
      status: 'limit',
    });
    expect(calls).toHaveLength(MAX_PHOTOS_PER_SESSION);
  });

  it('同じデモで読んでいる間は重ねて呼ばず、書き起こせなかった操作はもう一度送れる', async () => {
    const sessions = demoSessions();
    const id = sessions.create('backup');
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let fail = true;
    const slow: PhotoReader = async (photo) => {
      await gate;
      if (fail) throw new ReadingError('refusal', 'refusal');
      return transcriber()(photo);
    };
    const first = sessions.photo(id, 'b', { ...JPEG, operationId: 'p-1' }, slow);
    expect(await sessions.photo(id, 'b', { ...JPEG, operationId: 'p-2' }, slow)).toEqual({
      status: 'busy',
    });
    open();
    expect(await first).toEqual({ status: 'failed', reason: 'refusal' });
    fail = false;
    expect((await sessions.photo(id, 'b', { ...JPEG, operationId: 'p-1' }, slow))?.status).toBe(
      'ok',
    );
  });
});

describe('写真の口（HTTP）', () => {
  const start = async (app: ReturnType<typeof createApp>) => {
    const made = await app.request('/api/demo/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'backup' }),
    });
    return (await made.json()) as { sessionId: string; canPhoto: boolean };
  };
  const post = (app: ReturnType<typeof createApp>, sid: string, path: string, body: object) =>
    app.request(`/api/demo/sessions/${sid}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('書き起こした文を返し、その文を写真の印つきで読める', async () => {
    const app = createApp({ reader, transcriber: transcriber() });
    const { sessionId, canPhoto } = await start(app);
    expect(canPhoto).toBe(true);
    const photo = await post(app, sessionId, 'photos', {
      memberId: 'b',
      operationId: 'p-1',
      ...JPEG,
    });
    expect(photo.status).toBe(200);
    const { text } = (await photo.json()) as { text: string };
    expect(text).toBe(POSTPONED);
    const read = await post(app, sessionId, 'notices', {
      memberId: 'b',
      operationId: 'n-1',
      text,
      medium: 'photo',
    });
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      sourceId: string;
      view: { sources: { id: string; medium: string }[] };
    };
    expect(body.view.sources.find((s) => s.id === body.sourceId)?.medium).toBe('photo');
  });

  it('書き起こしの口が無いか、家族の家庭なら開けない。形の違う中身は断る', async () => {
    for (const app of [
      createApp({ reader }),
      createApp({ family: {} as FamilyBackend, reader, transcriber: transcriber() }),
    ]) {
      const made = await app.request('/api/demo/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'backup' }),
      });
      expect(made.status).toBe(200);
      const { sessionId, canPhoto } = (await made.json()) as {
        sessionId: string;
        canPhoto: boolean;
      };
      expect(canPhoto).toBe(false);
      const photo = await post(app, sessionId, 'photos', {
        memberId: 'b',
        operationId: 'p-1',
        ...JPEG,
      });
      expect(photo.status).toBe(503);
    }
    const app = createApp({ reader, transcriber: transcriber() });
    const { sessionId } = await start(app);
    for (const bad of [
      { ...JPEG, mediaType: 'image/heic' },
      { ...JPEG, data: 'not base64!' },
    ]) {
      const photo = await post(app, sessionId, 'photos', {
        memberId: 'b',
        operationId: 'p-1',
        ...bad,
      });
      expect(photo.status).toBe(400);
    }
  });
});

describe('写真の入力の量と、デモが消えた時', () => {
  it('入力の見積もりが多すぎた時は、書き起こさずに断り、一回と数える（送り直しには数え直さない）', async () => {
    const sessions = demoSessions();
    const id = sessions.create('backup');
    let counted = 0;
    const tooLarge: PhotoReader = async () => {
      counted += 1;
      throw new PhotoTooLarge(40_000);
    };
    for (let i = 0; i < 2; i++) {
      expect(await sessions.photo(id, 'b', { ...JPEG, operationId: 'big' }, tooLarge)).toEqual({
        status: 'tooLarge',
      });
    }
    expect(counted).toBe(1);
    const calls: PhotoInput[] = [];
    for (let i = 1; i < MAX_PHOTOS_PER_SESSION; i++) {
      const result = await sessions.photo(
        id,
        'b',
        { ...JPEG, operationId: `p-${i}` },
        transcriber(calls),
      );
      expect(result?.status).toBe('ok');
    }
    expect(
      await sessions.photo(id, 'b', { ...JPEG, operationId: 'p-last' }, transcriber(calls)),
    ).toEqual({ status: 'limit' });
    expect(calls).toHaveLength(MAX_PHOTOS_PER_SESSION - 1);
  });

  it('書き起こす間にデモが期限切れになったら、文を返さない', async () => {
    let now = Date.parse('2026-11-03T08:00:00Z');
    const sessions = demoSessions(() => now);
    const id = sessions.create('backup');
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const slow: PhotoReader = async (photo) => {
      await gate;
      return transcriber()(photo);
    };
    const pending = sessions.photo(id, 'b', { ...JPEG, operationId: 'p-1' }, slow);
    now += 13 * 60 * 60 * 1000;
    open();
    expect(await pending).toBeUndefined();
  });

  it('確かめる間にデモが消えたら（期限切れ・追い出し）、外に送らない（写真・お知らせ・一言）', async () => {
    let now = Date.parse('2026-11-03T08:00:00Z');
    const later = () => {
      now += 13 * 60 * 60 * 1000;
    };
    const calls: PhotoInput[] = [];
    let noticeReads = 0;
    let heard = 0;
    const notices: NoticeReader = async (request) => {
      noticeReads += 1;
      return reader(request);
    };
    const listener: UtteranceReader = async () => {
      heard += 1;
      throw new ReadingError('refusal', 'refusal');
    };
    // 期限切れ：呼んだ後、最初の待ちの間に時計が進む。
    for (const start of [
      (sessions: ReturnType<typeof demoSessions>, id: string) =>
        sessions.photo(id, 'b', { ...JPEG, operationId: 'p-1' }, transcriber(calls)),
      (sessions: ReturnType<typeof demoSessions>, id: string) =>
        sessions.notice(
          id,
          'b',
          { text: POSTPONED, sender: 'school', operationId: 'n-1' },
          notices,
        ),
      (sessions: ReturnType<typeof demoSessions>, id: string) =>
        sessions.utterance(id, 'b', { text: 'シャツは家にない', operationId: 'u-1' }, listener),
    ]) {
      const sessions = demoSessions(() => now);
      const pending = start(sessions, sessions.create('backup'));
      later();
      expect(await pending).toBeUndefined();
    }
    // 追い出し：写真を確かめる間に、新しいデモが上限まで作られる。
    const sessions = demoSessions(() => now);
    const pending = sessions.photo(
      sessions.create('backup'),
      'b',
      { ...JPEG, operationId: 'p-2' },
      transcriber(calls),
    );
    // 埋める物は、作るのが速い最初の段にする。
    for (let i = 0; i < 200; i++) sessions.create('arrived');
    expect(await pending).toBeUndefined();
    expect(calls).toEqual([]);
    expect(noticeReads).toBe(0);
    expect(heard).toBe(0);
  });

  it('書き起こしている途中のデモは、新しいデモが上限まで作られても追い出さず、文を返す', async () => {
    const sessions = demoSessions();
    const id = sessions.create('backup');
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const calls: PhotoInput[] = [];
    const slow: PhotoReader = async (photo) => {
      await gate;
      return transcriber(calls)(photo);
    };
    const pending = sessions.photo(id, 'b', { ...JPEG, operationId: 'p-1' }, slow);
    // 確かめ終えて、書き起こしを待つ所まで進める。
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let i = 0; i < 200; i++) sessions.create('arrived');
    open();
    expect(await pending).toEqual({ status: 'ok', text: POSTPONED });
    expect(calls).toHaveLength(1);
    expect(await sessions.view(id, 'b')).toBeDefined();
  });

  it('形の崩れた・言った形式と違う・大きすぎる中身は、書き起こしに渡さずに断る', async () => {
    const calls: PhotoInput[] = [];
    const app = createApp({ reader, transcriber: transcriber(calls) });
    const made = await app.request('/api/demo/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'backup' }),
    });
    const { sessionId } = (await made.json()) as { sessionId: string };
    const post = (mediaType: string, data: string) =>
      app.request(`/api/demo/sessions/${sessionId}/photos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ memberId: 'b', operationId: `p-${data.length}`, mediaType, data }),
      });
    const pdfBytes = Buffer.alloc(MAX_PHOTO_BYTES.pdf + 1);
    pdfBytes.write('%PDF', 'latin1');
    expect((await post('image/jpeg', 'JVBERg==')).status).toBe(400);
    expect((await post('image/jpeg', '/9j/4AAQ==')).status).toBe(400);
    expect((await post('application/pdf', pdfBytes.toString('base64'))).status).toBe(413);
    expect(calls).toEqual([]);
  });
});

describe('要求の中身の大きさ（読む前に断る）', () => {
  const start = async (app: ReturnType<typeof createApp>) => {
    const made = await app.request('/api/demo/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'backup' }),
    });
    return ((await made.json()) as { sessionId: string }).sessionId;
  };
  const post = (
    app: ReturnType<typeof createApp>,
    path: string,
    body: string,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

  it('写真の口は写真の大きさまで受け、超える中身は、言った大きさでも実際の大きさでも読まずに断る', async () => {
    const calls: PhotoInput[] = [];
    const app = createApp({ reader, transcriber: transcriber(calls) });
    const path = `/api/demo/sessions/${await start(app)}/photos`;
    const photo = (data: string, operationId: string) =>
      JSON.stringify({ memberId: 'b', operationId, mediaType: 'image/jpeg', data });
    // 他の口の上限（64KB）を超える写真も、写真の口では受ける。
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100_000)]);
    const fits = await post(app, path, photo(jpeg.toString('base64'), 'p-1'));
    expect(fits.status).toBe(200);
    const claimed = await post(app, path, '{}', { 'content-length': String(MAX_PHOTO_BODY + 1) });
    expect(claimed.status).toBe(413);
    expect(await claimed.json()).toEqual({ error: 'photoTooLarge' });
    const streamed = await post(app, path, photo('A'.repeat(MAX_PHOTO_BODY), 'p-2'));
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toEqual({ error: 'photoTooLarge' });
    expect(calls).toHaveLength(1);
  });

  it('他の口は、文の上限に合わせた大きさを超える中身を、読み取りに渡さずに断る', async () => {
    let reads = 0;
    const counting: NoticeReader = async (request) => {
      reads += 1;
      return reader(request);
    };
    const app = createApp({ reader: counting });
    const path = `/api/demo/sessions/${await start(app)}/notices`;
    const big = JSON.stringify({
      memberId: 'b',
      operationId: 'n-1',
      text: 'あ'.repeat(MAX_JSON_BODY / 3 + 1),
    });
    const refused = await post(app, path, big);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual({ error: 'bodyTooLarge' });
    const usual = JSON.stringify({ memberId: 'b', operationId: 'n-2', text: POSTPONED });
    expect((await post(app, path, usual)).status).toBe(200);
    expect(reads).toBe(1);
  });
});
