const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeQuestionPayload, normalizeQuestionTools } = require('../question-data');

test('private tools default off; type changes discard settings that no longer apply', () => {
  const all = ['explanation', 'clarification', 'suggestion', 'suggestion'];
  assert.deepEqual(normalizeQuestionTools([], 'Agreement'), []);
  assert.deepEqual(normalizeQuestionTools(all, 'Multiple Choice'), ['clarification', 'explanation', 'suggestion']);
  for (const type of ['Yes/No', 'Agreement', 'Numerical']) {
    assert.deepEqual(normalizeQuestionTools(all, type), ['clarification', 'explanation']);
  }
  assert.deepEqual(normalizeQuestionTools(all, 'Open Ended'), ['clarification']);
  for (const tools of [true, 'suggestion', ['unknown'], [null]]) {
    assert.equal(normalizeQuestionPayload({ text: 'Test', type: 'Yes/No', tools }), null);
  }
});
