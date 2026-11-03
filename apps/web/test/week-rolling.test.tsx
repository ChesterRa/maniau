// 「よてい」：きょうから七日と、その後の七日を出す（暦の週にしない）。日曜の夜に、終わる週の空の日だけを
// 並べず、次の決め時と要る日が見える。返事を待つ間は、断られた時の次の手が消える決め時も出す。
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WeekScreen } from '../src/screens';
import { ctxFor } from './ctx';

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

it('日曜（11/29、祖母の返事待ち）：きょうから七日に、学童の決め時と発表会、その後に 12/7 を出す', () => {
  const shown = text(renderToStaticMarkup(<WeekScreen ctx={ctxFor('chase', 'b', 'ja')} />));
  expect(shown).toContain('11/29（日） – 12/5（土）');
  // 次に消える手（断られた時に間に合う学童）の決め時。
  expect(shown).toContain('学童に預けるの決め時');
  expect(shown).toContain('学習発表会（学習発表会の実施日が12/5（土）なら）');
  // その後の七日に、12/7 の振替休業日。
  const later = shown.slice(shown.indexOf('その後の7日'));
  expect(later).toContain('振替休業日（学習発表会の実施日が12/5（土）なら）');
  // 終わった週の日（11/23〜11/28）は出さない。
  expect(shown).not.toContain('11/23');
});

it('平日でも、きょうから始める（英語も同じ）', () => {
  const ja = text(renderToStaticMarkup(<WeekScreen ctx={ctxFor('arrived', 'b', 'ja')} />));
  expect(ja).toContain('11/25（水） – 12/1（火）');
  const en = text(renderToStaticMarkup(<WeekScreen ctx={ctxFor('arrived', 'b', 'en')} />));
  expect(en).toContain('The 7 days after');
  expect(en).not.toContain('Next week');
});
