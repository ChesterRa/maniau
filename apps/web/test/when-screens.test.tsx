// いつにするかの候補の画面：デモの段 when・club を、サーバーと同じ見せる物から組んで描く（日英の文言、表の数と印、
// 決め手の人、勧め、決め時、きょうの一行）。
import { Arrangement } from '@maniau/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TodayScreen } from '../src/screens';
import { WhenScreen } from '../src/when';
import { ctxFor } from './ctx';

const RAW_KEY = /\b(when|answerPage|need)\.[a-zA-Z]+/;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const whenKey = (stage: string, member: string, lang: 'ja' | 'en') => {
  const ctx = ctxFor(stage, member, lang);
  const requirement =
    ctx.plan.requirements.find((r) => r.when !== undefined && r.what === 'クラブの練習') ??
    ctx.plan.requirements.find((r) => r.when !== undefined);
  if (!requirement) throw new Error('候補の「すること」が無い');
  return { ctx, key: requirement.key };
};

describe('いつにするかの画面（デモの段）', () => {
  for (const stage of ['when', 'club']) {
    for (const lang of ['ja', 'en'] as const) {
      it(`${stage}・${lang}：鍵のままの文言・埋めていない差し込みを出さない`, () => {
        const { ctx, key } = whenKey(stage, stage === 'club' ? 'a' : 'b', lang);
        for (const page of [
          <WhenScreen key="when" ctx={ctx} requirementKey={key} />,
          <TodayScreen key="today" ctx={ctx} />,
        ]) {
          const shown = text(renderToStaticMarkup(page));
          expect(shown).not.toMatch(RAW_KEY);
          expect(shown).not.toContain('{{');
        }
      });
    }
  }

  it('club：表に人数と印、日ごとの決め手の人、勧めの無い理由、会場の決め時を出す', () => {
    const { ctx, key } = whenKey('club', 'a', 'ja');
    const shown = text(renderToStaticMarkup(<WhenScreen ctx={ctx} requirementKey={key} />));
    expect(shown).toContain('5／8');
    expect(shown).toContain('6／9');
    expect(shown).toContain(
      'この人の答えで、条件を満たすかが変わることがあります：エンドウさん、オカダさん、キムラさん',
    );
    expect(shown).toContain('この人の答えで、条件を満たすかが変わることがあります：コーチ');
    // コーチは「たぶん」：答えてはいるが、「はい」とは確かめられていない。
    expect(shown).toContain('要る人のうち、コーチ は「はい」かどうか、まだ確かめられていません。');
    expect(shown).toContain('勧められる日はありません');
    expect(shown).toContain('地区センターの体育室を予約する：使えます。決め時 12/9（水） 16:50');
    expect(shown).toContain('エンドウさん（たぶん）：午前だけなら');
  });

  it('日を決めても、この「すること」のやり方を選んでいなければ、次にすることを書く（日英）', () => {
    for (const lang of ['ja', 'en'] as const) {
      const { ctx, key } = whenKey('when', 'b', lang);
      // 決めた日があり、この手配のやり方がまだ無い（名前だけの家族で日を決めた時と同じ形）を、見せる物の上で作る。
      // 段 when では日をまだ決めていないので、手配も無い（決めると、その日の手配ができる）。
      const plan = structuredClone(ctx.plan);
      const requirement = plan.requirements.find((r) => r.key === key);
      const candidate = requirement?.when?.candidates[0];
      if (!requirement?.when || !candidate) throw new Error('候補が無い');
      const arrangement = Arrangement.parse({
        key: `arr:need:${key}`,
        requirementKey: key,
        kind: 'need',
        start: candidate.start,
        end: candidate.end,
        status: 'undetermined',
        options: [],
        reasons: [{ code: 'inputMissing', refs: ['ways'] }],
        live: true,
        needShape: 'window',
      });
      plan.arrangements.push(arrangement);
      requirement.when.chosen = {
        candidateId: candidate.id,
        rev: candidate.rev,
        stale: false,
        changes: [],
      };
      const shownFor = (status: 'undetermined' | 'decidable', stale = false) => {
        arrangement.status = status;
        arrangement.reasons =
          status === 'undetermined' ? [{ code: 'inputMissing', refs: ['ways'] }] : [];
        if (requirement.when?.chosen) requirement.when.chosen.stale = stale;
        return text(
          renderToStaticMarkup(<WhenScreen ctx={{ ...ctx, plan }} requirementKey={key} />),
        );
      };
      const next =
        lang === 'ja'
          ? '次は、この日の手配を開いて、やり方（だれが・どうするか）を足すか選びます。'
          : 'Next, open this day’s arrangement and add or choose a way (who does what).';
      expect(shownFor('undetermined')).toContain(next);
      // やり方を選んだ後と、決めた根拠が変わって決め直す時は書かない。
      expect(shownFor('decidable')).not.toContain(next);
      expect(shownFor('undetermined', true)).not.toContain(next);
    }
  });

  it('when：一つだけの日を勧め、きょうに「答えを集めています」の一行を出す', () => {
    const { ctx, key } = whenKey('when', 'b', 'ja');
    const shown = text(renderToStaticMarkup(<WhenScreen ctx={ctx} requirementKey={key} />));
    expect(shown).toContain('答えの条件を満たす日は、ここだけです。');
    // ほかの日（12/12）は、まだ決まらない：一番良いとは言わず、そう添える。
    expect(shown).toContain('ほかに、答えがそろわず、まだ決まらない日があります');
    expect(shown).toContain('近所のサトウさん（たぶん）：2時までなら');
    const today = text(renderToStaticMarkup(<TodayScreen ctx={ctx} />));
    expect(today).toContain('陽菜を見てもらう：答えを集めています（候補 2 つ）');
  });
});
