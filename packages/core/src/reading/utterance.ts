// 家族の一言（話した・打った短い文）を、確かめてから記録する変更の候補に直す（01-model §10）。
// モデルは、一言を今の作業・頼み事・未定の値に結び付けるだけ。対象があるか、話した人がしてよいか、
// 今の状態で効くかはここで確かめる。家族に見せる文（候補の説明・答えの一覧）は、画面が計画から作る。
// 確かめる前には何も書かない。候補には、見せた時の状態の控え（seen）を付け、確かめる時に比べる。
import { z } from 'zod';
import type { Command } from '../schema/commands';
import {
  type CommitmentState,
  type ExternalRequestState,
  isNeedArrangementKey,
  type PlanResult,
} from '../schema/plan';

export const UTTERANCE_ACTION_TYPES = [
  'withdraw',
  'decline',
  'done',
  'recordSent',
  'recordReply',
  'recordCancellationSent',
  'answer',
] as const;

/** モデルの出す候補の一つ。使わない欄は null。 */
export const UtteranceAction = z.object({
  type: z.enum(UTTERANCE_ACTION_TYPES),
  taskKey: z.string().nullable(),
  requestId: z.string().nullable(),
  reply: z.enum(['yes', 'no']).nullable(),
  unknownId: z.string().nullable(),
  value: z.string().nullable(),
});
export type UtteranceAction = z.infer<typeof UtteranceAction>;

export const UNSUPPORTED_REASONS = [
  'routineChange',
  'otherAdultsTask',
  'notInPlan',
  /** 本当の返事か、仮の話（「断られたら？」）か決められない、または一つの一言に両方が混ざっている。 */
  'replyOrWhatIf',
  'other',
] as const;
export type UnsupportedReason = (typeof UNSUPPORTED_REASONS)[number];

/** モデルの出力（構造化出力の形）。 */
export const UtteranceOutput = z.object({
  kind: z.enum(['change', 'clarify', 'whatIf', 'question', 'unsupported']),
  actions: z.array(UtteranceAction),
  refs: z.object({
    taskKeys: z.array(z.string()),
    requestIds: z.array(z.string()),
    itemIds: z.array(z.string()),
  }),
  unsupported: z.enum(UNSUPPORTED_REASONS).nullable(),
});
export type UtteranceOutput = z.infer<typeof UtteranceOutput>;

export interface UtteranceTask {
  key: string;
  /** 何をする作業か（日本語の短い説明）。 */
  what: string;
  /** その作業が要る日（子の居場所の日、物の要る日）。 */
  date: string | null;
  /** 作業の締切（時差付き）。 */
  deadline: string | null;
  assigneeId: string | null;
  commitment: CommitmentState;
  /** 外の相手に頼む・出す作業なら、その相手（名前）と種類。 */
  external: { to: string; kind: string } | null;
  /** その作業の頼み事を、もう送ったと記録したか。 */
  sent: boolean;
  /** 取り消しを伝える作業なら、取り消す頼み事の ID。 */
  cancels: string | null;
}

export interface UtteranceRequest {
  id: string;
  to: string;
  what: string;
  /** 頼んだ日（送ったと記録した時の計画の控えの日。今の手配の日ではない）。控えが無ければ null。 */
  forDate: string | null;
  state: ExternalRequestState;
  sentBy: string;
  /** まだ要るか。要らなくなり、取り消しを伝える作業が出ている物は false。 */
  needed: boolean;
}

/** モデルに渡す前提。今の計画の、生きている物だけ。 */
export interface UtteranceContext {
  now: string;
  timeZone: string;
  speaker: { id: string; name: string };
  members: { id: string; name: string; kind: string }[];
  utterance: string;
  tasks: UtteranceTask[];
  requests: UtteranceRequest[];
  unknowns: { id: string; label: string; values: string[]; answer: string | null }[];
  items: {
    id: string;
    kind: string;
    what: string;
    date: string | null;
    deadline: string | null;
    /** 条件しだいの事項の条件（文）。いつも当てはまる物は null。 */
    condition: string | null;
  }[];
}

/**
 * 見せた時の対象（前提に載っていた形のまま：何か・日・相手・状態）。確かめる時に今の前提と比べ、
 * 一つでも違えば（状態だけでなく、日や用件が替わっても）古い候補を記録しない。
 */
