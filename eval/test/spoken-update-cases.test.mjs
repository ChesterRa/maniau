import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../cases/spoken-updates/', import.meta.url);
const files = (await readdir(root)).filter((name) => name.endsWith('.json')).sort();
const cases = await Promise.all(
  files.map(async (name) => ({ name, value: JSON.parse(await readFile(new URL(name, root), 'utf8')) })),
);

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === value;
};

test('家族の一言の開発用場面は架空で、入力と採点が分かれている', () => {
  assert.equal(cases.length, 6);
  const ids = new Set();
  const checks = new Set();
  for (const { name, value } of cases) {
    assert.equal(value.synthetic, true, name);
    assert.equal(value.task, 'spoken_update', name);
    assert.equal(value.timeZone, 'Asia/Tokyo', name);
    assert.ok(!ids.has(value.id), name);
    ids.add(value.id);
    assert.ok(value.input.utterance, name);
    assert.ok(Number.isFinite(Date.parse(value.input.now)), name);
    assert.match(value.input.now, /\+09:00$/, name);
    assert.ok(Number.isInteger(value.input.state.throughSeq), name);
    assert.ok(!Object.hasOwn(value.input, 'expected'), name);
    const members = new Map(value.input.members.map((member) => [member.id, member]));
    assert.equal(members.size, value.input.members.length, name);
    assert.equal(members.get(value.input.actor.id)?.kind, 'adult', name);
    assert.equal(members.get(value.input.actor.id)?.name, value.input.actor.name, name);
    assert.ok(value.expected.checks.some((check) => check.critical), name);
    for (const check of value.expected.checks) {
      assert.ok(!checks.has(check.id), `${name}: ${check.id}`);
      assert.equal(typeof check.critical, 'boolean', name);
      assert.ok(check.check, name);
      checks.add(check.id);
    }
    const taskKeys = value.input.state.tasks.map((task) => task.key);
    const requestIds = value.input.state.requests.map((request) => request.id);
    assert.equal(new Set(taskKeys).size, taskKeys.length, name);
    assert.equal(new Set(requestIds).size, requestIds.length, name);
    for (const task of value.input.state.tasks) {
      assert.ok(members.has(task.assigneeId), name);
      assert.ok(validDate(task.date), name);
    }
    for (const request of value.input.state.requests) {
      assert.ok(members.has(request.sentBy), name);
      assert.ok(validDate(request.forDate), name);
    }
    for (const routine of value.input.state.routines) assert.ok(members.has(routine.memberId), name);
    if (value.expected.afterPreview) {
      assert.ok(value.expected.afterPreview.change, name);
      assert.ok(value.expected.afterPreview.expected, name);
    }
  }
});

test('参照する操作は入力にある対象と本人の権限に沿う', () => {
  for (const { name, value } of cases) {
    const state = value.input.state;
    for (const command of value.expected.referenceCommands) {
      if (command.type === 'commitment') {
        const task = state.tasks.find((entry) => entry.key === command.taskKey);
        assert.ok(task, name);
        assert.equal(task.assigneeId, value.input.actor.id, name);
        assert.equal(task.commitment, 'accepted', name);
        assert.equal(command.action, 'withdraw', name);
      } else if (command.type === 'recordReply') {
        const request = state.requests.find((entry) => entry.id === command.requestId);
        assert.ok(request, name);
        assert.equal(request.state, 'awaitingReply', name);
        assert.equal(command.reply, 'no', name);
      } else {
        assert.fail(`${name}: unknown reference command`);
      }
    }
    if (value.expected.classification !== 'change') {
      assert.deepEqual(value.expected.referenceCommands, [], name);
    }
  }
  const question = cases.find(({ value }) => value.id === 'update-dev-03').value;
  const date = question.input.state.notices[0].items[0].date;
  assert.equal(date, '2026-12-03'); // 12/2 の「明日」
  const daily = cases.find(({ value }) => value.id === 'update-dev-06').value;
  assert.deepEqual(daily.input.state.tasks, []);
  assert.equal(daily.input.state.routines[0].weekday, 'fri');
  assert.equal(new Date('2026-11-27T00:00:00Z').getUTCDay(), 5);
});
