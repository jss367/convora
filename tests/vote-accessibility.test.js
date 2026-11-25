const assert = require('node:assert/strict');
const { test } = require('node:test');
const React = require('react');
const { loadClientModule } = require('./helpers/client-module.cjs');

// Inspect the real React voting elements without creating a browser or socket.
for (const [type, options] of [
  ['Agreement', ['Strongly Agree', 'Agree', 'Unsure', 'Disagree', 'Strongly Disagree']],
  ['Yes/No', ['Yes', 'No']],
]) {
  test(`${type} vote names stay stable through selection, pending replacement, and undo`, async () => {
    const { default: VotingControls } = loadClientModule('client/src/questions/VotingControls.jsx');
    const context = {
      locked: false, pendingVotes: {}, sliderValues: {}, isMyVote: () => true,
      handleVote() {}, handleClearVote() {}, handleSliderChange() {},
    };
    context.render = question => VotingControls({ ...context, question });
    const question = { id: 7, type, text: '*Proceed*?', votes: [] };
    function render() {
      const nodes = [];
      function visit(node) {
        if (!React.isValidElement(node)) return;
        nodes.push(node);
        React.Children.forEach(node.props.children, visit);
      }
      visit(context.render(question));
      return { buttons: nodes.filter(n => n.type === 'button'), statuses: nodes.filter(n => n.props.role === 'status') };
    }
    const expectedNames = options.map(option => `Vote ${option} on "Proceed?"`);
    for (const [saved, pending] of [[undefined, undefined], [options[0], undefined], [options[0], options[1]], [options[1], undefined], [options[1], null], [undefined, undefined]]) {
      question.votes = saved === undefined ? [] : [{ value: saved }];
      context.pendingVotes = pending === undefined ? {} : { 7: pending };
      const { buttons, statuses } = render();
      assert.deepEqual(buttons.map(b => b.props['aria-label']), expectedNames);
      buttons.forEach((button, i) => {
        assert.equal(button.props['aria-pressed'], options[i] === saved);
        assert.equal(button.props.disabled, pending !== undefined);
        const saving = pending !== undefined && (pending === options[i] || (pending === null && saved === options[i]));
        assert.equal(button.props['aria-busy'], saving || undefined);
        assert.equal(statuses[i].props.children, saving ? 'Saving your vote on "Proceed?"…' : '');
      });
    }
  });
}