export type ProposalSeen =
  | { task: UtteranceTask | null }
  | { request: UtteranceRequest | null }
  | { unknown: UtteranceContext['unknowns'][number] | null };

export interface UtteranceProposal {
  command: Command;
  seen: ProposalSeen;
}

export type UtteranceRefs = { taskKeys: string[]; requestIds: string[]; itemIds: string[] };

export type UtteranceReply =
  | { kind: 'change'; proposals: [UtteranceProposal] }
  /**
   * どれのことか決められない（候補から選ぶ）か、別の大人の作業で話した人には変えられないか、まだだれも
   * 持っていない作業を含む（先に持つ人を決めてもらう。unowned はコードだけが出す理由）。別の大人の作業と
   * だれも持っていない作業の両方を含む時は、reason を otherAdultsTask にし、unowned を付ける。
   */
  | {
      kind: 'clarify';
      proposals: UtteranceProposal[];
      reason: 'ambiguous' | 'otherAdultsTask' | 'unowned';
      unowned?: true;
    }
  /**
   * 仮の話（「おばあちゃんがダメだったら？」）：断られたと仮に置く頼み事の候補。今返事を待っている、要る頼み事
   * だけ（入力に無い ID と、返事のあった・要らなくなった頼み事は捨てる）。空なら、仮に置ける頼み事が無い。何も
   * 記録しない（家族が選んでから、書かない計算を見せる）。
   */
  | { kind: 'whatIf'; requestIds: string[] }
  | { kind: 'question'; refs: UtteranceRefs }
  | { kind: 'unsupported'; reason: UnsupportedReason };

type Checked =
  | { ok: true; proposal: UtteranceProposal }
  | { ok: false; why: 'otherAdultsTask' | 'unowned' | 'notApplicable' };

/** 候補の対象の、今の形（見せた時と確かめる時で、同じ形で比べる）。 */
export function seenOf(command: Command, context: UtteranceContext): ProposalSeen {
  switch (command.type) {
    case 'commitment':
    case 'recordSent':
      return { task: context.tasks.find((t) => t.key === command.taskKey) ?? null };
    case 'recordReply':
    case 'recordCancellationSent':
      return { request: context.requests.find((r) => r.id === command.requestId) ?? null };
    case 'answer':
      return { unknown: context.unknowns.find((u) => u.id === command.unknownId) ?? null };
    default:
      return { task: null };
  }
}

/**
 * 一言の候補を、一言からは記録させない訳（02-foundation §8）。otherTasks・otherRequests・otherUnknowns：同じ種類の
 * 対象がほかにもある。needOnCard：試しの家庭の「すること」の頼み事の返事・取り消しを伝えたこと（札で記録する）。
 * missing：候補の対象が、今の前提に無い。
 */
export type RecordBlock =
  | 'otherTasks'
  | 'otherRequests'
  | 'otherUnknowns'
  | 'needOnCard'
  | 'missing';

/**
 * 一言の候補を記録してよいか。同じ種類の対象がほかに一つも無い時だけ記録できる。題・名前・品名・控えの文は
 * 家族やお知らせの文で、同じに見えて違う物（空白・見えない文字・形の似た字）を見分けられず、日付や時刻の表示も
 * 自由な文で真似できるので、どの文も比べない（数だけで決める）。作業は計画の生きている作業の全部（比べるための
 * 案の作業も）、頼み事は記録の先になりうる頼み事の全部、未定の値は一言で答えられる値の全部（家にあるかとほかの
 * 値を分けない）と比べる。候補を出す時と、家庭を押さえて記録する時の二度、同じ時の前提と計画で呼ぶ。
 */
export function recordBlock(
  command: Command,
  context: UtteranceContext,
  plan: PlanResult,
  options: { trial: boolean },
): RecordBlock | undefined {
  switch (command.type) {
    case 'commitment':
    case 'recordSent': {
      if (!context.tasks.some((t) => t.key === command.taskKey)) return 'missing';
      const others = plan.tasks.some((t) => t.live && t.key !== command.taskKey);
      return others ? 'otherTasks' : undefined;
    }
    case 'recordReply':
    case 'recordCancellationSent': {
      const request = plan.requests.find((r) => r.requestId === command.requestId);
      if (!request || !context.requests.some((r) => r.id === command.requestId)) return 'missing';
      if (
        options.trial &&
        request.basis.arrangementKey !== undefined &&
        isNeedArrangementKey(request.basis.arrangementKey)
      ) {
        return 'needOnCard';
      }
      const target = (state: ExternalRequestState, live: boolean) =>
        state !== 'cancelled' && (command.type === 'recordReply' || !live);
      const others = plan.requests.some(
        (r) => r.requestId !== command.requestId && target(r.state, r.live),
      );
      return others ? 'otherRequests' : undefined;
    }
    case 'answer': {
      if (!context.unknowns.some((u) => u.id === command.unknownId)) return 'missing';
      const others = context.unknowns.some((u) => u.id !== command.unknownId);
      return others ? 'otherUnknowns' : undefined;
    }
    default:
      return 'missing';
  }
}

