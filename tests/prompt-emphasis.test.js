const assert = require('node:assert/strict');
const { test } = require('node:test');
const emphasis = import('../client/src/questions/promptEmphasis.mjs');

test('prompts recognize single- and double-star phrases with surrounding punctuation', async () => {
  const { plainPrompt, promptParts } = await emphasis;
  const text = '“*Could* it?” or “Would it **even try**?”';
  assert.deepEqual(promptParts(text), [
    { type: 'text', text: '“' }, { type: 'em', text: 'Could' }, { type: 'text', text: ' it?” or “Would it ' },
    { type: 'strong', text: 'even try' }, { type: 'text', text: '?”' },
  ]);
  assert.equal(plainPrompt(text), '“Could it?” or “Would it even try?”');
});

test('ordinary stars, incomplete delimiters and unsupported markup stay literal', async () => {
  const { promptParts } = await emphasis;
  for (const text of ['2 * 3 * 4', '2 ** 3', 'a*b*c', '*unfinished', '* padded *', '**mismatch*', '*mismatch**', '***both***', '_word_', '[source](url)']) {
    assert.deepEqual(promptParts(text), [{ type: 'text', text }]);
  }
});
