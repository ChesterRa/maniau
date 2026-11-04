// 周りの資源の調べ（survey.v1。02-foundation §3.5）：Claude がウェブ検索で頁を探し、頁を読んで返した候補を、
// コードが確かめて、家族に見せる候補（資源と、要れば前もっての前提の案）にする。家の情報には書かない（家族が入れる）。
//
// 確かめ方：
// - 候補にするのは、同じ応答で頁の本文（text/plain）を読み、候補の引用がその本文に文字のとおりにある物だけ（全角・
//   半角と空白をそろえて比べる）。読んでいない・PDF・読めなかった頁、引用が本文に無い物、頼んでいない種類の物は、
//   候補にせず、外した訳だけを返す。
// - 引用が本文にあることは、その文が頁にあることしか示さない（意味を読み違えていないこと、頁が公式であることは
//   示さない）。事前の登録が要るか・何日前かは、Claude の読みとして原文と一緒に見せ、家族が確かめる。
// - 事前の登録が要るという読みは、その引用も本文にある時だけ、前もっての前提の案（だれの分か分からない・済んだか
//   分からない）を添える。家に入るのは、家族が「要る」と確かめた時だけ。
// - 日数は、引用が本文にあり、引用に同じ数字がある時だけ見せる。何の日数かは確かめていないので、前提の lead には
//   入れない（期限にしない）。
import { z } from 'zod';
import { Id, Preparation, Resource, type ResourceSource } from '../schema/household';
import { DateTime } from '../time';

/** モデルの出力（最後の文の JSON）。言われていない事は null。 */
export const SurveyModelOutput = z.object({
  candidates: z.array(
    z.object({
      kind: z.string().min(1),
      name: z.string().min(1),
      area: z.string().nullable(),
      url: z.string().min(1),
      title: z.string().nullable(),
      /** 何をする所か（家族に見せる一文。頁に書かれた事だけ）。 */
      summary: z.string().min(1),
      /** summary の根拠になる、頁の本文からの短い引用。 */
      quote: z.string().min(1),
      registration: z.object({ required: z.boolean(), quote: z.string().min(1) }).nullable(),
      leadDays: z
        .object({ days: z.number().int().positive().max(366), quote: z.string().min(1) })
        .nullable(),
    }),
  ),
});
export type SurveyModelOutput = z.infer<typeof SurveyModelOutput>;

/** 同じ応答で読んだ頁。text は text/plain の本文（PDF・読めなかった頁には無い）。 */
export interface FetchedPage {
  url: string;
  title?: string;
  text?: string;
  retrievedAt?: string;
  kind: 'text' | 'pdf' | 'error';
}

/** 家族に見せる候補（家の情報には、家族が入れた時だけ入る）。 */
export const SurveyCandidate = z.object({
  id: Id,
  /** 資源の案（扱いは「候補」。分かった事は Claude の一文と、頁の本文にあった引用）。 */
  resource: Resource,
  /** Claude の読み：事前の登録が要るか（引用が本文にある時だけ。意味は家族が確かめる）。 */
  registration: z.object({ required: z.boolean(), quote: z.string().min(1) }).optional(),
  /** 要ると読んだ時の、前もっての前提の案（家族が「要る」と確かめた時だけ家に入る）。 */
  preparation: Preparation.optional(),
  /** 頁に書かれた日数（引用が本文にあり、引用に同じ数字がある時だけ。何の日数かは確かめていない。期限にしない）。 */
  leadDays: z.object({ days: z.number().int().positive(), quote: z.string().min(1) }).optional(),
});
export type SurveyCandidate = z.infer<typeof SurveyCandidate>;

/**
 * 候補にしなかった物と、その訳（家族には訳ごとの数を見せる）。notRead：頁の本文を読んでいない（読んでいない・PDF・
 * 読めなかった）。quoteNotFound：引用が頁の本文に無い。kind：頼んでいない種類。同じ頁・同じ名前の重なりは、同じ
 * 候補なので数えない。
 */
export const SurveyDropped = z.object({
  url: z.string(),
  name: z.string(),
  reason: z.enum(['notRead', 'quoteNotFound', 'kind']),
});
export type SurveyDropped = z.infer<typeof SurveyDropped>;

export interface SurveyChecked {
  candidates: SurveyCandidate[];
  dropped: SurveyDropped[];
}

/**
 * 家族に見せる調べの結果。area は調べた地域、at は調べた時刻。recorded は、前に調べて記録した物（引用の確かめも、
 * その時にした。頁の本文は持たない）。
 */
export const SurveyShown = z.object({
  area: z.string().min(1),
  at: DateTime,
  recorded: z.boolean(),
  candidates: z.array(SurveyCandidate),
  dropped: z.array(SurveyDropped),
});
export type SurveyShown = z.infer<typeof SurveyShown>;

