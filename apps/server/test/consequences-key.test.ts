// 「選んだら」の新しい違反：二つの作業の重なりは向きの無い対で比べる。同じ作業でも相手の違う重なりは
// 新しい違反として出し、対の向き（検証器の並べ順）が変わっただけの物は新しいと言わない。
// 検証器は差し替えて、決まった違反を返す（鍵の作り方だけを確かめる）。
import { computePlan } from '@maniau/core/engine';
import { expect, it, vi } from 'vitest';

const issues = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@maniau/verify', () => ({ verifyPlan: () => ({ issues: issues.list }) }));

import { consequencesOf, violationsOf } from '../src/consequences';
import { demoEvents } from '../src/demo';

const now = '2026-11-25T19:31+09:00';
const events = demoEvents('arrived');
const set = events.find((e) => e.type === 'householdSet');
if (set?.type !== 'householdSet') throw new Error('家庭が無い');
const household = set.household;
const plan = computePlan(events, now);

const overlap = (subject: string, related: string) => ({
  kind: 'violation',
  code: 'task_overlap',
  subject,
  detail: `${subject} と ${related} が重なる`,
  related,
});

it('重なりの鍵は、対の向きによらず同じで、相手が違えば別', () => {
  issues.list = [overlap('task:x', 'task:y')];
  const [xy] = violationsOf(household, events, plan);
  issues.list = [overlap('task:y', 'task:x')];
  const [yx] = violationsOf(household, events, plan);
  issues.list = [overlap('task:x', 'task:z')];
  const [xz] = violationsOf(household, events, plan);
  expect(xy).toBe(yx);
  expect(xz).not.toBe(xy);
  // 対の無い違反は、符号と対象。決まらない物（undetermined）は数えない。
  issues.list = [
    { kind: 'violation', code: 'deadline_passed', subject: 'task:x', detail: '' },
    { kind: 'undetermined', code: 'task_overlap_scope_unknown', subject: 'task:x', detail: '' },
  ];
  expect(violationsOf(household, events, plan)).toEqual([
    JSON.stringify(['deadline_passed', 'task:x']),
  ]);
});

it('同じ作業でも相手の違う重なりは、新しい違反として「選んだら」に出す', () => {
  issues.list = [overlap('task:x', 'task:y')];
  const already = new Set(violationsOf(household, events, plan));
  const arrangement = plan.arrangements.find((a) => a.kind === 'childCare');
  const option = arrangement?.options[0];
  if (!arrangement || !option) throw new Error('手が無い');
  const choice = { arrangementKey: arrangement.key, optionKey: option.key };
  const simulated = { before: plan, added: [], after: plan };
  // 向きが入れ替わっただけ：新しい違反は無い。
  issues.list = [overlap('task:y', 'task:x')];
  expect(consequencesOf(household, events, already, simulated, choice).issues).toEqual([]);
  // 同じ作業 x に、別の相手 z との重なりが増えた：新しい違反として符号を出す。
  issues.list = [overlap('task:y', 'task:x'), overlap('task:x', 'task:z')];
  expect(consequencesOf(household, events, already, simulated, choice).issues).toEqual([
    'task_overlap',
  ]);
});
