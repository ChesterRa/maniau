// 事象の列を、計算に使う状態にたたむ（docs/design/01-model.md §2）。同じ列からは、いつも同じ状態になる。
import {
  type ConditionView,
  conditionShape,
  conditionView,
  evaluateCondition,
  type ItemShown,
  MAX_CONDITION_NODES,
  mentionsUnknown,
  type ShownFrom,
  type ShownTarget,
  type ShownWhen,
} from '../schema/condition';
import type { DomainEvent, ProposalSnapshot, RequestSnapshot, TaskContent } from '../schema/events';
import type { Household } from '../schema/household';
import type { CommitmentState, ExternalRequestState } from '../schema/plan';
import {
  type ConditionNode,
  Extraction,
  type Interpretation,
  type Item,
  type Source,
  type Unknown,
} from '../schema/source';
import { type DateTime, formatDateTime, toEpochMinutes } from '../time';

export interface RequestRecord {
  requestId: string;
  taskKey: string;
  sentAt: DateTime;
  sentBy: string;
  /** 送った事象の通し番号（送った後の家族の決めごとと、順で比べる）。 */
  sentSeq: number;
  state: ExternalRequestState;
  /** 送った時の控え。古い事象には無い（02-foundation §5.6）。 */
  snapshot?: RequestSnapshot;
}

/**
 * 事項の作用（未定の値を決める・置き換える・取り消す）が効くか（02-foundation §5.2）。
 * on：確かな事項（記載か家族の確認）で、条件が真で、置き換え・取り消しを受けていない。
 * off：確かでないか、条件が偽か、置き換え・取り消しを受けた。
 * unknown：条件が分からないか、置き換え・取り消しを受けるか分からない。
 */
export type EffectActivity = 'on' | 'off' | 'unknown';

/** 送り・迎えが今回要るかの、家族の言明と、言った時の子・用件・日・書かれた時刻・場所。 */
export interface EscortStatement {
  needed: boolean;
  childId: string;
  what: string;
  /** その方の日（迎えは、終わりが次の日と読めれば次の日）。 */
  date: string;
  /** 書かれた時刻。時刻の無い方は null。 */
  at: string | null;
  place: string | null;
}

export interface EngineState {
  household?: Household;
  sources: Map<string, Source>;
  /** 出典ごとの、検査を通った読み取り（後の物が前の物を置き換える）。 */
  extractions: Map<string, Extraction>;
  /** 未定の値の答え（家族の答えと、効いている出典の作用）。後の物が勝つ。たたみ終えた時に answers から作る。 */
  resolved: Map<string, { value: string; seq: number; by: 'family' | 'source'; about?: string }>;
  /**
   * 答えの記録。出典の作用の順は、その出典が届いた時（noticeReceived の seq）とする。読み直しは
   * お知らせを新しくしないので、読み直しの前に来た家族の答えに勝たない。同じ出典を読み直したら、
   * 前の読み取りの作用は外す（新しい読み取りに無い作用を残さない）。
   */
  answers: {
    unknownId: string;
    value: string;
    seq: number;
    by: 'family' | 'source';
    sourceId?: string;
    /** 出典の作用なら、その作用を持つ事項。 */
    itemId?: string;
    /** 家にあるかの答えなら、答えた時に見せた品物。 */
    about?: string;
  }[];
  /** 事項ごとの、作用が効くか。たたみ終えた時に決める（settle）。 */
  effects: Map<string, EffectActivity>;
  /**
   * 答えはあるが確かでない未定の値：より後の、効くか分からない作用が別の値に変えるかもしれない物と、
   * 同じお知らせの中の効く作用が違う値を言う物。確かな答えとして使わず、resolved から外す（02-foundation §5.2）。
   */
  doubted: Set<string>;
  /** これまでの読み取りに一度でも出た事項の ID（読み直しで見つからなくなった物を見分ける）。 */
  seenItemIds: Set<string>;
  /** 出典が届いた時の seq（出典の ID → seq）。 */
  sourceSeq: Map<string, number>;
  /** 出典を入れた人（出典の ID → 最後に届けた事象の actorId。仕組みが入れた物は system）。 */
  sourceBy: Map<string, string>;
  /** 出典ごとの、今の読み取りの時刻（読み取りの事象の occurredAt）。 */
  extractionAt: Map<string, DateTime>;
  /** 出典ごとの、今の読み取りが読んだ文の版。出典の版より古ければ、書き起こしを直す前の読み取り。 */
  extractionVersion: Map<string, number>;
  /** 出典ごとの、今の読み取りを記録した seq（読み直すと進む。同じ ID が同じ事項かを確かめる手がかり）。 */
  extractionSeq: Map<string, number>;
  /** 家族が直した解釈（事項の ID → 直した欄を重ねた物）。 */
  corrections: Map<string, Interpretation>;
  /** 家族の確かめ（事項の ID → 最後の言明）。confirmed は「家族が確認」、dismissed は「関係ない」。 */
  verdicts: Map<string, 'confirmed' | 'dismissed'>;
  /**
   * 読み取りの「すること」（モデルが読んだ need）への家族の確かめ・直し・外しが、どの読み取りに対する物か（事項の
   * ID → その時に拠っていた読み取りの印。readingSignature）。拠る読み取り（その事項の出典と、条件・答え・置き換える
   * 物の出典）のどれかを読み直した後は（同じ中身・同じ版の読み直しでも）、前の確かめを当てない（確かめていない
   * 読み取りは、計画に入れない）。
   */
  verdictReading: Map<string, string>;
  /** 読み取りの「すること」への家族の直し（読み取りごと。読み直しの後は、前の直しを新しい読みに重ねない）。 */
  needCorrections: Map<string, { reading: string; interpretation: Interpretation }>;
  /**
   * 家族が、当番がうちの番かを言った（事項の ID → 最後の言明と、その時の用件と対象）。読んだ中身の確かめ・
   * 直し・取り下げ（verdicts）とは別に持ち、事項の確かさも作用も変えない。
   */
  turns: Map<string, { ours: boolean; what: string; audience: string | null }>;
  /**
   * 家族が、習い事・クラブの行事の送り・迎えが今回要るかを言った（「事項の ID:to|from」→ 最後の言明と、
   * その時の子・用件・日・書かれた時刻・場所）。事項の確かさも作用も変えない。
   */
  escorts: Map<string, EscortStatement>;
  /**
   * 出典ごとに、その出典の文・読み取り・事項・答え・うちの番かの言明が最後に替わった事象の通し番号。画面が
   * 見せた時より後に替わっていれば、その画面からの言明（うちの番です・ではない）を断る（元に戻った時も含む）。
   */
  sourceChangedSeq: Map<string, number>;
  /** 家族が取り下げた出典。 */
  withdrawnSources: Set<string>;
  /**
   * 家族が書いた出典（事項が家族の言明 itemsStated の物）。モデルの読み取りで置き換えず、書き起こしも直さない
   * （家族の言葉を、ほかの物にしない）。
   */
  statedSources: Set<string>;
  /**
   * 家族が「すること」に選んだやり方（事項の ID → 最後の選びと、選んだ時の中身とやり方の版の要約）。要約が今と
   * 違えば当てない。
   */
  needWays: Map<string, { wayIds: string[]; about: string; seq: number }>;
  /** 書き起こしを直した事のある出典（読んだ版の無い読み取りは、もう使わない）。 */
  correctedSources: Set<string>;
  /**
   * 出典ごとに、これまでの読み取りが一度でも出した未定の値の ID（ID だけを覚え、中身は持たない）。
   * 取り下げ・削除の時は、最後の読み取りに無い物も含めて、全部の答えを使わない。
   */
  declaredUnknowns: Map<string, Set<string>>;
  /** 中身を消した出典（photo：写真だけ、all：お知らせごと）。 */
  purgedSources: Map<string, 'photo' | 'all'>;
  /** 引き受けた時に見た提案の控え（作業の key → 控え）。 */
  shown: Map<string, ProposalSnapshot>;
  /** 引き受けた時の作業の根拠（作業の key → 事項と出典の ID と、引き受けた seq）。無いのは古い事象の引き受け。 */
  acceptedBasis: Map<string, { itemIds: string[]; sourceIds: string[]; seq: number }>;
  /** 済んだと記録した時に見せた用件（作業の key → 用件）。無いのは古い事象の済み。 */
  doneContent: Map<string, TaskContent>;
  primary: Map<string, string>;
  backups: Map<string, Set<string>>;
  /** 家族が取り下げた案（手配の key → 案の key）。頼んだ後なら、取り消しの連絡が要る。 */
  dropped: Map<string, Set<string>>;
  assignees: Map<string, string>;
  commitments: Map<string, CommitmentState>;
  /**
   * 作業ごとの、引き受けの変遷（担当の提案・本人の操作・送った）。「送った」の押し間違いを直したら、
   * その送ったを除いてたどり直す（後の担当替え・済んだ・別の依頼は、そのまま残る）。
   */
  /** 作業ごとの引き受けの変遷（at は事象の時。済んだ手順の後の待ち時間を、記録した時から数えるのに使う）。 */
  commitmentLog: Map<
    string,
    { state: CommitmentState; seq: number; at: number; requestId?: string }[]
  >;
  requests: Map<string, RequestRecord>;
  /** これまでに使った依頼の ID（押し間違いを直して消した物も含む。同じ ID は二度使わない）。 */
  sentRequestIds: Set<string>;
  notified: Set<string>;
  /**
   * 引き受けた作業が「もう要らなくなった」と本人に知らせた（作業の key → 最後に知らせた事象の通し番号と
   * 相手）。はっきりした取り消し（§4.2）なので、その後に作業が戻っても、前の引き受けをそのまま当てない。
   */
  releasedNotified: Map<string, { seq: number; memberId: string }>;
  /** 時計（試験とデモで進めた時刻）。無ければ、呼ぶ側の now を使う。 */
  clock?: number;
  lastSeq: number;
  /** 使えなかったモデルの出力など、記録はあるが計算に入れなかった物。 */
  rejected: { seq: number; reason: string }[];
}

