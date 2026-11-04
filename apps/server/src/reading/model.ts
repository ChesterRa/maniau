// 製品の Claude の呼び出し（お知らせの読み取り・写真の書き起こし・一言・やり方の案・店の検索語）の、モデル・
// 思考の強さ・速さ。いちばん強いモデルで呼ぶ（作り手の指示 2026-11-04：費用より、読みの確かさ。01-model
// §10）。速いモードは切り替えで、作る間は切っておき、提出の前に公開のデモで入れる（作り手の指示 2026-11-05：
// 額の多くを、審査の人が試す時に残す）。

/** 製品の呼び出しのモデル。 */
export const PRODUCT_MODEL = 'claude-opus-5-5';

/** 思考の強さ。Opus 5.5 は思考を切れず、初期値も medium だが、呼び出しごとに明示する。 */
export const PRODUCT_EFFORT = 'medium' as const;

/**
 * 呼び出しに足す速さ。環境変数 CLAUDE_FAST_MODE が 1 の時だけ速いモード（出力の速さが上がる。料金は標準の 2 倍）で、
 * 無ければ標準の速さ（欄を足さない）。呼ぶたびに読む（試験で切り替えられるように）。Opus 5.5 は本文の speed だけで
 * よい（beta の頭は要らない。公式の文書と、2026-11-04 の一回の呼び出しで usage.speed が fast だったことで確かめた）。
 * 速いモードで答えたかは、応答の usage.speed で分かる。
 */
export function productSpeed(env: NodeJS.ProcessEnv = process.env): { speed?: 'fast' } {
  return env.CLAUDE_FAST_MODE === '1' ? { speed: 'fast' } : {};
}
