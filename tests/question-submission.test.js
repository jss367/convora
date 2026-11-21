const assert = require('node:assert/strict');
const { test } = require('node:test');
const model = import('../client/src/questions/composerLifecycle.mjs');

async function composer(draft = {}, adminToken = null) {
  const { initialComposerState, composerReducer, createQuestionSubmission } = await model;
  let state = initialComposerState();
  state.draft = { ...state.draft, text: 'Original', ...draft };
  const sent = [], errors = [];
  const socket = {
    timeout(ms) { assert.equal(ms, 10000); return this; },
    emit(event, room, question, force, token, ack) { sent.push({ event, room, question, force, token, ack }); },
  };
  const session = { socket, discussionSlug: 'room', adminToken };
  const dispatch = action => { state = composerReducer(state, action); };
  const send = createQuestionSubmission(dispatch, error => errors.push(error));
  return {
    sent, errors, session, dispatch, get state() { return state; },
    submit: (force = false) => send(state, session, force),
    ack: (...args) => sent.at(-1).ack(...args),
    text: text => dispatch({ type: 'text', text, isAdmin: !!session.adminToken }),
    choose: (field, value) => dispatch({ type: 'chooseSetting', field, value }),
  };
}

test('submit emits one normalized addQuestion and resets the entire untouched draft only after ack', async () => {
  const form = await composer({ text: ' Range? ', type: 'Numerical', minValue: '-20', maxValue: '80' }, 'token');
  const original = form.state.draft;
  form.submit();
  form.submit();
  assert.equal(form.sent.length, 1);
  const { event, room, force, token, question } = form.sent[0];
  assert.deepEqual([event, room, force, token], ['addQuestion', 'room', false, 'token']);
  assert.equal(typeof question.timestamp, 'number');
  assert.deepEqual(question, { text: 'Range?', type: 'Numerical', minValue: -20, maxValue: 80,
    timestamp: question.timestamp, maxResponses: undefined, showAttribution: undefined });
  assert.equal(form.state.draft, original);
  form.ack(null, { added: true });
  assert.deepEqual(form.state.draft, { text: '', type: 'Agreement', minValue: 0, maxValue: 100, options: ['', ''], typeChosen: false });
});

for (const [name, draft, message] of [
  ['blank text', { text: '   ' }, /cannot be empty/],
  ['invalid bounds', { type: 'Numerical', minValue: '' }, /whole numbers/],
  ['reversed bounds', { type: 'Numerical', minValue: 10, maxValue: 1 }, /less than maximum/],
  ['empty choices', { type: 'Multiple Choice' }, /Fill in at least 2/],
  ['duplicate choices', { type: 'Multiple Choice', options: [' A ', 'a'] }, /must be different/],
]) {
  test(`validation keeps ${name} on the form without emitting`, async () => {
    const form = await composer(draft);
    const original = form.state.draft;
    form.submit();
    assert.match(form.errors.at(-1), message);
    assert.equal(form.state.draft, original);
    assert.equal(form.sent.length, 0);
  });
}

for (const [label, draft, edit] of [
  ['wording', {}, form => form.text('New wording')],
  ['type', {}, form => form.choose('type', 'Yes/No')],
  ['minimum', { type: 'Numerical' }, form => form.choose('minValue', '-10')],
  ['maximum', { type: 'Numerical' }, form => form.choose('maxValue', '20')],
  ['choices', { type: 'Multiple Choice', options: ['Higher', 'Lower'] }, form => form.dispatch({ type: 'options', options: ['Up', 'Down'] })],
  ['response limit', { type: 'Open Ended' }, form => form.choose('maxResponses', '3')],
  ['attribution', { type: 'Open Ended' }, form => form.choose('showAttribution', false)],
]) {
  test(`a late ack cannot erase edits to ${label}, including when confirming an older prompt`, async () => {
    const form = await composer(draft);
    form.submit();
    const question = form.sent[0].question;
    edit(form);
    const edited = form.state.draft;
    form.ack(null, { added: true });
    assert.equal(form.state.draft, edited);

    form.dispatch({ type: 'similarPrompt', prompt: { candidate: 'Similar', question } });
    form.submit(true);
    assert.equal(form.state.similarPrompt, null);
    assert.equal(form.sent[1].question, question);
    assert.equal(form.sent[1].force, true);
    form.ack(null, { added: true });
    assert.equal(form.state.draft, edited);
    form.submit();
    form.ack(null, { added: true });
    assert.equal(form.state.draft.text, '');
  });
}

