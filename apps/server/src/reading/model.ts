// 製品の Claude の呼び出し（お知らせの読み取り・写真の書き起こし・一言・やり方の案）の、モデル・思考の強さ・速さ。
// 家族は画面で答えを待つので、いちばん強いモデルを速いモードで呼ぶ（作り手の指示 2026-11-04：費用より、読みの
// 確かさと速さ。01-model §10）。

/** 製品の呼び出しのモデル。 */
export const PRODUCT_MODEL = 'claude-opus-5-5';

/** 思考の強さ。Opus 5.5 は思考を切れず、初期値も medium だが、呼び出しごとに明示する。 */
export const PRODUCT_EFFORT = 'medium' as const;

/**
 * 速いモード（出力の速さが上がる。料金は標準の 2 倍）。Opus 5.5 は本文の speed
 * だけでよい（beta の頭は要らない。公式の文書と、2026-11-04 の一回の呼び出しで usage.speed が fast だったことで
 * 確かめた）。速いモードで答えたかは、応答の usage.speed で分かる。
 */
export const FAST_SPEED = 'fast' as const;
