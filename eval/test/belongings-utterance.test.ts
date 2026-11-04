// 開発用場面の形と採点の試験。読み取りは偽物で、モデルの能力を示さない。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  belongingsCases,
  fixtureUtterance,
  passedBelongingsCase,
  runBelongingsCase,
} from '../belongings-utterance';

test('製品の計画を前提に、架空の九場面を通信せずに再生できる', async () => {
  assert.equal(belongingsCases.length, 9);
  for (const scenario of belongingsCases) {
    let calls = 0;
    const fake = fixtureUtterance(scenario);
    const result = await runBelongingsCase(scenario, async (input) => {
      calls += 1;
      assert.equal('expected' in input, false);
      assert.ok(input.unknowns.some((u) => u.id === 'u-atHome:n1:i5'));
      return fake(input);
    });
    assert.equal(calls, 1, scenario.id);
    assert.equal(result.result, 'observed', scenario.id);
    assert.equal(result.targetMatches, true, scenario.id);
    assert.equal(result.previewNoWrite, true, scenario.id);
    assert.equal(result.screen, 'not_run', scenario.id);
    if (scenario.expected.type === 'question') {
      assert.equal(result.confirmation, 'not_applicable', scenario.id);
      assert.equal(result.stateAfter, 'not_checked', scenario.id);
    } else if (scenario.expected.type === 'answer') {
      assert.equal(result.confirmation, 'blocked', scenario.id);
      assert.equal(result.blockedReason, 'otherUnknowns', scenario.id);
      assert.equal(result.stateAfter, 'unchanged', scenario.id);
    } else {
      assert.equal(result.confirmation, 'ok', scenario.id);
      assert.equal(result.stateAfter, 'matches', scenario.id);
    }
    assert.equal(passedBelongingsCase(scenario, result), true, scenario.id);
    if (scenario.id === 'home-correct-no') {
      assert.equal(result.context?.unknowns.find((u) => u.id === 'u-atHome:n1:i5')?.answer, 'yes');
    }
    if (scenario.id === 'bought-found-home' || scenario.id === 'bought-missing') {
      assert.equal(result.context?.unknowns.find((u) => u.id === 'u-atHome:n1:i5')?.answer, null);
    }
    if (scenario.id === 'same-name-dated') {
      assert.ok(result.context?.unknowns.some((u) => u.id === 'u-atHome:n1:i5'));
      assert.ok(result.context?.unknowns.some((u) => u.id === 'u-atHome:u1:i1'));
    }
  }
});

test('買った後の場面に買った記録がなければ、読み取りを呼ばず未実施とする', async () => {
  const scenario = belongingsCases.find((entry) => entry.id === 'bought-missing');
  assert.ok(scenario);
  let calls = 0;
  const result = await runBelongingsCase({ ...scenario, stage: 'arrived' }, async () => {
    calls += 1;
    throw new Error('読み取りは呼ばない');
  });
  assert.equal(calls, 0);
  assert.equal(result.result, 'incomplete');
  assert.equal(result.reason, 'fixture_bought');
});

test('答えを取り違えた候補は合格にせず、確認を実行しない', async () => {
  const scenario = belongingsCases.find((entry) => entry.id === 'home-yes');
  assert.ok(scenario);
  const fake = fixtureUtterance(scenario);
  const result = await runBelongingsCase(scenario, async (context) => {
    const reading = await fake(context);
    const action = reading.output.actions[0];
    assert.ok(action);
    action.value = 'no';
    return reading;
  });
  assert.equal(result.result, 'observed');
  assert.equal(result.targetMatches, false);
  assert.equal(result.previewNoWrite, true);
  assert.equal(result.confirmation, 'not_applicable');
  assert.equal(result.stateAfter, 'not_checked');
  assert.equal(passedBelongingsCase(scenario, result), false);
});

test('記録を塞ぐ場面は、対象・理由・書かれていない事を別々に確かめる', async () => {
  const scenario = belongingsCases.find((entry) => entry.id === 'home-yes');
  assert.ok(scenario);
  const result = await runBelongingsCase(scenario, fixtureUtterance(scenario));
  assert.equal(passedBelongingsCase(scenario, result), true);
  assert.equal(passedBelongingsCase(scenario, { ...result, blockedReason: 'missing' }), false);
  assert.equal(
    passedBelongingsCase(scenario, { ...result, confirmation: 'unexpected_available' }),
    false,
  );
  assert.equal(passedBelongingsCase(scenario, { ...result, stateAfter: 'mismatch' }), false);
  assert.equal(passedBelongingsCase(scenario, { ...result, previewNoWrite: false }), false);
});
