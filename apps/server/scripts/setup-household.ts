// 家庭を作る（最初の一度。置き場所の Postgres に）：家庭の行、成員の行（権限の正本）、家族の情報の
// 事象（householdSet）。家族の情報の JSON は、架空の物（data/demo/household.json）か、作り手の手元の
// 物（~/dev/maniau-private/。リポジトリに入れない）。名前などの中身は画面にも記録にも出さない。
//
// 家庭の ID は、家族の情報の JSON の id（別に決めない）。一つのトランザクションで作るので、途中で
// 失敗しても半分だけ残らない。
//
//   DATABASE_URL=... pnpm --filter @maniau/server setup:household -- --kind test|real --file <JSON>
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Household, validateHousehold } from '@maniau/core';
import { nowIn } from '../src/clock';
import { connect } from '../src/db/connect';
import { setupHousehold } from '../src/db/store';

const { values } = parseArgs({
  options: { kind: { type: 'string' }, file: { type: 'string' } },
});
const { kind, file } = values;
if (!file || (kind !== 'test' && kind !== 'real')) {
  throw new Error('使い方：--kind test|real --file <家族の情報の JSON>');
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL が無い');

const household = Household.parse(JSON.parse(readFileSync(file, 'utf8')));
const issues = validateHousehold(household);
if (issues.length > 0) throw new Error(`家族の情報に誤りがある（${issues.length} 件）`);

const { db, close } = await connect(url);
try {
  await setupHousehold(db, kind, household, nowIn(household.timeZone));
  const adults = household.members.filter((m) => m.kind === 'adult').map((m) => m.id);
  console.log(`家庭 ${household.id}（${kind}）を作った。大人：${adults.join('、')}`);
} finally {
  await close();
}
