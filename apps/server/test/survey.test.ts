// 家の周りの調べ（02-foundation §3.5）：Claude のウェブ検索と頁の読み取りの応答から、読んだ頁と候補を取り出し、
// コードが確かめた候補だけを見せる。デモでは、記録した調べ（数えない）と、Claude にいま調べてもらう（数と同時に
// 読む数を抑える）の二つ。家の情報に入れられるのは、見せた候補と同じ中身の物だけ。Claude の API は呼ばない（偽物の
// 応答）。頁と候補は架空の物（example.invalid）。
import {
  type Household,
  type SaveablePreview,
  type SurveyShown,
  surveyPreparation,
} from '@maniau/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { demoSessions, type SurveyReader } from '../src/demo-sessions';
import { ReadingError } from '../src/reading/extract';
import {
  readSurvey,
  SURVEY_KINDS,
  type SurveyInput,
  type SurveyResult,
  surveyCandidateId,
} from '../src/reading/survey';

const PAGE_URL = 'https://example.invalid/sick-care';
const PAGE_TEXT = [
  'みなと橋病児保育室（架空）は、病気のお子さんを、保護者が仕事などで家庭で保育できないときにお預かりします。',
  '利用には、事前の利用登録が必要です。登録は利用の３日前までに済ませてください。',
].join('\n');

const ANSWER = {
  candidates: [
    {
      kind: 'sickChildCare',
      name: 'みなと橋病児保育室（架空）',
      area: '豊洲',
      url: PAGE_URL,
      title: null,
      summary: '病気の子を、保護者が仕事で見られない時に預かる。',
      quote: '家庭で保育できないときにお預かりします。',
      registration: { required: true, quote: '利用には、事前の利用登録が必要です。' },
      leadDays: { days: 3, quote: '登録は利用の3日前までに済ませてください。' },
    },
    {
      kind: 'temporaryCare',
      name: '読んでいない頁の一時預かり（架空）',
      area: null,
      url: 'https://example.invalid/never-read',
      title: null,
      summary: '一時的に預かる。',
      quote: 'この頁は読んでいないので確かめられない引用です。',
      registration: null,
      leadDays: null,
    },
  ],
};

