const assert = require('node:assert/strict');
const { test } = require('node:test');
const { escapeCsv, responsesCsv } = require('../discussion-export');

test('cells that start with a tab or line break are neutralized like formulas', () => {
  assert.equal(escapeCsv('\t=1+1'), `"'\t=1+1"`);
  assert.equal(escapeCsv('\r=1+1'), `"'\r=1+1"`);
  assert.equal(escapeCsv('\n=1+1'), `"'\n=1+1"`);
  assert.equal(escapeCsv('=1+1'), `"'=1+1"`);
  assert.equal(escapeCsv(-3), '"-3"');
  assert.equal(escapeCsv('plain'), '"plain"');
});

test('written answers are exported exactly as typed, even when they look like JSON', () => {
  const discussion = { topic: 'Export' };
  const vote = value => ({ id: 1, pseudonym: 'Ana', value, created_at: null });
  const csv = responsesCsv(discussion, [
    { id: 1, text: 'Open', type: 'Open Ended', created_at: null, votes: [vote('null'), vote('{"a":1}'), vote('007')] },
    { id: 2, text: 'Ideas', type: 'Brainstorm', created_at: null, votes: [vote('true')] },
    { id: 3, text: 'Range', type: 'Numerical', created_at: null, votes: [vote('7')] },
  ]);
  const values = csv.split('\n').slice(1).map(line => line.split(',').at(-2));
  assert.deepEqual(values, ['"null"', '"{""a"":1}"', '"007"', '"true"', '"7"']);
});
