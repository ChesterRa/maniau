// @vitest-environment happy-dom
// デモの時計：画面の上のデモの操作から進められる（戻せない）。決め時の前後で、札と知らせがどう変わるかを試すため。
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { DemoBar } from '../src/App';
import '../src/i18n';
import { step } from './fake-fetch';

const props = {
  stages: ['arrived'],
  stage: 'arrived',
  onStage: () => {},
  adults: [{ value: 'a', label: '健太' }],
  member: 'a',
  onMember: () => {},
  lang: 'ja' as const,
  onLang: () => {},
  clock: '11/26（木）12:10',
  onRestart: () => {},
};

it('「+1時間」「+1日」で、その分だけ進める', async () => {
  const advanced: number[] = [];
  const host = document.createElement('div');
  const root = createRoot(host);
  await step(() => root.render(<DemoBar {...props} onAdvance={(m) => advanced.push(m)} />));
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === label);
  await step(() => button('+1時間')?.click());
  await step(() => button('+1日')?.click());
  expect(advanced).toEqual([60, 24 * 60]);
  // 画面がまだ読めていない時は、進めるボタンを出さない。
  await step(() => root.render(<DemoBar {...props} onAdvance={undefined} />));
  expect(button('+1日')).toBeUndefined();
  await step(() => root.unmount());
});

it('場面ごとの見どころを、日本語と英語で一行出す', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  for (const stage of ['arrived', 'asked', 'chase', 'backup', 'postponed']) {
    await step(() =>
      root.render(<DemoBar {...props} stages={[stage]} stage={stage} onAdvance={undefined} />),
    );
    expect(host.textContent).not.toMatch(/demo\.guide/);
    // 用意した状態の説明だと示す（操作や時計を進めると、画面の方が変わる）。
    expect(host.textContent).toContain('場面のはじめ');
  }
  await step(() =>
    root.render(<DemoBar {...props} stages={['chase']} stage="chase" onAdvance={undefined} />),
  );
  expect(host.textContent).toContain('「断られたら？」で、断られた時の計算を見られます');
  // 「断られたら？」は頼んだ人（彩）にだけ出るので、どちらの画面かを書く。
  expect(host.textContent).toContain('彩の画面');
  await step(() =>
    root.render(<DemoBar {...props} stages={['backup']} stage="backup" onAdvance={undefined} />),
  );
  expect(host.textContent).toContain('彩の画面');
  await step(() => root.unmount());
});