export function emptyState(): EngineState {
  return {
    sources: new Map(),
    extractions: new Map(),
    resolved: new Map(),
    answers: [],
    effects: new Map(),
    doubted: new Set(),
    seenItemIds: new Set(),
    sourceSeq: new Map(),
    sourceBy: new Map(),
    extractionAt: new Map(),
    extractionVersion: new Map(),
    extractionSeq: new Map(),
    corrections: new Map(),
    verdicts: new Map(),
    verdictReading: new Map(),
    needCorrections: new Map(),
    turns: new Map(),
    escorts: new Map(),
    sourceChangedSeq: new Map(),
    withdrawnSources: new Set(),
    statedSources: new Set(),
    needWays: new Map(),
    correctedSources: new Set(),
    declaredUnknowns: new Map(),
    purgedSources: new Map(),
    shown: new Map(),
    doneContent: new Map(),
    primary: new Map(),
    backups: new Map(),
    dropped: new Map(),
    assignees: new Map(),
    commitments: new Map(),
    commitmentLog: new Map(),
    requests: new Map(),
    sentRequestIds: new Set(),
    notified: new Set(),
    releasedNotified: new Map(),
    acceptedBasis: new Map(),
    lastSeq: 0,
    rejected: [],
  };
}

/** 事象が替える出典（文・読み取り・事項の言明・その出典の未定の値への答え）。 */
function touchedSources(state: EngineState, event: DomainEvent): string[] {
  switch (event.type) {
    case 'noticeReceived':
      return [event.source.id];
    case 'modelOutputRecorded':
      return event.sourceId ? [event.sourceId] : [];
    case 'itemsStated':
      return [event.sourceId];
    case 'sourceWithdrawn':
    case 'sourceContentPurged':
    case 'transcriptionCorrected':
      return [event.sourceId];
    case 'itemConfirmed':
    case 'itemCorrected':
    case 'itemDismissed':
    case 'turnStated':
    case 'escortStated':
    case 'needWaysSet':
      return [...state.extractions]
        .filter(([, e]) => e.items.some((i) => i.id === event.itemId))
        .map(([sourceId]) => sourceId);
    case 'answered':
      return [...state.extractions]
        .filter(([, e]) => e.unknowns.some((u) => u.id === event.unknownId))
        .map(([sourceId]) => sourceId);
    default:
      return [];
  }
}

export function foldEvents(events: readonly DomainEvent[]): EngineState {
  const state = emptyState();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of ordered) apply(state, event);
  settle(state);
  return state;
}

/** 家族の言明（確かめ・直し・取り下げ・書き起こしの直し・「送った」の直し）は、その時の有効な大人だけ。 */
const FAMILY_ONLY = new Set<DomainEvent['type']>([
  'itemConfirmed',
  'itemCorrected',
  'itemDismissed',
  'turnStated',
  'escortStated',
  'itemsStated',
  'needWaysSet',
  'sourceWithdrawn',
  'transcriptionCorrected',
  'requestRecordCorrected',
]);

