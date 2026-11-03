// 保存済みの読み取り応答だけを採点する。通信・API キーの読み込みはしない。
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { scoreReadingV4 } from './reading-v4-score.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 許した材料の外や、シンボリックリンクを通った別の場所を読まない。 */
async function allowedFile(name, roots) {
  const target = await realpath(path.resolve(root, name));
  for (const entry of roots) {
    const base = await realpath(path.join(root, entry)).catch(() => undefined);
    if (!base) continue;
    const relative = path.relative(base, target);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      return target;
  }
  throw new Error('評価の材料として許された場所のファイルを指定してください');
}

const { values } = parseArgs({
  options: { case: { type: 'string' }, response: { type: 'string' } },
  strict: true,
});
if (!values.case || !values.response) {
  throw new Error('使い方：node eval/score-reading-v4.mjs --case 場面 --response 保存した応答');
}
const scenarioPath = await allowedFile(values.case, [
  'eval/cases/reading-v4',
  '.local/eval-holdout/reading-v4',
]);
const responsePath = await allowedFile(values.response, [
  'eval/runs',
  '.local/eval-holdout/reading-v4',
]);
const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
const saved = JSON.parse(await readFile(responsePath, 'utf8'));
const output = saved && typeof saved === 'object' && 'output' in saved ? saved.output : saved;
const stopReason = saved?.stop_reason ?? saved?.stopReason;
process.stdout.write(`${JSON.stringify(scoreReadingV4(scenario, output, { stopReason }), null, 2)}\n`);
