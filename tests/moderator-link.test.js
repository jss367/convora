const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Supply hook scheduling without a browser, socket, or database. The production
// hook itself runs unchanged, including router replacements and storage errors.
function mountPrompt({ storageFails = false } = {}) {
  const slots = [];
  const pending = [];
  const values = new Map();
  let cursor = 0;
  let dirty = false;
  let slug;
  let token;
  let location;
  let prompt;
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const context = {
    localStorage: {
      getItem(key) { if (storageFails) throw Error('blocked'); return values.get(key); },
      setItem(key, value) { if (storageFails) throw Error('blocked'); values.set(key, value); },
    },
    console: { warn() {} },
    useState(initial) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: initial };
      return [slots[i].value, value => {
        slots[i].value = typeof value === 'function' ? value(slots[i].value) : value;
        dirty = true;
      }];
    },
    useRef(current) { const i = cursor++; return slots[i] ||= { current }; },
    useCallback(callback, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) slots[i] = { deps, callback };
      return slots[i].callback;
    },
    useEffect(effect, deps) {
      const i = cursor++;
      if (!same(slots[i]?.deps, deps)) {
        pending.push(() => { slots[i]?.cleanup?.(); slots[i] = { deps, cleanup: effect() }; });
      }
    },
    useLocation: () => location,
    useNavigate: () => navigate,
  };
  function navigate(url, options) {
    assert.equal(url, `${location.pathname}${location.search}${location.hash}`);
    assert.equal(options.replace, true);
    location = { ...location, state: options.state };
    dirty = true;
  }
  const source = readFileSync(path.join(__dirname, '../client/src/ModeratorLinkPanel.jsx'), 'utf8');
  const hook = source.slice(source.indexOf('const SAVED_KEY_PREFIX'), source.indexOf('// The reminder shown'))
    .replaceAll('export ', '');
  vm.runInNewContext(`${hook}\nthis.mount = useModeratorLinkPrompt; this.creationState = moderatorLinkPromptState;`, context);
  function flush() {
    do {
      dirty = false;
      cursor = 0;
      prompt = context.mount(slug, token);
      pending.splice(0).forEach(effect => effect());
    } while (dirty);
    return prompt;
  }
  return {
    visit(nextSlug, created = false, nextToken = `token-${nextSlug}`) {
      token = nextToken;
      slug = nextSlug;
      location = { pathname: `/discussion/${slug}`, search: '?clusters=1', hash: '#question',
        state: created ? context.creationState(slug) : null };
      return flush();
    },
    flush, values,
    state: () => location.state,
    unmount: () => slots.forEach(slot => slot?.cleanup?.()),
  };
}

test('creation and duplication consume the one-time flag while preserving the URL', () => {
  const hook = mountPrompt();
  assert.equal(hook.visit('created', true).mode, 'created');
  assert.equal(hook.state(), null);
  assert.equal(hook.visit('duplicated', true).mode, 'created');
  assert.equal(hook.state(), null);
  assert.equal(hook.visit('participant').mode, null);
});

test('leaving and returning never resurrects an undismissed creation or fallback panel', () => {
  const hook = mountPrompt();
  assert.equal(hook.visit('a', true).mode, 'created');
  hook.visit('b');
  assert.equal(hook.visit('a').mode, null);
  hook.flush().showManual();
  assert.equal(hook.flush().mode, 'manual');
  hook.visit('b');
  assert.equal(hook.visit('a').mode, null);
});

test('late clipboard callbacks cannot reopen a panel after leaving and returning', () => {
  const hook = mountPrompt();
  const old = hook.visit('a', true);
  hook.visit('b');
  hook.visit('a');
  old.showManual();
  old.markSaved();
  assert.equal(hook.flush().mode, null);
  assert.equal(hook.flush().saved, false);
});

test('storage errors keep successful copying saved in memory and dismissal restores focus', () => {
  const hook = mountPrompt({ storageFails: true });
  const prompt = hook.visit('a', true);
  let focused = false;
  prompt.toolbarButtonRef.current = { focus() { focused = true; } };
  prompt.markSaved();
  assert.equal(hook.flush().saved, true);
  hook.flush().dismiss();
  assert.equal(hook.flush().mode, null);
  assert.equal(focused, true);
  assert.equal(hook.visit('b').saved, false);
});

test('saved reminders are scoped per discussion and survive a later visit', () => {
  const hook = mountPrompt();
  hook.visit('a').markSaved();
  assert.equal(hook.flush().saved, true);
  assert.equal(hook.values.get('convora_modlink_saved_a'), 'token-a');
  assert.equal(hook.visit('b').saved, false);
  assert.equal(hook.visit('a').saved, true);
});

// A per-user moderator grant rotates when the user is demoted and promoted.
test('a replacement credential restores the reminder even for the same slug', () => {
  const hook = mountPrompt();
  hook.visit('a', false, 'old-token').markSaved();
  assert.equal(hook.flush().saved, true);
  assert.equal(hook.visit('a', false, null).saved, false);
  assert.equal(hook.visit('a', false, 'new-token').saved, false);
  hook.flush().markSaved();
  assert.equal(hook.flush().saved, true);
  assert.equal(hook.values.get('convora_modlink_saved_a'), 'new-token');
});

test('clipboard completion after a credential change or unmount is ignored', () => {
  const hook = mountPrompt();
  const old = hook.visit('a', false, 'old-token');
  hook.visit('a', false, 'new-token');
  old.markSaved();
  old.showManual();
  assert.equal(old.isCurrent(), false);
  assert.equal(hook.flush().saved, false);
  assert.equal(hook.flush().mode, null);
  const current = hook.flush();
  hook.unmount();
  assert.equal(current.isCurrent(), false);
  current.markSaved();
  assert.equal(hook.values.size, 0);
});

for (const result of ['resolve', 'reject']) {
  test(`a clipboard promise that ${result}s after navigation cannot update the new visit`, async () => {
    const hook = mountPrompt();
    const moderatorLink = hook.visit('a');
    let finish;
    let indicatorUpdates = 0;
    let timers = 0;
    const pending = new Promise((resolve, reject) => { finish = result === 'resolve' ? resolve : reject; });
    const source = readFileSync(path.join(__dirname, '../client/src/DiscussionPage.jsx'), 'utf8');
    const handler = source.slice(source.indexOf('const handleCopyAdminLink ='), source.indexOf('    const saveShortLink'))
      .replace('const handleCopyAdminLink =', 'this.copy =');
    const context = {
      moderatorLink, adminUrl: 'https://example.test/discussion/a?admin=token-a',
      navigator: { clipboard: { writeText: () => pending } },
      setAdminLinkCopied: () => { indicatorUpdates += 1; },
      setTimeout: () => { timers += 1; },
      console: { error() {} },
    };
    vm.runInNewContext(handler, context);
    const copying = context.copy();
    hook.visit('b');
    hook.visit('a');
    finish();
    await copying;
    assert.equal(indicatorUpdates, 0);
    assert.equal(timers, 0);
    assert.equal(hook.values.size, 0);
    assert.equal(hook.flush().mode, null);
  });
}

test('legacy slug-only markers do not claim that a current credential was saved', () => {
  const hook = mountPrompt();
  hook.values.set('convora_modlink_saved_a', '1');
  assert.equal(hook.visit('a').saved, false);
});