function apply(state: EngineState, event: DomainEvent): void {
  state.lastSeq = Math.max(state.lastSeq, event.seq);
  for (const sourceId of touchedSources(state, event)) {
    state.sourceChangedSeq.set(sourceId, event.seq);
  }
  if (FAMILY_ONLY.has(event.type)) {
    const member = state.household?.members.find((m) => m.id === event.actorId);
    if (member?.kind !== 'adult' || !member.active) {
      state.rejected.push({ seq: event.seq, reason: '有効な大人でない人の言明' });
      return;
    }
  }
  switch (event.type) {
    case 'householdSet':
      state.household = event.household;
      return;
    case 'noticeReceived':
      // 中身を消した出典の ID は、もう使わない（消した中身を、同じ ID で戻さない）。
      if (state.purgedSources.get(event.source.id) === 'all') {
        state.rejected.push({ seq: event.seq, reason: '中身を消した出典と同じ ID のお知らせ' });
        return;
      }
      state.sources.set(event.source.id, event.source);
      state.sourceSeq.set(event.source.id, event.seq);
      state.sourceBy.set(event.source.id, event.actorId);
      return;
    case 'modelOutputRecorded': {
      if (event.call !== 'extract') return;
      const parsed = Extraction.safeParse(event.output);
      if (!parsed.success) {
        state.rejected.push({ seq: event.seq, reason: '読み取りの出力が型に合わない' });
        return;
      }
      const sourceId = parsed.data.sourceId;
      // 記録の出典、読み取りの出典、各事項の出典は一つに揃う。揃わない読み取りは、別の出典を
      // 汚さないように使わない（非同期の読み取りの取り違えや、壊れた記録）。
      if (
        (event.sourceId !== undefined && event.sourceId !== sourceId) ||
        parsed.data.items.some((i) => i.sourceId !== sourceId)
      ) {
        state.rejected.push({ seq: event.seq, reason: '出典の揃わない読み取り' });
        return;
      }
      if (state.purgedSources.get(sourceId) === 'all') {
        state.rejected.push({ seq: event.seq, reason: '中身を消した出典の読み取り' });
        return;
      }
      if (!state.sources.has(sourceId)) {
        state.rejected.push({ seq: event.seq, reason: '届いていない出典の読み取り' });
        return;
      }
      if (state.statedSources.has(sourceId)) {
        state.rejected.push({ seq: event.seq, reason: '家族の言明の出典の読み取り' });
        return;
      }
      // 読み取りは非同期なので、書き起こしを直す前の版を読んだ物が後で届くことがある。
      // 読んだ版の分からない読み取りは、直した事の無い出典でだけ使う（直した後なら、どの版か示せない）。
      // 今の読み取りより古い版の読み取りでは置き換えない。
      const current = state.sources.get(sourceId)?.version ?? 1;
      if (event.sourceVersion === undefined && state.correctedSources.has(sourceId)) {
        state.rejected.push({ seq: event.seq, reason: '読んだ文の版の分からない読み取り' });
        return;
      }
      if (event.sourceVersion !== undefined && event.sourceVersion > current) {
        state.rejected.push({ seq: event.seq, reason: 'まだ無い版の文を読んだ読み取り' });
        return;
      }
      const version = event.sourceVersion ?? current;
      if (version < (state.extractionVersion.get(sourceId) ?? 0)) {
        state.rejected.push({ seq: event.seq, reason: '前の版の文を読んだ読み取り' });
        return;
      }
      state.extractionVersion.set(sourceId, version);
      state.extractionSeq.set(sourceId, event.seq);
      state.extractionAt.set(sourceId, event.occurredAt);
      state.extractions.set(sourceId, parsed.data);
      const declared = state.declaredUnknowns.get(sourceId) ?? new Set<string>();
      for (const unknown of parsed.data.unknowns) declared.add(unknown.id);
      state.declaredUnknowns.set(sourceId, declared);
      const seq = state.sourceSeq.get(sourceId) ?? event.seq;
      state.answers = state.answers.filter((a) => !(a.by === 'source' && a.sourceId === sourceId));
      for (const item of parsed.data.items) {
        state.seenItemIds.add(item.id);
        for (const effect of item.effects) {
          if (effect.type === 'resolveUnknown') {
            state.answers.push({
              unknownId: effect.unknownId,
              value: effect.value,
              seq,
              by: 'source',
              sourceId,
              itemId: item.id,
            });
          }
        }
      }
      return;
    }
    case 'itemsStated': {
      // 家族が書いた出典の事項。出典は家族の物で、まだ事項の無い物だけ（言い直しは事項の直しで行う）。
      const source = state.sources.get(event.sourceId);
      if (
        source?.sender !== 'family' ||
        state.purgedSources.get(event.sourceId) === 'all' ||
        state.withdrawnSources.has(event.sourceId) ||
        state.extractions.has(event.sourceId) ||
        event.items.some((i) => i.sourceId !== event.sourceId || i.evidence !== 'stated')
      ) {
        state.rejected.push({ seq: event.seq, reason: '使えない家族の言明の事項' });
        return;
      }
      state.statedSources.add(event.sourceId);
      state.extractions.set(event.sourceId, {
        sourceId: event.sourceId,
        items: event.items,
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      });
      state.extractionVersion.set(event.sourceId, source.version);
      state.extractionSeq.set(event.sourceId, event.seq);
      state.extractionAt.set(event.sourceId, event.occurredAt);
      for (const item of event.items) state.seenItemIds.add(item.id);
      return;
    }
    case 'needWaysSet':
      state.needWays.set(event.itemId, {
        wayIds: event.wayIds,
        about: event.about,
        seq: event.seq,
      });
      return;
    case 'answered':
      state.answers.push({
        unknownId: event.unknownId,
        value: event.value,
        seq: event.seq,
        by: 'family',
        ...(event.about === undefined ? {} : { about: event.about }),
      });
      return;
    case 'optionChosen':
      // 一つの案は、本命か予備のどちらか。予備を本命にしたら予備から外す。本命を予備に選ぶのは使わない。
      if (event.role === 'backup' && state.primary.get(event.arrangementKey) === event.optionKey) {
        state.rejected.push({ seq: event.seq, reason: '本命の案を予備にも選ぶ' });
        return;
      }
      state.dropped.get(event.arrangementKey)?.delete(event.optionKey);
      if (event.role === 'primary') {
        state.primary.set(event.arrangementKey, event.optionKey);
        state.backups.get(event.arrangementKey)?.delete(event.optionKey);
      } else {
        const set = state.backups.get(event.arrangementKey) ?? new Set<string>();
        set.add(event.optionKey);
        state.backups.set(event.arrangementKey, set);
      }
      return;
    case 'optionDropped':
      if (state.primary.get(event.arrangementKey) === event.optionKey) {
        state.primary.delete(event.arrangementKey);
      }
      state.backups.get(event.arrangementKey)?.delete(event.optionKey);
      {
        const set = state.dropped.get(event.arrangementKey) ?? new Set<string>();
        set.add(event.optionKey);
        state.dropped.set(event.arrangementKey, set);
      }
      return;
    case 'assignmentProposed':
      // 担当を決め直したら、前の引き受けの控えは使わない（前の担当の同意を、次の担当に引き継がない）。
      state.assignees.set(event.taskKey, event.assigneeId);
      setCommitment(state, event.taskKey, 'proposed', event);
      state.shown.delete(event.taskKey);
      return;
    case 'itemConfirmed':
    case 'itemCorrected':
    case 'itemDismissed': {
      if (!state.seenItemIds.has(event.itemId)) {
        state.rejected.push({ seq: event.seq, reason: '読み取りに無い事項への確かめ' });
        return;
      }
      // 読み取りの「すること」への言明は、その時に採っていた読み取りに結ぶ（読み直しの後に当てない）。
      const read = readNeedOf(state, event.itemId);
      if (read !== undefined) {
        state.verdictReading.set(event.itemId, read.reading);
        if (event.type === 'itemCorrected') {
          const before = state.needCorrections.get(event.itemId);
          state.needCorrections.set(event.itemId, {
            reading: read.reading,
            interpretation: {
              ...(before?.reading === read.reading ? before.interpretation : {}),
              ...event.interpretation,
            },
          });
        }
      } else if (event.type === 'itemCorrected') {
        const before = state.corrections.get(event.itemId) ?? {};
        state.corrections.set(event.itemId, { ...before, ...event.interpretation });
      }
      state.verdicts.set(event.itemId, event.type === 'itemDismissed' ? 'dismissed' : 'confirmed');
      return;
    }
    case 'turnStated':
      if (!state.seenItemIds.has(event.itemId)) {
        state.rejected.push({ seq: event.seq, reason: '読み取りに無い事項への言明' });
        return;
      }
      state.turns.set(event.itemId, {
        ours: event.ours,
        what: event.what,
        audience: event.audience,
      });
      return;
    case 'escortStated':
      if (!state.seenItemIds.has(event.itemId)) {
        state.rejected.push({ seq: event.seq, reason: '読み取りに無い事項への言明' });
        return;
      }
      state.escorts.set(`${event.itemId}:${event.leg}`, {
        needed: event.needed,
        childId: event.childId,
        what: event.what,
        date: event.date,
        at: event.at,
        place: event.place,
      });
      return;
    case 'sourceWithdrawn':
      if (!state.sources.has(event.sourceId)) {
        state.rejected.push({ seq: event.seq, reason: '届いていない出典の取り下げ' });
        return;
      }
      state.withdrawnSources.add(event.sourceId);
      return;
    case 'sourceContentPurged':
      if (event.actorId !== 'system' || !state.sources.has(event.sourceId)) {
        state.rejected.push({ seq: event.seq, reason: '仕組みでない人の削除か、届いていない出典' });
        return;
      }
      if (event.scope === 'all') {
        // 事項・答え・作用を使わない。事項は「見つからない」になり、頼る依頼は要確認になる。
        // 原文も状態から外す（見せる物に出さない。事象の列の中身を消すのは置き場所の仕事）。
        state.purgedSources.set(event.sourceId, 'all');
        state.sources.delete(event.sourceId);
        state.extractions.delete(event.sourceId);
        state.answers = state.answers.filter(
          (a) => !(a.by === 'source' && a.sourceId === event.sourceId),
        );
      } else if (state.purgedSources.get(event.sourceId) !== 'all') {
        state.purgedSources.set(event.sourceId, 'photo');
      }
      return;
    case 'transcriptionCorrected': {
      const source = state.sources.get(event.sourceId);
      if (
        !source ||
        state.statedSources.has(event.sourceId) ||
        state.purgedSources.get(event.sourceId) === 'all' ||
        event.sourceVersion <= source.version
      ) {
        state.rejected.push({ seq: event.seq, reason: '書き起こしの版が進まない直し' });
        return;
      }
      state.sources.set(event.sourceId, {
        ...source,
        version: event.sourceVersion,
        sentences: event.sentences,
      });
      state.correctedSources.add(event.sourceId);
      return;
    }
    case 'requestRecordCorrected': {
      const request = state.requests.get(event.requestId);
      // 送ったと記録した本人だけが、返事も取り消しもまだ無い間に使える（02-foundation §5.6）。
      if (!request || request.sentBy !== event.actorId || request.state !== 'awaitingReply') {
        state.rejected.push({ seq: event.seq, reason: '使えない「送った」の取り消し' });
        return;
      }
      state.requests.delete(event.requestId);
      // その送ったを除いて、作業の引き受けの変遷をたどり直す。後の担当替え・本人の「済んだ」・
      // 同じ作業の別の依頼は残り、引き受けていない人の作業を「引き受けた」にもしない。
      const changes = (state.commitmentLog.get(request.taskKey) ?? []).filter(
        (c) => c.requestId !== event.requestId,
      );
      state.commitmentLog.set(request.taskKey, changes);
      const last = changes.at(-1);
      if (last === undefined) state.commitments.delete(request.taskKey);
      else state.commitments.set(request.taskKey, last.state);
      return;
    }
    case 'commitmentChanged': {
      // 本人だけが変えられる（§7）。本人でない操作は記録に残るが、状態は変えない。
      const assignee = state.assignees.get(event.taskKey) ?? event.assigneeId;
      if (event.actorId !== event.assigneeId || assignee !== event.assigneeId) {
        state.rejected.push({ seq: event.seq, reason: '本人でない人の引き受けの操作' });
        return;
      }
      state.assignees.set(event.taskKey, event.assigneeId);
      if (event.action === 'accept') {
        if (event.shown) state.shown.set(event.taskKey, event.shown);
        else state.shown.delete(event.taskKey);
        if (event.basisItemIds && event.basisSourceIds) {
          state.acceptedBasis.set(event.taskKey, {
            itemIds: event.basisItemIds,
            sourceIds: event.basisSourceIds,
            seq: event.seq,
          });
        } else {
          state.acceptedBasis.delete(event.taskKey);
        }
      }
      if (event.action === 'done' && event.content)
        state.doneContent.set(event.taskKey, event.content);
      else state.doneContent.delete(event.taskKey);
      const next: Record<typeof event.action, CommitmentState> = {
        accept: 'accepted',
        decline: 'declined',
        done: 'done',
        withdraw: 'withdrawn',
      };
      setCommitment(state, event.taskKey, next[event.action], event);
      return;
    }
    case 'externalRequestSent': {
      if (state.sentRequestIds.has(event.requestId)) {
        state.rejected.push({ seq: event.seq, reason: '前に使った依頼の ID' });
        return;
      }
      state.sentRequestIds.add(event.requestId);
      state.requests.set(event.requestId, {
        requestId: event.requestId,
        taskKey: event.taskKey,
        sentAt: event.occurredAt,
        sentBy: event.actorId,
        sentSeq: event.seq,
        state: 'awaitingReply',
        ...(event.snapshot ? { snapshot: event.snapshot } : {}),
      });
      setCommitment(state, event.taskKey, 'done', event, event.requestId);
      return;
    }
    case 'externalReplyRecorded': {
      const request = state.requests.get(event.requestId);
      // 返事待ちから確定・断られたへ。相手の都合が変わった時（確定の後の「いいえ」、断った後の「はい」）も
      // 後の返事に従う。取り消した依頼は変えない。
      if (request && request.state !== 'cancelled') {
        request.state = event.reply === 'yes' ? 'confirmed' : 'turnedDown';
      }
      return;
    }
    case 'cancellationSent': {
      const request = state.requests.get(event.requestId);
      if (request) request.state = 'cancelled';
      return;
    }
    case 'notified':
      // 事業者が受け付けた時に、仕組みだけが書く（02-foundation §5.7）。
      if (event.actorId !== 'system') {
        state.rejected.push({ seq: event.seq, reason: '仕組みでない人の「知らせた」' });
        return;
      }
      state.notified.add(event.notificationKey);
      {
        const taskKey = releasedTaskKey(event.notificationKey, event.toMemberId);
        if (taskKey !== undefined) {
          state.releasedNotified.set(taskKey, { seq: event.seq, memberId: event.toMemberId });
        }
      }
      return;
    case 'clockAdvanced':
      state.clock = toEpochMinutes(event.to);
      return;
  }
}

