const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

const defaultDraft = () => ({ text: 'Original', type: 'Agreement', minValue: 0, maxValue: 100 });

// Exercise the actual event handler with delayed acknowledgments, without a
// network listener or database. Keep UI state and the Socket.IO boundary fake.
function setup(draft = defaultDraft()) {
  const source = fs.readFileSync(require.resolve('../client/src/DiscussionPage.jsx'), 'utf8');
  const start = source.indexOf('    const submitQuestion =');
  const end = source.indexOf('    const handlePostAnyway =', start);
  const state = { draft, sent: [], error: null };
  const context = {
    questionDraft: draft,
    questionPendingRef: { current: false }, discussionSlug: 'room', adminToken: null,
    QuestionTypes: { AGREEMENT: 'Agreement', NUMERICAL: 'Numerical' }, console,
    setError: value => { state.error = value; },
    setQuestionDraft: update => { state.draft = update(state.draft); },
    socket: {
      timeout(ms) { assert.equal(ms, 10000); return this; },
      emit(...args) { state.sent.push(args); },
    },
  };
  const handler = vm.runInNewContext(`${source.slice(start, end)}\nsubmitQuestion`, context);
  const submit = (question = { ...state.draft }, force = false) => {
    context.questionDraft = state.draft;
    handler(question, force);
  };
  return { state, submit, ack: (...args) => state.sent.at(-1).at(-1)(...args) };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('question submissions wait for acknowledgment and reset an untouched draft atomically', () => {
  const { state, submit, ack } = setup({ text: 'Original', type: 'Numerical', minValue: -20, maxValue: 80 });
  submit();
  submit();
  assert.equal(state.sent.length, 1);
  ack(null, { added: true });
  assert.deepEqual(plain(state.draft), { text: '', type: 'Agreement', minValue: 0, maxValue: 100 });
});

for (const [label, edits] of [
  ['newer prompt, type, and range', { text: 'Next question', type: 'Numerical', minValue: -10, maxValue: 20 }],
  ['settings-only type and range edits', { type: 'Numerical', minValue: -10, maxValue: 20 }],
  ['settings-only minimum edit', { minValue: -10 }],
  ['settings-only maximum edit', { maxValue: 200 }],
]) {
  test(`delayed acknowledgment preserves ${label}`, () => {
    const initial = { ...defaultDraft(), type: /minimum|maximum/.test(label) ? 'Numerical' : 'Agreement' };
    const { state, submit, ack } = setup(initial);
    submit();
    const nextDraft = { ...state.draft, ...edits };
    state.draft = nextDraft;
    ack(null, { added: true });
    assert.strictEqual(state.draft, nextDraft);
    submit();
    assert.equal(state.sent.length, 2);
    assert.deepEqual(plain(state.sent[1][2]), nextDraft);
    ack(null, { added: true });
    assert.equal(state.draft.text, '');
  });
}

test('Post Anyway acknowledgment preserves a draft different from the older similarity prompt', () => {
  const { state, submit, ack } = setup();
  const nextDraft = { text: 'Next question', type: 'Numerical', minValue: -10, maxValue: 20 };
  state.draft = nextDraft;
  submit(defaultDraft(), true);
  ack(null, { added: true });
  assert.strictEqual(state.draft, nextDraft);
});

test('Post Anyway acknowledgment preserves settings-only edits to a numerical similarity prompt', () => {
  const original = { text: 'Original', type: 'Numerical', minValue: 0, maxValue: 100 };
  const { state, submit, ack } = setup(original);
  state.draft = { ...original, minValue: -20 };
  const nextDraft = state.draft;
  submit(original, true);
  ack(null, { added: true });
  assert.strictEqual(state.draft, nextDraft);
});

test('rejected or interrupted question submissions retain the draft and allow recovery', () => {
  const { state, submit, ack } = setup();
  const original = state.draft;
  submit();
  ack(null, { added: false, reason: 'similar' });
  assert.strictEqual(state.draft, original);
  submit({ ...original }, true);
  assert.equal(state.sent.length, 2);
  ack(new Error('timeout'));
  assert.strictEqual(state.draft, original);
  assert.match(state.error, /Check the discussion/);
  submit();
  assert.equal(state.sent.length, 3);
});