test('a similarity bounce permits dismissal or forced re-post of the server payload', async () => {
  const form = await composer({ text: ' Choose ', type: 'Multiple Choice', options: [' High ', 'Very   low'] });
  form.submit();
  assert.deepEqual(form.sent[0].question.options, ['High', 'Very low']);
  const question = { text: 'Choose', type: 'Multiple Choice', options: ['High', 'Very low'] };
  const prompt = { candidate: 'Choose again', question };
  const original = form.state.draft;
  form.dispatch({ type: 'similarPrompt', prompt });
  form.ack(null, { added: false, reason: 'similar' });
  assert.equal(form.state.draft, original);
  assert.equal(form.errors.at(-1), null);
  form.dispatch({ type: 'similarPrompt', prompt: null });
  form.submit(true);
  assert.equal(form.sent.length, 1);
  form.submit();
  form.dispatch({ type: 'similarPrompt', prompt });
  form.ack(null, { added: false, reason: 'similar' });
  form.submit(true);
  assert.equal(form.sent[2].question, question);
  assert.equal(form.sent[2].force, true);
  assert.equal(form.state.draft, original);
  form.ack(null, { added: true });
  assert.equal(form.state.draft.text, '');
});

test('a suggestion requests private delivery and confirms review only on a successful ack', async () => {
  const form = await composer();
  form.session.approvalRequired = true;
  form.submit();
  assert.equal(form.sent[0].question.queued, true);
  assert.ok(!form.state.suggestionSent);
  form.ack(null, { added: true, queued: true, suggested: true });
  assert.equal(form.state.suggestionSent, true);
  assert.equal(form.state.draft.text, '');
  form.text('Something else');
  assert.equal(form.state.suggestionSent, false);
});

test('queue preference survives ack, but demotion cannot turn a private draft into a public one', async () => {
  const form = await composer({}, 'moderator');
  form.dispatch({ type: 'queue', queued: true });
  form.submit();
  assert.equal(form.sent[0].question.queued, true);
  form.ack(null, { added: true });
  assert.equal(form.state.queueNewQuestions, true);
  form.text('Next private agenda item');
  form.session.adminToken = null;
  form.text('Edited after demotion');
  form.submit();
  assert.match(form.errors.at(-1), /private to the moderator queue/);
  assert.equal(form.sent.length, 1);
  form.text('');
  form.text('New participant question');
  form.submit();
  assert.equal(form.sent[1].question.queued, undefined);
  assert.equal(form.sent[1].token, null);
});

for (const [name, ack, message] of [
  ['moderator-only', [null, { reason: 'moderator_only' }], /Only the moderator/],
  ['unauthorized', [null, { reason: 'not_authorized' }], /to the queue/],
  ['locked', [null, { reason: 'locked' }], /discussion is locked/],
  ['missing reply', [null, undefined], /Could not add the question/],
  ['timeout', [new Error('timeout')], /Check the discussion/],
]) {
  test(`${name} leaves the draft retryable`, async () => {
    const form = await composer();
    form.submit();
    form.ack(...ack);
    assert.equal(form.state.draft.text, 'Original');
    assert.match(form.errors.at(-1), message);
    form.submit();
    assert.equal(form.sent.length, 2);
    assert.equal(form.errors.at(-1), null);
  });
}