/**
 * 「もう要らなくなった」の知らせのキー（released:作業の key:相手#回）から、作業の key を読む（view/notify の
 * 作り方と同じ）。ほかの知らせなら無し。
 */
function releasedTaskKey(notificationKey: string, memberId: string): string | undefined {
  const base = notificationKey.replace(/#\d+$/, '');
  const prefix = 'released:';
  const suffix = `:${memberId}`;
  if (!base.startsWith(prefix) || !base.endsWith(suffix)) return undefined;
  const taskKey = base.slice(prefix.length, base.length - suffix.length);
  return taskKey.length > 0 ? taskKey : undefined;
}

function setCommitment(
  state: EngineState,
  taskKey: string,
  value: CommitmentState,
  event: Pick<DomainEvent, 'seq' | 'occurredAt'>,
  requestId?: string,
): void {
  const changes = state.commitmentLog.get(taskKey) ?? [];
  const { seq } = event;
  const at = toEpochMinutes(event.occurredAt);
  changes.push(
    requestId === undefined ? { state: value, seq, at } : { state: value, seq, at, requestId },
  );
  state.commitmentLog.set(taskKey, changes);
  state.commitments.set(taskKey, value);
}

/** 未定の値ごとに、順の最も後の答えを今の答えにする（同じ順なら、後に記録した物）。 */
function latestAnswers(answers: EngineState['answers']): EngineState['resolved'] {
  const resolved: EngineState['resolved'] = new Map();
  for (const answer of answers) {
    const current = resolved.get(answer.unknownId);
    if (current === undefined || answer.seq >= current.seq) {
      resolved.set(answer.unknownId, {
        value: answer.value,
        seq: answer.seq,
        by: answer.by,
        ...(answer.about === undefined ? {} : { about: answer.about }),
      });
    }
  }
  return resolved;
}

const isTrusted = (item: Item) => item.evidence === 'stated' || item.evidence === 'confirmed';

/**
 * 今の読み取りで、モデルが読んだ「すること」（家族の言明でない出典の need）なら、今それが拠る読み取りの印。
 */
function readNeedOf(state: EngineState, itemId: string): { reading: string } | undefined {
  for (const [sourceId, extraction] of state.extractions) {
    const item = extraction.items.find((i) => i.id === itemId);
    if (!item) continue;
    if (item.kind !== 'need' || state.statedSources.has(sourceId)) return undefined;
    return { reading: readingSignature(state, item) };
  }
  return undefined;
}

/** 条件の式の節点と、そこに出る未定の値（見つからない節点の先は無い。深さは限る）。 */
function conditionRefs(rootId: string, nodes: ReadonlyMap<string, ConditionNode>) {
  const nodeIds = new Set<string>();
  const unknownIds = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (depth > MAX_CONDITION_NODES || nodeIds.has(id)) return;
    nodeIds.add(id);
    const node = nodes.get(id);
    if (node?.kind === 'eq') unknownIds.add(node.unknownId);
    else if (node?.kind === 'not') walk(node.childId, depth + 1);
    else if (node) for (const child of node.childIds) walk(child, depth + 1);
  };
  walk(rootId, 0);
  return { nodeIds, unknownIds };
}

