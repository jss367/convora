const assert = require('node:assert/strict');
const { test } = require('node:test');

const helpers = import('../client/src/questions/questionHelpers.mjs');

test('"Most Recent" sorts by the server created_at, newest first', async () => {
  const { sortQuestionsMostRecent } = await helpers;
  // A late joiner receives every question in one snapshot, so the client-side
  // receipt timestamp is identical across them and must not decide the order.
  const receivedAt = Date.parse('2026-01-01T12:00:00.000Z');
  const questions = [
    { id: 1, text: 'A', created_at: '2026-01-01T10:00:00.000Z', timestamp: receivedAt },
    { id: 2, text: 'B', created_at: '2026-01-01T10:05:00.000Z', timestamp: receivedAt },
    { id: 3, text: 'C', created_at: '2026-01-01T10:10:00.000Z', timestamp: receivedAt },
  ];
  assert.deepEqual(sortQuestionsMostRecent(questions).map(q => q.text), ['C', 'B', 'A']);
  // The input list is left untouched.
  assert.deepEqual(questions.map(q => q.text), ['A', 'B', 'C']);
});

test('created_at wins over a conflicting client timestamp', async () => {
  const { getQuestionSortTime, sortQuestionsMostRecent } = await helpers;
  // The older question reached this browser later (e.g. after a reconnect), so
  // its client timestamp is larger; the server time must still decide.
  const older = { text: 'older', created_at: '2026-01-01T10:00:00.000Z', timestamp: 9_999_999_999_999 };
  const newer = { text: 'newer', created_at: '2026-01-01T11:00:00.000Z', timestamp: 1 };
  assert.equal(getQuestionSortTime(older), Date.parse('2026-01-01T10:00:00.000Z'));
  assert.deepEqual(sortQuestionsMostRecent([older, newer]).map(q => q.text), ['newer', 'older']);
});

test('the client timestamp is only a fallback when created_at is missing or invalid', async () => {
  const { getQuestionSortTime } = await helpers;
  assert.equal(getQuestionSortTime({ timestamp: 1234 }), 1234);
  assert.equal(getQuestionSortTime({ created_at: null, timestamp: 1234 }), 1234);
  assert.equal(getQuestionSortTime({ created_at: 'not a date', timestamp: 1234 }), 1234);
  assert.equal(getQuestionSortTime({}), 0);
  assert.equal(getQuestionSortTime({ created_at: 'not a date' }), 0);
});

test('clampNumericalValue keeps typed and slider values inside the question range', async () => {
  const { clampNumericalValue } = await helpers;
  assert.equal(clampNumericalValue(50, 0, 100), 50);
  assert.equal(clampNumericalValue('42', 0, 100), 42);
  assert.equal(clampNumericalValue(250, 0, 100), 100);
  assert.equal(clampNumericalValue(-5, 0, 100), 0);
  assert.equal(clampNumericalValue(5, 10, 20), 10);
  assert.equal(clampNumericalValue(-30, -20, -10), -20);
  assert.equal(clampNumericalValue(7.9, 0, 10), 7);
  assert.equal(clampNumericalValue('1e2', 0, 100), 100);
  assert.equal(clampNumericalValue('1e', 0, 100), null);
  // A real zero is a value, not "unset".
  assert.equal(clampNumericalValue(0, 0, 100), 0);
});

test('clampNumericalValue reports "nothing selected" as null', async () => {
  const { clampNumericalValue } = await helpers;
  for (const raw of [undefined, null, '', '   ', '-', 'abc', NaN]) {
    assert.equal(clampNumericalValue(raw, 0, 100), null, `expected null for ${String(raw)}`);
  }
});

test('signed drafts stay unset until digits arrive and clamp independently of the raw text', async () => {
  const { clampNumericalValue } = await helpers;
  const drafts = ['-', '-1', '-15', '-150'];
  assert.deepEqual(drafts.map(raw => clampNumericalValue(raw, -100, 100)), [null, -1, -15, -100]);
  assert.deepEqual(drafts, ['-', '-1', '-15', '-150']);
});
