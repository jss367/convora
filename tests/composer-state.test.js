const assert = require('node:assert/strict');
const { test } = require('node:test');
const composer = import('../client/src/questions/composerLifecycle.mjs');

test('on phones only a loaded empty room auto-expands; opening pins the form until navigation', async () => {
  const { initialComposerState, isComposerCollapsed, composerReducer } = await composer;
  let state = initialComposerState();
  const dispatch = type => { state = composerReducer(state, { type }); };
  assert.equal(isComposerCollapsed(state, 0), true);
  dispatch('questionsLoaded');
  assert.equal(isComposerCollapsed(state, 0), false);
  assert.equal(isComposerCollapsed(state, 1), true);
  dispatch('open');
  dispatch('questionsLoaded');
  assert.equal(isComposerCollapsed(state, 2), false);
  dispatch('roomChanged');
  assert.equal(isComposerCollapsed(state, 0), true);
  dispatch('questionsLoaded');
  assert.equal(isComposerCollapsed(state, 1), true);
});

test('the type follows wording until a deliberate picker or settings change', async () => {
  const { initialComposerState, composerReducer } = await composer;
  let state = initialComposerState();
  const dispatch = action => { state = composerReducer(state, action); };
  dispatch({ type: 'text', text: 'How many people will attend?', isAdmin: false });
  assert.equal(state.draft.type, 'Numerical');
  dispatch({ type: 'text', text: 'A statement', isAdmin: false });
  assert.equal(state.draft.type, 'Agreement');
  dispatch({ type: 'chooseSetting', field: 'type', value: 'Multiple Choice' });
  dispatch({ type: 'options', options: ['Tea', 'Coffee'] });
  dispatch({ type: 'chooseSetting', field: 'type', value: 'Numerical' });
  dispatch({ type: 'chooseSetting', field: 'maxValue', value: '50' });
  dispatch({ type: 'text', text: 'Why now?', isAdmin: false });
  assert.equal(state.draft.type, 'Numerical');
  dispatch({ type: 'chooseSetting', field: 'type', value: 'Multiple Choice' });
  assert.deepEqual(state.draft.options, ['Tea', 'Coffee']);
});
