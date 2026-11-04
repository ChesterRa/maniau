// @vitest-environment happy-dom
// 「うち」の「周りの資源」で、家の店の扱い（家族の好み）を選ぶ（02-foundation §3.5）。扱いを決めていない店にも選べ、
// 選ぶと店の資源（ID は店から、名前は店の名前、分かった事は無し）を足した家の情報で「この変更で変わること」を見る。
// 架空のデモの家。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Household } from '@maniau/core';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import i18n from '../src/i18n';
import { ResourcesCard } from '../src/resources';
import type { Ctx } from '../src/screens';
import { step } from './fake-fetch';

const household = Household.parse(
  JSON.parse(readFileSync(resolve(process.cwd(), '../../data/demo/household.json'), 'utf8')),
);
const B = 'store-kids-toyosu';
const t = i18n.getFixedT('ja');

describe('「周りの資源」の店の扱い', () => {
  it('扱いを決めていない店にも扱いを選べ、選ぶと店の資源を足した家の情報で変わることを見る', async () => {
    const looked: Household[] = [];
    const ctx = {
      lang: 'ja',
      tz: 'Asia/Tokyo',
      now: '2026-11-25T20:05+09:00',
      me: household.members[1],
      household,
      t,
      send: async () => ({ status: 'ok' }),
      previewHousehold: async (next: Household) => {
        looked.push(next);
        return undefined;
      },
      go: () => {},
    } as unknown as Ctx;
    const host = document.createElement('div');
    const root = createRoot(host);
    await step(() => root.render(<ResourcesCard ctx={ctx} />));
    const names = '豊洲駅の近くのスーパー・豊洲駅の近くの子ども服の店（架空）';
    expect(host.textContent).toContain(t('resources.stores.hint', { names }));
    const press = async (label: string, index = 0) => {
      const button = [...host.querySelectorAll('button')].filter((b) => b.textContent === label)[
        index
      ];
      if (!button) throw new Error(`押す物が無い：${label}`);
      await step(() => button.click());
    };
    await press(t('household.edit'));
    expect(host.textContent).toContain(t('resources.stores.kind'));
    // 扱いを決めた資源（病児保育室・店 A）の後に、扱いを決めていない店が並ぶ。最後の店が B。
    const usual = [...host.querySelectorAll('button')].filter(
      (b) => b.textContent === t('resources.use.choice.usual'),
    );
    const forB = usual.at(-1);
    if (!forB) throw new Error('店 B の「いつも使う」が無い');
    await step(() => forB.click());
    await press(t('household.look'));
    expect(looked.at(-1)?.resources.find((r) => r.placeId === B)).toEqual({
      id: `res-store-${B}`,
      kind: 'store',
      name: '豊洲駅の近くの子ども服の店（架空）',
      placeId: B,
      notes: [],
      use: 'usual',
    });
    root.unmount();
  });
});
