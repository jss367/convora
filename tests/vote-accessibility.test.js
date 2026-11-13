const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const React = require('react');
const { transformSync } = require('esbuild');

// Inspect the real React voting elements without creating a browser or socket.
for (const [type, options] of [
  ['Agreement', ['Strongly Agree', 'Agree', 'Unsure', 'Disagree', 'Strongly Disagree']],
  ['Yes/No', ['Yes', 'No']],
]) {
  test(`${type} vote names stay stable through selection, pending replacement, and undo`, () => {
    const source = readFileSync(require.resolve('../client/src/DiscussionPage.jsx'), 'utf8');
    const start = source.indexOf('    const renderVotingMechanism =');
    const end = source.indexOf('    const sortedAndFilteredQuestions =', start);
    const code = transformSync(`${source.slice(start, end)}\nthis.render = renderVotingMechanism;`, { loader: 'jsx' }).code;
    const context = {
      React, locked: false, pendingVotes: {}, isMyVote: () => true,
      QuestionTypes: { AGREEMENT: 'Agreement', YES_NO: 'Yes/No' },
      VoteOptions: { STRONGLY_AGREE: options[0], AGREE: options[1], UNSURE: options[2], DISAGREE: options[3], STRONGLY_DISAGREE: options[4] },
      YesNoOptions: { YES: 'Yes', NO: 'No' }, AgreementResults: () => null, YesNoResults: () => null,
      handleVote() {}, handleClearVote() {},
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    const question = { id: 7, type, text: 'Proceed?', votes: [] };
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
