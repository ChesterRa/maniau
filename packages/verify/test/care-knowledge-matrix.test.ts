// すべて架空。回答と忙しい時間の組を、一分ごとの別の数え方で照らす。
import { expect, it } from 'vitest';
import { type RecordedCareDay, recordedCareDay } from '../src/care-day-evidence';
import { careKnowledge } from '../src/care-knowledge';

const from = 9 * 60;
const pieces = 4;
const length = 30;
const restKinds = ['can', 'cannot', 'unknown'] as const;
const pieceKinds = ['can', 'cannot', 'rest'] as const;
type State = (typeof restKinds)[number];
type Piece = (typeof pieceKinds)[number];
const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
let seed = 0x08c0ffee;
function next(max: number): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed % max;
}

interface Input {
  day: RecordedCareDay;
  states: Piece[];
  busy?: { start: number; end: number };
}

function make(id: string): Input {
  const states = Array.from({ length: pieces }, () => pieceKinds[next(pieceKinds.length)] as Piece);
  const day: RecordedCareDay = {
    memberId: id,
    rest: restKinds[next(restKinds.length)] as State,
    can: states.flatMap((value, i) =>
      value === 'can'
        ? [{ start: clock(from + i * length), end: clock(from + (i + 1) * length) }]
        : [],
    ),
    cannot: states.flatMap((value, i) =>
      value === 'cannot'
        ? [{ start: clock(from + i * length), end: clock(from + (i + 1) * length) }]
        : [],
    ),
  };
  const start = from + next(pieces * length - 15);
  return next(2) === 0 ? { day, states } : { day, states, busy: { start, end: start + 15 } };
}

function expectedAt(input: Input, minute: number): State {
  if (input.busy && input.busy.start <= minute && minute < input.busy.end) return 'cannot';
  const index = Math.floor((minute - from) / length);
  const piece = index >= 0 && index < pieces ? input.states[index] : 'rest';
  return piece === 'can' || piece === 'cannot' ? piece : input.day.rest;
}

it('二人の部分回答・それ以外・忙しさ 400 組を、一分ごとの三値で照らす', () => {
  const signatures = new Set<string>();
  const restPairs = new Set<string>();
  const busyMasks = new Set<string>();
  for (let sample = 0; sample < 400; sample += 1) {
    const inputs = [make('a'), make('b')];
    signatures.add(JSON.stringify(inputs));
    restPairs.add(inputs.map((input) => input.day.rest).join('/'));
    busyMasks.add(inputs.map((input) => (input.busy ? '1' : '0')).join(''));
    const records = inputs.map((input) =>
      recordedCareDay(
        input.day,
        input.busy ? [{ start: clock(input.busy.start), end: clock(input.busy.end) }] : [],
      ),
    );
    if (!records[0] || !records[1]) throw new Error('架空の入力を読めない');
    const result = careKnowledge([records[0], records[1]]);
    if (!result) throw new Error('架空の根拠を読めない');
    const certain = new Uint8Array(24 * 60);
    const possible = new Uint8Array(24 * 60);
    const missing = new Uint8Array(24 * 60);
    for (const interval of result.certain) certain.fill(1, interval.start, interval.end);
    for (const interval of result.possible) possible.fill(1, interval.start, interval.end);
    for (const interval of result.missing) {
      const mask =
        (interval.adults.includes('a') ? 1 : 0) | (interval.adults.includes('b') ? 2 : 0);
      missing.fill(mask, interval.start, interval.end);
    }
    let memberMask = 0;
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const states = inputs.map((input) => expectedAt(input, minute));
      const expectedCertain = states.every((state) => state === 'cannot') ? 1 : 0;
      const expectedPossible = states.includes('can') ? 0 : 1;
      const expectedMissing = expectedPossible
        ? (states[0] === 'unknown' ? 1 : 0) | (states[1] === 'unknown' ? 2 : 0)
        : 0;
      if (
        certain[minute] !== expectedCertain ||
        possible[minute] !== expectedPossible ||
        missing[minute] !== expectedMissing
      ) {
        throw new Error(`組 ${sample} の ${clock(minute)} が違う`);
      }
      memberMask |= expectedMissing;
    }
    expect(result.missingAdults).toEqual([
      ...(memberMask & 1 ? ['a'] : []),
      ...(memberMask & 2 ? ['b'] : []),
    ]);
  }
  expect(signatures.size).toBeGreaterThan(390);
  expect(restPairs.size).toBe(9);
  expect(busyMasks.size).toBe(4);
});
