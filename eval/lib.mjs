const FIRST_SUPPORTED_DAY = '2026-11-01';
const LAST_SUPPORTED_DAY = '2026-12-31';
const JAPAN_HOLIDAYS = new Set(['2026-11-03', '2026-11-23']);
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function parseDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('日付は YYYY-MM-DD で指定してください。');
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('存在しない日付です。');
  }
  return date;
}

function dayText(date) {
  return date.toISOString().slice(0, 10);
}

function assertSupportedDay(value) {
  if (value < FIRST_SUPPORTED_DAY || value > LAST_SUPPORTED_DAY) {
    throw new Error('営業日の計算範囲は 2026-11-01〜2026-12-31 です。範囲外の祝日は未確認です。');
  }
}

export function calculateCalendar({ operation, value, amount }) {
  if (operation === 'weekday') {
    const date = parseDay(value);
    return { date: value, weekday: WEEKDAYS[date.getUTCDay()] };
  }
  if (operation === 'add_business_days') {
    const date = parseDay(value);
    assertSupportedDay(value);
    if (!Number.isInteger(amount) || Math.abs(amount) > 60) {
      throw new Error('営業日数は -60〜60 の整数で指定してください。');
    }
    let left = Math.abs(amount);
    const step = Math.sign(amount);
    while (left > 0) {
      date.setUTCDate(date.getUTCDate() + step);
      const day = dayText(date);
      assertSupportedDay(day);
      if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !JAPAN_HOLIDAYS.has(day)) left -= 1;
    }
    return { date: dayText(date), weekday: WEEKDAYS[date.getUTCDay()], excludes_start_day: true };
  }
  if (operation === 'add_minutes') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/.test(value)) {
      throw new Error('時刻は日本時間の YYYY-MM-DDTHH:mm:ss+09:00 で指定してください。');
    }
    parseDay(value.slice(0, 10));
    if (!Number.isInteger(amount) || Math.abs(amount) > 100_000) {
      throw new Error('分数は -100000〜100000 の整数で指定してください。');
    }
    const hour = Number(value.slice(11, 13));
    const minute = Number(value.slice(14, 16));
    const second = Number(value.slice(17, 19));
    if (hour > 23 || minute > 59 || second > 59) throw new Error('存在しない時刻です。');
    const time = new Date(value).getTime() + amount * 60_000;
    const jst = new Date(time + 9 * 60 * 60_000).toISOString().slice(0, 19);
    return { datetime: `${jst}+09:00` };
  }
  throw new Error('未対応の計算です。');
}

export const TOOLS = [
  {
    name: 'ask_family',
    description: '結果に影響する不明点を家族に質問する。返事を得られない場合もある。',
    input_schema: {
      type: 'object',
      properties: { question: { type: 'string', description: '家族に尋ねる質問' } },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'calendar_calculation',
    description: '曜日、分の加減算、日本の営業日を計算する。営業日の祝日は2026年11月1日から12月31日まで確認済み。開始日は数えない。',
    input_schema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['weekday', 'add_minutes', 'add_business_days'] },
        value: { type: 'string', description: '日付は YYYY-MM-DD、時刻は YYYY-MM-DDTHH:mm:ss+09:00。' },
        amount: { type: 'integer', description: '加える分数または営業日数。引く場合は負数。' },
      },
      required: ['operation', 'value'],
      additionalProperties: false,
    },
  },
];

export function buildRequest({ scenario, input, prompt, model, effort, maxTokens = 16384 }) {
  if (scenario.synthetic !== true || !['raw', 'facts'].includes(input)) {
    throw new Error('架空の場面と raw または facts を指定してください。');
  }
  if (!scenario.now || !Array.isArray(scenario[input]) || scenario[input].length === 0) {
    throw new Error('場面の時刻または入力がありません。');
  }
  if (!prompt || !model) throw new Error('プロンプトとモデルを指定してください。');
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('effort を確認してください。');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 65536) throw new Error('出力上限を確認してください。');
  return {
    model,
    max_tokens: maxTokens,
    ...(effort ? { output_config: { effort } } : {}),
    system: prompt,
    tools: TOOLS,
    messages: [{
      role: 'user',
      content: JSON.stringify({ now: scenario.now, information: scenario[input] }, null, 2),
    }],
  };
}

export function estimateCost(usage, pricing) {
  if (!usage || !pricing || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return null;
  if ((usage.cache_creation_input_tokens ?? 0) !== 0 || (usage.cache_read_input_tokens ?? 0) !== 0) return null;
  // 速度別に単価を指定できる。地域割増や、指定と違う速度の料金は推測しない。
  const speed = pricing.speed ?? 'standard';
  if (!['standard', 'fast'].includes(speed) || usage.inference_geo !== 'global') return null;
  if ((usage.speed && usage.speed !== speed) || (speed === 'fast' && usage.speed !== 'fast')) return null;
  return (usage.input_tokens * pricing.input + usage.output_tokens * pricing.output) / 1_000_000;
}
