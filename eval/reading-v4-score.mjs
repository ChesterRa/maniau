// extract.v4 の架空場面の機械で照らせる部分。意味の判断は採点者が別に行う。
import { createHash } from 'node:crypto';

/** 製品の buildExtractInput と同じ入力だけを作る。正解や採点項目は含めない。 */
export function inputForModel(scenario) {
  return {
    receivedAt: scenario.source.receivedAt,
    schoolYear: scenario.schoolYear,
    sender: scenario.source.sender,
    sentences: scenario.source.sentences.map(({ id, text }) => ({ id, text })),
    priorItems: scenario.priorItems.map((item) => ({
      id: item.id,
      kind: item.kind,
      written: item.written,
      interpretation: item.interpretation,
      conditionNodeId: item.conditionNodeId ?? null,
    })),
    priorUnknowns: scenario.priorUnknowns,
  };
}

export function inputHash(scenario) {
  return createHash('sha256').update(JSON.stringify(inputForModel(scenario))).digest('hex');
}

function fieldMatches(value, expected) {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (expected.present === true) return typeof value === 'string' && value.length > 0;
    if (typeof expected.startsWith === 'string')
      return typeof value === 'string' && value.startsWith(expected.startsWith);
    throw new TypeError('未知の採点条件');
  }
  return expected === null ? value === null || value === undefined : value === expected;
}

function matchesFields(item, fields = {}) {
  return Object.entries(fields).every(([field, expected]) => fieldMatches(item[field], expected));
}

// 原文との照合だけに使う。意味の同一性を、この正規化で判断しない。
const quoteForm = (value) =>
  typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, '') : '';

function citedText(item, sentences) {
  const ids = new Set(item.sentenceIds);
  return quoteForm(
    [...sentences.entries()]
      .filter(([id]) => ids.has(id))
      .map(([, text]) => text)
      .join(''),
  );
}

/** 条件の参照と循環を照らす。条件が原文と同じ意味かは、別途人が判定する。 */
function validConditions(output, scenario) {
  const nodes = new Map();
  const unknowns = new Map();
  for (const unknown of [...scenario.priorUnknowns, ...output.unknowns]) {
    if (!unknown || typeof unknown.id !== 'string' || !Array.isArray(unknown.values)) return false;
    if (unknowns.has(unknown.id)) return false;
    unknowns.set(unknown.id, unknown);
  }
  for (const node of output.conditions) {
    if (!node || typeof node.id !== 'string' || nodes.has(node.id) || !Array.isArray(node.childIds))
      return false;
    nodes.set(node.id, node);
  }
  for (const item of output.items) {
    if (item.conditionNodeId != null && !nodes.has(item.conditionNodeId)) return false;
  }
  const marks = new Map();
  const visit = (id) => {
    if (marks.get(id) === 'active') return false;
    if (marks.get(id) === 'done') return true;
    const node = nodes.get(id);
    if (!node) return false;
    marks.set(id, 'active');
    if (node.kind === 'eq') {
      if (node.childIds.length !== 0 || !unknowns.get(node.unknownId)?.values.includes(node.value))
        return false;
    } else if (node.kind === 'not') {
      if (node.childIds.length !== 1 || !visit(node.childIds[0])) return false;
    } else if (node.kind === 'and' || node.kind === 'or') {
      if (node.childIds.length < 2 || !node.childIds.every(visit)) return false;
    } else return false;
    marks.set(id, 'done');
    return true;
  };
  return [...nodes.keys()].every(visit);
}

function scoreCheck(check, items, ambiguous, sentences) {
  const relevant = items.filter((item) => item.sentenceIds.includes(check.sentenceId));
  const candidates = relevant.filter((item) => item.kind === check.kind);
  switch (check.type) {
    case 'require': {
      const correct = candidates.some(
        (item) => item.inferred === false && matchesFields(item, check.fields),
      );
      if (correct) return 'pass';
      if (
        ambiguous.has(check.sentenceId) &&
        candidates.every((item) =>
          Object.entries(check.fields ?? {}).every(
            ([field, expected]) =>
              item[field] == null || fieldMatches(item[field], expected),
          ),
        )
      )
        return 'undetermined';
      return 'fail';
    }
    case 'forbid': {
      const matches = candidates.filter((item) => matchesFields(item, check.fields));
      if (
        matches.some((item) => {
          const quote = quoteForm(item.written);
          return quote !== '' && quoteForm(sentences.get(check.sentenceId)).includes(quote);
        })
      )
        return 'fail';
      // 跨いだ引用や他の文を根拠にしている時、対象の文が用件か単なる文脈かは機械では決めない。
      return matches.length > 0 ? 'undetermined' : 'pass';
    }
    case 'empty':
      return relevant.some((item) => item[check.field] !== null && item[check.field] !== undefined)
        ? 'fail'
        : 'pass';
    case 'unresolved':
      return ambiguous.has(check.sentenceId) ||
        relevant.some(
          (item) =>
            item.kind === 'need' &&
            item.shape === 'window' &&
            (item.startTime == null || item.endTime == null),
        )
        ? 'pass'
        : 'fail';
    default:
      throw new TypeError('未知の採点方法');
  }
}

