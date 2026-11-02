// 架空の開発用場面を製品の一言入力に移し、見えた出力だけを採点する。
// 正解と採点項目は読み取りに渡さない。画面と確認操作の成否は別に確かめる。

const emptyArray = (value) => (Array.isArray(value) ? value : []);

export function sameSourceFingerprints(before, after) {
  if (!before || !after) return false;
  const keys = Object.keys(before).sort();
  return keys.length === Object.keys(after).length && keys.every((key) => before[key] === after[key]);
}

function rowsOf(state) {
  return [...emptyArray(state.items), ...emptyArray(state.notices).flatMap((notice) => emptyArray(notice.items))];
}

function sentOf(task, requests) {
  if (typeof task.sent === 'boolean') return task.sent;
  if (!task.external || requests.length === 0) return false;
  if (requests.every((request) => typeof request.taskKey === 'string')) {
    return requests.some((request) => request.taskKey === task.key);
  }
  // 依頼と作業の対応が欠ける時、未送信と決めつけない。
  throw new Error('送信済みか判定できない作業があります。');
}

/** 実際に渡せる情報だけを移す。存在しない詳細は空欄とし、欠落を記録する。 */
export function prepareUtteranceCase(scenario) {
  if (scenario?.synthetic !== true || scenario.task !== 'spoken_update') {
    throw new Error('架空の一言の場面だけを使ってください。');
  }
  const { input } = scenario;
  if (!input?.state || !input.actor || !Array.isArray(input.members)) {
    throw new Error('場面の入力が足りません。');
  }
  const state = input.state;
  if (!Array.isArray(state.tasks) || !Array.isArray(state.requests)) {
    throw new Error('作業と依頼の一覧がありません。');
  }
  const omissions = [];
  const sourceTasks = emptyArray(state.tasks);
  const sourceRequests = emptyArray(state.requests);
  if ([...sourceTasks, ...sourceRequests].some((row) => typeof row.live !== 'boolean')) {
    throw new Error('有効か分からない作業または依頼があります。');
  }
  const activeTasks = sourceTasks.filter((task) => task.live && ['proposed', 'accepted'].includes(task.commitment));
  for (const task of sourceTasks) {
    if (task.live && !['proposed', 'accepted'].includes(task.commitment)) omissions.push({ type: 'task.state_not_in_context', id: task.key });
  }
  const cancellations = new Set(activeTasks.map((task) => task.cancels).filter(Boolean));
  const requests = sourceRequests.filter((request) => request.live || cancellations.has(request.id));
  const tasks = activeTasks.map((task) => ({
    key: task.key,
    what: task.what,
    date: task.date ?? null,
    deadline: task.deadline ?? null,
    assigneeId: task.assigneeId ?? null,
    commitment: task.commitment,
    external: task.external ? { to: task.external.to, kind: task.external.kind } : null,
    sent: sentOf(task, sourceRequests),
    cancels: task.cancels ?? null,
  }));
  const includedRequests = requests.map((request) => {
    if (typeof request.what !== 'string') omissions.push({ type: 'request.what', id: request.id });
    return {
      id: request.id,
      to: request.to,
      what: typeof request.what === 'string' ? request.what : '',
      forDate: request.forDate ?? null,
      state: request.state,
      sentBy: request.sentBy,
      needed: request.live,
    };
  });
  for (const notice of emptyArray(state.notices)) {
    if (notice.title) omissions.push({ type: 'notice.title', id: notice.id });
  }
  const items = rowsOf(state)
    .filter((item) => item.live !== false && item.conditionState !== 'false')
    .map((item) => {
      if (typeof item.kind !== 'string') omissions.push({ type: 'item.kind', id: item.id });
      if (item.evidence !== undefined) omissions.push({ type: 'item.evidence', id: item.id });
      let condition = null;
      if (item.condition && item.condition !== 'always' && item.conditionState !== 'true') {
        condition = item.condition;
      }
      return {
        id: item.id,
        kind: typeof item.kind === 'string' ? item.kind : '',
        what: item.what,
        date: item.date ?? null,
        deadline: item.deadline ?? null,
        condition,
      };
    });
  if (emptyArray(state.routines).length) omissions.push({ type: 'routines', id: null });
  return {
    context: {
      now: input.now,
      timeZone: scenario.timeZone,
      speaker: { id: input.actor.id, name: input.actor.name },
      members: input.members.map(({ id, name, kind }) => ({ id, name, kind })),
      utterance: input.utterance,
      tasks,
      requests: includedRequests,
      unknowns: emptyArray(state.unknowns).map(({ id, label, values, answer }) => ({
        id, label, values: [...values], answer: answer ?? null,
      })),
      items,
    },
    omissions,
  };
}

function commandMatches(reference, command) {
  return command && Object.entries(reference).every(([key, value]) => command[key] === value);
}

/** 分類と対象だけを機械で照合し、確認項目は人や画面による判定を待つ。 */
export function scoreUtteranceCase(scenario, reply, omissions = []) {
  const expected = scenario.expected;
  const checks = expected.checks.map(({ id, critical }) => ({ id, critical, result: 'undetermined' }));
  const base = { caseId: scenario.id, omissions, checks, afterPreview: expected.afterPreview ? 'not_run' : null };
  if (expected.classification === 'one_day_exception') {
    return { ...base, checks: checks.map((check) => ({ ...check, result: 'not_run' })), status: 'not_run', reason: 'routine_change_not_supported' };
  }
  if (!reply || !['change', 'clarify', 'question', 'unsupported'].includes(reply.kind)) {
    return { ...base, status: 'incomplete', reason: 'invalid_reply' };
  }
  const classification = reply.kind === expected.classification ? 'match' : 'mismatch';
  let commands = 'not_applicable';
  if (expected.classification === 'change') {
    if (reply.kind !== 'change') {
      commands = 'mismatch';
    } else if (!Array.isArray(reply.proposals) || reply.proposals.some((p) => !p?.command)) {
      commands = 'undetermined';
    } else {
      const actual = reply.proposals.map((p) => p.command);
      const reference = expected.referenceCommands;
      commands = actual.length === reference.length && reference.every((c, i) => commandMatches(c, actual[i]))
        ? 'match' : 'mismatch';
    }
  }
  return { ...base, status: 'observed', classification, commands };
}

/** 読み取りと変換を注入し、未対応の場面では呼ばない。 */
export async function evaluateUtteranceCase(scenario, { read, toReply }) {
  const { context, omissions } = prepareUtteranceCase(scenario);
  if (scenario.expected.classification === 'one_day_exception') {
    return { context, reply: null, report: scoreUtteranceCase(scenario, null, omissions) };
  }
  const output = await read(context);
  const reply = await toReply(output, context);
  return { context, reply, report: scoreUtteranceCase(scenario, reply, omissions) };
}
