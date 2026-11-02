import { describe, expect, it } from 'vitest';
import { type ExtractionOutput, toExtraction } from '../src';
import { notice1, notice2 } from './fixtures/demo';

// 手で書いたモデルの出力の形（モデルの出力ではない）。検査のコードの試験に使う。
const item = (
  over: Partial<ExtractionOutput['items'][number]> & Pick<ExtractionOutput['items'][number], 'id'>,
): ExtractionOutput['items'][number] => ({
  sentenceIds: [],
  kind: 'schoolEvent',
  written: '',
  date: null,
  writtenWeekday: 'none',
  startTime: null,
  endTime: null,
  what: null,
  dayType: null,
  deadline: null,
  audience: null,
  conditionNodeId: null,
  inferred: false,
  effects: [],
  ...over,
});

const output1: ExtractionOutput = {
  unknowns: [
    {
      id: 'u-date',
      label: '学習発表会の実施日',
      values: ['2026-12-05', '2026-12-08'],
      kind: 'schedule',
    },
  ],
  conditions: [
    { id: 'c5', kind: 'eq', unknownId: 'u-date', value: '2026-12-05', childIds: [] },
    { id: 'c8', kind: 'eq', unknownId: 'u-date', value: '2026-12-08', childIds: [] },
  ],
  items: [
    item({
      id: 'i1',
      sentenceIds: ['n1#6'],
      written: '12月5日(土)に学習発表会を行います。',
      date: '2026-12-05',
      writtenWeekday: 'sat',
      what: '学習発表会',
      conditionNodeId: 'c5',
    }),
    item({
      id: 'i2',
      sentenceIds: ['n1#7'],
      written: '1年生の発表は9時20分からです。',
      startTime: '09:20',
      audience: '1年生',
    }),
    item({
      id: 'i3',
      sentenceIds: ['n1#8'],
      kind: 'belongings',
      written: '衣装として、白い長袖シャツを用意してください。',
      what: '白い長袖シャツ',
    }),
    item({
      id: 'i4',
      sentenceIds: ['n1#9'],
      kind: 'dayChange',
      written: '5日(土)に行った場合、12月7日(月)は振替休業日です。',
      date: '2026-12-07',
      writtenWeekday: 'mon',
      dayType: 'noSchool',
      conditionNodeId: 'c5',
    }),
    item({
      id: 'i5',
      sentenceIds: ['n1#10'],
      written: '感染症の流行状況により延期する場合は、12月8日(火)に行います。',
      date: '2026-12-08',
      writtenWeekday: 'tue',
      conditionNodeId: 'c8',
    }),
    item({
      id: 'i6',
      sentenceIds: ['n1#11'],
      kind: 'dayChange',
      written: '延期した場合、7日(月)は通常授業とします。',
      date: '2026-12-07',
      writtenWeekday: 'mon',
      dayType: 'normalSchool',
      conditionNodeId: 'c8',
    }),
    item({
      id: 'i7',
      sentenceIds: ['n1#12'],
      kind: 'contact',
      written: 'ご不明な点は、担任までお問い合わせください。',
      what: '担任',
    }),
  ],
  irrelevantSentenceIds: ['n1#1', 'n1#2', 'n1#3', 'n1#4', 'n1#5'],
  ambiguities: [],
};

