// 家族が進める案どうしを一緒に置く（docs/plan/02-product.md「G1 の結果」）。案ごとの逆算は、ほかの案の
// 作業を知らないので、二日分の届けを同じ人の同じ時刻に置くことがある。手配を一つずつ置き、前に置いた案の
// 作業が使う時間を、後の手配では使わない。どの手配から置くかで結果が変わるので、少数なら並べ方を全部試し、
// 決まった物差しで一番良い物を選ぶ。多ければ与えた順のまま置き、探しきれなかったと返す（解が無いとも、
// 一番良いとも言わない）。

/**
 * 並べ方を全部試すのは、この数まで（4 つなら 24 通り）。計画は命令のたびに作り直すので、重い探し方で家族の
 * 操作を待たせない（手元の測りで、全部を試す時、4 つで約 0.7 秒、5 つで約 4 秒）。
 */
export const JOINT_LIMIT = 4;

/** 物差し（大きいほど良い）を前から順に比べる。長さが違えば、短い方を足りない所で小さいとする。 */
export function compareScore(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? Number.NEGATIVE_INFINITY;
    const y = b[i] ?? Number.NEGATIVE_INFINITY;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 並べ方を、与えた順から辞書順に作る（最初は与えた順のまま）。 */
export function* orders<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i] as T;
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of orders(rest)) yield [head, ...tail];
  }
}

/**
 * 並べ方ごとに置いてみて（run）、物差し（score）が一番大きい結果を返す。同じ物差しなら、先に試した方
 * （与えた順に近い方）。与えた順で置いた結果が good なら、ほかを試さない（重なりも動かす約束も無い時は、
 * いつも同じ置き方にして、計算を軽く保つ）。数が JOINT_LIMIT を超えれば、与えた順の結果だけを返し、
 * complete を false にする（探しきれなかった。解が無いとも、一番良いとも言わない）。
 */
export function bestOrder<T, R>(
  items: readonly T[],
  run: (order: readonly T[]) => R,
  score: (result: R) => readonly number[],
  good: (result: R) => boolean = () => false,
): { result: R; complete: boolean } {
  const first = run(items);
  if (good(first)) return { result: first, complete: true };
  if (items.length > JOINT_LIMIT) return { result: first, complete: false };
  let best = { result: first, key: score(first) };
  let skip = true;
  for (const order of orders(items)) {
    // 最初の並べ方は、与えた順（もう置いた）。
    if (skip) {
      skip = false;
      continue;
    }
    const result = run(order);
    const key = score(result);
    if (compareScore(key, best.key) > 0) best = { result, key };
  }
  return { result: best.result, complete: true };
}
