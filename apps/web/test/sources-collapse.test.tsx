// 長いお知らせ（学校だよりの表など）の画面：読み終えた後は、たたんで「きょうを見る」と読み取った事項の名から
// 始める。確かめてほしい文の知らせは、たたんでいても出す。元の文を指して開いた時は全文を開く。短いお知らせと、
// 確かめる札・直す画面の元の文の始め方も確かめる。
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { type Ctx, NoticeText, SourcesScreen } from '../src/screens';
import { ctxFor } from './ctx';

/** 見本の家族の一つ目のお知らせに、架空の文を足して長くする（count 文）。 */
function longCtx(
  count: number,
  check: string[] = [],
): { ctx: Ctx; sourceId: string; first: string } {
  const base = ctxFor('arrived', 'b', 'ja');
  const [entry] = base.items;
  if (!entry) throw new Error('事項が無い');
  const sourceId = entry.item.sourceId;
  const source = base.sources.get(sourceId);
  if (!source) throw new Error('お知らせが無い');
  const extra = Array.from({ length: count - source.sentences.length }, (_, i) => ({
    id: `${sourceId}:x${i + 1}`,
    text: `架空の追加の文その${i + 1}です。`,
  }));
  const sentences = [...source.sentences, ...extra];
  const sources = new Map(base.sources);
  sources.set(sourceId, { ...source, sentences });
  const readings = base.readings.map((r) => (r.sourceId === sourceId ? { ...r, check } : r));
  return { ctx: { ...base, sources, readings }, sourceId, first: sentences[0]?.text ?? '' };
}

it('長いお知らせは、たたんで「きょうを見る」と読み取った事項の名から始め、要確認の数はたたんでいても出す', () => {
  const probe = longCtx(30);
  const { ctx, sourceId } = longCtx(30, [`${probe.sourceId}:x3`]);
  const html = renderToStaticMarkup(<SourcesScreen ctx={ctx} sourceId={sourceId} />);
  expect(html).toContain('きょうを見る');
  expect(html).toContain('原文と読み取りを見る（30文）');
  expect(html).toContain('読み取った事項：');
  expect(html).not.toContain('架空の追加の文その10です。');
  // 確かめてほしい文の数は、開かなくても見える。
  expect(html).toContain('1文を確かめてください');
});

it('元の文を指して開いた時は、長いお知らせでも全文を開く', () => {
  const { ctx, sourceId } = longCtx(30);
  const html = renderToStaticMarkup(
    <SourcesScreen ctx={ctx} sourceId={sourceId} highlight={[`${sourceId}:x10`]} />,
  );
  expect(html).toContain('架空の追加の文その10です。');
  expect(html).not.toContain('原文と読み取りを見る（30文）');
});

it('短いお知らせは、今までどおり全文から始める', () => {
  const base = ctxFor('arrived', 'b', 'ja');
  const [entry] = base.items;
  if (!entry) throw new Error('事項が無い');
  const source = base.sources.get(entry.item.sourceId);
  expect(source?.sentences.length ?? 0).toBeLessThanOrEqual(15);
  const html = renderToStaticMarkup(<SourcesScreen ctx={base} sourceId={entry.item.sourceId} />);
  expect(html).toContain(source?.sentences[0]?.text ?? '-');
  expect(html).not.toContain('原文と読み取りを見る');
});

it('元の文：確かめる札（startBrief）の長いお知らせだけ指した文と前後から始め、直す画面は全文から始める', () => {
  const { ctx, sourceId, first } = longCtx(30);
  const source = ctx.sources.get(sourceId);
  const cited = [`${sourceId}:x10`];
  const brief = renderToStaticMarkup(
    <NoticeText source={source} cited={cited} t={ctx.t} startBrief />,
  );
  expect(brief).toContain('架空の追加の文その10です。');
  expect(brief).not.toContain(first);
  // 絞っている事と残りの数は、引用の前に出す。
  expect(brief.indexOf('お知らせの全文を見る')).toBeLessThan(
    brief.indexOf('架空の追加の文その10です。'),
  );
  const full = renderToStaticMarkup(<NoticeText source={source} cited={cited} t={ctx.t} />);
  expect(full).toContain(first);
});

it.each([
  ['ja', '写真・PDFの書き起こしです（元のファイルはアプリに残していません）。'],
  ['en', "Transcribed from a photo or PDF (the original file isn't kept in the app)."],
] as const)('%s：写真・PDF の書き起こしには、引用の前に出どころを示す', (lang, label) => {
  const { ctx, sourceId } = longCtx(30);
  const source = ctx.sources.get(sourceId);
  if (!source) throw new Error('お知らせが無い');
  const t = ctxFor('arrived', 'b', lang).t;
  const cited = [`${sourceId}:x10`];
  for (const startBrief of [true, false]) {
    const photo = renderToStaticMarkup(
      <NoticeText
        source={{ ...source, medium: 'photo' }}
        cited={cited}
        t={t}
        startBrief={startBrief}
      />,
    );
    const text = renderToStaticMarkup(
      <NoticeText
        source={{ ...source, medium: 'text' }}
        cited={cited}
        t={t}
        startBrief={startBrief}
      />,
    );
    const photoText = photo.replaceAll('&#x27;', "'");
    const plainText = text.replaceAll('&#x27;', "'");
    expect(photoText).toContain(label);
    expect(photoText.indexOf(label)).toBeLessThan(photoText.indexOf('<blockquote'));
    expect(plainText).not.toContain(label);
  }
  const sources = new Map(ctx.sources);
  sources.set(sourceId, { ...source, medium: 'photo' });
  const sourceScreen = renderToStaticMarkup(
    <SourcesScreen ctx={{ ...ctx, lang, t, sources }} sourceId={sourceId} highlight={cited} />,
  ).replaceAll('&#x27;', "'");
  expect(sourceScreen).toContain(label);
});

it('元の文：絞った引用は、省いた所に「…」を置き、離れた二つの文を続いた文に見せない', () => {
  const { ctx, sourceId, first } = longCtx(40);
  const source = ctx.sources.get(sourceId);
  const cited = [`${sourceId}:x5`, `${sourceId}:x20`];
  const plain = renderToStaticMarkup(
    <NoticeText source={source} cited={cited} t={ctx.t} startBrief />,
  ).replace(/<[^>]+>/g, '');
  expect(plain).not.toContain(first);
  // 前が省かれ、二つの間も省かれ、後ろも省かれている。
  expect(plain).toContain('…架空の追加の文その4です。');
  expect(plain).toContain('その6です。…架空の追加の文その19です。');
  expect(plain).toMatch(/その21です。…$/);
  // 全文では「…」を置かない。
  const full = renderToStaticMarkup(<NoticeText source={source} cited={cited} t={ctx.t} />);
  expect(full).not.toContain('…');
});

it('一覧：同じ時刻に届いたお知らせは、後に届いた方を先に置いて開く（試しの時計は止まっている）', () => {
  const base = ctxFor('arrived', 'b', 'ja');
  const [older] = base.sources.values();
  if (!older) throw new Error('お知らせが無い');
  const newer = {
    ...older,
    id: 'later',
    sentences: [{ id: 'later:1', text: '架空の後から届いたお知らせです。' }],
  };
  const sources = new Map([
    [older.id, older],
    [newer.id, newer],
  ]);
  const html = renderToStaticMarkup(<SourcesScreen ctx={{ ...base, sources }} />);
  // 後に届いた方が開き、先に届いた方はたたむ。
  expect(html).toContain('架空の後から届いたお知らせです。');
  expect(html).not.toContain(older.sentences[0]?.text ?? '-');
});
