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

test('"Most Interesting" sorts by interest count, then newest first', async () => {
  const { sortQuestionsMostInteresting } = await helpers;
  const questions = [
    { text: 'old, no marks', created_at: '2026-01-01T10:00:00.000Z', interestCount: 0 },
    { text: 'old, two marks', created_at: '2026-01-01T10:05:00.000Z', interestCount: 2 },
    { text: 'new, two marks', created_at: '2026-01-01T10:10:00.000Z', interestCount: 2 },
    { text: 'five marks', created_at: '2026-01-01T10:15:00.000Z', interestCount: 5 },
    // A payload from an older server has no count; it ranks as zero.
    { text: 'new, no count', created_at: '2026-01-01T10:20:00.000Z' },
  ];
  assert.deepEqual(sortQuestionsMostInteresting(questions).map(q => q.text),
    ['five marks', 'new, two marks', 'old, two marks', 'new, no count', 'old, no marks']);
  assert.equal(questions[0].text, 'old, no marks');
});

test('clampNumericalValue keeps typed and slider values inside the question range', async () => {
  const { clampNumericalValue } = await helpers;
  assert.equal(clampNumericalValue(50, 0, 100), 50);
  assert.equal(clampNumericalValue('42', 0, 100), 42);
  assert.equal(clampNumericalValue(250, 0, 100), 100);
  assert.equal(clampNumericalValue(-5, 0, 100), 0);
  assert.equal(clampNumericalValue(5, 10, 20), 10);
  assert.equal(clampNumericalValue(-30, -20, -10), -20);
  assert.equal(clampNumericalValue(7.9, 0, 10), 7.9);
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

test('numerical answers keep two decimal places, including a typed decimal comma', async () => {
  const { clampNumericalValue } = await helpers;
  assert.equal(clampNumericalValue('0.5', 0, 100), 0.5);
  assert.equal(clampNumericalValue('.25', 0, 100), 0.25);
  assert.equal(clampNumericalValue('0,5', 0, 100), 0.5);
  assert.equal(clampNumericalValue('-0,25', -1, 1), -0.25);
  assert.equal(clampNumericalValue('33.337', 0, 100), 33.34);
  assert.equal(clampNumericalValue(0.004, 0, 100), 0);
  assert.equal(clampNumericalValue('100.4', 0, 100), 100);
  // Mid-typing input: a trailing point is the whole number so far, a trailing
  // comma is not a number yet.
  assert.equal(clampNumericalValue('0.', 0, 100), 0);
  assert.equal(clampNumericalValue('0,', 0, 100), null);
  // A rounded negative zero is plain zero, so it never shows as "-0".
  assert.ok(Object.is(clampNumericalValue(-0.001, -5, 5), 0));
  // Thousands separators are not guessed at.
  assert.equal(clampNumericalValue('1,000.5', 0, 5000), null);
});

test('numerical statistics show two decimals only where one would hide the answer', async () => {
  const { formatNumerical, parseNumericalVote } = await helpers;
  assert.equal(formatNumerical(0.345), '0.34');
  assert.equal(formatNumerical(0.5), '0.5');
  assert.equal(formatNumerical(3), '3');
  assert.equal(formatNumerical(32.46), '32.5');
  assert.equal(formatNumerical(-50), '-50');
  assert.equal(formatNumerical(-0.001), '0');
  assert.equal(formatNumerical(null), '—');
  assert.equal(formatNumerical(undefined), '—');
  assert.equal(parseNumericalVote('0.5'), 0.5);
  assert.equal(parseNumericalVote(70), 70);
  assert.ok(Number.isNaN(parseNumericalVote('')));
  assert.ok(Number.isNaN(parseNumericalVote('Agree')));
});

test('a decimal answer lands in the histogram bin of the nearest whole number on a short scale', async () => {
  const { numericalBinIndex } = await helpers;
  // 0 to 5 has one bin per whole number.
  assert.deepEqual([0, 0.4, 0.5, 4.2, 4.6, 5].map(v => numericalBinIndex(v, 0, 5, 6)), [0, 0, 1, 4, 5, 5]);
  // Whole numbers go where they always did.
  assert.deepEqual([1, 2, 3, 4, 5].map(v => numericalBinIndex(v, 1, 5, 5)), [0, 1, 2, 3, 4]);
  // 0 to 100 is cut into ten equal bins; the last includes the maximum.
  assert.deepEqual([0, 0.5, 9.99, 10, 99.5, 100].map(v => numericalBinIndex(v, 0, 100, 10)), [0, 0, 0, 1, 9, 9]);
  // Out-of-range values (older data) are clamped into the end bins.
  assert.deepEqual([-3, 140].map(v => numericalBinIndex(v, 0, 100, 10)), [0, 9]);
});

test('validateChoiceOptions matches the server rules for Multiple Choice options', async () => {
  const { validateChoiceOptions } = await helpers;
  const limits = { MIN_OPTIONS: 2, MAX_OPTIONS: 6, MAX_OPTION_LENGTH: 100 };
  assert.deepEqual(validateChoiceOptions([' Higher ', 'Lower', 'About   the same'], limits),
    { options: ['Higher', 'Lower', 'About the same'] });
  assert.match(validateChoiceOptions(['Higher', '  '], limits).error, /Fill in every/);
  assert.match(validateChoiceOptions(['Only one'], limits).error, /2 to 6/);
  assert.match(validateChoiceOptions(['a', 'b', 'c', 'd', 'e', 'f', 'g'], limits).error, /2 to 6/);
  assert.match(validateChoiceOptions(['Higher', 'x'.repeat(101)], limits).error, /100 characters/);
  assert.match(validateChoiceOptions(['Higher', 'higher'], limits).error, /different/);
  assert.match(validateChoiceOptions(undefined, limits).error, /2 to 6/);
});

test('numerical question forms and server accept the full database range and reject invalid bounds', async () => {
  const { validateNumericalRange } = await helpers;
  const { normalizeQuestionPayload } = require('../question-data');
  const question = { text: 'Temperature?', type: 'Numerical' };
  for (const [minValue, maxValue] of [['-2147483648', '2147483647'], ['-10', '0']]) {
    const expected = { minValue: Number(minValue), maxValue: Number(maxValue) };
    assert.deepEqual(validateNumericalRange(minValue, maxValue), expected);
    const stored = normalizeQuestionPayload({ ...question, minValue, maxValue });
    assert.equal(stored.minValue, expected.minValue);
    assert.equal(stored.maxValue, expected.maxValue);
  }
  for (const [minValue, maxValue] of [['', 10], [-10, ''], [-1.5, 0], [-2147483649, 0], [0, 2147483648], [1, 1], [2, 1]]) {
    assert.ok(validateNumericalRange(minValue, maxValue).error);
    assert.equal(normalizeQuestionPayload({ ...question, minValue, maxValue }), null);
  }
});
