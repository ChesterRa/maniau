import { describe, expect, it } from 'vitest';
import {
  type ExtractionOutput,
  parseStoredExtraction,
  relativeDayBase,
  type Source,
  toExtraction,
  writtenOnProblem,
} from '../src';
import { notice1, notice2 } from './fixtures/demo';

// 手で書いたモデルの出力の形（モデルの出力ではない）。検査のコードの試験に使う。
const item = (
  over: Partial<ExtractionOutput['items'][number]> & Pick<ExtractionOutput['items'][number], 'id'>,
): ExtractionOutput['items'][number] => ({
  sentenceIds: [],
  kind: 'event',
  written: '',
  date: null,
  writtenWeekday: 'none',
  startTime: null,
  endTime: null,
  what: null,
  dayType: null,
  deadline: null,
  audience: null,
  place: null,
  relativeDay: 'none',
  conditionNodeId: null,
  inferred: false,
  familyAction: false,
  shape: 'none',
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

describe('家族に確かめてもらう文', () => {
  const context = { priorItems: [], priorUnknowns: [] };

  it('全部の文が事項か関係ない文になれば無い。外した事項の文は、同じ文の別の事項が残っても出す', () => {
    const clean = toExtraction(output1, notice1, context).extraction;
    expect(clean.checkSentenceIds).toEqual([]);
    expect(clean.checkAll).toBe(false);
    const twoInOne: ExtractionOutput = {
      ...output1,
      items: [
        ...output1.items,
        item({
          id: 'i8',
          sentenceIds: ['n1#8'],
          kind: 'belongings',
          deadline: '2026-13-01T08:00+09:00',
        }),
      ],
    };
    const { extraction, issues } = toExtraction(twoInOne, notice1, context);
    expect(issues.map((i) => i.problem)).toEqual(['badDate']);
    expect(extraction.items.map((i) => i.id)).toContain('n1:i3');
    expect(extraction.checkSentenceIds).toEqual(['n1#8']);
    expect(extraction.checkAll).toBe(false);
  });

  it('書かれた表現が指した文に無ければ「食い違い」にして出す（空白と全角・半角の違いは許す）', () => {
    const invented: ExtractionOutput = {
      ...output1,
      items: [
        ...output1.items,
        item({
          id: 'i9',
          sentenceIds: ['n1#1'],
          kind: 'belongings',
          written: '白い長袖シャツは不要です。',
          effects: [{ type: 'cancel', itemId: 'n0:i1', unknownId: null, value: null }],
        }),
      ],
    };
    const prior = toExtraction(output1, notice1, context).extraction.items[0];
    if (!prior) throw new Error('事項が無い');
    const { extraction, issues } = toExtraction(invented, notice1, {
      priorItems: [{ ...prior, id: 'n0:i1' }],
      priorUnknowns: [],
    });
    expect(issues).toEqual([{ problem: 'quoteMismatch', ref: 'n1:i9' }]);
    expect(extraction.items.find((i) => i.id === 'n1:i9')?.evidence).toBe('conflicting');
    expect(extraction.checkSentenceIds).toEqual(['n1#1']);
    const spaced: ExtractionOutput = {
      ...output1,
      items: output1.items.map((i) =>
        i.id === 'i3' ? { ...i, written: '衣装として、 白い長袖シャツを用意してください' } : i,
      ),
    };
    expect(toExtraction(spaced, notice1, context).issues).toEqual([]);
    // 二つの文にまたがる引用は、モデルが文を逆の順に挙げても、原文の順につないで探す。
    const reversed: ExtractionOutput = {
      ...output1,
      items: output1.items.map((i) =>
        i.id === 'i3'
          ? {
              ...i,
              sentenceIds: ['n1#9', 'n1#8'],
              written: '衣装として、白い長袖シャツを用意してください。5日(土)に行った場合',
            }
          : i,
      ),
    };
    expect(toExtraction(reversed, notice1, context).issues).toEqual([]);
  });

  it('同じ ID の未定の値を二度宣言したら、どちらも使わず、それに頼る事項を外して全体を確かめてもらう', () => {
    const twice: ExtractionOutput = {
      ...output1,
      unknowns: [
        ...output1.unknowns,
        { id: 'u-date', label: '実施するか', values: ['go', 'cancel'], kind: 'schedule' },
      ],
    };
    const { extraction, issues } = toExtraction(twice, notice1, context);
    expect(issues).toContainEqual({ problem: 'duplicateId', ref: 'n1:u-date' });
    expect(extraction.unknowns).toEqual([]);
    // 「12月5日(土)」「延期した場合」の条件に従う事項は使わない。
    expect(extraction.items.map((i) => i.id)).toEqual(['n1:i2', 'n1:i3', 'n1:i7']);
    expect(extraction.checkAll).toBe(true);
  });

  it('文に書かれた日付と合わない日付（曜日の同じ別の週）は「食い違い」にして出す', () => {
    const shifted: ExtractionOutput = {
      ...output1,
      items: output1.items.map((i) => (i.id === 'i1' ? { ...i, date: '2026-12-12' } : i)),
    };
    const { extraction, issues } = toExtraction(shifted, notice1, context);
    expect(issues).toEqual([{ problem: 'dateMismatch', ref: 'n1:i1', detail: '2026-12-12' }]);
    expect(extraction.items.find((i) => i.id === 'n1:i1')?.evidence).toBe('conflicting');
    expect(extraction.checkSentenceIds).toEqual(['n1#6']);
  });

  it('食い違い・事項にならなかった文・二通りに読める文（説明が空でも）を出し、文へ戻せない問題は全体', () => {
    const broken: ExtractionOutput = {
      ...output1,
      items: [
        item({ ...output1.items[3], id: 'i4', writtenWeekday: 'tue' }),
        item({ id: 'x', sentenceIds: ['n1#99'], written: '無い文' }),
      ],
      ambiguities: [{ sentenceId: 'n1#2', note: '' }],
    };
    const { extraction } = toExtraction(broken, notice1, context);
    // n1#9 は食い違い、n1#2 は二通り（関係ない文だが、説明の空の二通りでも出す）、他は事項にならなかった文。
    expect(extraction.checkSentenceIds).toEqual([
      'n1#2',
      'n1#6',
      'n1#7',
      'n1#8',
      'n1#9',
      'n1#10',
      'n1#11',
      'n1#12',
    ]);
    expect(extraction.checkAll).toBe(true);
    // 説明の空の二通りは、説明の一覧に入れない（読み取りは落ちない）。
    expect(extraction.ambiguities).toEqual([]);
  });
});

describe('「あした」「きょう」', () => {
  // 家族が書かれた日（金曜）を入れた連絡。「あした」は、その日から数える。
  const club = {
    id: 'c1',
    version: 1,
    receivedAt: '2026-11-27T18:00+09:00',
    writtenOn: '2026-11-27',
    sender: 'club' as const,
    language: 'ja' as const,
    medium: 'text' as const,
    sentences: [{ id: 'c1#1', text: 'あした（土）はれんしゅうじあいです。' }],
  };
  const output = (writtenWeekday: 'sat' | 'mon'): ExtractionOutput => ({
    items: [
      item({
        id: 'i1',
        sentenceIds: ['c1#1'],
        kind: 'event',
        written: 'あした（土）はれんしゅうじあいです。',
        writtenWeekday,
        relativeDay: 'tomorrow',
        what: '練習試合',
      }),
    ],
    unknowns: [],
    conditions: [],
    irrelevantSentenceIds: [],
    ambiguities: [],
  });

  it('金曜に書かれた習い事の連絡の「あした（土）」は、暦の次の日（土曜）', () => {
    const { extraction, issues } = toExtraction(output('sat'), club, {
      priorItems: [],
      priorUnknowns: [],
    });
    expect(issues).toEqual([]);
    expect(extraction.items[0]?.interpretation).toMatchObject({
      date: '2026-11-28',
      relativeDay: 'tomorrow',
      writtenWeekday: 6,
    });
  });

  it('書かれた曜日と食い違えば、食い違いとして家族に確かめてもらう', () => {
    const { extraction, issues } = toExtraction(output('mon'), club, {
      priorItems: [],
      priorUnknowns: [],
    });
    expect(issues.map((i) => i.problem)).toEqual(['weekdayMismatch']);
    expect(extraction.items[0]?.evidence).toBe('conflicting');
  });
});

describe('「あした」とモデルの日付', () => {
  it('「あした」から決めた日付とモデルの日付が違えば、モデルの日付を取らずに食い違いにする', () => {
    const club = {
      id: 'c2',
      version: 1,
      receivedAt: '2026-11-27T18:00+09:00',
      sender: 'club' as const,
      language: 'ja' as const,
      medium: 'text' as const,
      sentences: [{ id: 'c2#1', text: 'あしたはれんしゅうです。' }],
    };
    const output: ExtractionOutput = {
      items: [
        item({
          id: 'i1',
          sentenceIds: ['c2#1'],
          written: 'あしたはれんしゅうです。',
          relativeDay: 'tomorrow',
          date: '2026-11-30',
          what: '練習',
        }),
      ],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    };
    const { extraction, issues } = toExtraction(output, club, {
      priorItems: [],
      priorUnknowns: [],
    });
    // 書かれた日を入れていない習い事の連絡なので、届いた日から数えた推定でもある。食い違いは推定に下げない。
    expect(issues.map((i) => i.problem)).toEqual(['relativeDayMismatch', 'relativeDayUnanchored']);
    expect(extraction.items[0]?.evidence).toBe('conflicting');
    expect(extraction.items[0]?.interpretation.date).toBe('2026-11-28');
  });
});

describe('お知らせが書かれた日（「あした」の基準）', () => {
  // 11/24（火）の連絡帳を、次の日の夜（11/25）に入れた。
  const TEXT = 'あした、体操服を持ってきてください。';
  const note = (over: Partial<Source> = {}): Source => ({
    id: 'w1',
    version: 1,
    receivedAt: '2026-11-25T21:00+09:00',
    sender: 'school',
    language: 'ja',
    medium: 'text',
    sentences: [{ id: 'w1#1', text: TEXT }],
    ...over,
  });
  const read = (
    source: Source,
    over: Partial<ExtractionOutput['items'][number]> = {},
    written = TEXT,
  ) =>
    toExtraction(
      {
        items: [
          item({
            id: 'i1',
            sentenceIds: ['w1#1'],
            kind: 'belongings',
            written,
            relativeDay: 'tomorrow',
            what: '体操服',
            ...over,
          }),
        ],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
      source,
      { priorItems: [], priorUnknowns: [] },
    );

  it('家族が書かれた日を入れたら、「あした」はその日から数え、確かな読み取りにする', () => {
    const { extraction, issues } = read(note({ writtenOn: '2026-11-24' }));
    expect(issues).toEqual([]);
    expect(extraction.items[0]?.evidence).toBe('stated');
    expect(extraction.items[0]?.interpretation).toMatchObject({
      date: '2026-11-25',
      relativeDay: 'tomorrow',
    });
    expect(extraction.items[0]?.interpretation).not.toHaveProperty('relativeDayFromReceived');
    // 「きょう」は書かれた日。
    const today = read(note({ writtenOn: '2026-11-24' }), { relativeDay: 'today' });
    expect(today.extraction.items[0]?.interpretation.date).toBe('2026-11-24');
    // モデルが（言いつけに反して）届いた日から数えた日付を返しても、食い違いにせず、書かれた日から数え直す。
    const counted = read(note({ writtenOn: '2026-11-24' }), { date: '2026-11-26' });
    expect(counted.issues).toEqual([]);
    expect(counted.extraction.items[0]?.interpretation.date).toBe('2026-11-25');
  });

  it('書かれた日の分からない学校のお知らせは、届いた日から数えて推定にし、家族に確かめてもらう', () => {
    const { extraction, issues } = read(note());
    expect(issues).toEqual([
      { problem: 'relativeDayUnanchored', ref: 'w1:i1', detail: '2026-11-25' },
    ]);
    expect(extraction.items[0]?.evidence).toBe('inferred');
    expect(extraction.items[0]?.interpretation).toMatchObject({
      date: '2026-11-26',
      relativeDayFromReceived: '2026-11-25',
    });
    expect(extraction.checkSentenceIds).toEqual(['w1#1']);
  });

  it('送り手が家族でも、書かれた日を入れなければ届いた日から数えて推定にする（前の日の連絡を後で貼ることがある）', () => {
    // 11/25 に、家族が 11/24 に送った「あした」の連絡を、書かれた日を選ばずに貼った（11/7 見直しの反例）。
    const { extraction, issues } = read(note({ sender: 'family' }));
    expect(issues).toEqual([
      { problem: 'relativeDayUnanchored', ref: 'w1:i1', detail: '2026-11-25' },
    ]);
    expect(extraction.items[0]?.evidence).toBe('inferred');
    expect(extraction.items[0]?.interpretation).toMatchObject({
      date: '2026-11-26',
      relativeDayFromReceived: '2026-11-25',
    });
    // 書かれた日を選べば、その日から数えて確かな読み取りにする。
    const dated = read(note({ sender: 'family', writtenOn: '2026-11-24' }));
    expect(dated.issues).toEqual([]);
    expect(dated.extraction.items[0]).toMatchObject({
      evidence: 'stated',
      interpretation: { date: '2026-11-25' },
    });
  });

  it('指した文に書かれた日付は取り、「あした」と照らすのは書かれた日が分かる時だけ', () => {
    const text = 'あした（12月5日）は体操服を持ってきてください。';
    const dated = (over: Partial<Source>) =>
      read(note({ sentences: [{ id: 'w1#1', text }], ...over }), { date: '2026-12-05' }, text);
    // 書かれた日が分からない：書かれた日付を取り、推定にも食い違いにもしない。
    const unknown = dated({});
    expect(unknown.issues).toEqual([]);
    expect(unknown.extraction.items[0]).toMatchObject({
      evidence: 'stated',
      interpretation: { date: '2026-12-05' },
    });
    // 書かれた日（12/4）の次の日と合う：確かな読み取り。
    expect(dated({ writtenOn: '2026-12-04', receivedAt: '2026-12-04T20:00+09:00' }).issues).toEqual(
      [],
    );
    // 書かれた日（11/24）と合わない：食い違いにし、書かれた日付のまま家族に確かめてもらう。
    const mismatch = dated({ writtenOn: '2026-11-24' });
    expect(mismatch.issues).toEqual([
      { problem: 'relativeDayMismatch', ref: 'w1:i1', detail: '2026-12-05' },
    ]);
    expect(mismatch.extraction.items[0]).toMatchObject({
      evidence: 'conflicting',
      interpretation: { date: '2026-12-05' },
    });
  });

  it('書かれた日の基準と、入れた書かれた日の確かめ', () => {
    expect(relativeDayBase(note(), 'Asia/Tokyo')).toEqual({ day: '2026-11-25', known: false });
    // 送り手が家族でも、送り手は書かれた日の証拠にならない。
    expect(relativeDayBase(note({ sender: 'family' }), 'Asia/Tokyo')).toEqual({
      day: '2026-11-25',
      known: false,
    });
    expect(relativeDayBase(note({ writtenOn: '2026-11-20' }), 'Asia/Tokyo')).toEqual({
      day: '2026-11-20',
      known: true,
    });
    // 届いた日は家庭の時区で決める（UTC では前の日の 23 時 30 分でも、日本では 11/25）。
    const at = '2026-11-24T23:30+00:00';
    expect(writtenOnProblem('2026-11-25', at, 'Asia/Tokyo')).toBeUndefined();
    expect(writtenOnProblem('2026-11-25', at, 'UTC')).toBe('future');
    expect(writtenOnProblem('2026-11-26', at, 'Asia/Tokyo')).toBe('future');
    expect(writtenOnProblem('2026-09-26', at, 'Asia/Tokyo')).toBeUndefined();
    expect(writtenOnProblem('2026-09-25', at, 'Asia/Tokyo')).toBe('tooOld');
    expect(writtenOnProblem('2026-02-30', at, 'Asia/Tokyo')).toBe('invalid');
    expect(writtenOnProblem('11/25', at, 'Asia/Tokyo')).toBe('invalid');
  });
});

describe('家の人がすること（familyAction）', () => {
  // その日の連絡帳を、書かれた日を添えて入れた（「あした」を確かな日から数える）。
  const note = {
    id: 'r1',
    version: 1,
    receivedAt: '2026-11-25T18:00+09:00',
    writtenOn: '2026-11-25',
    sender: 'school' as const,
    language: 'ja' as const,
    medium: 'text' as const,
    sentences: [
      { id: 'r1#1', text: 'あした、音読カードにサインをお願いします。' },
      { id: 'r1#2', text: '漢字ドリル12ページ。' },
      { id: 'r1#3', text: '体操服を持ってきてください。' },
    ],
  };

  it('宿題と当番の物だけに残す（ほかの種類に付いても外す）。無い・false なら付けない', () => {
    const { extraction, issues } = toExtraction(
      {
        items: [
          item({
            id: 'i1',
            sentenceIds: ['r1#1'],
            kind: 'homework',
            written: 'あした、音読カードにサインをお願いします。',
            relativeDay: 'tomorrow',
            what: '音読カードのサイン',
            familyAction: true,
          }),
          item({
            id: 'i2',
            sentenceIds: ['r1#2'],
            kind: 'homework',
            written: '漢字ドリル12ページ。',
            what: '漢字ドリル12ページ',
          }),
          item({
            id: 'i3',
            sentenceIds: ['r1#3'],
            kind: 'belongings',
            written: '体操服を持ってきてください。',
            what: '体操服',
            familyAction: true,
          }),
        ],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
      note,
      { priorItems: [], priorUnknowns: [] },
    );
    expect(issues).toEqual([]);
    const byId = new Map(extraction.items.map((i) => [i.id, i.interpretation]));
    expect(byId.get('r1:i1')?.familyAction).toBe(true);
    expect(byId.get('r1:i2')).not.toHaveProperty('familyAction');
    expect(byId.get('r1:i3')).not.toHaveProperty('familyAction');
  });
});

describe('書かれていない時刻', () => {
  const note = (text: string) => ({
    id: 'r2',
    version: 1,
    receivedAt: '2026-11-25T18:00+09:00',
    sender: 'school' as const,
    language: 'ja' as const,
    medium: 'text' as const,
    sentences: [{ id: 'r2#1', text }],
  });
  const read = (text: string, over: Partial<ExtractionOutput['items'][number]>) =>
    toExtraction(
      {
        items: [
          item({ id: 'i1', sentenceIds: ['r2#1'], kind: 'submission', written: text, ...over }),
        ],
        unknowns: [],
        conditions: [],
        irrelevantSentenceIds: [],
        ambiguities: [],
      },
      note(text),
      { priorItems: [], priorUnknowns: [] },
    );

  it('日だけの締切に付けた時刻は、その日の朝の目安にして日だけと印を付け、その文を確かめてもらう', () => {
    const text = '個人面談の出欠票は12月4日までに出してください。';
    const { extraction, issues } = read(text, { deadline: '2026-12-04T17:00+09:00' });
    expect(extraction.items[0]?.interpretation).toMatchObject({
      deadline: '2026-12-04T08:00+09:00',
      deadlineDayOnly: true,
    });
    expect(issues).toEqual([
      { problem: 'unwrittenTime', ref: 'r2:i1', detail: '2026-12-04T17:00+09:00' },
    ]);
    // 時刻の書き方は数え切れないので、見つからないだけでは「書かれていない」と言わない（確かめてもらう）。
    expect(extraction.checkSentenceIds).toEqual(['r2#1']);
    expect(extraction.items[0]?.evidence).toBe('stated');
  });

  it('日だけで読んだ締切（時刻を付けない）は、日だけと印を付け、確かめを求めない', () => {
    const text = '個人面談の出欠票は12月4日までに出してください。';
    const { extraction, issues } = read(text, { deadline: '2026-12-04' });
    expect(extraction.items[0]?.interpretation).toMatchObject({
      deadline: '2026-12-04T08:00+09:00',
      deadlineDayOnly: true,
    });
    expect(issues).toEqual([]);
    expect(extraction.checkSentenceIds).toEqual([]);
    // 日付として無い日は、ほかの日付と同じく読めない物にする。
    expect(read(text, { deadline: '2026-12-32' }).issues).toContainEqual({
      problem: 'badDate',
      ref: 'r2:i1',
      detail: '2026-12-32',
    });
  });

  it('日だけで読んだ締切でも、文に時刻らしい書き方があれば、読み落としかもしれないので確かめてもらう', () => {
    for (const text of [
      '設備の利用は、12月4日（金）17:00までに窓口で申し込んでください。',
      '12月4日（金）午後五時までに出してください。',
      '12月4日（金）の夕方までに出してください。',
      '12月4日（金）の朝、担任に出してください。',
    ]) {
      const { extraction, issues } = read(text, { deadline: '2026-12-04' });
      // 日だけと印を付けたまま（読み落とした時刻を、コードが選んで埋めない）、その文を確かめてもらう。
      expect(extraction.items[0]?.interpretation).toMatchObject({ deadlineDayOnly: true });
      expect(issues).toEqual([{ problem: 'unwrittenTime', ref: 'r2:i1', detail: '2026-12-04' }]);
      expect(extraction.checkSentenceIds).toEqual(['r2#1']);
    }
  });

  it('漢数字の時刻も、書かれた時刻とする', () => {
    for (const [text, deadline] of [
      ['12月4日（金）午後八時までに出してください。', '2026-12-04T20:00+09:00'],
      ['12月4日（金）十二時半までに出してください。', '2026-12-04T12:30+09:00'],
      ['12月4日（金）十時十五分までに出してください。', '2026-12-04T10:15+09:00'],
    ] as const) {
      const { extraction, issues } = read(text, { deadline });
      expect(extraction.items[0]?.interpretation.deadline).toBe(deadline);
      expect(issues).toEqual([]);
    }
  });

  it('書かれた時刻はそのまま。午前・午後の書かれていない時は、どちらの読みも許す', () => {
    for (const [text, deadline] of [
      ['12月4日8時半までに出してください。', '2026-12-04T08:30+09:00'],
      ['12月4日 午後8時までに出してください。', '2026-12-04T20:00+09:00'],
      ['12月4日 13:00までに出してください。', '2026-12-04T13:00+09:00'],
      ['12月4日 1時までに出してください。', '2026-12-04T13:00+09:00'],
      ['12月4日 正午までに出してください。', '2026-12-04T12:00+09:00'],
    ] as const) {
      const { extraction, issues } = read(text, { deadline });
      expect(extraction.items[0]?.interpretation.deadline).toBe(deadline);
      expect(extraction.items[0]?.interpretation).not.toHaveProperty('deadlineDayOnly');
      expect(issues).toEqual([]);
    }
  });

  it('文に時刻があるのに合わない締切の時刻は、日だけにして、その文を確かめてもらう', () => {
    for (const [text, deadline] of [
      ['12月4日 午後8時までに出してください。', '2026-12-04T08:00+09:00'],
      ['12月4日 午前8時までに出してください。', '2026-12-04T20:00+09:00'],
      ['12月4日 13:00までに出してください。', '2026-12-04T01:00+09:00'],
    ] as const) {
      const { extraction, issues } = read(text, { deadline });
      expect(extraction.items[0]?.interpretation).toMatchObject({ deadlineDayOnly: true });
      expect(issues).toEqual([{ problem: 'unwrittenTime', ref: 'r2:i1', detail: deadline }]);
      expect(extraction.checkSentenceIds).toEqual(['r2#1']);
    }
  });

  it('書かれていない始まり・終わりは落とし（書かれた方は残す）、その文を確かめてもらう', () => {
    const text = '12月13日(日)8:30から お茶当番';
    const { extraction, issues } = read(text, {
      kind: 'duty',
      date: '2026-12-13',
      writtenWeekday: 'sun',
      startTime: '08:30',
      endTime: '10:00',
    });
    const interpretation = extraction.items[0]?.interpretation;
    expect(interpretation?.startTime).toBe('08:30');
    expect(interpretation).not.toHaveProperty('endTime');
    expect(issues).toEqual([{ problem: 'unwrittenTime', ref: 'r2:i1', detail: '10:00' }]);
    expect(extraction.checkSentenceIds).toEqual(['r2#1']);
  });

  it('範囲の前の午前・午後は後ろにも効く。空白の前後の数はつなげない', () => {
    const cases = [
      // [原文, 始まり, 終わり, 書かれた物か]
      ['12月13日（日）午後1〜3時 お茶当番', '13:00', '03:00', false],
      ['12月13日（日）午後1時〜3時 お茶当番', '13:00', '03:00', false],
      ['12月13日（日）午後1時〜3時 お茶当番', '13:00', '15:00', true],
      ['12月13日（日）午前9〜11時 お茶当番', '09:00', '23:00', false],
      ['12月13日（日）午前10時〜1時 お茶当番', '10:00', '13:00', true],
      ['12/13 9:00〜10:00 お茶当番', '09:00', '10:00', true],
      ['12/13 午後 8時から お茶当番', '08:00', null, false],
    ] as const;
    for (const [text, start, end, ok] of cases) {
      const { issues } = read(text, {
        kind: 'duty',
        date: '2026-12-13',
        startTime: start,
        endTime: end,
      });
      expect([text, start, end, issues.length === 0]).toEqual([text, start, end, ok]);
    }
  });

  it('つなぎの言葉が何でも（から・まで、–）、前の午前・午後から外れた読みを書かれたとしない', () => {
    const cases = [
      // [原文, 始まり, 終わり, 書かれた物か]
      ['12月13日 午前9時から10時まで お茶当番', '09:00', '22:00', false],
      ['12月13日 午前9時から10時まで お茶当番', '09:00', '10:00', true],
      ['12月13日 午前9時–10時 お茶当番', '09:00', '22:00', false],
      ['12月13日 午前9–10時 お茶当番', '09:00', '10:00', true],
      ['12月13日 午後1時から3時まで お茶当番', '13:00', '03:00', false],
      ['12月13日 午後1時から3時まで お茶当番', '13:00', '15:00', true],
      ['12月13日 正午から2時まで お茶当番', '12:00', '02:00', false],
      ['12月13日 正午から2時まで お茶当番', '12:00', '14:00', true],
      // 前に午前・午後の書かれていない時は、どちらの読みも許す（文の前後からのモデルの読みに任せる）。
      ['12月13日 9時から10時まで お茶当番', '09:00', '10:00', true],
    ] as const;
    for (const [text, start, end, ok] of cases) {
      const { issues } = read(text, {
        kind: 'duty',
        date: '2026-12-13',
        startTime: start,
        endTime: end,
      });
      expect([text, start, end, issues.length === 0]).toEqual([text, start, end, ok]);
    }
  });

  it('別の日・別の句の時刻からは受け継がない。24 時制で書いた時刻は書いたままにする', () => {
    const cases = [
      // [原文, 日, 始まり, 終わり, 書かれた物か]
      // 前の日の「15時」から午後を受けて、次の日の 9 時・10 時を消さない。
      [
        '12月4日の講習は15時に終了、12月5日の保護者のお茶当番は9時から10時です。',
        '2026-12-05',
        '09:00',
        '10:00',
        true,
      ],
      // 読点で区切った後の時刻は、前の午後を受けない（どちらの読みも許す）。
      ['12月13日 午後3時に解散、集合は8時です。', '2026-12-13', '08:00', null, true],
      // 前に 0 を付けた時刻は 24 時制。午後の読みは無い。続く時刻も書いたまま。
      ['12月13日のお茶当番は09:00〜10:00です。', '2026-12-13', '21:00', '22:00', false],
      ['12月13日のお茶当番は09:00〜10:00です。', '2026-12-13', '09:00', '22:00', false],
      ['12月13日のお茶当番は09:00〜10:00です。', '2026-12-13', '09:00', '10:00', true],
      ['12月13日 08:30〜10:00 お茶当番', '2026-12-13', '08:30', '10:00', true],
      // 同じ句の 24 時制の後の時刻も、書いたまま（午後と読まない）。
      ['12月13日 15時終了 9時から10時 お茶当番', '2026-12-13', '09:00', '10:00', true],
      ['12月13日 15時終了 9時から10時 お茶当番', '2026-12-13', '21:00', '22:00', false],
    ] as const;
    for (const [text, date, start, end, ok] of cases) {
      const { issues } = read(text, { kind: 'duty', date, startTime: start, endTime: end });
      expect([text, start, end, issues.length === 0]).toEqual([text, start, end, ok]);
    }
  });

  it('始まりの時刻を落とした時は、確かめていないと印を付ける（書かれていないとは言わない）', () => {
    const text = '12月13日のお茶当番は09:00〜10:00です。';
    const dropped = read(text, {
      kind: 'duty',
      date: '2026-12-13',
      startTime: '21:00',
      endTime: null,
    }).extraction.items[0]?.interpretation;
    expect(dropped).toMatchObject({ startTimeUnconfirmed: true });
    expect(dropped).not.toHaveProperty('startTime');
    const kept = read(text, {
      kind: 'duty',
      date: '2026-12-13',
      startTime: '09:00',
      endTime: '10:00',
    }).extraction.items[0]?.interpretation;
    expect(kept).not.toHaveProperty('startTimeUnconfirmed');
  });

  it('「9〜10時」のように時をまとめて書いた範囲も、両方を書かれた時刻とする', () => {
    for (const [text, start, end] of [
      ['12月13日（日）9〜10時 お茶当番', '09:00', '10:00'],
      ['12月13日（日）午後1〜3時 お茶当番', '13:00', '15:00'],
      ['12月13日（日）9時〜10時半 お茶当番', '09:00', '10:30'],
    ] as const) {
      const { extraction, issues } = read(text, {
        kind: 'duty',
        date: '2026-12-13',
        writtenWeekday: 'sun',
        startTime: start,
        endTime: end,
      });
      expect(extraction.items[0]?.interpretation).toMatchObject({ startTime: start, endTime: end });
      expect(issues).toEqual([]);
    }
  });
});

describe('通用の「すること」（need）の読み取り', () => {
  const note = (...texts: string[]) => ({
    id: 'r3',
    version: 1,
    receivedAt: '2026-11-24T19:00+09:00',
    sender: 'school' as const,
    language: 'ja' as const,
    medium: 'text' as const,
    sentences: texts.map((text, i) => ({ id: `r3#${i + 1}`, text })),
  });
  const read = (texts: string[], items: ExtractionOutput['items'], writtenOn?: string) =>
    toExtraction(
      { items, unknowns: [], conditions: [], irrelevantSentenceIds: [], ambiguities: [] },
      { ...note(...texts), ...(writtenOn ? { writtenOn } : {}) },
      { priorItems: [], priorUnknowns: [] },
    );

  it('同じ文の行事と出席の依頼を別の事項にし、出席は窓の形で、書かれた時刻だけを持つ（だれのためは付けない）', () => {
    const text =
      '12月12日（土）13:00〜14:00に地域交流会を行います。各家庭から大人1名、ご参加ください。';
    const { extraction, issues } = read(
      [text, '会場は地域交流室です。'],
      [
        item({
          id: 'i1',
          sentenceIds: ['r3#1'],
          kind: 'event',
          written: '12月12日（土）13:00〜14:00に地域交流会を行います。',
          date: '2026-12-12',
          writtenWeekday: 'sat',
          startTime: '13:00',
          endTime: '14:00',
          what: '地域交流会',
        }),
        item({
          id: 'i2',
          sentenceIds: ['r3#1', 'r3#2'],
          kind: 'need',
          written: '各家庭から大人1名、ご参加ください。会場は地域交流室です。',
          date: '2026-12-12',
          writtenWeekday: 'sat',
          startTime: '13:00',
          endTime: '14:00',
          what: '地域交流会への参加',
          place: '地域交流室',
          audience: '各家庭から大人1名',
          shape: 'window',
        }),
      ],
    );
    expect(issues).toEqual([]);
    const need = extraction.items.find((i) => i.kind === 'need');
    expect(need?.interpretation).toEqual({
      date: '2026-12-12',
      writtenWeekday: 6,
      startTime: '13:00',
      endTime: '14:00',
      what: '地域交流会への参加',
      place: '地域交流室',
      audience: '各家庭から大人1名',
      shape: 'window',
    });
    expect(need?.interpretation).not.toHaveProperty('forMemberId');
    // 形は need だけに付ける（ほかの種類に付いても使わない）。
    const event = extraction.items.find((i) => i.kind === 'event');
    expect(event?.interpretation).not.toHaveProperty('shape');
  });

  it('締切の形：日だけの締切は日だけと印を付け、書かれていない時刻を作らない。時刻を確かめられない時は、その文を確かめてもらう', () => {
    const need = (text: string, deadline: string) =>
      read(
        [text],
        [
          item({
            id: 'i1',
            sentenceIds: ['r3#1'],
            kind: 'need',
            written: text,
            deadline,
            what: '申し込み',
            shape: 'by',
          }),
        ],
      );
    const plain = '印刷機を使う場合は、12月4日（金）までに地区センターの窓口で申し込んでください。';
    // 「12月4日（金）までに」を日だけで読んだ：日だけと印を付け、確かめは求めない（その日の朝を目安にする）。
    const dayOnly = need(plain, '2026-12-04');
    expect(dayOnly.extraction.items[0]?.interpretation).toMatchObject({
      shape: 'by',
      deadline: '2026-12-04T08:00+09:00',
      deadlineDayOnly: true,
    });
    expect(dayOnly.issues).toEqual([]);
    // モデルが書かれていない時刻（00:00）を付けた：その時刻は使わず日だけにし、その文を確かめてもらう。
    const added = need(plain, '2026-12-04T00:00+09:00');
    expect(added.extraction.items[0]?.interpretation).toMatchObject({
      deadline: '2026-12-04T08:00+09:00',
      deadlineDayOnly: true,
    });
    expect(added.issues).toEqual([
      { problem: 'unwrittenTime', ref: 'r3:i1', detail: '2026-12-04T00:00+09:00' },
    ]);
    expect(added.extraction.checkSentenceIds).toEqual(['r3#1']);
    // 「12月4日（金）17:00までに」：書かれた時刻の締切は、そのまま。
    const timed = '12月4日（金）17:00までに窓口で申し込んでください。';
    const right = need(timed, '2026-12-04T17:00+09:00');
    expect(right.extraction.items[0]?.interpretation.deadline).toBe('2026-12-04T17:00+09:00');
    expect(right.extraction.items[0]?.interpretation).not.toHaveProperty('deadlineDayOnly');
    expect(right.issues).toEqual([]);
    // 日だけで読んだのに、文に時刻か時刻らしい言葉（登校前・朝・放課後）がある：読み落としかもしれないので、
    // 日だけにして（時刻を作らない）、その文を確かめてもらう。
    for (const text of [
      timed,
      '12月4日（金）の登校前までに欠席を連絡してください。',
      '12月4日（金）の朝までに提出してください。',
      '12月4日（金）の放課後までに提出してください。',
    ]) {
      const { extraction, issues } = need(text, '2026-12-04');
      expect(extraction.items[0]?.interpretation).toMatchObject({
        deadline: '2026-12-04T08:00+09:00',
        deadlineDayOnly: true,
      });
      expect(issues).toContainEqual({
        problem: 'unwrittenTime',
        ref: 'r3:i1',
        detail: '2026-12-04',
      });
      expect(extraction.checkSentenceIds).toEqual(['r3#1']);
    }
    // 締切の言葉が先に来る書き方も、日だけの締切。
    for (const text of ['申込みの締切は12月4日（金）です。', '締切：12月4日（金）']) {
      const { extraction, issues } = need(text, '2026-12-04');
      expect(extraction.items[0]?.interpretation).toMatchObject({ deadlineDayOnly: true });
      expect(issues).toEqual([]);
    }
    // 締切でない日を締切と読んだ物（候補の日・打ち消した日）は、書き方が数え切れないので、変換では見分けない。読み
    // のまま残す。お知らせから読んだ「すること」は、家族が元の文と比べて確かめるまで計画に入らない（エンジンと
    // 命令の層の試験）。
    for (const text of [
      '12月4日と12月6日の希望を、12月1日までにお知らせください。',
      '申込みの締切は12月4日ではなく12月3日ですので、お申し込みください。',
    ]) {
      const { extraction } = need(text, '2026-12-04');
      expect(extraction.items).toHaveLength(1);
      expect(extraction.items[0]?.interpretation).toMatchObject({
        deadline: '2026-12-04T08:00+09:00',
        deadlineDayOnly: true,
      });
    }
  });

  it('「あしたまでに」の締切は、コードが決めた日と違えば「食い違い」にする（日付の書かれた文でも、印を付ける）', () => {
    // 届いた日は、この組の出典の receivedAt（11/24）。家族は書かれた日に同じ日（11/24）を入れた。
    const text = 'あしたまでに地区センターの窓口で申し込んでください。';
    const base = {
      id: 'i1',
      sentenceIds: ['r3#1'],
      kind: 'need' as const,
      written: text,
      relativeDay: 'tomorrow' as const,
      what: '窓口での申し込み',
      shape: 'by' as const,
    };
    // 書かれた日（11/24）の次の日なら取る。
    const right = read([text], [item({ ...base, deadline: '2026-11-25' })], '2026-11-24');
    expect(right.issues).toEqual([]);
    expect(right.extraction.items[0]?.interpretation.deadline?.startsWith('2026-11-25')).toBe(true);
    // 別の日の締切は「食い違い」にする。
    const wrong = read([text], [item({ ...base, deadline: '2026-11-28' })], '2026-11-24');
    expect(wrong.issues).toContainEqual({
      problem: 'relativeDayMismatch',
      ref: 'r3:i1',
      detail: '2026-11-28',
    });
    expect(wrong.extraction.items[0]?.evidence).toBe('conflicting');
    // 同じ文に候補の日があれば、どの読みでも書かれた日と「あした」が合わないので、「食い違い」にして確かめてもらう
    // （候補の日を締切と読んでも、確かな物として通さない）。
    const withDates = '11月28日と11月26日の希望を、あしたまでにお知らせください。';
    for (const deadline of ['2026-11-28', '2026-11-25']) {
      const candidate = read(
        [withDates],
        [item({ ...base, written: withDates, deadline })],
        '2026-11-24',
      );
      expect(candidate.extraction.items[0]?.evidence).toBe('conflicting');
      expect(candidate.extraction.checkSentenceIds).toEqual(['r3#1']);
    }
  });

  it('「あしたまでに」の締切は、書かれた日から数える。書かれた日が分からなければ、届いた日から数えて確かめてもらう', () => {
    const text = 'あしたの17時までに地区センターの窓口で申し込んでください。';
    const base = {
      id: 'i1',
      sentenceIds: ['r3#1'],
      kind: 'need' as const,
      written: text,
      relativeDay: 'tomorrow' as const,
      what: '窓口での申し込み',
      shape: 'by' as const,
      // モデルは届いた時刻（11/24）だけを見て、その次の日を締切にする。
      deadline: '2026-11-25T17:00+09:00',
    };
    // 前の日（11/23）の連絡帳を 11/24 に入れた：締切は 11/24 の 17 時（書かれた時刻はそのまま）。確かな読み取り。
    const yesterday = read([text], [item(base)], '2026-11-23');
    expect(yesterday.issues).toEqual([]);
    expect(yesterday.extraction.items[0]).toMatchObject({
      evidence: 'stated',
      interpretation: { deadline: '2026-11-24T17:00+09:00' },
    });
    expect(yesterday.extraction.items[0]?.interpretation).not.toHaveProperty(
      'relativeDayFromReceived',
    );
    // 書かれた日を入れていない学校のお知らせ：届いた日から数えた締切を推定にし、その文を確かめてもらう。
    const unknown = read([text], [item(base)]);
    expect(unknown.issues).toEqual([
      { problem: 'relativeDayUnanchored', ref: 'r3:i1', detail: '2026-11-24' },
    ]);
    expect(unknown.extraction.items[0]).toMatchObject({
      evidence: 'inferred',
      interpretation: {
        deadline: '2026-11-25T17:00+09:00',
        relativeDayFromReceived: '2026-11-24',
      },
    });
    expect(unknown.extraction.checkSentenceIds).toEqual(['r3#1']);
  });

  it('形の足りない need は事項を残し、その文を家族に確かめてもらう（時刻を作らない・別の形に変えない）', () => {
    const text =
      '12月13日（日）09:00から地域の説明会です。各家庭から大人1人の参加をお願いします。終了時刻は後ほどお知らせします。';
    const base = {
      id: 'i1',
      sentenceIds: ['r3#1'],
      kind: 'need' as const,
      written: '各家庭から大人1人の参加をお願いします。',
      date: '2026-12-13',
      writtenWeekday: 'sun' as const,
      what: '説明会への参加',
    };
    const cases: [Partial<ExtractionOutput['items'][number]>, string][] = [
      [{ shape: 'window', startTime: '09:00', endTime: null }, 'window'],
      // 書かれていない終わりは落ちるので、窓は足りない（12:00 を作らない）。
      [{ shape: 'window', startTime: '09:00', endTime: '12:00' }, 'window'],
      [{ shape: 'none', startTime: '09:00' }, 'shape'],
      [{ shape: 'by', deadline: null }, 'deadline'],
    ];
    for (const [over, detail] of cases) {
      const { extraction, issues } = read([text], [item({ ...base, ...over })]);
      expect(extraction.items).toHaveLength(1);
      expect(extraction.items[0]?.interpretation).not.toHaveProperty('endTime');
      expect(issues.filter((i) => i.problem === 'needIncomplete')).toEqual([
        { problem: 'needIncomplete', ref: 'r3:i1', detail },
      ]);
      expect(extraction.checkSentenceIds).toEqual(['r3#1']);
    }
    // 窓の終わりが始まりより前の物も、確かめてもらう。
    const reversed = read(
      ['12月13日（日）14:00〜13:00 説明会。各家庭から大人1人の参加をお願いします。'],
      [
        item({
          ...base,
          written: '各家庭から大人1人の参加をお願いします。',
          shape: 'window',
          startTime: '14:00',
          endTime: '13:00',
        }),
      ],
    );
    expect(reversed.issues.map((i) => i.detail)).toContain('overnight');
  });

  it('前の版の録った出力（形の欄が無い）は、形を none として読む', () => {
    const { shape: _shape, ...v3 } = item({ id: 'i1' });
    const stored = parseStoredExtraction({
      items: [v3],
      unknowns: [],
      conditions: [],
      irrelevantSentenceIds: [],
      ambiguities: [],
    });
    expect(stored.items[0]?.shape).toBe('none');
  });
});
