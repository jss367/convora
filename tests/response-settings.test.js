const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeQuestionPayload } = require('../question-data');

test('free-text settings default to unlimited attributed responses and reject invalid limits', () => {
  const base = { text: 'Suggestions', type: 'Open Ended' };
  assert.equal(normalizeQuestionPayload(base).maxResponses, null);
  assert.equal(normalizeQuestionPayload(base).showAttribution, true);
  for (const limit of [0, -1, 1.5, '2abc', 2147483648]) {
    assert.equal(normalizeQuestionPayload({ ...base, maxResponses: limit }), null);
  }
  assert.equal(normalizeQuestionPayload({ ...base, maxResponses: '2' }).maxResponses, 2);
  assert.equal(normalizeQuestionPayload({ ...base, showAttribution: false }).showAttribution, false);
  assert.equal(normalizeQuestionPayload({ ...base, showAttribution: 'false' }), null);
  assert.equal(normalizeQuestionPayload({ ...base, type: 'Brainstorm' }).type, 'Open Ended');
});

test('legacy Brainstorm creation keeps its hidden attribution default', () => {
  const legacy = { text: 'Legacy ideas', type: 'Brainstorm' };
  assert.equal(normalizeQuestionPayload(legacy).showAttribution, false);
  assert.equal(normalizeQuestionPayload({ ...legacy, showAttribution: true }).showAttribution, true);
  assert.equal(normalizeQuestionPayload({ ...legacy, showAttribution: false }).showAttribution, false);
  assert.equal(normalizeQuestionPayload({ text: 'New written prompt', type: 'Open Ended' }).showAttribution, true);
});

test('other question types ignore retained free-text response limits', () => {
  for (const type of ['Agreement', 'Yes/No', 'Numerical', 'Multiple Choice']) {
    for (const maxResponses of [0, -1, 'invalid', 1.5]) {
      const normalized = normalizeQuestionPayload({ text: 'A prompt', type, maxResponses, minValue: 0, maxValue: 100, options: ['A', 'B'] });
      assert.ok(normalized, `${type} ignores ${maxResponses}`);
      assert.equal(normalized.maxResponses, null);
    }
  }
});
