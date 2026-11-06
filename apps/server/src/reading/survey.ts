// 周りの資源の調べ（survey.v1。02-foundation §3.5）：Claude がウェブ検索で頁を探し、頁を読んで、候補を JSON で
// 返す。引用が読んだ頁の本文にあるかは、@maniau/core の checkSurvey がコードで確かめる。何も書かない（家族が入れる）。
//
// ウェブ検索は引用（citations）がいつも付くので、構造化出力（output_config.format）とは一緒に使えない（公式の文書）。
// 最後の文の JSON を zod で読む。検索と頁の読み取りは、コードの実行を通さず直に呼ばせる（allowed_callers: direct）。
// 頁の本文（text/plain）が応答に入り、コードが引用を確かめられる。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type Anthropic from '@anthropic-ai/sdk';
import {
  checkHomeArea,
  type FetchedPage,
  formatDateTime,
  type Household,
  SurveyModelOutput,
} from '@maniau/core';
import { ReadingError } from './extract';
import { PRODUCT_EFFORT, PRODUCT_MODEL, productSpeed } from './model';

export const SURVEY_PROMPT_VERSION = 'survey.v1';
const PROMPT = readFileSync(new URL('./prompts/survey.v1.md', import.meta.url), 'utf8');

/** 調べる資源の種類（データ。計算は種類で分けない）。 */
export const SURVEY_KINDS = [
  { kind: 'sickChildCare', label: '病児保育・病後児保育（子どもが病気の時に預かる）' },
  { kind: 'temporaryCare', label: '一時保育・一時預かり' },
  {
    kind: 'familySupport',
    label: 'ファミリー・サポート・センター（地域の会員が送り迎えや預かりをする）',
  },
] as const;

/**
 * モデルに渡す入力。area は区や駅の粒度（番地は渡さない）。国・時区と、地域の頭に書いてあった都道府県（region）は、
 * 検索の地域の目安にだけ使う。
 */
export interface SurveyInput {
  area: string;
  kinds: readonly { kind: string; label: string }[];
  today: string;
  country: string;
  timeZone: string;
  region?: string;
}

/**
 * 家の情報から、調べる時にモデルに渡す物を作る：家の場所の地域（区や駅の粒度。番地は持たない）と最寄りの駅、頼む
 * 種類、今日（本当の日付。デモの時計ではない）、検索の地域の目安の国と時区。家の場所に地域が無ければ noArea。
 */
export function surveyInputFor(household: Household, nowMs: number): SurveyInput | 'noArea' {
  const home = household.places.find((p) => p.kind === 'home');
  if (!home?.area) return 'noArea';
  const station = household.places.find((p) => p.id === home.nearStationId);
  const checked = checkHomeArea(home.area);
  const read = typeof checked === 'string' ? undefined : checked;
  return {
    area: station ? `${home.area}（${station.name}）` : home.area,
    kinds: SURVEY_KINDS,
    today: formatDateTime(Math.floor(nowMs / 60_000), household.timeZone).slice(0, 10),
    country: household.region,
    timeZone: household.timeZone,
    ...(read?.prefecture ? { region: read.prefecture } : {}),
  };
}

/** 候補の ID：同じ頁・同じ名前なら同じ（調べ直しても同じ候補と分かる）。家の情報の ID の形に収める。 */
export const surveyCandidateId = (url: string, name: string) =>
  `res-${createHash('sha256').update(`${url}\u0000${name}`).digest('hex').slice(0, 12)}`;

/** 応答の中身（ブロックの並び）。録った応答も同じ形で渡せる（試験・比べる評価は API を呼ばない）。 */
export type SurveyBlocks = readonly Anthropic.ContentBlock[];

export interface SurveyResult {
  output: SurveyModelOutput;
  pages: FetchedPage[];
  model: string;
  promptVersion: string;
  inputHash: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    web_search_requests: number;
    web_fetch_requests: number;
  };
}

/**
 * 読んだ頁：応答の web_fetch の結果から、URL・題・本文（text/plain だけ）・読んだ時刻（家の時区の時刻の形にする。
 * 読めない時刻は持たない）。
 */