describe('読み取りの検査', () => {
  it('正しい形は、出典の ID を前に付けて通す', () => {
    const { extraction, issues } = toExtraction(output1, notice1, {
      priorItems: [],
      priorUnknowns: [],
    });
    expect(issues).toEqual([]);
    expect(extraction.items.map((i) => i.id)).toEqual([
      'n1:i1',
      'n1:i2',
      'n1:i3',
      'n1:i4',
      'n1:i5',
      'n1:i6',
      'n1:i7',
    ]);
    expect(extraction.items[3]?.conditionNodeId).toBe('n1:c5');
    expect(extraction.conditions[0]).toEqual({
      id: 'n1:c5',
      kind: 'eq',
      unknownId: 'n1:u-date',
      value: '2026-12-05',
    });
  });

  it('使えない節点を子に持つ式は、祖先まで使わず、その式に従う事項を外して知らせる', () => {
    const output: ExtractionOutput = {
      ...output1,
      conditions: [
        ...output1.conditions,
        { id: 'b1', kind: 'eq', unknownId: 'u-date', value: null, childIds: [] },
        { id: 'b2', kind: 'not', unknownId: null, value: null, childIds: ['b1'] },
        { id: 'b3', kind: 'or', unknownId: null, value: null, childIds: ['b2', 'c5'] },
      ],
      items: output1.items.map((i) => (i.id === 'i4' ? { ...i, conditionNodeId: 'b3' } : i)),
    };
    const { extraction, issues } = toExtraction(output, notice1, {
      priorItems: [],
      priorUnknowns: [],
    });
    const bad = issues.filter((i) => i.problem === 'badCondition').map((i) => i.ref);
    expect(bad).toEqual(expect.arrayContaining(['n1:b1', 'n1:b2', 'n1:b3', 'n1:i4']));
    expect(extraction.conditions.map((c) => c.id)).toEqual(['n1:c5', 'n1:c8']);
    expect(extraction.items.map((i) => i.id)).not.toContain('n1:i4');
  });

  it('日付と曜日が食い違えば「食い違い」にし、無い文を指せば外し、残った文を知らせる', () => {
    const broken: ExtractionOutput = {
      ...output1,
      items: [
        item({ ...output1.items[3], id: 'i4', writtenWeekday: 'tue' }),
        item({ id: 'x', sentenceIds: ['n1#99'], written: '無い文' }),
      ],
    };
    const { extraction, issues } = toExtraction(broken, notice1, {
      priorItems: [],
      priorUnknowns: [],
    });
    expect(extraction.items.map((i) => [i.id, i.evidence])).toEqual([['n1:i4', 'conflicting']]);
    const problems = issues.map((i) => i.problem);
    expect(problems).toContain('weekdayMismatch');
    expect(problems).toContain('unknownSentence');
    expect(issues.filter((i) => i.problem === 'uncoveredSentence').map((i) => i.ref)).toContain(
      'n1#6',
    );
  });

  it('変更の連絡：前の未定の値を決め、前の事項を置き換える。無い事項を指す作用は外す', () => {
    const first = toExtraction(output1, notice1, { priorItems: [], priorUnknowns: [] }).extraction;
    const output2: ExtractionOutput = {
      unknowns: [],
      conditions: [],
      items: [
        item({
          id: 'j1',
          sentenceIds: ['n2#5'],
          written: '感染症の流行のため、学習発表会は12月8日(火)に行います。',
          date: '2026-12-08',
          writtenWeekday: 'tue',
          effects: [
            { type: 'resolveUnknown', unknownId: 'n1:u-date', value: '2026-12-08', itemId: null },
          ],
        }),
        item({
          id: 'j2',
          sentenceIds: ['n2#6'],
          kind: 'dayChange',
          written: '12月7日(月)は通常授業です。',
          date: '2026-12-07',
          writtenWeekday: 'mon',
          dayType: 'normalSchool',
          effects: [{ type: 'replace', unknownId: null, value: null, itemId: 'n1:i6' }],
        }),
        item({
          id: 'j3',
          sentenceIds: ['n2#7'],
          kind: 'belongings',
          written: '衣装は、先日のお知らせのとおりご用意ください。',
          what: '白い長袖シャツ',
          effects: [{ type: 'replace', unknownId: null, value: null, itemId: 'n1:i404' }],
        }),
      ],
      irrelevantSentenceIds: ['n2#1', 'n2#2', 'n2#3', 'n2#4'],
      ambiguities: [],
    };
    const { extraction, issues } = toExtraction(output2, notice2, {
      priorItems: first.items,
      priorUnknowns: first.unknowns,
    });
    expect(extraction.items.map((i) => i.id)).toEqual(['n2:j1', 'n2:j2']);
    expect(extraction.items[0]?.effects).toEqual([
      { type: 'resolveUnknown', unknownId: 'n1:u-date', value: '2026-12-08' },
    ]);
    expect(issues.map((i) => [i.problem, i.ref])).toEqual([
      ['unknownEffectTarget', 'n2:j3'],
      ['uncoveredSentence', 'n2#7'],
    ]);
  });
});
