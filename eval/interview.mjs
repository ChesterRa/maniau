const UNKNOWN = '分かりません。';

export function resolveInterview(question, interview) {
  const normalized = question.normalize('NFKC').toLocaleLowerCase('ja');
  const matches = [];
  for (const entry of Array.isArray(interview) ? interview : []) {
    const excluded = (Array.isArray(entry.exclude) ? entry.exclude : []).some((word) =>
      typeof word === 'string' && word && normalized.includes(word.normalize('NFKC').toLocaleLowerCase('ja')));
    const groups = excluded || !Array.isArray(entry.match) ? [] : entry.match.filter((group) =>
      Array.isArray(group) && group.length > 0 && group.every((word) =>
        typeof word === 'string' && word.length > 0 && normalized.includes(word.normalize('NFKC').toLocaleLowerCase('ja'))));
    if (groups.length) matches.push({ entry, groups });
  }
  const matchedRules = matches.map(({ entry, groups }) => ({ topic: entry.topic, groups }));
  if (matches.length !== 1 || typeof matches[0].entry.answer !== 'string' || !matches[0].entry.answer.trim()) {
    return { answer: UNKNOWN, matched_rules: matchedRules, resolution: matches.length > 1 ? 'ambiguous' : 'unknown' };
  }
  return { answer: matches[0].entry.answer, matched_rules: matchedRules, resolution: 'matched' };
}
