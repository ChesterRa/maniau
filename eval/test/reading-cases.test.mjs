import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../cases/reading/', import.meta.url);
const files = (await readdir(root)).filter((name) => name.endsWith('.json')).sort();

test('架空の読み取り場面が3種類あり、根拠と条件をたどれる', async () => {
  assert.equal(files.length, 3);
  for (const file of files) {
    const scenario = JSON.parse(await readFile(new URL(file, root), 'utf8'));
    assert.equal(scenario.synthetic, true, file);
    assert.equal(scenario.task, 'extraction', file);
    const sourceIds = new Set(scenario.source.sentences.map((sentence) => sentence.id));
    assert.equal(sourceIds.size, scenario.source.sentences.length, file);
    const reference = scenario.expected.referenceOutput;
    const covered = new Set(reference.irrelevantSentenceIds);
    const itemIds = new Set(reference.items.map((entry) => entry.id));
    assert.equal(itemIds.size, reference.items.length, file);
    for (const entry of reference.items) {
      assert.ok(entry.sentenceIds.length > 0, `${file}: ${entry.id}`);
      const sentences = entry.sentenceIds.map((id) => {
        assert.ok(sourceIds.has(id), `${file}: ${id}`);
        assert.ok(!reference.irrelevantSentenceIds.includes(id), `${file}: ${id}`);
        covered.add(id);
        return scenario.source.sentences.find((sentence) => sentence.id === id).text;
      });
      assert.ok(sentences.some((text) => text.includes(entry.written)), `${file}: ${entry.id}`);
      assert.equal(entry.inferred, false, `${file}: ${entry.id}`);
    }
    for (const id of covered) assert.ok(sourceIds.has(id), `${file}: ${id}`);
    assert.deepEqual([...covered].sort(), [...sourceIds].sort(), file);
    const nodes = new Map(reference.conditions.map((entry) => [entry.id, entry]));
    const unknowns = new Map(reference.unknowns.map((entry) => [entry.id, entry]));
    assert.equal(nodes.size, reference.conditions.length, file);
    assert.equal(unknowns.size, reference.unknowns.length, file);
    for (const entry of reference.items)
      if (entry.conditionNodeId !== null) assert.ok(nodes.has(entry.conditionNodeId), file);
    for (const node of nodes.values()) {
      if (node.kind === 'eq') {
        assert.ok(unknowns.has(node.unknownId), file);
        assert.ok(unknowns.get(node.unknownId).values.includes(node.value), file);
      } else {
        assert.ok(node.childIds.length >= (node.kind === 'not' ? 1 : 2), file);
        if (node.kind === 'not') assert.equal(node.childIds.length, 1, file);
        for (const child of node.childIds) assert.ok(nodes.has(child), file);
      }
    }
    const marks = new Map();
    const visit = (id) => {
      assert.notEqual(marks.get(id), 'visiting', `${file}: 条件の循環`);
      if (marks.get(id) === 'done') return;
      marks.set(id, 'visiting');
      for (const child of nodes.get(id).childIds) visit(child);
      marks.set(id, 'done');
    };
    for (const id of nodes.keys()) visit(id);
  }
});

test('条件の参照解は、取消しと振替の条件を取り違えない', async () => {
  const read = async (file) => JSON.parse(await readFile(new URL(file, root), 'utf8'));
  const evaluate = (nodes, id, answers) => {
    const node = nodes.find((entry) => entry.id === id);
    assert.ok(node);
    if (node.kind === 'eq')
      return answers[node.unknownId] === undefined ? 'unknown' : answers[node.unknownId] === node.value;
    const values = node.childIds.map((child) => evaluate(nodes, child, answers));
    if (node.kind === 'not') return values[0] === 'unknown' ? 'unknown' : !values[0];
    if (node.kind === 'and')
      return values.includes(false) ? false : values.includes('unknown') ? 'unknown' : true;
    return values.includes(true) ? true : values.includes('unknown') ? 'unknown' : false;
  };
  const football = (await read('02-football.json')).expected.referenceOutput.conditions;
  assert.equal(evaluate(football, 'play', { rain: 'はい', field: 'はい' }), false);
  assert.equal(evaluate(football, 'play', { rain: 'はい', field: 'いいえ' }), true);
  assert.equal(evaluate(football, 'play', { rain: 'いいえ', field: 'はい' }), true);
  assert.equal(evaluate(football, 'play', {}), 'unknown');
  const swimming = (await read('03-swimming.json')).expected.referenceOutput.conditions;
  assert.equal(evaluate(swimming, 'eligible', { absent: 'はい', ontime: 'はい', vacancy: 'はい' }), true);
  assert.equal(evaluate(swimming, 'eligible', { absent: 'はい', ontime: 'いいえ', vacancy: 'はい' }), false);
  assert.equal(evaluate(swimming, 'eligible', { absent: 'はい', ontime: 'はい' }), 'unknown');
  assert.equal(evaluate(swimming, 'check-acceptance', { absent: 'はい', ontime: 'はい', vacancy: 'はい' }), 'unknown');
  assert.equal(evaluate(swimming, 'check-acceptance', { absent: 'はい', ontime: 'はい', vacancy: 'はい', applied: 'はい' }), true);
});