export function fetchedPages(blocks: SurveyBlocks, timeZone: string): FetchedPage[] {
  const pages: FetchedPage[] = [];
  for (const block of blocks) {
    if (block.type !== 'web_fetch_tool_result') continue;
    const content = block.content;
    if (content.type !== 'web_fetch_result') continue;
    const source = content.content.source;
    const retrieved = content.retrieved_at ? Date.parse(content.retrieved_at) : Number.NaN;
    pages.push({
      url: content.url,
      ...(content.content.title ? { title: content.content.title } : {}),
      ...(Number.isFinite(retrieved)
        ? { retrievedAt: formatDateTime(Math.floor(retrieved / 60_000), timeZone) }
        : {}),
      ...(source.type === 'text'
        ? { text: source.data, kind: 'text' as const }
        : { kind: 'pdf' as const }),
    });
  }
  return pages;
}

/** 最後の文の ```json の囲み（無ければ最後の { … }）を読む。 */
export function surveyOutputOf(blocks: SurveyBlocks): SurveyModelOutput {
  const text = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const fenced = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  const raw = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReadingError('unparsed', 'json');
  }
  const output = SurveyModelOutput.safeParse(parsed);
  if (!output.success) throw new ReadingError('unparsed', 'shape');
  return output.data;
}

type MessagesClient = Pick<Anthropic, 'messages'>;

/** 止まった応答（pause_turn）を、そのまま返して続けさせる回数の上限。 */
const MAX_CONTINUE = 4;
/**
 * 一つの要求の待ちの上限。検索と頁の読み取りを何度かするので、ほかの読み取り（サーバーの口の既定 110 秒）より長く
 * する（2026-11-05 の記録の調べは、標準の速さで全部で 57 秒）。
 */
const SURVEY_REQUEST_TIMEOUT_MS = 240_000;

export async function readSurvey(
  client: MessagesClient,
  input: SurveyInput,
): Promise<SurveyResult> {
  const { country, timeZone, region, ...asked } = input;
  const content = JSON.stringify(asked);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content }];
  const blocks: Anthropic.ContentBlock[] = [];
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    web_search_requests: 0,
    web_fetch_requests: 0,
  };
  let model: string = PRODUCT_MODEL;
  for (let turn = 0; ; turn++) {
    const response = await client.messages.create(
      {
        model: PRODUCT_MODEL,
        max_tokens: 16000,
        ...productSpeed(),
        system: PROMPT,
        messages,
        output_config: { effort: PRODUCT_EFFORT },
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            max_uses: 6,
            allowed_callers: ['direct'],
            user_location: {
              type: 'approximate',
              country,
              timezone: timeZone,
              ...(region ? { region } : {}),
            },
          },
          {
            type: 'web_fetch_20260209',
            name: 'web_fetch',
            max_uses: 8,
            allowed_callers: ['direct'],
            max_content_tokens: 12000,
          },
        ],
      },
      { timeout: SURVEY_REQUEST_TIMEOUT_MS },
    );
    model = response.model;
    usage.input_tokens += response.usage.input_tokens;
    usage.output_tokens += response.usage.output_tokens;
    usage.web_search_requests += response.usage.server_tool_use?.web_search_requests ?? 0;
    usage.web_fetch_requests += response.usage.server_tool_use?.web_fetch_requests ?? 0;
    blocks.push(...response.content);
    if (response.stop_reason === 'refusal') throw new ReadingError('refusal', response.stop_reason);
    if (response.stop_reason === 'max_tokens') {
      throw new ReadingError('max_tokens', response.stop_reason);
    }
    if (response.stop_reason !== 'pause_turn') break;
    if (turn >= MAX_CONTINUE) throw new ReadingError('unparsed', 'pause_turn');
    // 止まった応答は、そのまま返して続けさせる（「続けて」の文は足さない）。
    messages.push({ role: 'assistant', content: response.content });
  }
  return {
    output: surveyOutputOf(blocks),
    pages: fetchedPages(blocks, timeZone),
    model,
    promptVersion: SURVEY_PROMPT_VERSION,
    inputHash: createHash('sha256').update(content).digest('hex'),
    usage,
  };
}