/** モデルの候補の一つを、今の前提で確かめ、命令にする。 */
function check(
  action: UtteranceAction,
  context: UtteranceContext,
  newRequestId: () => string,
): Checked {
  const me = context.speaker.id;
  const proposal = (command: Command): Checked => ({
    ok: true,
    proposal: { command, seen: seenOf(command, context) },
  });
  const no = { ok: false, why: 'notApplicable' } as const;
  if (
    action.type === 'withdraw' ||
    action.type === 'decline' ||
    action.type === 'done' ||
    action.type === 'recordSent'
  ) {
    const task = context.tasks.find((t) => t.key === action.taskKey);
    if (!task) return no;
    // 別の大人が持つ作業は、話した人の言葉では変えない（本人の操作だけ。02-foundation §7.2）。
    if (task.assigneeId !== me) {
      return { ok: false, why: task.assigneeId !== null ? 'otherAdultsTask' : 'unowned' };
    }
    switch (action.type) {
      case 'withdraw':
        return task.commitment === 'accepted'
          ? proposal({ type: 'commitment', taskKey: task.key, action: 'withdraw' })
          : no;
      case 'decline':
        return task.commitment === 'proposed'
          ? proposal({ type: 'commitment', taskKey: task.key, action: 'decline' })
          : no;
      case 'done':
        // 取り消しを伝える作業は、その頼み事に取り消しを伝えたとして記録する（画面の札と同じ）。
        if (task.cancels !== null) {
          const request = context.requests.find((r) => r.id === task.cancels);
          return request && request.state !== 'cancelled'
            ? proposal({ type: 'recordCancellationSent', requestId: request.id })
            : no;
        }
        // 外に頼む・出す作業は「送った」として記録する（返事待ちを持つため）。引き受けを押さずに
        // 済ませた本人の作業も、済みにできる（命令と同じ）。
        return (task.commitment === 'accepted' || task.commitment === 'proposed') &&
          task.external === null
          ? proposal({ type: 'commitment', taskKey: task.key, action: 'done' })
          : no;
      case 'recordSent':
        // 引き受けを押さずに送った時も、本人の担当で未送信なら記録できる（送ると済みになる。命令と同じ）。
        return (task.commitment === 'accepted' || task.commitment === 'proposed') &&
          task.external !== null &&
          !task.sent
          ? proposal({ type: 'recordSent', taskKey: task.key, requestId: newRequestId() })
          : no;
    }
  }
  if (action.type === 'recordReply' || action.type === 'recordCancellationSent') {
    const request = context.requests.find((r) => r.id === action.requestId);
    if (!request) return no;
    if (action.type === 'recordReply') {
      // 初めての返事と、返事の変わった時（「大丈夫」の後に「無理」）。同じ返事の繰り返しは記録しない。
      const changes =
        request.state === 'awaitingReply' ||
        (request.state === 'confirmed' && action.reply === 'no') ||
        (request.state === 'turnedDown' && action.reply === 'yes');
      return changes && action.reply !== null
        ? proposal({ type: 'recordReply', requestId: request.id, reply: action.reply })
        : no;
    }
    // 取り消しを伝えたと記録できるのは、計画が取り消しを伝える作業を出している依頼だけ（要らなくなった
    // 物。まだ要る頼み事を、一言の読み違いで取り消したことにしない）。
    const cancelling = context.tasks.some((t) => t.cancels === request.id);
    return cancelling && request.state !== 'cancelled'
      ? proposal({ type: 'recordCancellationSent', requestId: request.id })
      : no;
  }
  // answer
  const unknown = context.unknowns.find((u) => u.id === action.unknownId);
  if (!unknown || action.value === null || !unknown.values.includes(action.value)) return no;
  if (unknown.answer === action.value) return no;
  return proposal({ type: 'answer', unknownId: unknown.id, value: action.value });
}

