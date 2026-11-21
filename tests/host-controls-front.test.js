const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const vm = require('node:vm');
const read = name => process.env.HOST_CONTROL_BASE
  ? execFileSync('git', ['show', process.env.HOST_CONTROL_BASE + ':' + name], { encoding: 'utf8' })
  : fs.readFileSync(require.resolve('../' + name), 'utf8');

test('decimal ties use the same exponent-shift rounding on the client and server', async () => {
  const server = { exports: {} };
  vm.runInNewContext(read('question-data.js'), { module: server, console, require: require('node:module').createRequire(require.resolve('../question-data')) });
  const client = await import('data:text/javascript,' + encodeURIComponent(read('client/src/questions/questionHelpers.mjs')));
  for (const [input, expected] of [[1.005, 1.01], [-1.005, -1], [1.015, 1.02], [-1.015, -1.01], [.005, .01], [-.005, 0], [2.675, 2.68], [-2.675, -2.67]]) {
    assert.equal(server.exports.normalizeNumericalVote(input), expected);
    assert.equal(client.clampNumericalValue(input, -100, 100), expected);
  }
  assert.ok(Object.is(server.exports.normalizeNumericalVote(-.005), 0));
});

test('the editor draft survives being remounted from the queue into the published list', () => {
  const source = read('client/src/questions/QuestionEditor.jsx');
  const start = source.indexOf('const QuestionEditor =');
  const prefix = source.slice(start, source.indexOf('    const handleSave =', start));
  let draft;
  const question = { id: 7, text: 'Fictional saved text', type: 'Agreement', queued: true };
  function mount(currentQuestion) {
    const context = vm.createContext({ MULTIPLE_CHOICE_LIMITS: { MIN_OPTIONS: 2 },
      useRef: current => ({ current }),
      useState: initial => { let value = typeof initial === 'function' ? initial() : initial;
        return [value, update => { value = typeof update === 'function' ? update(value) : update; }]; },
    });
    vm.runInContext(prefix + ' return {text,type,minValue,maxValue,setText,setType,setMinValue,setMaxValue}; }; this.run=QuestionEditor;', context);
    return context.run({ question: currentQuestion, draft, onDraftChange: value => { draft = value; } });
  }
  mount(question).setText('Fictional unsaved edit');
  mount(question).setType('Numerical');
  mount(question).setMinValue(-5);
  mount(question).setMaxValue(5);
  const published = mount({ ...question, queued: false });
  assert.equal(published.text, 'Fictional unsaved edit');
  assert.equal(published.type, 'Numerical');
  assert.equal(published.minValue, -5);
  assert.equal(published.maxValue, 5);
});

test('both editor locations use the same parent draft map and explicit draft cleanup', () => {
  const source = read('client/src/DiscussionPage.jsx');
  const editors = source.match(/<QuestionEditor[\s\S]*?\/>/g);
  assert.equal(editors.length, 2);
  for (const editor of editors) {
    assert.match(editor, /draft=\{editingDrafts\[question.id\]\}/);
    assert.match(editor, /onDraftChange=/);
    assert.match(editor, /onCancel=\{closeQuestionEditor\}/);
  }
});
