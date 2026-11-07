// 「この変更で変わること」で、行き先までの道のりを確かめられない点は、数ではなく何かを言う（例：家の店を架空の
// 店に替えると、その店までの道のりは測っていない）。ほかの決まりは、今までどおり数だけ言う。
import { describe, expect, it } from 'vitest';
import { householdPreviewLines } from '../src/household';
import { ctxFor } from './ctx';

const emptyChanges = {
  added: [],
  removed: [],
  moved: [],
  unplaced: [],
  placed: [],
  reassigned: [],
  changed: [],
  relocated: [],
  reconfirm: [],
  released: [],
  cancels: [],
  checks: [],
  deadlines: [],
  windows: [],
  conflicts: [],
  rechoose: [],
};

const preview = (unverified: string[]) => ({
  changes: emptyChanges,
  issues: [],
  unverified,
  seen: 'x',
  throughSeq: 1,
});

describe('道のりを確かめられない点', () => {
  it('道のりだけなら、何かを言い、数の行は出さない（日英）', () => {
    const ja = householdPreviewLines(ctxFor('asked', 'a', 'ja'), preview(['route_is_estimate']));
    expect(ja).toEqual([
      '計画は変わりません。',
      '行き先までの道のりは確かめていません（時刻は目安です）。',
    ]);
    const en = householdPreviewLines(ctxFor('asked', 'a', 'en'), preview(['route_is_estimate']));
    expect(en).toEqual([
      "The plan doesn't change.",
      'The route to a place hasn’t been checked (times are estimates).',
    ]);
  });

  it('道のりの決まりが二つでも一行。ほかの決まりは、その数で残す', () => {
    const ja = householdPreviewLines(
      ctxFor('asked', 'a', 'ja'),
      preview(['route_is_estimate', 'route_unconfirmed', 'required_arrangement_missing']),
    );
    expect(ja).toEqual([
      '計画は変わりません。',
      '行き先までの道のりは確かめていません（時刻は目安です）。',
      '必要な子の見守りが手配できているか、1件確かめられません。「きょう」で見守りの予定を確認してください。',
    ]);
  });

  it('ほかの未判定も隠さず、差分が無いことと、確認できなかった意味・次の確認を伝える（日英）', () => {
    const codes = ['required_arrangement_missing', 'other_unverified'];
    const ja = householdPreviewLines(ctxFor('asked', 'b', 'ja'), preview(codes));
    expect(ja[0]).toBe('計画は変わりません。');
    expect(ja.join(' ')).toContain('必要な子の見守り');
    expect(ja.join(' ')).toContain('詳しい内訳はまだ表示できません');
    expect(ja.join(' ')).toContain('問題がないと確かめられたわけではありません');
    const en = householdPreviewLines(ctxFor('asked', 'b', 'en'), preview(codes));
    expect(en[0]).toBe("The plan doesn't change.");
    expect(en.join(' ')).toContain("couldn't confirm that the child's care is arranged");
    expect(en.join(' ')).toContain("The details aren't shown here yet.");
    expect(en.join(' ')).toContain('does not mean it is known to be correct');
  });
});