/** 止まった応答（検索だけ）と、続けた応答（頁の読み取りと最後の JSON）。 */
function fakeClient(answer: unknown = ANSWER, stop: string = 'end_turn') {
  const requests: Record<string, unknown>[] = [];
  const responses = [
    {
      model: 'claude-opus-5-5',
      stop_reason: 'pause_turn',
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        server_tool_use: { web_search_requests: 2 },
      },
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: '豊洲 病児保育' },
          caller: { type: 'direct' },
        },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          caller: { type: 'direct' },
          content: [
            { type: 'web_search_result', url: PAGE_URL, title: '架空の頁', encrypted_content: 'x' },
          ],
        },
      ],
    },
    {
      model: 'claude-opus-5-5',
      stop_reason: stop,
      usage: { input_tokens: 3000, output_tokens: 400, server_tool_use: { web_fetch_requests: 1 } },
      content: [
        {
          type: 'web_fetch_tool_result',
          tool_use_id: 'srvtoolu_2',
          caller: { type: 'direct' },
          content: {
            type: 'web_fetch_result',
            url: PAGE_URL,
            retrieved_at: '2026-11-05T00:58:31.512Z',
            content: {
              type: 'document',
              title: 'みなと橋病児保育室のご案内（架空）',
              citations: null,
              source: { type: 'text', media_type: 'text/plain', data: PAGE_TEXT },
            },
          },
        },
        {
          type: 'text',
          text: `調べました。\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
        },
      ],
    },
  ];
  const client = {
    messages: {
      create: async (request: Record<string, unknown>) => {
        requests.push(structuredClone(request));
        const next = responses.shift();
        if (!next) throw new Error('呼びすぎ');
        return next;
      },
    },
  };
  return { client: client as never, requests };
}

// 速いモードの切り替えは、手元の設定に依らず切った状態から始める。
beforeEach(() => {
  vi.stubEnv('CLAUDE_FAST_MODE', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const INPUT: SurveyInput = {
  area: '豊洲（豊洲駅）',
  kinds: SURVEY_KINDS,
  today: '2026-11-05',
  country: 'JP',
  timeZone: 'Asia/Tokyo',
};

describe('周りの調べの呼び出し', () => {
  it('検索と頁の読み取りを直に呼ばせ、止まった応答は続けさせ、読んだ頁・候補・使った量を返す', async () => {
    const { client, requests } = fakeClient();
    const result = await readSurvey(client, INPUT);
    expect(requests).toHaveLength(2);
    const [first, second] = requests;
    expect(first?.model).toBe('claude-opus-5-5');
    expect(first).not.toHaveProperty('speed');
    expect(first?.output_config).toEqual({ effort: 'medium' });
    expect(first?.tools).toEqual([
      expect.objectContaining({
        type: 'web_search_20260209',
        allowed_callers: ['direct'],
        user_location: { type: 'approximate', country: 'JP', timezone: 'Asia/Tokyo' },
      }),
      expect.objectContaining({ type: 'web_fetch_20260209', allowed_callers: ['direct'] }),
    ]);
    // 国と時区はモデルへの文に入れない（検索の地域の目安だけ）。
    const messagesOf = (r: Record<string, unknown> | undefined) =>
      (r?.messages ?? []) as { content: unknown }[];
    const sent = JSON.parse(String(messagesOf(first)[0]?.content));
    expect(sent).toEqual({ area: '豊洲（豊洲駅）', kinds: SURVEY_KINDS, today: '2026-11-05' });
    // 止まった応答は、そのまま返して続けさせる。
    expect(messagesOf(second)).toHaveLength(2);
    expect(result.pages).toEqual([
      {
        url: PAGE_URL,
        title: 'みなと橋病児保育室のご案内（架空）',
        retrievedAt: '2026-11-05T09:58+09:00',
        text: PAGE_TEXT,
        kind: 'text',
      },
    ]);
    expect(result.output.candidates).toHaveLength(2);
    expect(result.usage).toEqual({
      input_tokens: 4000,
      output_tokens: 500,
      web_search_requests: 2,
      web_fetch_requests: 1,
    });
  });

  it('速いモードは切り替えの時だけ', async () => {
    vi.stubEnv('CLAUDE_FAST_MODE', '1');
    try {
      const { client, requests } = fakeClient();
      await readSurvey(client, INPUT);
      expect(requests[0]?.speed).toBe('fast');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('JSON が無い・形が違う・断られた応答は、読み取りの失敗にする', async () => {
    await expect(readSurvey(fakeClient({ wrong: true }).client, INPUT)).rejects.toMatchObject({
      reason: 'unparsed',
    });
    await expect(readSurvey(fakeClient(ANSWER, 'refusal').client, INPUT)).rejects.toBeInstanceOf(
      ReadingError,
    );
  });

  it('候補の ID は、同じ頁・同じ名前なら同じで、家の情報の ID の形', () => {
    const id = surveyCandidateId(PAGE_URL, 'みなと橋病児保育室（架空）');
    expect(id).toBe(surveyCandidateId(PAGE_URL, 'みなと橋病児保育室（架空）'));
    expect(id).not.toBe(surveyCandidateId(PAGE_URL, '別の名前'));
    expect(id).toMatch(/^res-[0-9a-f]{12}$/);
  });
});

/** 偽物の読み手：数えて、上の応答を返す（読む間に待たせることもできる）。 */
function reader(during?: () => Promise<void>, fail?: Error) {
  const inputs: SurveyInput[] = [];
  const read: SurveyReader = async (input) => {
    inputs.push(input);
    await during?.();
    if (fail) throw fail;
    return readSurvey(fakeClient().client, input) as Promise<SurveyResult>;
  };
  return { read, inputs };
}

const RECORDED: SurveyShown = {
  area: '豊洲（豊洲駅）',
  at: '2026-11-05T10:00+09:00',
  recorded: true,
  candidates: [],
  dropped: [],
};

async function setup(
  options: { recorded?: SurveyShown | null; surveysPerDay?: number; clock?: () => number } = {},
) {
  const sessions = demoSessions(
    options.clock ?? Date.now,
    options.surveysPerDay === undefined ? {} : { surveysPerDay: options.surveysPerDay },
    { recordedSurvey: options.recorded === undefined ? RECORDED : options.recorded },
  );
  const id = sessions.create('arrived');
  const household = async () => (await sessions.view(id, 'b'))?.household as Household;
  let op = 0;
  const save = async (next: Household) => {
    const command: SaveablePreview = { type: 'updateHousehold', household: next };
    const shown = await sessions.changePreview(id, 'b', command);
    if (!shown) throw new Error('デモが無い');
    if ('reason' in shown) return { status: 'invalid', reason: shown.reason };
    const done = await sessions.command(id, 'b', `op-${++op}`, {
      ...command,
      seen: { throughSeq: shown.throughSeq, changes: shown.seen },
    });
    return done?.result;
  };
  return { sessions, id, household, save };
}

describe('デモの家庭で、周りを調べる', () => {
  it('記録した調べは、この家の地域の物だけを数えずに見せる', async () => {
    const { sessions, id } = await setup();
    const shown = await sessions.survey(id, 'b', { operationId: 's-1', live: false });
    expect(shown).toEqual({ status: 'ok', survey: RECORDED });
    const other = await setup({ recorded: { ...RECORDED, area: '別の町' } });
    expect(await other.sessions.survey(other.id, 'b', { operationId: 's-1', live: false })).toEqual(
      {
        status: 'noRecord',
      },
    );
    const none = await setup({ recorded: null });
    expect(await none.sessions.survey(none.id, 'b', { operationId: 's-1', live: false })).toEqual({
      status: 'noRecord',
    });
  });

  it('いま調べる時は、家の地域と駅・頼む種類・本当の今日を送り、確かめた候補だけを返す', async () => {
    const { sessions, id } = await setup({ clock: () => Date.parse('2026-11-05T01:00:00Z') });
    const { read, inputs } = reader();
    const done = await sessions.survey(id, 'b', { operationId: 's-1', live: true }, read);
    expect(inputs).toEqual([INPUT]);
    if (done?.status !== 'ok') throw new Error(JSON.stringify(done));
    expect(done.survey).toMatchObject({
      area: '豊洲（豊洲駅）',
      at: '2026-11-05T10:00+09:00',
      recorded: false,
    });
    expect(done.survey.candidates.map((c) => c.resource.name)).toEqual([
      'みなと橋病児保育室（架空）',
    ]);
    expect(done.survey.dropped).toEqual([
      {
        url: 'https://example.invalid/never-read',
        name: '読んでいない頁の一時預かり（架空）',
        reason: 'notRead',
      },
    ]);
  });

  it('同じ操作 ID は調べ直さずに同じ結果。一つのデモで 3 回、サーバー全体で一日の数まで。家族の大人でなければ断る', async () => {
    const { sessions, id } = await setup();
    const { read, inputs } = reader();
    const first = await sessions.survey(id, 'b', { operationId: 's-1', live: true }, read);
    expect(await sessions.survey(id, 'b', { operationId: 's-1', live: true }, read)).toEqual(first);
    // 同じ操作 ID を別の人が使うのは、別の操作（断る）。
    expect(await sessions.survey(id, 'a', { operationId: 's-1', live: true }, read)).toEqual({
      status: 'conflict',
    });
    expect(inputs).toHaveLength(1);
    await sessions.survey(id, 'b', { operationId: 's-2', live: true }, read);
    await sessions.survey(id, 'b', { operationId: 's-3', live: true }, read);
    expect(await sessions.survey(id, 'b', { operationId: 's-4', live: true }, read)).toEqual({
      status: 'limit',
    });
    expect(inputs).toHaveLength(3);
    expect(await sessions.survey(id, 'c', { operationId: 's-5', live: true }, read)).toEqual({
      status: 'invalid',
    });
    const day = await setup({ surveysPerDay: 1 });
    await day.sessions.survey(day.id, 'b', { operationId: 's-1', live: true }, read);
    const another = day.sessions.create('arrived');
    expect(
      await day.sessions.survey(another, 'b', { operationId: 's-1', live: true }, read),
    ).toEqual({ status: 'limit' });
  });

  it('同じデモで同時には調べない。失敗は訳の種類だけを返す', async () => {
    const { sessions, id } = await setup();
    let release = () => {};
    const waiting = new Promise<void>((r) => {
      release = r;
    });
    const slow = reader(() => waiting);
    const running = sessions.survey(id, 'b', { operationId: 's-1', live: true }, slow.read);
    expect(await sessions.survey(id, 'b', { operationId: 's-2', live: true }, slow.read)).toEqual({
      status: 'busy',
    });
    release();
    expect((await running)?.status).toBe('ok');
    const failing = reader(undefined, new ReadingError('unparsed', 'json'));
    expect(
      await sessions.survey(id, 'b', { operationId: 's-3', live: true }, failing.read),
    ).toEqual({
      status: 'failed',
      reason: 'unparsed',
    });
  });

  it('見せた候補だけを、家族が選んだ扱いで家に入れられる。地図の場所は、同じ名前の家以外の場所だけ。前提だけを足しても、頼む先は替えない', async () => {
    const { sessions, id, household, save } = await setup();
    const before = await household();
    // 調べる前は、どんな資源も足せない。
    const made = {
      id: 'res-made-up',
      kind: 'sickChildCare',
      name: '作った資源',
      notes: [],
      use: 'candidate' as const,
    };
    expect(await save({ ...before, resources: [...before.resources, made] })).toMatchObject({
      status: 'invalid',
      reason: 'resourcesLocked',
    });
    const done = await sessions.survey(id, 'b', { operationId: 's-1', live: true }, reader().read);
    if (done?.status !== 'ok') throw new Error('調べられない');
    const [found] = done.survey.candidates;
    if (!found?.preparation) throw new Error('前提の案が無い');
    // 中身を替えた候補は入れない。前提だけ（資源なし）も入れない（資源の参照が切れるので、家の情報の検査で断る）。
    expect(
      await save({
        ...before,
        resources: [...before.resources, { ...found.resource, name: '名前を替えた' }],
      }),
    ).toMatchObject({ status: 'invalid', reason: 'resourceNotAsSurveyed' });
    expect(
      await save({ ...before, preparations: [...before.preparations, found.preparation] }),
    ).toMatchObject({ status: 'invalid', reason: 'householdInvalid' });
    // 地図の場所に結ぶのは、名前が同じで家ではない場所だけ（名前の違う場所・家には結ばない）。
    const other = { id: 'place-other', kind: 'other' as const, name: '別の所（架空）', goods: [] };
    expect(
      await save({
        ...before,
        places: [...before.places, other],
        resources: [...before.resources, { ...found.resource, placeId: other.id }],
      }),
    ).toMatchObject({ status: 'invalid', reason: 'resourceNotAsSurveyed' });
    expect(
      await save({
        ...before,
        resources: [...before.resources, { ...found.resource, placeId: 'home' }],
      }),
    ).toMatchObject({ status: 'invalid', reason: 'resourceNotAsSurveyed' });
    // 資源を「いつも使う」で、同じ名前の場所に結んで入れ、要ると確かめた前提を足し、病児保育のやり方の前提にする。
    const place = {
      id: `place-${found.id.slice(4)}`,
      kind: 'other' as const,
      name: found.resource.name,
      area: '豊洲',
      goods: [],
    };
    const next: Household = {
      ...before,
      places: [...before.places, place],
      resources: [...before.resources, { ...found.resource, placeId: place.id, use: 'usual' }],
      preparations: [...before.preparations, found.preparation],
      ways: before.ways.map((w) =>
        w.id === 'way-sick-care'
          ? { ...w, requires: [...(w.requires ?? []), found.preparation?.id ?? ''] }
          : w,
      ),
    };
    expect(await save(next)).toMatchObject({ status: 'ok' });
    const after = await household();
    const added = after.resources.find((r) => r.id === found.id);
    expect(added).toMatchObject({
      placeId: place.id,
      use: 'usual',
      decidedAt: '2026-11-25T19:31+09:00',
    });
    expect(added?.notes).toEqual(found.resource.notes);
    expect(after.places.find((p) => p.id === place.id)).toMatchObject({ name: place.name });
    const prep = after.preparations.find((p) => p.id === found.preparation?.id);
    expect(prep).toMatchObject({ state: 'unknown', appliesTo: { kind: 'unknown' } });
    expect(prep).not.toHaveProperty('stateCheckedAt');
    // 前提が増えただけで、使う資源と頼む先は前のまま。
    const sickCare = after.ways.find((w) => w.id === 'way-sick-care');
    expect(sickCare).toMatchObject({
      requires: ['prep-sick-care', found.preparation.id],
      resourceIds: ['res-sick-care'],
    });
    expect(sickCare?.steps.map((s) => s.external?.to)).toEqual(['sick-care']);
  });

  it('調べた所を使う新しいやり方：計画の頼む先がその所になり、登録を「陽菜の分・済んだ」と確かめれば印が消える。前のやり方は替わらない', async () => {
    const { sessions, id, household, save } = await setup();
    const done = await sessions.survey(id, 'b', { operationId: 's-1', live: true }, reader().read);
    if (done?.status !== 'ok') throw new Error('調べられない');
    const [found] = done.survey.candidates;
    const prep = found?.preparation;
    if (!found || !prep) throw new Error('前提の案が無い');
    const first = await household();
    const place = {
      id: `place-${found.id.slice(4)}`,
      kind: 'other' as const,
      name: found.resource.name,
      goods: [],
    };
    // 一度目：資源と場所と、陽菜の分で済んだと確かめた登録を入れる（やり方はまだ替えない）。
    expect(
      await save({
        ...first,
        places: [...first.places, place],
        resources: [...first.resources, { ...found.resource, placeId: place.id }],
        preparations: [
          ...first.preparations,
          { ...prep, appliesTo: { kind: 'members', memberIds: ['c'] }, state: 'done' },
        ],
      }),
    ).toMatchObject({ status: 'ok' });
    const added = (await household()).preparations.find((p) => p.id === prep.id);
    expect(added).toMatchObject({
      appliesTo: { kind: 'members', memberIds: ['c'] },
      state: 'done',
      stateCheckedAt: '2026-11-25T19:31+09:00',
    });
    // 二度目：病児保育のやり方を写した新しいやり方。予約はこの所に頼み、時間・期限は家族が入れ、費用は分からない。
    const later = await household();
    const old = later.ways.find((w) => w.id === 'way-sick-care');
    const reserve = old?.steps[0];
    if (!old || !reserve) throw new Error('病児保育のやり方が無い');
    const copy = {
      ...old,
      id: 'way-sick-care-2',
      name: `病児保育に預ける（${found.resource.name}）`,
      steps: [
        {
          ...reserve,
          external: { to: place.id, kind: 'reply' as const },
          deadline: { type: 'daysBefore' as const, days: 1, at: '20:00' },
        },
      ],
      covers: { start: '09:00', end: '18:00' },
      cost: { ...old.cost, yen: 0, unknown: ['yen' as const] },
      requires: [prep.id],
      resourceIds: [found.id],
    };
    expect(await save({ ...later, ways: [...later.ways, copy] })).toMatchObject({ status: 'ok' });
    // 陽菜の「すること」に、新しいやり方と祖母を選ぶ：新しいやり方の案に前もっての印が付かず、本命にすると、
    // 予約の作業はこの所に頼む（前の架空の所ではない）。
    let op = 100;
    const run = async (command: SaveablePreview) => {
      const shown = await sessions.changePreview(id, 'b', command);
      if (!shown || 'reason' in shown) throw new Error(`見られない：${JSON.stringify(shown)}`);
      const result = await sessions.command(id, 'b', `op-${++op}`, {
        ...command,
        seen: { throughSeq: shown.throughSeq, changes: shown.seen },
      });
      expect(result?.result).toMatchObject({ status: 'ok' });
      return result?.view;
    };
    const stated = await run({
      type: 'stateNeed',
      text: '12月2日は陽菜を家で見る',
      interpretation: {
        what: '家で見る',
        shape: 'window',
        date: '2026-12-02',
        startTime: '09:00',
        endTime: '17:00',
        forMemberId: 'c',
      },
    });
    const itemId = stated?.plan.requirements.find((r) => r.kind === 'need' && r.live)?.basis
      .itemIds[0];
    if (!itemId) throw new Error('「すること」が無い');
    const view = await run({ type: 'setNeedWays', itemId, wayIds: [copy.id, 'way-grandma'] });
    const arrangement = view?.plan.arrangements.find((a) => a.kind === 'need' && a.live);
    const option = arrangement?.options.find((o) => o.templateId === copy.id);
    if (!arrangement || !option) throw new Error('新しいやり方の案が無い');
    expect(option).not.toHaveProperty('needsPreparation');
    // 本命に選ぶ（「選んだら」の控えは付けない。付けない時は、見せ直しを求めない）。
    const chosen = await sessions.command(id, 'b', 'op-choose', {
      type: 'chooseOption',
      arrangementKey: arrangement.key,
      optionKey: option.key,
      role: 'primary',
      assigneeId: 'b',
    });
    expect(chosen?.result).toMatchObject({ status: 'ok' });
    const asks = chosen?.view?.plan.tasks.filter(
      (t) => t.live && t.basis.optionKey === option.key && t.external,
    );
    expect(asks?.map((t) => t.external)).toEqual([{ to: place.id, kind: 'reply' }]);
    // 前のやり方は、資源も前提も頼む先も前のまま。
    expect((await household()).ways.find((w) => w.id === 'way-sick-care')).toEqual(old);
  });

  it('Claude の読みの無い候補にも、家族が「要る」と確かめた時の登録の案を入れられる（案と同じ形の時だけ）', async () => {
    const plain: SurveyShown = {
      ...RECORDED,
      candidates: [
        {
          id: 'res-bbbbbbbbbbbb',
          resource: {
            id: 'res-bbbbbbbbbbbb',
            kind: 'temporaryCare',
            name: 'みなと橋一時預かり（架空）',
            notes: [],
            use: 'candidate',
          },
        },
      ],
    };
    const { sessions, id, household, save } = await setup({ recorded: plain });
    await sessions.survey(id, 'b', { operationId: 's-1', live: false });
    const [found] = plain.candidates;
    if (!found) throw new Error('候補が無い');
    const prep = surveyPreparation(found);
    const before = await household();
    expect(
      await save({
        ...before,
        resources: [...before.resources, found.resource],
        preparations: [...before.preparations, { ...prep, name: '別の名前' }],
      }),
    ).toMatchObject({ status: 'invalid', reason: 'resourceNotAsSurveyed' });
    expect(
      await save({
        ...before,
        resources: [...before.resources, found.resource],
        preparations: [...before.preparations, { ...prep, state: 'notDone' }],
      }),
    ).toMatchObject({ status: 'ok' });
    expect((await household()).preparations.find((p) => p.id === prep.id)).toMatchObject({
      name: 'みなと橋一時預かり（架空）の事前の登録',
      state: 'notDone',
      stateCheckedAt: '2026-11-25T19:31+09:00',
    });
  });

  it('場所に結ばずに入れた資源は、後から、名前が同じで家ではない場所にだけ結べる（結んだ場所は替えない）', async () => {
    const { sessions, id, household, save } = await setup();
    const done = await sessions.survey(id, 'b', { operationId: 's-1', live: true }, reader().read);
    if (done?.status !== 'ok') throw new Error('調べられない');
    const [found] = done.survey.candidates;
    if (!found) throw new Error('候補が無い');
    const first = await household();
    // 家に同じ名前の場所（家族が前に入れた所）があり、同じ所と確かめずに資源だけ入れた。
    const own = { id: 'own-place', kind: 'other' as const, name: found.resource.name, goods: [] };
    const other = { id: 'other-place', kind: 'other' as const, name: '別の所（架空）', goods: [] };
    expect(
      await save({
        ...first,
        places: [...first.places, own, other],
        resources: [...first.resources, found.resource],
      }),
    ).toMatchObject({ status: 'ok' });
    const later = await household();
    const linkTo = (placeId: string) => ({
      ...later,
      resources: later.resources.map((r) => (r.id === found.id ? { ...r, placeId } : r)),
    });
    // 名前の違う場所・家には結ばない。
    expect(await save(linkTo(other.id))).toMatchObject({
      status: 'invalid',
      reason: 'resourcesLocked',
    });
    expect(await save(linkTo('home'))).toMatchObject({
      status: 'invalid',
      reason: 'resourcesLocked',
    });
    // 同じ名前の場所に結ぶ（家族が同じ所と確かめた）。扱いと、ほかの欄は替えない。
    expect(await save(linkTo(own.id))).toMatchObject({ status: 'ok' });
    const linked = (await household()).resources.find((r) => r.id === found.id);
    expect(linked).toEqual({
      ...found.resource,
      placeId: own.id,
      decidedAt: '2026-11-25T19:31+09:00',
    });
    // 結んだ場所は、ほかの場所へ替えない。
    const after = await household();
    expect(
      await save({
        ...after,
        resources: after.resources.map((r) =>
          r.id === found.id ? { ...r, placeId: other.id } : r,
        ),
      }),
    ).toMatchObject({ status: 'invalid', reason: 'resourcesLocked' });
  });

  it('「まだ分からない」で資源だけ入れた後でも、登録を入れて、やり方の前提にできる（頼む先は替えない）', async () => {
    const { sessions, id, household, save } = await setup();
    const done = await sessions.survey(id, 'b', { operationId: 's-1', live: true }, reader().read);
    if (done?.status !== 'ok') throw new Error('調べられない');
    const [found] = done.survey.candidates;
    if (!found) throw new Error('候補が無い');
    const first = await household();
    const place = {
      id: `place-${found.id.slice(4)}`,
      kind: 'other' as const,
      name: found.resource.name,
      goods: [],
    };
    expect(
      await save({
        ...first,
        places: [...first.places, place],
        resources: [...first.resources, { ...found.resource, placeId: place.id }],
      }),
    ).toMatchObject({ status: 'ok' });
    const later = await household();
    const prep = surveyPreparation(found);
    expect(
      await save({
        ...later,
        preparations: [...later.preparations, prep],
        ways: later.ways.map((w) =>
          w.id === 'way-sick-care' ? { ...w, requires: [...(w.requires ?? []), prep.id] } : w,
        ),
      }),
    ).toMatchObject({ status: 'ok' });
    const sickCare = (await household()).ways.find((w) => w.id === 'way-sick-care');
    expect(sickCare).toMatchObject({
      requires: ['prep-sick-care', prep.id],
      resourceIds: ['res-sick-care'],
    });
    expect(sickCare?.steps.map((s) => s.external?.to)).toEqual(['sick-care']);
  });

  it('API：記録した調べは鍵なしで見られ、いま調べるのは読み手がある時だけ', async () => {
    const app = createApp();
    const created = await app.request('/api/demo/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stage: 'arrived' }),
    });
    const session = (await created.json()) as {
      sessionId: string;
      hasRecordedSurvey?: boolean;
      canSurvey?: boolean;
    };
    expect(session.hasRecordedSurvey).toBe(true);
    expect(session.canSurvey).toBeUndefined();
    const post = (body: unknown) =>
      app.request(`/api/demo/sessions/${session.sessionId}/survey`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const recorded = await post({ memberId: 'b', operationId: 's-1' });
    expect(recorded.status).toBe(200);
    const shown = (await recorded.json()) as { survey: SurveyShown };
    expect(shown.survey.recorded).toBe(true);
    expect(shown.survey.area).toBe('豊洲（豊洲駅）');
    expect((await post({ memberId: 'b', operationId: 's-2', live: true })).status).toBe(503);
    expect((await post({ memberId: 'b' })).status).toBe(400);
  });

  it('知らないデモは無し', async () => {
    const sessions = demoSessions(Date.now, {}, { recordedSurvey: null });
    expect(await sessions.survey('nope', 'b', { operationId: 's-1', live: false })).toBeUndefined();
  });
});
