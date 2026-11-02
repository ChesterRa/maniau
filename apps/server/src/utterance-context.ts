// 家族の一言を読む時に、モデルに渡す前提（今の計画の、生きている作業・頼み事・未定の値・事項）を作る。
// 作業の説明は、画面と同じ言葉（日本語の画面の文言）で作る。家族の名前を含むので、架空のデモだけで使う
// （実在の家族に使う前に、送る範囲を決める。01-model §10、02-foundation §11）。
import { readFileSync } from 'node:fs';
import {
  type ConditionNode,
  type DateTime,
  type DomainEvent,
  formatDateTime,
  type Household,
  isActiveTask,
  type PlanResult,
  type Task,
  toEpochMinutes,
  type UtteranceContext,
} from '@maniau/core';
import {
  type EngineState,
  foldEvents,
  liveItems,
  planFromState,
  retiredUnknowns,
} from '@maniau/core/engine';

const ROOT = new URL('../../../', import.meta.url);
const JA: Record<string, unknown> = JSON.parse(
  readFileSync(new URL('apps/web/src/locales/ja.json', ROOT), 'utf8'),
);

/** 画面の文言を引いて、{{名前}} を埋める。無い鍵は鍵のまま返す。 */
function ja(key: string, params: Record<string, string> = {}): string {
  let node: unknown = JA;
  for (const part of key.split('.')) {
    node =
      typeof node === 'object' && node !== null
        ? (node as Record<string, unknown>)[part]
        : undefined;
  }
  const text =
    typeof node === 'string'
      ? node
      : typeof node === 'object' &&
          node !== null &&
          typeof (node as { title?: unknown }).title === 'string'
        ? (node as { title: string }).title
        : key;
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => params[name] ?? '');
}

const nameOf = (household: Household, id: string | undefined) =>
  (id &&
    (household.members.find((m) => m.id === id)?.name ??
      household.places.find((p) => p.id === id)?.name)) ||
  (id ?? '');

/** 作業の名前（画面の taskTitle と同じ決め方）。 */
function taskTitle(plan: PlanResult, household: Household, task: Task): string {
  if (task.titleKey === 'task.helper.ask') {
    const option = plan.arrangements
      .flatMap((a) => a.options)
      .find((o) => o.key === task.basis.optionKey);
    const template = household.careOptions.find((c) => c.id === option?.templateId);
    return ja('task.helper.ask', { name: nameOf(household, template?.providerId) });
  }
  if (task.titleKey === 'task.cancelRequest') {
    return ja('task.cancelRequest', { to: nameOf(household, task.titleParams.to) });
  }
  return ja(task.titleKey, task.titleParams);
}

/** その作業・頼み事が要る日（子の居場所の日、物の要る日）。 */
function needDate(plan: PlanResult, basis: Task['basis']): string | null {
  const arrangement = plan.arrangements.find((a) => a.key === basis.arrangementKey);
  if (arrangement) return arrangement.start.slice(0, 10);
  const requirement = plan.requirements.find((r) => r.key === basis.requirementKey);
  return requirement?.date ?? requirement?.by?.slice(0, 10) ?? null;
}

function describe(plan: PlanResult, household: Household, task: Task): string {
  const title = taskTitle(plan, household, task);
  const arrangement = plan.arrangements.find((a) => a.key === task.basis.arrangementKey);
  return arrangement?.kind === 'childCare' ? `${title}（子の居場所）` : title;
}

/** 条件の文の長さの上限。共有する子の多い式は、展開すると指数的に長くなるので、途中で止める。 */
const CONDITION_TEXT_MAX = 300;
/** 上限を超えた時の文（切った文を、条件の全部として見せない）。 */
export const CONDITION_TOO_COMPLEX = '条件が複雑です（元の文を見てください）';

/**
 * 条件の式を文にする（未定の値の名前と値で）。作った文の長さを足していき、上限を超えたら止めて
 * CONDITION_TOO_COMPLEX を返す（展開の手間も、この上限で抑える）。
 */
export function conditionText(
  nodeId: string,
  nodes: ReadonlyMap<string, ConditionNode>,
  labels: ReadonlyMap<string, string>,
): string {
  let used = 0;
  const visit = (id: string, depth: number): string | undefined => {
    const node = nodes.get(id);
    if (!node) return '';
    if (depth > 16) return undefined;
    let text: string;
    switch (node.kind) {
      case 'eq':
        text = `${labels.get(node.unknownId) ?? node.unknownId}が「${node.value}」`;
        break;
      case 'and':
      case 'or': {
        const parts: string[] = [];
        for (const child of node.childIds) {
          const part = visit(child, depth + 1);
          if (part === undefined) return undefined;
          parts.push(part);
        }
        text = parts.join(node.kind === 'and' ? '、かつ' : '、または');
        break;
      }
      case 'not': {
        const part = visit(node.childId, depth + 1);
        if (part === undefined) return undefined;
        text = `「${part}」でない`;
        break;
      }
    }
    used += text.length;
    return used > CONDITION_TEXT_MAX ? undefined : text;
  };
  return visit(nodeId, 0) ?? CONDITION_TOO_COMPLEX;
}

