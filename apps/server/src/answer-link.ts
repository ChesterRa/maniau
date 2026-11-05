// 相手の頁の口（02-foundation §3.4）：家の外の人（祖母・近所の人・コーチ）が、一人ずつのリンクで、いつにするかの
// 候補に答える。見せるのは、その人が答えるのに要る物だけ（ほかの人の名前・答え・人数・左右する人・家族の計画は
// 出さない）。デモの家庭（架空）でだけ出せる。鍵はサーバーに残さず、sha256 だけを事象と表に持つ。
// リンクからの答えは「リンクを持つ人の答え」で、本人の確かめではない（画面も「リンクから」と言う）。
import { type DateTime, formatDateTime, Id, type Language } from '@maniau/core';
import { type EngineState, foldEvents, liveItems } from '@maniau/core/engine';
import { z } from 'zod';
import { sha256Of } from './digest';
import type { HouseholdLog } from './store';

/** 鍵の sha256 から引く表の一行（どのデモの家庭の、どの「すること」の、だれのリンクか）。 */
export interface LinkEntry {
  householdId: string;
  itemId: string;
  personId: string;
}

export interface AnswerView {
  what: string;
  place?: string;
  /** 答える人の名前（家の名簿の名前か、家族が付けた名前）。 */
  name: string;
  /** 家族が決めた、その人に出す文の言葉（無ければ頁が端末の言葉で決める）。 */
  language?: Language;
  candidates: {
    id: string;
    rev: number;
    date: string;
    startTime: string;
    endTime: string;
    /** リンクからの今の答え（無い・取り下げた時は無し）。 */
    answer?: 'yes' | 'maybe' | 'no';
    note?: string;
    /** その候補へのリンクからの最後の記録の番号（無ければ 0）。送る時にそのまま返す。 */
    seenSeq: number;
  }[];
}

export const AnswerSubmit = z
  .object({
    operationId: z.string().min(1).max(100),
    candidateId: Id,
    rev: z.number().int().positive(),
    seenSeq: z.number().int().nonnegative(),
    answer: z.enum(['yes', 'maybe', 'no', 'withdrawn']),
    note: z.string().trim().min(1).max(140).optional(),
  })
  .strict()
  .refine((b) => b.answer !== 'withdrawn' || b.note === undefined, {
    message: 'noteWithoutAnswer',
  });
export type AnswerSubmit = z.infer<typeof AnswerSubmit>;

export type AnswerResult =
  | { status: 'unauthorized' }
  | { status: 'ok' | 'noop'; view: AnswerView }
  | {
      status: 'conflict';
      reason: 'operationIdReused' | 'candidateChanged' | 'answerChanged';
      view: AnswerView;
    };

/**
 * 押さえた中で、リンクが今も効くかを確かめ直す：「すること」がまだ生きている、その人がまだ名簿にいる、鍵がその人の
 * 今の（止めていない）リンクの物。どれかが違えば無し（どれが違うかを言わない）。
 */
function linked(state: EngineState, entry: LinkEntry, tokenHash: string) {
  const live = liveItems(state).find((l) => l.item.id === entry.itemId);
  if (live?.item.kind !== 'need') return undefined;
  const roster = state.needPeople.get(entry.itemId);
  const person = roster?.people.find((p) => p.id === entry.personId);
  if (!roster || !person) return undefined;
  const link = state.answerLinks.get(entry.itemId)?.get(entry.personId);
  if (!link || link.revoked || link.tokenHash !== tokenHash) return undefined;
  return {
    item: live.item,
    person,
    linkId: link.linkId,
    since: roster.since.get(person.id) ?? Number.POSITIVE_INFINITY,
  };
}

