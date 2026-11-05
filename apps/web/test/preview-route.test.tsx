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
    expect(ja).toEqual(['行き先までの道のりは確かめていません（時刻は目安です）。']);
    const en = householdPreviewLines(ctxFor('asked', 'a', 'en'), preview(['route_is_estimate']));
    expect(en).toEqual(['The route to a place hasn’t been checked (times are estimates).']);
  });

  it('道のりの決まりが二つでも一行。ほかの決まりは、その数で残す', () => {
    const ja = householdPreviewLines(
      ctxFor('asked', 'a', 'ja'),
      preview(['route_is_estimate', 'route_unconfirmed', 'required_arrangement_missing']),
    );
    expect(ja).toEqual([
      '行き先までの道のりは確かめていません（時刻は目安です）。',
      '確かめきれない点が1件あります。',
    ]);
  });
});