/**
 * 読み取りの事項が拠る読み取りの印：その事項の出典と、条件の式の節点・そこに出る未定の値・答える未定の値・置き換え
 * や取り消しの先の事項を持つ出典の、それぞれ採っている読み取りの事象の番号。見つからない物も印に入れる（後で
 * 見つかれば、見せていない物に効くので、確かめをやり直す）。家族の言明は、言った時の印と今の印が同じ時だけ当てる。
 */
function readingSignature(state: EngineState, item: Item): string {
  const nodes = new Map<string, ConditionNode>();
  for (const extraction of state.extractions.values()) {
    for (const node of extraction.conditions) nodes.set(node.id, node);
  }
  const refs =
    item.conditionNodeId === undefined
      ? { nodeIds: new Set<string>(), unknownIds: new Set<string>() }
      : conditionRefs(item.conditionNodeId, nodes);
  const targets = new Set<string>();
  for (const effect of item.effects) {
    if (effect.type === 'resolveUnknown') refs.unknownIds.add(effect.unknownId);
    else targets.add(effect.itemId);
  }
  const sources = new Set([item.sourceId]);
  const found = new Set<string>();
  for (const [sourceId, extraction] of state.extractions) {
    const hits = [
      ...extraction.conditions.filter((n) => refs.nodeIds.has(n.id)).map((n) => `node:${n.id}`),
      ...extraction.unknowns.filter((u) => refs.unknownIds.has(u.id)).map((u) => `unknown:${u.id}`),
      ...extraction.items.filter((i) => targets.has(i.id)).map((i) => `item:${i.id}`),
    ];
    if (hits.length > 0) sources.add(sourceId);
    for (const hit of hits) found.add(hit);
  }
  const missing = [
    ...[...refs.nodeIds].map((id) => `node:${id}`),
    ...[...refs.unknownIds].map((id) => `unknown:${id}`),
    ...[...targets].map((id) => `item:${id}`),
  ].filter((key) => !found.has(key));
  return JSON.stringify([
    [...sources].sort().map((sourceId) => [sourceId, state.extractionSeq.get(sourceId) ?? 0]),
    missing.sort(),
  ]);
}

/**
 * 家族の言明（確かめ・外し）のうち、今の読み取りに当たる物。読み取りに結んだ言明（読み取りの「すること」への物）は、
 * 結んだ読み取りが今の読み取りの時だけ。今、読み取りの「すること」の事項は、結んだ言明だけを当てる（前に別の種類
 * だった時の言明を当てない）。
 */
function verdictOf(state: EngineState, item: Item): 'confirmed' | 'dismissed' | undefined {
  const bound = state.verdictReading.get(item.id);
  const readNeed = item.kind === 'need' && !state.statedSources.has(item.sourceId);
  if (bound !== undefined ? bound !== readingSignature(state, item) : readNeed) return undefined;
  return state.verdicts.get(item.id);
}

/**
 * 読み取りの「すること」で、今の読み取りへの家族の言明（合っている・直す・読み取りが違う）がまだ無い物。計画に
 * 入れず、作用（置き換え・取り消し・答え）は効くか分からない物にする（確かめた後に効く）。
 */
export function awaitingConfirmation(state: EngineState, item: Item): boolean {
  return (
    item.kind === 'need' &&
    !state.statedSources.has(item.sourceId) &&
    verdictOf(state, item) === undefined
  );
}

/** 読み取りの事項に、家族の直しと確かめを重ねた物（確かめた・直した事項は「家族が確認」）。 */
export function itemsOf(state: EngineState): Item[] {
  return [...state.extractions.values()].flatMap((e) =>
    e.items.map((item) => familyItem(state, item)),
  );
}