/**
 * 単純な種類・欄・引用だけを照らす。項目に一致しても意味や条件は未採点である。
 * 拒否、打ち切り、壊れた応答は成功ではなく unscorable として分ける。
 */
export function scoreReadingV4(scenario, output, { stopReason } = {}) {
  const manual = scenario.expected.manual.map(({ id, critical }) => ({
    id,
    critical,
    status: 'pending',
  }));
  if (
    (stopReason != null && stopReason !== 'end_turn') ||
    !output ||
    !Array.isArray(output.items) ||
    !Array.isArray(output.ambiguities) ||
    !Array.isArray(output.conditions) ||
    !Array.isArray(output.unknowns) ||
    !Array.isArray(output.irrelevantSentenceIds) ||
    output.items.some(
      (item) =>
        !item ||
        typeof item.kind !== 'string' ||
        !Array.isArray(item.sentenceIds) ||
        item.sentenceIds.some((id) => typeof id !== 'string'),
    )
  ) {
    return { state: 'unscorable', inputHash: inputHash(scenario), checks: [], manual };
  }
  const sentences = new Map(scenario.source.sentences.map(({ id, text }) => [id, text]));
  const ambiguous = new Set(
    output.ambiguities
      .filter((entry) => typeof entry?.note === 'string' && entry.note.trim() !== '')
      .map((entry) => entry.sentenceId),
  );
  const usedSentenceIds = new Set(output.items.flatMap((item) => item.sentenceIds));
  const sourceValid =
    output.items.every(
      (item) =>
        item.sentenceIds.length > 0 &&
        item.sentenceIds.every((id) => sentences.has(id)) &&
        quoteForm(item.written) !== '' &&
        citedText(item, sentences).includes(quoteForm(item.written)),
    ) &&
    output.ambiguities.every((entry) => sentences.has(entry?.sentenceId)) &&
    output.irrelevantSentenceIds.every((id) => sentences.has(id) && !usedSentenceIds.has(id));
  const memberAbsent = output.items.every(
    (item) => item.forMemberId == null && item.interpretation?.forMemberId == null,
  );
  const coveredSentenceIds = new Set([...usedSentenceIds, ...output.irrelevantSentenceIds]);
  const checks = [
    { id: 'source-evidence', critical: true, status: sourceValid ? 'pass' : 'fail' },
    {
      id: 'sentence-coverage',
      critical: true,
      status: [...sentences.keys()].every((id) => coveredSentenceIds.has(id)) ? 'pass' : 'fail',
    },
    { id: 'no-inferred-member-id', critical: true, status: memberAbsent ? 'pass' : 'fail' },
    {
      id: 'condition-references',
      critical: true,
      status: validConditions(output, scenario) ? 'pass' : 'fail',
    },
    ...scenario.expected.checks.map((check) => ({
      id: check.id,
      critical: check.critical,
      status: scoreCheck(check, output.items, ambiguous, sentences),
    })),
  ];
  return { state: 'partial', inputHash: inputHash(scenario), checks, manual };
}

/** 人の判断と根拠を別に付ける。未判定や未採点を成功に数えない。 */
export function reviewReadingV4(result, decisions) {
  if (result.state === 'unscorable') return { ...result, verdict: 'unscorable' };
  if (!decisions || typeof decisions !== 'object' || Array.isArray(decisions))
    throw new TypeError('人の採点は確認点 ID ごとの記録にしてください');
  const known = new Set(result.manual.map((entry) => entry.id));
  if (Object.keys(decisions).some((id) => !known.has(id)))
    throw new TypeError('場面にない確認点の採点があります');
  const manual = result.manual.map((entry) => {
    const decision = decisions[entry.id];
    if (decision === undefined) return entry;
    if (
      !decision ||
      !['pass', 'fail', 'undetermined'].includes(decision.status) ||
      typeof decision.evidence !== 'string' ||
      decision.evidence.trim() === ''
    )
      throw new TypeError('人の採点には判定と根拠が要ります');
    return { ...entry, status: decision.status, evidence: decision.evidence };
  });
  const critical = [...result.checks, ...manual].filter((entry) => entry.critical);
  const verdict = critical.some((entry) => entry.status === 'fail')
    ? 'fail'
    : critical.some((entry) => entry.status === 'pending')
      ? 'pending'
      : critical.some((entry) => entry.status === 'undetermined')
        ? 'undetermined'
        : 'pass';
  return { ...result, manual, verdict };
}
