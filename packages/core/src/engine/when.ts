// いつにするかの候補への答えの数え（02-foundation §3.4.1）。純関数だけを置く（事象を読まない）。
// 検証器は別に書く（エンジンを読み込まない）。答えどうしは独立と仮定する（関わり合う条件は数えない）。

/** 一人の、一つの候補への効く値。maybe・食い違い・未回答は unknown（未定）。 */
export type CountValue = 'yes' | 'no' | 'unknown';

export interface CountInput {
  /** 名簿の人（重ねない）。 */
  people: readonly string[];
  /** 要る人（名簿の中）。 */
  required: readonly string[];
  /** 最少の人数。 */
  minCount: number;
  /** 人ごとの値（無い人は unknown）。 */
  values: ReadonlyMap<string, CountValue>;
}

export interface CountResult {
  /** 「はい」の人数（L）。 */
  yes: number;
  /** 「はい」と未定の人数（U）。 */
  possible: number;
  requiredNo: string[];
  requiredOpen: string[];
  condition: 'meets' | 'open' | 'cannot';
  /** 未定の人のうち、その人の「はい」「いいえ」で成り立ちが変わり得る人。 */
  pivotal: string[];
}

/**
 * 一つの候補の、答えの条件（要る人が全員「はい」で、「はい」が最少の人数以上）。
 * - cannot：要る人に「いいえ」がある、または「はい」と未定を合わせても最少の人数に届かない（今の名簿と答えでは）。
 * - meets：「はい」が最少の人数以上で、要る人が全員「はい」。
 * - open：それ以外（未定しだい）。
 * 左右する人は閉じた式で求める：要る人に「いいえ」があれば、だれもいない。未定の要る人は、U ≥ k なら左右する
 * （その人の「いいえ」で必ず崩れ、「はい」ならほかの未定しだいで成り立つ）。未定の、要る人でない人は、
 * L ＋ 未定の要る人の数 ≤ k − 1 かつ U ≥ k なら左右する（ほかの未定を、ちょうど k − 1 人が「はい」になるように
 * 決められる）。
 */
export function countCandidate(input: CountInput): CountResult {
  const people = [...new Set(input.people)];
  const required = new Set(input.required.filter((id) => people.includes(id)));
  const value = (id: string): CountValue => input.values.get(id) ?? 'unknown';
  const yes = people.filter((id) => value(id) === 'yes').length;
  const open = people.filter((id) => value(id) === 'unknown');
  const possible = yes + open.length;
  const requiredNo = people.filter((id) => required.has(id) && value(id) === 'no');
  const requiredOpen = open.filter((id) => required.has(id));
  const k = input.minCount;
  const condition =
    requiredNo.length > 0 || possible < k
      ? 'cannot'
      : yes >= k && requiredOpen.length === 0
        ? 'meets'
        : 'open';
  const pivotal =
    requiredNo.length > 0 || possible < k
      ? []
      : open.filter((id) =>
          required.has(id) ? true : k >= 1 && yes + requiredOpen.length <= k - 1,
        );
  return { yes, possible, requiredNo, requiredOpen, condition, pivotal };
}

/** 答えの記録（事象から。出所ごと）。 */
export interface AnswerRecord {
  seq: number;
  personId: string;
  candidateId: string;
  rev: number;
  answer: 'yes' | 'maybe' | 'no' | 'withdrawn';
  note?: string;
  source: 'self' | 'link' | 'family';
  /** 書いた人（家の大人の ID か link）。 */
  by: string;
  at: string;
}

export interface EffectiveAnswer {
  value: 'yes' | 'maybe' | 'no' | 'conflict';
  /** 効いている出所ごとの一番後の記録（取り下げは入れない。たぶんの条件の一言は、それぞれの記録が持つ）。 */
  sources: AnswerRecord[];
}

/**
 * 一人の、一つの候補（同じ代）への効く答え。出所（自分の画面・リンク・家族の記録）ごとに一番後の記録を見て、
 * 取り下げは、その出所だけを未回答に戻す（ほかの出所の記録は消さない。リンクを持つ人は本人とは限らない）。
 * 残った出所の答えが全部同じならそれ、違えば食い違い（未定として数える。黙ってどれかにしない）。どれも無ければ
 * 未回答（undefined）。
 */
export function effectiveAnswer(records: readonly AnswerRecord[]): EffectiveAnswer | undefined {
  const latest = (source: AnswerRecord['source']) =>
    records.filter((r) => r.source === source).sort((a, b) => b.seq - a.seq)[0];
  const live = (['self', 'link', 'family'] as const)
    .map(latest)
    .filter((r): r is AnswerRecord => r !== undefined && r.answer !== 'withdrawn');
  if (live.length === 0) return undefined;
  const answers = new Set(live.map((r) => r.answer));
  if (answers.size > 1) return { value: 'conflict', sources: live };
  return { value: (live[0] as AnswerRecord).answer as 'yes' | 'maybe' | 'no', sources: live };
}

/** 数えに使う値（たぶん・食い違いは未定）。 */
export function countValueOf(answer: EffectiveAnswer | undefined): CountValue {
  if (answer === undefined) return 'unknown';
  return answer.value === 'yes' ? 'yes' : answer.value === 'no' ? 'no' : 'unknown';
}