/** 一つの事項に、家族の直しと確かめを重ねた物。 */
function familyItem(state: EngineState, item: Item): Item {
  const verdict = verdictOf(state, item);
  // 読み取りの「すること」（と、そうだった時に結んだ物）の直しは、今の読み取りへの直しだけ（前の直しを、読み
  // 直した新しい読みに重ねない）。
  const bound = state.needCorrections.get(item.id);
  const readNeed = item.kind === 'need' && !state.statedSources.has(item.sourceId);
  const correction =
    state.verdictReading.has(item.id) || readNeed
      ? bound !== undefined && bound.reading === readingSignature(state, item)
        ? bound.interpretation
        : undefined
      : state.corrections.get(item.id);
  const interpretation = correction
    ? { ...item.interpretation, ...correction }
    : item.interpretation;
  return verdict === 'confirmed'
    ? { ...item, interpretation, evidence: 'confirmed' as const }
    : { ...item, interpretation };
}

/**
 * 家族の言明で外れた事項（「関係ない」と取り下げた出典の事項）と、書き起こしを直す前の版から
 * 読んだ事項（読み直すまで確かとしない）。
 */
function familyOverrides(state: EngineState, all: readonly Item[]) {
  const excluded = new Set<string>();
  const stale = new Set<string>();
  for (const item of all) {
    if (verdictOf(state, item) === 'dismissed' || state.withdrawnSources.has(item.sourceId)) {
      excluded.add(item.id);
    }
    const version = state.sources.get(item.sourceId)?.version;
    const read = state.extractionVersion.get(item.sourceId);
    if (version !== undefined && read !== undefined && read < version) stale.add(item.id);
  }
  return { excluded, stale };
}

function activityOf(
  item: Item,
  nodes: readonly ConditionNode[],
  assignment: ReadonlyMap<string, string>,
  graph: EffectGraph,
): EffectActivity {
  if (!isTrusted(item)) return 'off';
  // 置き換え・取り消しを受けた事項の作用は、もう効かない（前に効いていた答えも外れる）。
  if (graph.replacedBy.has(item.id) || graph.cancelled.has(item.id)) return 'off';
  const truth = item.conditionNodeId
    ? evaluateCondition(item.conditionNodeId, nodes, assignment)
    : true;
  if (truth === false) return 'off';
  if (
    truth === 'unknown' ||
    graph.maybe.has(item.id) ||
    graph.maybe.has(graph.rootOf(item.id)) ||
    graph.contested.has(item.id)
  ) {
    return 'unknown';
  }
  return 'on';
}

/**
 * 今も確かな読み取り：取り下げていない出典の、今の版の文を読んだ物。未定の値の名前と条件の式を家族に
 * 見せる時は、ここからだけ取る（画面の条件の添え書きと、引き受けの控えの条件で、同じ物を使う）。
 */
/**
 * 家族が読み取りを確かめる時に見せる物：条件の式、未定の値への答え（どの値に何と）、置き換え・取り消しの先（何を・
 * いつ）。別のお知らせの物には、そのお知らせ（題と届いた日）を添える。確かめる札と直す画面、確かめる命令の検査が
 * 同じ物を使う。式の節点・値の名前・出典が見つからない時と、見せる形の同じ別の物（同じ名前の別の問い、同じ名前と
 * 日時の別の事項）がある時は shown: false（どれに効くか家族に見分けられない物を、確かめたことにしない）。節点と
 * 値の名前は、採っている読み取りから取る。
 */
export function itemShown(state: EngineState, item: Item): ItemShown {
  const timeZone = state.household?.timeZone;
  const local = (value: DateTime) =>
    timeZone === undefined ? value : formatDateTime(toEpochMinutes(value), timeZone);
  let shown = true;
  // 別のお知らせの手がかり（そのお知らせが見つからなければ null。見せられない）。
  const fromOf = (sourceId: string): ShownFrom | undefined | null => {
    if (sourceId === item.sourceId) return undefined;
    const source = state.sources.get(sourceId);
    if (!source) return null;
    return {
      ...(source.title ? { title: source.title } : {}),
      day: local(source.receivedAt).slice(0, 10),
    };
  };
  const fromKey = (from: ShownFrom | undefined | null) =>
    from === null ? [null] : from ? [from.title ?? '', from.day] : [];
  const nodes = new Map<string, ConditionNode>();
  const unknowns = new Map<string, { label: string; from?: ShownFrom; key: string; lost?: true }>();
  const items = new Map<string, ShownTarget & { key: string; lost?: true }>();
  for (const [sourceId, extraction] of state.extractions) {
    const from = fromOf(sourceId);
    const context = from === null ? { lost: true as const } : from ? { from } : {};
    for (const node of extraction.conditions) nodes.set(node.id, node);
    for (const unknown of extraction.unknowns) {
      unknowns.set(unknown.id, {
        label: unknown.label,
        ...context,
        key: JSON.stringify([unknown.label, ...fromKey(from)]),
      });
    }
    for (const raw of extraction.items) {
      const target = familyItem(state, raw);
      const i = target.interpretation;
      const when: ShownWhen = {
        ...(i.date ? { date: i.date } : {}),
        ...(i.startTime ? { startTime: i.startTime } : {}),
        ...(i.endTime ? { endTime: i.endTime } : {}),
        ...(i.deadline ? { deadline: i.deadline } : {}),
        ...(i.deadline && i.deadlineDayOnly === true ? { deadlineDayOnly: true } : {}),
      };
      const deadline = i.deadline === undefined ? undefined : local(i.deadline);
      const what = i.what ?? target.written;
      items.set(raw.id, {
        type: 'replace',
        itemId: raw.id,
        what,
        ...(Object.keys(when).length > 0 ? { when } : {}),
        ...context,
        // 見せる形（家の時区の日と時刻。日だけの締切は時刻を入れない）。
        key: JSON.stringify([
          what,
          i.date ?? '',
          i.startTime ?? '',
          i.endTime ?? '',
          deadline?.slice(0, 10) ?? '',
          deadline !== undefined && i.deadlineDayOnly !== true ? deadline.slice(11, 16) : '',
          ...fromKey(from),
        ]),
      });
    }
  }
  // 見せる形ごとの物の数（二つ以上なら、どれか見分けられない）。
  const count = (keys: Iterable<string>) => {
    const n = new Map<string, number>();
    for (const key of keys) n.set(key, (n.get(key) ?? 0) + 1);
    return n;
  };
  const unknownCount = count([...unknowns.values()].map((u) => u.key));
  const itemCount = count([...items.values()].map((t) => t.key));
  const shownUnknown = (unknownId: string) => {
    const unknown = unknowns.get(unknownId);
    if (unknown === undefined || unknown.lost || (unknownCount.get(unknown.key) ?? 0) > 1) {
      shown = false;
    }
    return unknown;
  };
  let condition: ConditionView | undefined;
  if (item.conditionNodeId !== undefined) {
    for (const id of conditionRefs(item.conditionNodeId, nodes).unknownIds) shownUnknown(id);
    condition = conditionView(item.conditionNodeId, nodes, unknowns);
    if (!condition) shown = false;
  }
  const answers: ItemShown['answers'] = [];
  const targets: ShownTarget[] = [];
  for (const effect of item.effects) {
    if (effect.type === 'resolveUnknown') {
      const unknown = shownUnknown(effect.unknownId);
      if (unknown !== undefined) {
        answers.push({
          unknownId: effect.unknownId,
          label: unknown.label,
          value: effect.value,
          ...(unknown.from ? { from: unknown.from } : {}),
        });
      }
      continue;
    }
    const target = items.get(effect.itemId);
    if (target === undefined) {
      targets.push({ type: effect.type, itemId: effect.itemId });
      continue;
    }
    if (target.lost || (itemCount.get(target.key) ?? 0) > 1) shown = false;
    const { key: _key, lost: _lost, ...rest } = target;
    targets.push({ ...rest, type: effect.type });
  }
  return { shown, ...(condition ? { condition } : {}), answers, targets };
}