function viewOf(
  state: EngineState,
  entry: LinkEntry,
  need: NonNullable<ReturnType<typeof linked>>,
): AnswerView {
  const member = state.household?.members.find((m) => m.id === entry.personId);
  const name = need.person.kind === 'guest' ? (need.person.name ?? '') : (member?.name ?? '');
  const candidates = (state.needCandidates.get(entry.itemId) ?? []).map((c) => {
    // 計画と同じく、今の代で、その人が今の名簿に加わった後の記録だけを見る。
    const last = state.availability
      .filter(
        (r) =>
          r.itemId === entry.itemId &&
          r.personId === entry.personId &&
          r.candidateId === c.id &&
          r.rev === c.rev &&
          r.source === 'link' &&
          r.seq > need.since,
      )
      .at(-1);
    return {
      id: c.id,
      rev: c.rev,
      date: c.date,
      startTime: c.startTime,
      endTime: c.endTime,
      ...(last && last.answer !== 'withdrawn'
        ? { answer: last.answer, ...(last.note === undefined ? {} : { note: last.note }) }
        : {}),
      seenSeq: last?.seq ?? 0,
    };
  });
  const place = need.item.interpretation.place;
  return {
    what: need.item.interpretation.what ?? need.item.written,
    ...(place === undefined ? {} : { place }),
    name,
    ...(member?.outboundLanguage ? { language: member.outboundLanguage } : {}),
    candidates,
  };
}

/** 頁に見せる物（押さえた中で読む）。 */
export function answerView(
  log: HouseholdLog,
  entry: LinkEntry,
  tokenHash: string,
): AnswerView | undefined {
  const state = foldEvents(log.events());
  const need = linked(state, entry, tokenHash);
  return need ? viewOf(state, entry, need) : undefined;
}

/**
 * リンクからの答えを書く（押さえた中で）。操作 ID は、そのリンクの中の名前にする（家族の操作と混ぜない）。同じ
 * 操作 ID・同じ中身の送り直しは何も足さず、中身が違えば断る。候補の代が今と違う・頁が見た後に同じ人の別の答えが
 * 入った（二つのタブ）時は、今の物を返して断る（後の方が前の方を黙って上書きしない）。
 */
export function submitAnswer(
  log: HouseholdLog,
  entry: LinkEntry,
  tokenHash: string,
  body: AnswerSubmit,
  fallbackNow: DateTime,
): AnswerResult {
  const state = foldEvents(log.events());
  const need = linked(state, entry, tokenHash);
  if (!need || !state.household) return { status: 'unauthorized' };
  const view = viewOf(state, entry, need);
  const operationId = `link:${need.linkId}:${body.operationId}`;
  const digest = sha256Of(body);
  const previous = log.operation(operationId);
  if (previous) {
    return previous.digest === digest
      ? { status: 'noop', view }
      : { status: 'conflict', reason: 'operationIdReused', view };
  }
  const shown = view.candidates.find((c) => c.id === body.candidateId);
  if (!shown || shown.rev !== body.rev) {
    return { status: 'conflict', reason: 'candidateChanged', view };
  }
  if (shown.seenSeq !== body.seenSeq) return { status: 'conflict', reason: 'answerChanged', view };
  const same =
    body.answer === 'withdrawn'
      ? shown.answer === undefined
      : shown.answer === body.answer && shown.note === body.note;
  const now =
    state.clock === undefined ? fallbackNow : formatDateTime(state.clock, state.household.timeZone);
  if (!same) {
    log.append(
      [
        {
          type: 'availabilityRecorded',
          itemId: entry.itemId,
          candidateId: body.candidateId,
          rev: body.rev,
          personId: entry.personId,
          answer: body.answer,
          ...(body.note === undefined ? {} : { note: body.note }),
          source: 'link',
          linkId: need.linkId,
        },
      ],
      'link',
      now,
    );
  }
  log.recordOperation({
    id: operationId,
    actorId: 'link',
    digest,
    throughSeq: log.events().at(-1)?.seq ?? 0,
  });
  if (same) return { status: 'noop', view };
  const after = foldEvents(log.events());
  const again = linked(after, entry, tokenHash);
  return again ? { status: 'ok', view: viewOf(after, entry, again) } : { status: 'unauthorized' };
}
