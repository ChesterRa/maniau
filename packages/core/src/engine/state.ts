// 事象の列を、計算に使う状態にたたむ（docs/design/01-model.md §2）。同じ列からは、いつも同じ状態になる。
import { evaluateCondition } from '../schema/condition';
import type { DomainEvent, ProposalSnapshot, RequestSnapshot, TaskContent } from '../schema/events';
import type { Household } from '../schema/household';
import type { CommitmentState, ExternalRequestState } from '../schema/plan';
import {
  type ConditionNode,
  Extraction,
  type Interpretation,
  type Item,
  type Source,
} from '../schema/source';
import { type DateTime, toEpochMinutes } from '../time';

export interface RequestRecord {
  requestId: string;
  taskKey: string;
  sentAt: DateTime;
  sentBy: string;
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
  /** 出典ごとの、今の読み取りが読んだ文の版。出典の版より古ければ、書き起こしを直す前の読み取り。 */
  extractionVersion: Map<string, number>;
  /** 家族が直した解釈（事項の ID → 直した欄を重ねた物）。 */
  corrections: Map<string, Interpretation>;
  /** 家族の確かめ（事項の ID → 最後の言明）。confirmed は「家族が確認」、dismissed は「関係ない」。 */
  verdicts: Map<string, 'confirmed' | 'dismissed'>;
  /** 家族が取り下げた出典。 */
  withdrawnSources: Set<string>;
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
  commitmentLog: Map<string, { state: CommitmentState; requestId?: string }[]>;
  requests: Map<string, RequestRecord>;
  /** これまでに使った依頼の ID（押し間違いを直して消した物も含む。同じ ID は二度使わない）。 */
  sentRequestIds: Set<string>;
  notified: Set<string>;
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
    extractionVersion: new Map(),
    corrections: new Map(),
    verdicts: new Map(),
    withdrawnSources: new Set(),
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
    lastSeq: 0,
    rejected: [],
  };
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
  'sourceWithdrawn',
  'transcriptionCorrected',
  'requestRecordCorrected',
]);

function apply(state: EngineState, event: DomainEvent): void {
  state.lastSeq = Math.max(state.lastSeq, event.seq);
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
      setCommitment(state, event.taskKey, 'proposed');
      state.shown.delete(event.taskKey);
      return;
    case 'itemConfirmed':
    case 'itemCorrected':
    case 'itemDismissed': {
      if (!state.seenItemIds.has(event.itemId)) {
        state.rejected.push({ seq: event.seq, reason: '読み取りに無い事項への確かめ' });
        return;
      }
      if (event.type === 'itemCorrected') {
        const before = state.corrections.get(event.itemId) ?? {};
        state.corrections.set(event.itemId, { ...before, ...event.interpretation });
      }
      state.verdicts.set(event.itemId, event.type === 'itemDismissed' ? 'dismissed' : 'confirmed');
      return;
    }
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
      setCommitment(state, event.taskKey, next[event.action]);
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
        state: 'awaitingReply',
        ...(event.snapshot ? { snapshot: event.snapshot } : {}),
      });
      setCommitment(state, event.taskKey, 'done', event.requestId);
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
      return;
    case 'clockAdvanced':
      state.clock = toEpochMinutes(event.to);
      return;
  }
}

function setCommitment(
  state: EngineState,
  taskKey: string,
  value: CommitmentState,
  requestId?: string,
): void {
  const changes = state.commitmentLog.get(taskKey) ?? [];
  changes.push(requestId === undefined ? { state: value } : { state: value, requestId });
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

/** 読み取りの事項に、家族の直しと確かめを重ねた物（確かめた・直した事項は「家族が確認」）。 */
export function itemsOf(state: EngineState): Item[] {
  return [...state.extractions.values()].flatMap((e) =>
    e.items.map((item) => {
      const correction = state.corrections.get(item.id);
      const verdict = state.verdicts.get(item.id);
      const interpretation = correction
        ? { ...item.interpretation, ...correction }
        : item.interpretation;
      return verdict === 'confirmed'
        ? { ...item, interpretation, evidence: 'confirmed' as const }
        : { ...item, interpretation };
    }),
  );
}

/**
 * 家族の言明で外れた事項（「関係ない」と取り下げた出典の事項）と、書き起こしを直す前の版から
 * 読んだ事項（読み直すまで確かとしない）。
 */
function familyOverrides(state: EngineState, all: readonly Item[]) {
  const excluded = new Set<string>();
  const stale = new Set<string>();
  for (const item of all) {
    if (state.verdicts.get(item.id) === 'dismissed' || state.withdrawnSources.has(item.sourceId)) {
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
  const usable = state.answers.filter((a) => !retired.has(a.unknownId));
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
  const forced = new Set<string>();
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
