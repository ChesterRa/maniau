// 「うち」の「周りの資源」と、案の前もっての前提（事前の登録など）の書き方。済んでいるかは家族が確かめて入れる物で、
// 確かめていなければ「分からない」と書き、お勧めしない訳を出す。出典がデモの架空の決まりなら、本当の頁ではないと
// 書く。

import type { HouseholdPreview } from '@maniau/core';
import { computePlan, foldEvents } from '@maniau/core/engine';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../server/src/commands';
import { demoEvents } from '../../server/src/demo';
import { previewChange } from '../../server/src/preview';
import { memoryStore } from '../../server/src/store';
import { HouseholdScreen, householdPreviewLines } from '../src/household';
import { preparationGapText } from '../src/screens';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('周りの資源', () => {
  it('「うち」に、資源と出典、前もっての登録の状態・だれの分・使うやり方を出す', () => {
    const shown = text(renderToStaticMarkup(<HouseholdScreen ctx={ctxFor('chase', 'b', 'ja')} />));
    expect(shown).toContain('周りの資源');
    expect(shown).toContain('みらい橋病児保育室（架空）');
    expect(shown).toContain('出典：デモのための架空の決まり（本当の頁ではありません）');
    expect(shown).toContain('前もって：病児保育の事前登録');
    expect(shown).toContain('陽菜の分');
    expect(shown).toContain('済んでいるか分かりません');
    expect(shown).toContain('使うやり方：病児保育に預ける');
    expect(shown).toContain('何日前までに済ませるかは確かめていません（早めに確かめてください）');
  });

  it('英語でも同じことを出す', () => {
    const shown = text(renderToStaticMarkup(<HouseholdScreen ctx={ctxFor('chase', 'b', 'en')} />));
    expect(shown).toContain('Around us');
    expect(shown).toContain('Source: a made-up rule for the demo (not a real page)');
    expect(shown).toContain('For 陽菜');
    expect(shown).toContain('Not known whether it’s done');
  });

  it('案の前もっての前提：家族が確かめた日数があれば目安の日、無ければ早めに確かめる', () => {
    const ctx = ctxFor('chase', 'b', 'ja');
    expect(preparationGapText(ctx, { preparationId: 'prep-sick-care', state: 'unknown' })).toBe(
      '病児保育の事前登録：済んでいるか分かりません。使う前に、早めに確かめてください。',
    );
    expect(
      preparationGapText(ctx, {
        preparationId: 'prep-sick-care',
        state: 'notDone',
        by: '2026-12-01',
      }),
    ).toContain('病児保育の事前登録：まだです。12/1（火） までに済ませておく目安です');
    expect(
      preparationGapText(ctxFor('chase', 'b', 'en'), {
        preparationId: 'prep-sick-care',
        state: 'otherPerson',
      }),
    ).toBe(
      '病児保育の事前登録: it’s for someone else, not this person. Check it early, before you need it.',
    );
  });

  it('「この変更で変わること」に、前もっての印・「使わない」の印・勧める手の変化を書く', () => {
    const ctx = ctxFor('chase', 'b', 'ja');
    const empty = {
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
    const preview = {
      changes: {
        ...empty,
        preparations: [
          {
            arrangementKey: 'arr:need:x',
            optionKey: 'opt:x:way-sick-care',
            templateId: 'way-sick-care',
            before: [{ preparationId: 'prep-sick-care', state: 'unknown' }],
            after: [],
          },
        ],
        unusedResources: [
          {
            arrangementKey: 'arr:need:x',
            optionKey: 'opt:x:way-sick-care',
            templateId: 'way-sick-care',
            before: [],
            after: ['res-sick-care'],
          },
        ],
        recommendations: [
          {
            arrangementKey: 'arr:need:x',
            kind: 'need',
            what: '家で見る',
            after: { optionKey: 'opt:x:way-grandma', templateId: 'way-grandma' },
          },
        ],
      },
      issues: [],
      unverified: [],
      seen: 's',
      throughSeq: 1,
    } as unknown as HouseholdPreview;
    const lines = householdPreviewLines(ctx, preview);
    expect(
      lines.some((l) => l.includes('前もって済ませる事（病児保育の事前登録）の印が消えます')),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.includes('「使わない」とした所（みらい橋病児保育室（架空））を使う手になります'),
      ),
    ).toBe(true);
    expect(lines).toContain('「家で見る」：「祖母に来てもらう」をお勧めするようになります。');
    // 今の計画に無い手も、やり方の名前で書く（「ある手」にしない）。
    expect(lines.join('\n')).not.toContain('ある手');
  });

  it('「すること」に初めてやり方を選ぶ時、新しく選べる手を、やり方の名前と日で書く（日英。正式の命令と計算）', async () => {
    const now = '2026-11-26T20:00+09:00';
    const store = memoryStore(new Map([['demo', demoEvents('arrived')]]));
    const events = () => store.withHousehold('demo', (log) => [...log.events()]);
    const stated = {
      type: 'stateNeed',
      text: '架空の依頼',
      interpretation: {
        what: '家で見る',
        shape: 'window',
        date: '2026-12-02',
        startTime: '09:00',
        endTime: '17:00',
        forMemberId: 'c',
      },
    } as const;
    const prior = previewChange(await events(), { memberId: 'b', now }, stated);
    if ('reason' in prior) throw new Error(prior.reason);
    const result = await runCommand(
      store,
      'demo',
      { memberId: 'b', now, operationId: 'name-new-ways', demo: true },
      { ...stated, seen: { throughSeq: prior.throughSeq, changes: prior.seen } },
    );
    expect(result.status).toBe('ok');
    const all = await events();
    const plan = computePlan(all, now);
    const household = foldEvents(all).household;
    if (!household) throw new Error('家の情報が無い');
    const itemId = plan.requirements.find((r) => r.kind === 'need' && r.live)?.basis.itemIds[0];
    if (!itemId) throw new Error('「すること」が無い');
    // 今の計画のこの手配には、まだ手が無い（どちらの手も、今の計画に無い）。
    const arrangement = plan.arrangements.find((a) => a.kind === 'need' && a.live);
    expect(arrangement?.options).toEqual([]);
    const shown = previewChange(
      all,
      { memberId: 'b', now },
      { type: 'setNeedWays', itemId, wayIds: ['way-sick-care', 'way-grandma'] },
    );
    if ('reason' in shown) throw new Error(shown.reason);
    const ja = householdPreviewLines({ ...ctxFor('arrived', 'b', 'ja'), household, plan }, shown);
    expect(ja).toContain('「12/2（水）の病児保育に預ける」が、選べる手に入ります。');
    expect(ja).toContain('「12/2（水）の祖母に来てもらう」が、選べる手に入ります。');
    expect(
      ja.some((l) =>
        l.startsWith('「12/2（水）の病児保育に預ける」：前もって済ませる事（病児保育の事前登録）'),
      ),
    ).toBe(true);
    expect(ja.join('\n')).not.toContain('ある手');
    const en = householdPreviewLines({ ...ctxFor('arrived', 'b', 'en'), household, plan }, shown);
    expect(
      en.some((l) => l.includes('病児保育に預ける') && l.includes('would become an option')),
    ).toBe(true);
    expect(
      en.some((l) => l.includes('祖母に来てもらう') && l.includes('would become an option')),
    ).toBe(true);
    expect(en.join('\n')).not.toContain('a way');
  });

  it('子の居場所の手配の勧める手が替わる時も、主語を書く（空の主語にしない。日英）', () => {
    const events = demoEvents('arrived');
    const household = foldEvents(events).household;
    if (!household) throw new Error('家の情報が無い');
    const next = structuredClone(household);
    const gakudo = next.careOptions.find((o) => o.id === 'opt-gakudo');
    if (!gakudo) throw new Error('学童の手が無い');
    gakudo.cost.yen = 100000;
    const preview = previewChange(
      events,
      { memberId: 'b', now: '2026-11-25T19:30+09:00' },
      { type: 'updateHousehold', household: next },
    );
    if ('reason' in preview) throw new Error(preview.reason);
    expect(preview.changes.recommendations.length).toBeGreaterThan(0);
    const ja = householdPreviewLines(ctxFor('arrived', 'b', 'ja'), preview).filter((l) =>
      l.includes('勧め'),
    );
    expect(ja.length).toBeGreaterThan(0);
    for (const line of ja) {
      expect(line).toMatch(/^陽菜の居場所の手配：/);
    }
    const en = householdPreviewLines(ctxFor('arrived', 'b', 'en'), preview).filter((l) =>
      l.includes('recommended'),
    );
    expect(en.length).toBeGreaterThan(0);
    for (const line of en) {
      expect(line).toContain('for care for 陽菜');
      expect(line).not.toMatch(/^:/);
    }
  });
});