export interface RecommendInput {
  id: string;
  condition: CountResult['condition'];
  yes: number;
  ways: readonly {
    wayId: string;
    usable: boolean;
    decisionDeadline?: string;
    costUnknown?: true;
  }[];
}

export interface Recommendation {
  candidateId: string;
  reason: 'onlyUsable' | 'dominates';
  meetsCount: number;
  usableCount: number;
}

/**
 * 勧め（02-foundation §3.4.1）。答えの条件を満たし、使えるやり方がある候補だけを見る。
 * - 一つだけ：その使えるやり方の代償が全部分かる時だけ勧める（onlyUsable）。
 * - 二つ以上：どの候補も使えるやり方がちょうど一つで、同じやり方で、代償が分かる時だけ比べる。人数とその決め時が、
 *   ほかのどれにも劣らず一つは勝る物を勧める（dominates）。違うやり方の代償と決め時を組み合わせた優位は作らない。
 * - それ以外は勧めない（違いを並べ、家族が選ぶ）。
 */
export function recommend(candidates: readonly RecommendInput[]): Recommendation | undefined {
  // 決め時の無いやり方は、使えるとは数えない（足りない入力を、使えることにしない）。
  const usableWays = (c: RecommendInput) =>
    c.ways.filter((w) => w.usable && w.decisionDeadline !== undefined);
  const meets = candidates.filter((c) => c.condition === 'meets');
  const usable = meets.filter((c) => usableWays(c).length > 0);
  const counts = { meetsCount: meets.length, usableCount: usable.length };
  if (usable.length === 0) return undefined;
  if (usable.length === 1) {
    const only = usable[0] as RecommendInput;
    if (usableWays(only).some((w) => w.costUnknown)) return undefined;
    return { candidateId: only.id, reason: 'onlyUsable', ...counts };
  }
  const single = usable.map(usableWays);
  if (single.some((ws) => ws.length !== 1)) return undefined;
  const wayIds = new Set(single.map((ws) => ws[0]?.wayId));
  if (wayIds.size !== 1 || single.some((ws) => ws[0]?.costUnknown)) return undefined;
  const deadlineOf = (index: number) => single[index]?.[0]?.decisionDeadline;
  if (usable.some((_, i) => deadlineOf(i) === undefined)) return undefined;
  const minutes = (at: string) => Date.parse(at);
  const winner = usable.findIndex((c, i) =>
    usable.every((d, j) => {
      if (i === j) return true;
      const ci = minutes(deadlineOf(i) as string);
      const dj = minutes(deadlineOf(j) as string);
      return c.yes >= d.yes && ci >= dj && (c.yes > d.yes || ci > dj);
    }),
  );
  if (winner < 0) return undefined;
  return { candidateId: (usable[winner] as RecommendInput).id, reason: 'dominates', ...counts };
}

export interface DecisionBasisInput {
  people: readonly string[];
  required: readonly string[];
  minCount: number;
  /**
   * その候補への効く答え（未回答は入れない）。出所ごとの答えと、たぶんの条件の一言も入れる（条件が「午前なら」から
   * 「午後なら」に変わっても、決めた事を確かめ待ちにする）。
   */
  answers: readonly {
    personId: string;
    value: 'yes' | 'maybe' | 'no' | 'conflict';
    sources: readonly { source: string; answer: string; note?: string }[];
  }[];
}

/**
 * 決めた時の根拠の控え（candidateChosen の basis。サーバーが決める時に作り、エンジンが今の物と比べる）。名簿・
 * 要る人・最少の人数と、その候補への効く答え。並びによらない JSON。
 */
export function decisionBasis(input: DecisionBasisInput): string {
  const sorted = (values: readonly string[]) => [...new Set(values)].sort();
  return JSON.stringify({
    people: sorted(input.people),
    required: sorted(input.required),
    minCount: input.minCount,
    answers: [...input.answers]
      .map((a) => [
        a.personId,
        a.value,
        [...a.sources]
          .map((s) => [s.source, s.answer, s.note ?? null] as const)
          .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
      ])
      .sort(([a], [b]) =>
        (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0,
      ),
  });
}

/** 決めた時の根拠と今の根拠で、変わった物（読めない控えは、全部変わったとする）。 */
export function basisChanges(before: string, now: string): ('people' | 'rule' | 'answers')[] {
  if (before === now) return [];
  const parse = (text: string) => {
    try {
      return JSON.parse(text) as {
        people?: unknown;
        required?: unknown;
        minCount?: unknown;
        answers?: unknown;
      };
    } catch {
      return undefined;
    }
  };
  const a = parse(before);
  const b = parse(now);
  if (!a || !b) return ['people', 'rule', 'answers'];
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const changes: ('people' | 'rule' | 'answers')[] = [];
  if (!same(a.people, b.people)) changes.push('people');
  if (!same(a.required, b.required) || !same(a.minCount, b.minCount)) changes.push('rule');
  if (!same(a.answers, b.answers)) changes.push('answers');
  return changes;
}