export function currentReadings(state: EngineState): Extraction[] {
  return [...state.extractions]
    .filter(([sourceId]) => {
      const source = state.sources.get(sourceId);
      if (!source || state.withdrawnSources.has(sourceId)) return false;
      return (state.extractionVersion.get(sourceId) ?? 0) >= source.version;
    })
    .map(([, extraction]) => extraction);
}

/**
 * 家族が決める値の問いを、家族が見た形で書き表す（答えに about として控え、今と同じ時だけその答えを使う。
 * §5.3）：値の名前と値の並び、その値を条件に使う事項の中身（家族の直しを重ねた物）と条件の式の形。読み直し
 * や直しでどれかが替われば、前の答えは別の問い・別の日の行事への答えになり得る（式が替われば、答えで要る物が
 * 見せた物と逆になり得る）ので使わず、聞き直す。時が進んだだけ・確かめただけ・ほかの事項が取り消しただけでは
 * 変わらない。
 */
export function familyQuestionBasis(
  state: EngineState,
  unknown: Unknown,
  items: readonly Item[] = itemsOf(state),
): string {
  const nodes = [...state.extractions.values()].flatMap((e) => e.conditions);
  const using = items
    .filter(
      (item) =>
        item.conditionNodeId !== undefined &&
        mentionsUnknown(item.conditionNodeId, unknown.id, nodes),
    )
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      written: item.written,
      interpretation: item.interpretation,
      condition: conditionShape(item.conditionNodeId, nodes),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return canonical({ label: unknown.label, values: unknown.values, items: using });
}

/**
 * 家族が「すること」に選んだやり方の要約（needWaysSet と依頼の控えの about）。「すること」の中身（何を・形・日・
 * 時刻・締切・場所・だれのため・条件）と、選んだやり方の中身（版）。どちらかが変われば、前の選び・依頼の返事を
 * 当てない。「すること」でない事項・無い事項は無し。
 */
export function needWaysBasis(
  state: EngineState,
  itemId: string,
  wayIds: readonly string[],
): string | undefined {
  const item = itemsOf(state).find((i) => i.id === itemId);
  if (item?.kind !== 'need') return undefined;
  const nodes = [...state.extractions.values()].flatMap((e) => e.conditions);
  const i = item.interpretation;
  return canonical({
    need: {
      what: i.what ?? item.written,
      shape: i.shape,
      date: i.date,
      startTime: i.startTime,
      endTime: i.endTime,
      deadline: i.deadline,
      deadlineDayOnly: i.deadlineDayOnly,
      place: i.place,
      forMemberId: i.forMemberId,
      condition: conditionShape(item.conditionNodeId, nodes),
    },
    ways: wayIds.map((id) => state.household?.ways.find((w) => w.id === id) ?? null),
  });
}

/** 鍵の並びによらない JSON（同じ中身なら同じ文字列）。 */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

/**
 * 取り下げた・消した出典が出した未定の値。家族の答えも含めて答えを使わない（他の出典の事項が
 * その値を条件にしていれば、条件しだいに残る。02-foundation §5.1・§5.3）。
 */
export function retiredUnknowns(state: EngineState): Set<string> {
  const retired = new Set<string>();
  for (const [sourceId, declared] of state.declaredUnknowns) {
    if (state.withdrawnSources.has(sourceId) || state.purgedSources.get(sourceId) === 'all') {
      for (const id of declared) retired.add(id);
    }
  }
  return retired;
}

/**
 * 作用が効くかを決め、今の答えを作る（02-foundation §5.2）。家族の答えだけから始め、効く作用の答えを
 * 足しては決め直す。たたむ度に決め直すので、後で家族が答えれば、前の作用の効き方も変わる。
 * 作用と条件が互いを頼って回り続ける時は、回っている事項を unknown に固め、収まるまで解き直す
 * （最後の一回で変わった物だけを固めると、前提の崩れた on が残るため）。固める物は増える一方なので、
 * 事項の数で必ず止まる。
 */
