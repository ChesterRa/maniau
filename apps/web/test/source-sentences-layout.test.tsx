import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourcesScreen } from '../src/screens';
import { ctxFor } from './ctx';

describe('お知らせの原文と読み取りの印', () => {
  it.each(['ja', 'en'] as const)(
    '原文の各文を残し、確かめる印と読み取った日付をその下に出す (%s)',
    (lang) => {
      const ctx = ctxFor('arrived', 'b', lang);
      const source = ctx.sources.get('n1');
      const reading = ctx.readings.find((item) => item.sourceId === 'n1');
      const sentence = source?.sentences.find((item) => item.id === 'n1#6');
      if (!source || !reading || !sentence) throw new Error('原文か読み取りが無い');
      const checked = {
        ...ctx,
        readings: ctx.readings.map((item) =>
          item.sourceId === source.id ? { ...item, check: [sentence.id] } : item,
        ),
      };
      const root = new Window().document.createElement('div');
      root.innerHTML = renderToStaticMarkup(
        <SourcesScreen ctx={checked} sourceId={source.id} highlight={[sentence.id]} />,
      );
      const paragraphs = [...root.querySelectorAll('p')];
      for (const original of source.sentences) {
        expect(paragraphs.some((p) => p.textContent === original.text)).toBe(true);
      }
      const original = paragraphs.find((p) => p.textContent === sentence.text);
      expect(original?.parentElement?.className).toContain('bg-bag');
      expect(original?.parentElement?.className).toContain('border-warn');
      expect(original?.nextElementSibling?.textContent).toContain(
        lang === 'ja' ? '要確認' : 'Check',
      );
      expect(original?.nextElementSibling?.textContent).toContain(
        lang === 'ja' ? '12/5（土）' : 'Sat 12/5',
      );
      expect(original?.textContent).not.toContain(lang === 'ja' ? '要確認' : 'Check');
      const unread = paragraphs.find((p) => p.textContent === source.sentences[0]?.text);
      expect(unread?.nextElementSibling?.textContent).toBe('');
    },
  );
});
