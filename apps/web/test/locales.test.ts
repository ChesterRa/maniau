// 画面の文言のキーが、日本語と英語の両方にあるか（無いと、キーがそのまま画面に出る）。
import { readdirSync, readFileSync } from 'node:fs';
import { ExternalKind } from '@maniau/core';
import { describe, expect, it } from 'vitest';
import { DEMO_STAGES } from '../../server/src/demo';
import type { Notice } from '../src/family';
import en from '../src/locales/en.json';
import ja from '../src/locales/ja.json';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [path] : flatten(value, path);
  });
}

// 数で変わる形（_one・_other）は、元のキーにまとめる。
const base = (key: string) => key.replace(/_(one|other)$/, '');
const keysOf = (tree: Tree) => new Set(flatten(tree).map(base));
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('文言のキー', () => {
  const jaKeys = keysOf(ja);
  const enKeys = keysOf(en);

  it('日本語と英語で、同じキーを持つ', () => {
    expect([...jaKeys].filter((k) => !enKeys.has(k))).toEqual([]);
    expect([...enKeys].filter((k) => !jaKeys.has(k))).toEqual([]);
  });

  it('画面の中に書いたキーは、全部ある', () => {
    const top = new Set(Object.keys(ja));
    const used = new Set<string>();
    for (const file of readdirSync(new URL('../src/', import.meta.url))) {
      if (!file.endsWith('.tsx')) continue;
      // t( の最初の引数に書いたキー（三項の両方も含む）。比べるための文字列は数えない。
      for (const [, argument] of read(`../src/${file}`).matchAll(/\bt\(([^,)]*)/g)) {
        for (const [, key] of (argument ?? '').matchAll(/'([a-z]+(?:\.[a-zA-Z0-9]+)+)'/g)) {
          if (key && top.has(key.split('.')[0] ?? '')) used.add(key);
        }
      }
    }
    expect(used.size).toBeGreaterThan(50);
    expect([...used].filter((k) => !jaKeys.has(k))).toEqual([]);
  });

  it('組み立てて使うキー（外の相手の種類・知らせ・デモの段）も、全部ある', () => {
    const notices: Notice[] = ['changed', 'refused', 'expired', 'uncertain'];
    const needed = [
      ...ExternalKind.options.map((kind) => `card.proposal.external.${kind}`),
      ...notices.map((notice) => `notice.${notice}`),
      ...DEMO_STAGES.map((stage) => `demo.stages.${stage.id}`),
    ];
    expect(needed.filter((k) => !jaKeys.has(k))).toEqual([]);
  });

  it('家庭の決まりとエンジンが使う案・作業の名前のキーも、全部ある', () => {
    const household = read('../../../data/demo/household.json');
    const titleKeys = new Set(
      [...household.matchAll(/"titleKey":\s*"([^"]+)"/g)].map(([, key]) => key ?? ''),
    );
    const engine = new URL('../../../packages/core/src/engine/', import.meta.url);
    for (const file of readdirSync(engine)) {
      const text = readFileSync(new URL(file, engine), 'utf8');
      for (const [, key] of text.matchAll(/titleKey: '([^']+)'/g)) titleKeys.add(key ?? '');
    }
    const needed = [...titleKeys].flatMap((key) =>
      key.startsWith('option.') ? [`${key}.title`] : [key],
    );
    expect(needed.length).toBeGreaterThan(5);
    expect(needed.filter((k) => !jaKeys.has(k))).toEqual([]);
  });
});