/** 記録した調べ（data/demo/recorded/survey.json）：見せる物と、呼んだモデル・指示の版・使った量。 */
export const SurveyRecord = SurveyShown.extend({
  recorded: z.literal(true),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    web_search_requests: z.number().int().nonnegative(),
    web_fetch_requests: z.number().int().nonnegative(),
  }),
});
export type SurveyRecord = z.infer<typeof SurveyRecord>;

/**
 * 候補の資源を使う前の、事前の登録の案。Claude が「要る」と読み、その引用が頁の本文にあった時は、その出典つきの案
 * （checkSurvey が作る）。無ければ、出典の無い案（Claude が「要らない」と読んだ・読めなかった候補でも、家族が「要る」と
 * 確かめた時に使う。ID と名前は同じ形）。家に入れるのは、家族が「要る」と確かめた時だけ。
 */
export function surveyPreparation(candidate: SurveyCandidate): Preparation {
  return (
    candidate.preparation ?? {
      id: `prep-${candidate.id}`,
      name: `${candidate.resource.name}の事前の登録`,
      resourceId: candidate.id,
      appliesTo: { kind: 'unknown' },
      state: 'unknown',
    }
  );
}

/** 比べるための形：全角・半角をそろえ、空白を除く。 */
const folded = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');
/** 引用が短すぎると、どの頁にもありそうな言葉で通ってしまうので、そろえた後で 8 字より短い引用は確かめない。 */
const MIN_QUOTE = 8;

/** 引用が、読んだ頁の本文に文字のとおりにあるか。 */
export function quoteOnPage(quote: string, page: FetchedPage | undefined): boolean {
  if (page?.kind !== 'text' || page.text === undefined) return false;
  const q = folded(quote);
  return q.length >= MIN_QUOTE && folded(page.text).includes(q);
}

/**
 * モデルの候補を確かめて、家族に見せる候補にする。kinds は頼んだ種類（ほかの種類は外す）。id は、同じ頁・同じ
 * 名前なら同じになる物を呼ぶ側が渡す（調べ直しでも同じ候補と分かるように）。now は、頁を読んだ時刻が応答に無い時
 * に使う、この調べの時刻（頁は同じ応答の中で読んでいる）。
 */
export function checkSurvey(
  output: SurveyModelOutput,
  pages: readonly FetchedPage[],
  kinds: readonly string[],
  idOf: (url: string, name: string) => string,
  now: string,
): SurveyChecked {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const asked = new Set(kinds);
  const accepted = new Set<string>();
  const candidates: SurveyCandidate[] = [];
  // 同じ候補が何度出ても一つに数える（後の物が確かめを通れば、候補にして外した訳を消す）。
  const dropped = new Map<string, SurveyDropped>();
  for (const c of output.candidates) {
    const id = idOf(c.url, c.name);
    if (accepted.has(id)) continue;
    const drop = (reason: SurveyDropped['reason']) =>
      dropped.set(id, { url: c.url, name: c.name, reason });
    if (!asked.has(c.kind)) {
      drop('kind');
      continue;
    }
    const page = byUrl.get(c.url);
    if (page?.kind !== 'text') {
      drop('notRead');
      continue;
    }
    if (!quoteOnPage(c.quote, page)) {
      drop('quoteNotFound');
      continue;
    }
    const title = c.title ?? page.title;
    const source = (quote: string): ResourceSource => ({
      kind: 'webPage',
      url: c.url,
      ...(title ? { title } : {}),
      quote,
      fetchedAt: page.retrievedAt ?? now,
      quoteFound: true,
    });
    const registration =
      c.registration && quoteOnPage(c.registration.quote, page) ? c.registration : undefined;
    const lead =
      c.leadDays &&
      quoteOnPage(c.leadDays.quote, page) &&
      new RegExp(`(?<!\\d)${c.leadDays.days}(?!\\d)`).test(c.leadDays.quote.normalize('NFKC'))
        ? c.leadDays
        : undefined;
    const resource: Resource = {
      id,
      kind: c.kind,
      name: c.name,
      ...(c.area ? { area: c.area } : {}),
      notes: [{ text: c.summary, source: source(c.quote) }],
      use: 'candidate',
    };
    accepted.add(id);
    dropped.delete(id);
    candidates.push({
      id,
      resource,
      ...(registration
        ? { registration: { required: registration.required, quote: registration.quote } }
        : {}),
      ...(registration?.required
        ? {
            preparation: {
              id: `prep-${id}`,
              name: `${c.name}の事前の登録`,
              resourceId: id,
              source: source(registration.quote),
              appliesTo: { kind: 'unknown' },
              state: 'unknown',
            },
          }
        : {}),
      ...(lead ? { leadDays: { days: lead.days, quote: lead.quote } } : {}),
    });
  }
  return { candidates, dropped: [...dropped.values()] };
}
