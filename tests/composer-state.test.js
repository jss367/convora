const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

// Exercise the page's actual room-change effect and collapse decision without
// creating a browser, listener, or database. Keep state across route renders,
// as React Router does when only the discussion parameter changes.
function composer() {
  const source = readFileSync(require.resolve('../client/src/DiscussionPage.jsx'), 'utf8');
  const start = source.indexOf('    useEffect(() => {', source.indexOf('// The rename editor is scoped'));
  const end = source.indexOf('    }, [discussionSlug]);', start) + '    }, [discussionSlug]);'.length;
  const decision = source.match(/const composerCollapsed = (.*);/)[1];
  let previousSlug;
  const context = {
    composerOpen: false, questionsLoaded: false, questions: [],
    setEditingTitle() {}, setTitleDraft() {},
    setComposerOpen: value => { context.composerOpen = value; },
    setQuestionsLoaded: value => { context.questionsLoaded = value; },
    useEffect(effect, [slug]) {
      if (slug !== previousSlug) effect();
      previousSlug = slug;
    },
  };
  vm.createContext(context);
  return {
    state: context,
    navigate(slug) {
      context.discussionSlug = slug;
      vm.runInContext(source.slice(start, end), context);
    },
    collapsed: () => vm.runInContext(decision, context),
  };
}

test('room navigation resets composer expansion and question-loading state', () => {
  const page = composer();
  page.navigate('original');
  page.state.questionsLoaded = true;
  page.state.questions = [{ id: 1 }];
  page.state.composerOpen = true;
  assert.equal(page.collapsed(), false);
  page.navigate('copy');
  assert.equal(page.state.questionsLoaded, false);
  assert.equal(page.collapsed(), true);
  page.state.questionsLoaded = true;
  page.state.questions = [];
  assert.equal(page.collapsed(), false);
  page.navigate('original');
  assert.equal(page.collapsed(), true);
});

test('live questions and rerenders preserve an explicitly opened composer', () => {
  const page = composer();
  page.navigate('room');
  page.state.questionsLoaded = true;
  assert.equal(page.collapsed(), false);
  page.state.composerOpen = true;
  page.state.questions = [{ id: 1 }];
  page.navigate('room');
  assert.equal(page.state.questionsLoaded, true);
  assert.equal(page.collapsed(), false);
});
