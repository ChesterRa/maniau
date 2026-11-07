// 実際の見本の家族で、場面の案内が「きょう」にあるボタンを日英とも指す。
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DemoBar } from '../src/App';
import i18n from '../src/i18n';
import { TodayScreen } from '../src/screens';
import { ctxFor } from './ctx';

it.each([
  ['ja', '場面のはじめ', '子どもの見守り方を選ぶ'],
  ['en', 'At the start', 'Choose how to arrange care'],
] as const)('お知らせが届いた場面の案内は実際のボタンを指す（%s）', async (lang, lead, label) => {
  const browser = new Window({ url: 'http://localhost/' });
  await i18n.changeLanguage(lang);
  try {
    browser.document.body.innerHTML = renderToStaticMarkup(
      <>
        <DemoBar
          stages={['arrived']}
          stage="arrived"
          onStage={() => {}}
          adults={[{ value: 'a', label: '健太' }]}
          member="a"
          onMember={() => {}}
          lang={lang}
          onLang={() => {}}
          clock={undefined}
          onRestart={() => {}}
          onAdvance={undefined}
        />
        <TodayScreen ctx={ctxFor('arrived', 'a', lang)} />
      </>,
    );
    const guide = [...browser.document.querySelectorAll('p')].find((p) =>
      p.textContent?.includes(lead),
    );
    const action = [...browser.document.querySelectorAll('button')].find(
      (b) => b.textContent === label,
    );
    expect(action).toBeDefined();
    expect(guide?.textContent).toContain(label);
  } finally {
    await i18n.changeLanguage('ja');
    browser.happyDOM.abort();
  }
});