function settle(state: EngineState): void {
  const items = itemsOf(state);
  const overrides = familyOverrides(state, items);
  const retired = retiredUnknowns(state);
  // 家族が決める値への家族の答えは、答えた時に控えた問い（about：名前・値・その値を使う事項の中身と条件の式）が
  // 今と同じで、値が今の宣言にある時だけ使う（読み直しで同じ ID が別の問いになった、行事の日が直された等の後に、
  // 前の答えを当てない。§4.1・§5.3。当てなければ、まだ答えの無い値として聞き直す）。ほかの値（家にあるか等）は
  // 使う所で確かめる。
  const declared = new Map<string, Unknown>();
  for (const extraction of state.extractions.values()) {
    for (const unknown of extraction.unknowns) declared.set(unknown.id, unknown);
  }
  const usable = state.answers.filter((a) => {
    if (retired.has(a.unknownId)) return false;
    const unknown = a.by === 'family' ? declared.get(a.unknownId) : undefined;
    if (unknown?.kind !== 'family') return true;
    if (!unknown.values.includes(a.value)) return false;
    return a.about === undefined || a.about === familyQuestionBasis(state, unknown, items);
  });
  const nodes = [...state.extractions.values()].flatMap((e) => e.conditions);
  const counted = (activity: ReadonlyMap<string, EffectActivity>) =>
    usable.filter(
      (a) => a.by === 'family' || (a.itemId !== undefined && activity.get(a.itemId) === 'on'),
    );
  const settled = (activity: ReadonlyMap<string, EffectActivity>) => {
    const answers = counted(activity);
    const resolved = latestAnswers(answers);
    const doubted = new Set<string>();
    // 同じ順（同じお知らせの中）で効く答えが食い違えば、先後の証拠が無いので、どちらとも決めない。
    for (const [unknownId, current] of resolved) {
      const tied = answers.filter((a) => a.unknownId === unknownId && a.seq === current.seq);
      if (tied.some((a) => a.value !== current.value)) doubted.add(unknownId);
    }
    // 効くか分からない作用が、今の答えより後で、別の値を言っていれば、その値は確かでない。
    for (const a of usable) {
      if (a.itemId === undefined || activity.get(a.itemId) !== 'unknown') continue;
      const current = resolved.get(a.unknownId);
      if (current !== undefined && a.seq >= current.seq && a.value !== current.value) {
        doubted.add(a.unknownId);
      }
    }
    for (const id of doubted) resolved.delete(id);
    return { resolved, doubted };
  };
  const window = items.length + 1;
  const run = (forced: ReadonlySet<string>) => {
    const rounds: Map<string, EffectActivity>[] = [];
    let activity = new Map<string, EffectActivity>();
    for (let round = 0; round < 2 * window; round++) {
      const assignment = new Map([...settled(activity).resolved].map(([id, r]) => [id, r.value]));
      const graph = graphOf(items, activity, overrides);
      const next = new Map<string, EffectActivity>(
        items.map((item) => [
          item.id,
          forced.has(item.id) ? 'unknown' : activityOf(item, nodes, assignment, graph),
        ]),
      );
      if (items.every((item) => activity.get(item.id) === next.get(item.id))) {
        return { activity: next, unstable: [] as string[] };
      }
      rounds.push(next);
      activity = next;
    }
    // 連鎖は window 回で収まるので、後ろ半分で値が動く事項は、回り続けている。
    const tail = rounds.slice(window);
    const unstable = items
      .filter((item) => new Set(tail.map((m) => m.get(item.id))).size > 1)
      .map((item) => item.id);
    return { activity, unstable };
  };
  // 読み取りの「すること」で、家族がまだ確かめていない物の作用は、効くか分からない物にする（先の事項を、消えた
  // とも変わらないとも言わない。答えにも数えない）。確かめた後に、ふつうに効く。
  const forced = new Set<string>(
    items.filter((item) => awaitingConfirmation(state, item)).map((item) => item.id),
  );
  for (;;) {
    const { activity, unstable } = run(forced);
    if (unstable.length === 0) {
      const { resolved, doubted } = settled(activity);
      state.effects = activity;
      state.resolved = resolved;
      state.doubted = doubted;
      return;
    }
    for (const id of unstable) forced.add(id);
  }
}

interface EffectGraph {
  all: readonly Item[];
  byId: Map<string, Item>;
  /** 効いている置き換え（前の事項 → 後の事項）。 */
  replacedBy: Map<string, string>;
  /** 効いている取り消し。 */
  cancelled: Set<string>;
  /** 効くか分からない作用の先（置き換え・取り消しされるかもしれない事項）。 */
  maybe: Set<string>;
  /** 同じ事項を置き換えると言い合う事項（どれが正しい続きか分からない）。 */
  contested: Set<string>;
  /** 効いている置き換えを前へたどった、元の事項の ID。 */
  rootOf: (id: string) => string;
}

function graphOf(
  all: readonly Item[],
  activity: ReadonlyMap<string, EffectActivity>,
  overrides: { excluded: ReadonlySet<string>; stale: ReadonlySet<string> },
): EffectGraph {
  const byId = new Map(all.map((i) => [i.id, i]));
  const replacers = new Map<string, Map<string, EffectActivity>>();
  // 家族が外した事項は、取り消されたのと同じに扱う。直す前の版から読んだ事項は、確かとしない。
  const cancelled = new Set<string>(overrides.excluded);
  const maybe = new Set<string>(overrides.stale);
  for (const item of all) {
    const active = activity.get(item.id) ?? 'off';
    if (active === 'off') continue;
    for (const effect of item.effects) {
      if (effect.type === 'resolveUnknown') continue;
      if (effect.type === 'replace') {
        const by = replacers.get(effect.itemId) ?? new Map<string, EffectActivity>();
        by.set(item.id, active);
        replacers.set(effect.itemId, by);
      } else if (active === 'unknown') maybe.add(effect.itemId);
      else cancelled.add(effect.itemId);
    }
  }
  // 一つの事項を、効く（効くかもしれない）置き換えが二つ以上言う時は、どれが続きかを並びの順で
  // 決めない。系譜は継がせず、前の事項も、言い合う後の事項も、確かめる側（条件しだい）に置く。
  // 言い合う事項の作用は unknown にする（数えるのは off でない物なので、回り続けない）。
  const replacedBy = new Map<string, string>();
  const contested = new Set<string>();
  for (const [target, by] of replacers) {
    const [only, ...rest] = [...by];
    if (only === undefined) continue;
    if (rest.length > 0) {
      maybe.add(target);
      for (const id of by.keys()) contested.add(id);
    } else if (only[1] === 'on') replacedBy.set(target, only[0]);
    else maybe.add(target);
  }
  const replaces = new Map<string, string>();
  for (const [oldId, newId] of replacedBy) replaces.set(newId, oldId);
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    while (replaces.has(current) && !seen.has(current)) {
      seen.add(current);
      current = replaces.get(current) ?? current;
    }
    return current;
  };
  return { all, byId, replacedBy, cancelled, maybe, contested, rootOf };
}

function effectGraph(state: EngineState): EffectGraph {
  const all = itemsOf(state);
  return graphOf(all, state.effects, familyOverrides(state, all));
}

/**
 * 事項が今どうなっているか。置き換えは後の事項へたどる。読み直しで見つからなくなった物は vanished
 * （消えたとも、要らないとも決めない。02-foundation §4.1）。
 */
export function itemFate(
  state: EngineState,
  itemId: string,
): { status: 'current'; item: Item } | { status: 'cancelled' } | { status: 'vanished' } {
  const graph = effectGraph(state);
  let current = itemId;
  const seen = new Set<string>();
  while (graph.replacedBy.has(current) && !seen.has(current)) {
    seen.add(current);
    current = graph.replacedBy.get(current) ?? current;
  }
  if (graph.cancelled.has(current)) return { status: 'cancelled' };
  const item = graph.byId.get(current);
  if (item) return { status: 'current', item };
  return { status: 'vanished' };
}

/**
 * 今の事項（効いている置き換え・取り消しを受けていない物）と、置き換えをたどった元の事項の ID と、その出典。
 * 効くか分からない作用の先の事項は残し、doubted（置き換え・取り消しされるかもしれない）とする。分からない置き換えの後の事項は、
 * 系譜を継がない（前と後の両方を、別の物として残す）。
 */
export function currentItems(
  state: EngineState,
): { item: Item; rootId: string; rootSourceId: string; doubted: boolean }[] {
  const { all, byId, replacedBy, cancelled, maybe, contested, rootOf } = effectGraph(state);
  return all
    .filter((item) => !replacedBy.has(item.id) && !cancelled.has(item.id))
    .map((item) => {
      const rootId = rootOf(item.id);
      return {
        item,
        rootId,
        rootSourceId: byId.get(rootId)?.sourceId ?? item.sourceId,
        doubted: maybe.has(item.id) || maybe.has(rootId) || contested.has(item.id),
      };
    });
}
