const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the actual event handler with delayed acknowledgments, without a
// network listener or database. Keep UI state and the Socket.IO boundary fake.
function setup() {
  const source = fs.readFileSync(require.resolve('../client/src/DiscussionPage.jsx'), 'utf8');
  const start = source.indexOf('    const submitQuestion =');
  const end = source.indexOf('    const handlePostAnyway =', start);
  const state = { draft: 'Original', sent: [], error: null };
  const context = {
    questionPendingRef: { current: false }, discussionSlug: 'room', adminToken: null,
    QuestionTypes: { AGREEMENT: 'Agreement' }, console,
    setError: value => { state.error = value; },
    setNewQuestion: update => { state.draft = update(state.draft); },
    setQuestionType() {}, setMinValue() {}, setMaxValue() {},
    socket: {
      timeout(ms) { assert.equal(ms, 10000); return this; },
      emit(...args) { state.sent.push(args); },
    },
  };
  const submit = vm.runInNewContext(`${source.slice(start, end)}\nsubmitQuestion`, context);
  return { state, submit, ack: (...args) => state.sent.at(-1).at(-1)(...args) };
}

test('question submissions wait for acknowledgment and preserve a newer draft', () => {
  const { state, submit, ack } = setup();
  submit({ text: 'Original' }, false);
  submit({ text: 'Original' }, false);
  assert.equal(state.sent.length, 1);
  state.draft = 'Next question';
  ack(null, { added: true });
  assert.equal(state.draft, 'Next question');
  submit({ text: 'Next question' }, false);
  assert.equal(state.sent.length, 2);
  ack(null, { added: true });
  assert.equal(state.draft, '');
});

test('rejected or interrupted question submissions retain the draft and allow recovery', () => {
  const { state, submit, ack } = setup();
  submit({ text: 'Original' }, false);
  ack(null, { added: false, reason: 'similar' });
  assert.equal(state.draft, 'Original');
  submit({ text: 'Original' }, true);
  assert.equal(state.sent.length, 2);
  ack(new Error('timeout'));
  assert.equal(state.draft, 'Original');
  assert.match(state.error, /Check the discussion/);
  submit({ text: 'Original' }, false);
  assert.equal(state.sent.length, 3);
});
