// デモの回数の上限の言い方：お知らせ・写真の書き起こし・一言・やり方の案・周りの調べは、この試用（デモ）の分と、サーバー
// 全体の一日（UTC）の分を、同じ知らせ（上限）で断る。どちらで断られたかは分からないので、この試用の数を使い切ったと言い
// 切らず、両方の戻り方を言う。同じ文を、初めの画面から始めた試用と用意した場面の両方で出すので、片方にしか無いボタンの
// 名前を挙げない（「やり直す」は用意した場面の帯にだけあり、試用の操作には無い）。お知らせと一言は、送る量（前の記録を
// 含む）が多すぎる時も同じ知らせで断る。
import { describe, expect, it } from 'vitest';
import i18n from '../src/i18n';

/** サーバー全体の一日の上限と同じ知らせで断られる物の、上限の文。 */
const SHARED = [
  'input.limit',
  'input.photoStatus.limit',
  'say.limit',
  'wayIdeas.limit',
  'resources.survey.limit',
];

describe('デモの上限の言い方', () => {
  it.each([
    [
      'ja',
      'この試用・デモの分は、新しく始めると戻ります（今の記録は移りません）。',
      'サーバー全体の分は、翌日（UTC）に戻ります。',
    ],
    [
      'en',
      'The limit for this trial or demo resets when you start a new one (what you’ve entered won’t carry over).',
      'The server-wide limit resets the next day (UTC).',
    ],
  ] as const)(
    '%s：両方の戻り方を言い、用意した場面にだけあるボタンを挙げない',
    (lang, own, serverWide) => {
      const t = i18n.getFixedT(lang);
      for (const key of SHARED) {
        expect(t(key), key).toContain(own);
        expect(t(key), key).toContain(serverWide);
        expect(t(key), key).not.toContain(t('demo.restart'));
      }
    },
  );

  it('お知らせと一言は、送る量が多すぎる時も同じ知らせで断るので、数を使い切ったとは言わない', () => {
    for (const lang of ['ja', 'en'] as const) {
      const t = i18n.getFixedT(lang);
      for (const key of ['input.limit', 'say.limit']) {
        expect(t(key), key).toMatch(
          lang === 'ja' ? /^読み取りの上限に達しました。/ : /^A reading limit was reached\./,
        );
      }
    }
  });
});