/**
 * 持ち物の「家にあるか」の値（エンジンが宣言する。答えは「ある」yes・「ない」no だけ）。要件が生きていて
 * 要る時の前なら、問いが消えた後も載せる（「やっぱり無かった」「用意できた」と言えるように。サーバーが
 * 受け付ける範囲と同じ）。一言の答えの命令には、サーバーが見せた品物を付ける（品物が直された後の古い候補で、
 * 別の物を「ある」にしない）。今の答えは、今の品物について答えた物だけ（前の品物への答えは使わない）。
 * 同じ品物が別の日にも要る時に見分けられるよう、名前に要る日を添える（画面の候補にも同じ日を出す）。
 */
function atHomeUnknowns(state: EngineState, plan: PlanResult): UtteranceContext['unknowns'] {
  const now = toEpochMinutes(plan.now);
  return plan.requirements.flatMap((r) => {
    if (!r.live || r.atHomeUnknownId === undefined) return [];
    if (r.by === undefined || toEpochMinutes(r.by) <= now) return [];
    const answer = state.resolved.get(r.atHomeUnknownId);
    const current = answer && (answer.about === undefined || answer.about === r.what);
    return [
      {
        id: r.atHomeUnknownId,
        label: `${r.what}が家にあるか（${r.by.slice(0, 10)}までに要る）`,
        values: ['yes', 'no'],
        answer: current ? answer.value : null,
      },
    ];
  });
}

function contextFrom(
  state: EngineState,
  plan: PlanResult,
  household: Household,
  memberId: string,
  utterance: string,
): UtteranceContext | undefined {
  const speaker = household.members.find(
    (m) => m.id === memberId && m.kind === 'adult' && m.active,
  );
  if (!speaker) return undefined;
  const extractions = [...state.extractions.values()].filter(
    (e) => !state.withdrawnSources.has(e.sourceId),
  );
  const retired = retiredUnknowns(state);
  const unknowns = extractions.flatMap((e) => e.unknowns).filter((u) => !retired.has(u.id));
  const labels = new Map(unknowns.map((u) => [u.id, u.label]));
  const nodes = new Map(extractions.flatMap((e) => e.conditions).map((n) => [n.id, n]));
  // 比べるための候補の作業（まだ選んでいない案の物）は入れない。入れると、選ぶ前の案の担当を、
  // 頼んだ・引き受け待ちのように答えてしまう（「きょう」と同じ見分け方）。取り消しを伝える作業は、
  // 要らなくなった手配の根拠を持つので、別に入れる（「きょう」も別に出す）。
  const tasks = plan.tasks.filter(
    (t) =>
      t.live &&
      (t.commitment === 'proposed' || t.commitment === 'accepted') &&
      (t.cancels !== undefined || isActiveTask(plan, t)),
  );
  const cancelling = new Set(tasks.flatMap((t) => (t.cancels ? [t.cancels] : [])));
  return {
    now: plan.now,
    timeZone: household.timeZone,
    speaker: { id: speaker.id, name: speaker.name },
    members: household.members
      .filter((m) => m.active)
      .map((m) => ({ id: m.id, name: m.name, kind: m.kind })),
    utterance,
    tasks: tasks.map((t) => ({
      key: t.key,
      what: describe(plan, household, t),
      date: needDate(plan, t.basis),
      deadline: t.deadline ?? null,
      assigneeId: t.assigneeId ?? null,
      commitment: t.commitment,
      external: t.external ? { to: nameOf(household, t.external.to), kind: t.external.kind } : null,
      sent: plan.requests.some((r) => r.taskKey === t.key),
      cancels: t.cancels ?? null,
    })),
    // 要る頼み事と、要らなくなって取り消しを伝える作業が出ている頼み事。日は送ったと記録した時の控えの日
    // （置き換えで手配の日が替わっても、相手が頼まれたのはその日）。
    requests: plan.requests
      .filter((r) => r.live || cancelling.has(r.requestId))
      .map((r) => {
        const task = plan.tasks.find((t) => t.key === r.taskKey);
        return {
          id: r.requestId,
          to: nameOf(household, r.to),
          what: task ? describe(plan, household, task) : r.kind,
          forDate: r.window?.start.slice(0, 10) ?? null,
          state: r.state,
          sentBy: r.sentBy,
          needed: r.live,
        };
      }),
    unknowns: [
      ...unknowns.map((u) => ({
        id: u.id,
        label: u.label,
        values: u.values,
        answer: state.resolved.get(u.id)?.value ?? null,
      })),
      ...atHomeUnknowns(state, plan),
    ],
    items: liveItems(state)
      .filter((l) => l.live)
      .map(({ item, conditional }) => ({
        id: item.id,
        kind: item.kind,
        what: item.interpretation.what ?? item.written,
        date: item.interpretation.date ?? null,
        deadline: item.interpretation.deadline ?? null,
        condition:
          conditional && item.conditionNodeId
            ? conditionText(item.conditionNodeId, nodes, labels) || null
            : null,
      })),
  };
}

/**
 * 今の事象から、一言を読む前提を作る。話した人が有効な大人でなければ無し。時計を進めたデモは、その時刻。
 */
export function utteranceContext(
  events: readonly DomainEvent[],
  memberId: string,
  fallbackNow: DateTime,
  utterance: string,
): UtteranceContext | undefined {
  const state = foldEvents(events);
  const household = state.household;
  if (!household) return undefined;
  const now =
    state.clock === undefined ? fallbackNow : formatDateTime(state.clock, household.timeZone);
  return contextFrom(state, planFromState(state, now), household, memberId, utterance);
}
