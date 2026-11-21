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
  for (const text of ['2 * 3 * 4', '2 ** 3', 'a*b*c', 'é*word*', '\\*escaped*', '*unfinished', '* padded *', '**trailing **', '**mismatch*', '*mismatch**', '***both***', '_word_', '[source](url)']) {
    assert.deepEqual(promptParts(text), [{ type: 'text', text }]);
  }
});

test('preserves separators between runs and around single-character emphasis', async () => {
  const { promptParts } = await emphasis;
  assert.deepEqual(promptParts('*a*🌟**b**'), [
    { type: 'em', text: 'a' }, { type: 'text', text: '🌟' }, { type: 'strong', text: 'b' },
  ]);
});

test('combining marks are part of words on either side of emphasis markers', async () => {
  const { promptParts } = await emphasis;
  for (const text of ['e\u0301*word*', 'दे**word**', '*word*\u0301']) {
    assert.deepEqual(promptParts(text), [{ type: 'text', text }]);
  }
  assert.deepEqual(promptParts('*दे*'), [{ type: 'em', text: 'दे' }]);
});
