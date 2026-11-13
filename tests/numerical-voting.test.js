const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const React = require('react');
const { transformSync } = require('esbuild');

// Render the actual voting controls as React elements without a browser or
// transport. This checks the merged pending-vote and numerical-draft behavior.
async function controls({ saved } = {}) {
  const { clampNumericalValue } = await import('../client/src/questions/questionHelpers.mjs');
  const source = readFileSync(require.resolve('../client/src/DiscussionPage.jsx'), 'utf8');
  const start = source.indexOf('    const renderVotingMechanism =');
  const end = source.indexOf('    const sortedAndFilteredQuestions =', start);
  const code = transformSync(`${source.slice(start, end)}\nthis.render = renderVotingMechanism;`, { loader: 'jsx' }).code;
  const context = {
    React, clampNumericalValue,
    QuestionTypes: { NUMERICAL: 'Numerical' }, NumericalResults: () => null,
    pendingVotes: {}, sliderValues: {}, locked: false,
    isMyVote: () => true,
    handleSliderChange(id, value) { context.sliderValues[id] = value; },
    handleVote() {},
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  const question = {
    id: 7, text: 'Temperature', type: 'Numerical', min_value: -100, max_value: 100,
    votes: saved === undefined ? [] : [{ value: String(saved) }],
  };
  const render = () => {
    const nodes = [];
    const visit = node => {
      if (!React.isValidElement(node)) return;
      nodes.push(node);
      React.Children.forEach(node.props.children, visit);
    };
    visit(context.render(question));
    return {
      input: nodes.find(node => node.type === 'input' && node.props.type === 'text'),
      slider: nodes.find(node => node.type === 'input' && node.props.type === 'range'),
      submit: nodes.find(node => node.type === 'button'),
    };
  };
  return { context, render };
}

test('signed numerical drafts remain unset until digits arrive and cannot submit while pending', async () => {
  const { context, render } = await controls();
  assert.equal(render().submit.props.disabled, true);
  render().input.props.onChange({ target: { value: '-' } });
  assert.equal(render().input.props.value, '-');
  assert.equal(render().submit.props.disabled, true);
  render().input.props.onChange({ target: { value: '-15' } });
  assert.equal(render().slider.props.value, -15);
  assert.equal(render().submit.props.disabled, false);
  context.pendingVotes[7] = -15;
  render().input.props.onChange({ target: { value: '-16' } });
  assert.equal(render().submit.props.disabled, true);
  assert.equal(render().submit.props.children, 'Saving…');
  delete context.pendingVotes[7];
  assert.equal(render().submit.props.disabled, false);
});

test('saved numerical answers stay disabled when unchanged, including after a pending update', async () => {
  const { context, render } = await controls({ saved: -15 });
  assert.equal(render().input.props.value, -15);
  assert.equal(render().submit.props.disabled, true);
  render().input.props.onChange({ target: { value: '-14' } });
  assert.equal(render().submit.props.disabled, false);
  context.pendingVotes[7] = -14;
  assert.equal(render().submit.props.disabled, true);
  delete context.pendingVotes[7];
  render().input.props.onChange({ target: { value: '-15' } });
  assert.equal(render().submit.props.disabled, true);
  assert.equal(render().submit.props.children, 'Update Vote');
});