const sameCommand = (a: Command, b: Command) => {
  // 新しい依頼の ID は作るたびに違うので、比べない。
  const strip = (c: Command) => (c.type === 'recordSent' ? { ...c, requestId: '' } : c);
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

/**
 * モデルの出力を、家族に見せる答えにする。種類はモデルの言う物を元に、確かめた候補の数で決め直す。
 * - 変更：確かめて残った候補が一つなら、それを見せる。二つ以上なら選んでもらう。
 * - 残らず、別の大人の作業だった時は、話した人には変えられないと示す（候補を出さない）。
 * - 問い：今の計画にある物だけを指す。
 */
export function toUtteranceReply(
  output: UtteranceOutput,
  context: UtteranceContext,
  newRequestId: () => string,
): UtteranceReply {
  // 本当の返事か仮の話か決められない（両方が混ざる）とモデルが印を付けたら、ほかの欄が何を言っていても、記録の
  // 候補も仮の計算の口も出さない（矛盾した出力から、押せる候補を作らない）。
  if (output.unsupported === 'replyOrWhatIf')
    return { kind: 'unsupported', reason: 'replyOrWhatIf' };
  if (output.kind === 'question') {
    const tasks = new Set(context.tasks.map((t) => t.key));
    const requests = new Set(context.requests.map((r) => r.id));
    const items = new Set(context.items.map((i) => i.id));
    const unique = (ids: string[], known: Set<string>) =>
      [...new Set(ids)].filter((id) => known.has(id));
    return {
      kind: 'question',
      refs: {
        taskKeys: unique(output.refs.taskKeys, tasks),
        requestIds: unique(output.refs.requestIds, requests),
        itemIds: unique(output.refs.itemIds, items),
      },
    };
  }
  if (output.kind === 'whatIf') {
    const waiting = new Set(
      context.requests.filter((r) => r.state === 'awaitingReply' && r.needed).map((r) => r.id),
    );
    return {
      kind: 'whatIf',
      requestIds: [...new Set(output.refs.requestIds)].filter((id) => waiting.has(id)),
    };
  }
  if (output.kind === 'unsupported') {
    // 別の大人の作業のことなら、変えられないと示す（本人が記録する）。
    if (output.unsupported === 'otherAdultsTask') {
      return { kind: 'clarify', proposals: [], reason: 'otherAdultsTask' };
    }
    return { kind: 'unsupported', reason: output.unsupported ?? 'other' };
  }
  const proposals: UtteranceProposal[] = [];
  let otherAdults = false;
  let unowned = false;
  for (const action of output.actions) {
    const checked = check(action, context, newRequestId);
    if (checked.ok) {
      if (!proposals.some((p) => sameCommand(p.command, checked.proposal.command))) {
        proposals.push(checked.proposal);
      }
    } else if (checked.why === 'otherAdultsTask') {
      otherAdults = true;
    } else if (checked.why === 'unowned') {
      unowned = true;
    }
  }
  // 一言の一部が別の大人の作業なら、話した人の分だけを黙って一つの変更にしない（残りを本人が記録する
  // と示す）。話した人の分は、選べる候補として残す。
  if (otherAdults || output.unsupported === 'otherAdultsTask') {
    return {
      kind: 'clarify',
      proposals,
      reason: 'otherAdultsTask',
      ...(unowned ? { unowned: true as const } : {}),
    };
  }
  // まだだれも持っていない作業を含む時も、黙って落とさない（計画に無いとも言わない）。話した人の分は、
  // 選べる候補として残す。
  if (unowned) return { kind: 'clarify', proposals, reason: 'unowned' };
  const [only] = proposals;
  if (output.kind === 'change' && only && proposals.length === 1) {
    return { kind: 'change', proposals: [only] };
  }
  if (proposals.length > 0) return { kind: 'clarify', proposals, reason: 'ambiguous' };
  // どれのことか決められない時は、候補が無くても聞き返す（「その日」がどの日か等）。
  if (output.kind === 'clarify') return { kind: 'clarify', proposals: [], reason: 'ambiguous' };
  return { kind: 'unsupported', reason: output.unsupported ?? 'notInPlan' };
}
