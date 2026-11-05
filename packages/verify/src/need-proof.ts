// 「すること」とやり方の控えを、計画エンジンの要約関数を使わず照らす。
import type { Item, Way } from '@maniau/core';

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => sameValue(entry, b[index]))
    );
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left)
    .filter((key) => left[key] !== undefined)
    .sort();
  const otherKeys = Object.keys(right)
    .filter((key) => right[key] !== undefined)
    .sort();
  return sameValue(keys, otherKeys) && keys.every((key) => sameValue(left[key], right[key]));
}

export function aboutMatches(
  about: string | undefined,
  item: Item,
  ways: readonly Way[],
): boolean | undefined {
  if (!about || item.conditionNodeId) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(about) as unknown;
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const value = item.interpretation;
  const expected = {
    what: value.what ?? item.written,
    shape: value.shape,
    date: value.date,
    startTime: value.startTime,
    endTime: value.endTime,
    deadline: value.deadline,
    deadlineDayOnly: value.deadlineDayOnly,
    place: value.place,
    forMemberId: value.forMemberId,
    holdNeeded: value.holdNeeded,
    condition: 'true',
  };
  return sameValue(record.need, expected) && sameValue(record.ways, ways);
}
