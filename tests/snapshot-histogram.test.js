const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildOpinionSnapshot } = require('../opinion-snapshots');

const helpers = import('../client/src/questions/questionHelpers.mjs');
const live = readFileSync(require.resolve('../client/src/questions/NumericalResults.jsx'), 'utf8');
const rangeExpression = live.match(/const range = (.*);/)[1];
const countExpression = live.match(/const binCount = (.*);/)[1];
const liveBinCount = (minValue, maxValue) => vm.runInNewContext(
  `const range = ${rangeExpression}; ${countExpression};`, { minValue, maxValue }
);

for (const [min, max, values] of [
  [0, 5, [0, .49, .5, .51, 1.49, 1.5, 4.49, 4.5, 5]],
  [-3, 3, [-3, -2.51, -2.5, -.5, 0, .5, 2.5, 3]],
  [1, 5, [1, 1.49, 1.5, 2.5, 4.5, 5]],
  [0, 1, [0, .49, .5, .51, 1]],
  [1, 10, [1, 1.5, 5.49, 5.5, 9.5, 10]],
  [-10, 0, [-10, -9.99, -9, -.5, 0]],
  [0, 100, [0, .5, 9.99, 10, 99.5, 100]],
  [0, 11, [0, 1.1, 2.2, 3.3, 4.4, 5.5, 9.9, 11]],
  [-5, 5, [-5, -4.5, -4, 0, 4.99, 5]],
]) {
  test(`new ${min}–${max} snapshots use the same bins as the live decimal histogram`, async () => {
    const { numericalBinIndex } = await helpers;
    const binCount = liveBinCount(min, max);
    const counts = new Array(binCount).fill(0);
    values.forEach(value => { counts[numericalBinIndex(value, min, max, binCount)]++; });
    const question = { id: 7, text: 'Synthetic scale', type: 'Numerical', min_value: min, max_value: max,
      votes: values.map((value, id) => ({ id, user_id: `fictional-${id}`, value: String(value) })) };
    const snapshot = buildOpinionSnapshot([question]).questions[0];
    assert.deepEqual(snapshot.distribution.map(bin => bin.count), counts);
    assert.equal(snapshot.responseCount, values.length);
    assert.equal(snapshot.distribution[0].min, min);
    assert.equal(snapshot.distribution.at(-1).max, max);
    for (let i = 1; i < snapshot.distribution.length; i++) {
      assert.equal(snapshot.distribution[i].min, snapshot.distribution[i - 1].max, 'bin edges remain contiguous');
    }
  });
}

test('historical and new short-scale snapshots must not compare incompatible bins by index', () => {
  const source = readFileSync(require.resolve('../client/src/OpinionSnapshots.jsx'), 'utf8');
  const start = source.indexOf('export function snapshotQuestionChanged(');
  const end = source.indexOf('\nfunction DistributionCell', start);
  const changed = vm.runInNewContext(source.slice(start, end).replace('export function', 'function') + '\nsnapshotQuestionChanged;');
  const base = { id: 7, text: 'Synthetic scale', type: 'Numerical', minValue: 0, maxValue: 5 };
  const historical = { ...base, distribution: Array.from({ length: 5 }, (_, i) => ({ min: i, max: i + 1, count: 1 })) };
  const current = { ...base, distribution: Array.from({ length: 6 }, (_, i) => ({ min: Math.max(0, i - .5), max: Math.min(5, i + .5), count: 1 })) };
  const serialized = JSON.stringify(historical);
  assert.equal(changed(historical, current), true);
  assert.equal(changed(historical, { ...historical, responseCount: 99 }), false);
  assert.equal(JSON.stringify(historical), serialized);
});
