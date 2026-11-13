const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

// Run the actual hook's effects against a small DOM boundary. No browser,
// database, server, or network connection is created by these tests.
function setup() {
  const listeners = new Set();
  const document = {
    activeElement: null,
    addEventListener: (type, callback) => { assert.equal(type, 'keydown'); listeners.add(callback); },
    removeEventListener: (type, callback) => { assert.equal(type, 'keydown'); listeners.delete(callback); },
  };
  let effects;
  const source = readFileSync(require.resolve('../client/src/hooks/useModalDialog.js'), 'utf8')
    .replace(/^import .*;\n/, '').replace('export function', 'function');
  const context = { document, useRef: current => ({ current }), useEffect: effect => effects.push(effect) };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.mount = useModalDialog;`, context);
  function element() {
    return { isConnected: true, focus() { document.activeElement = this; } };
  }
  const trigger = element();
  trigger.focus();
  function mount(onClose, returnFocusRef, empty = false) {
    effects = [];
    const ref = context.mount(true, onClose, returnFocusRef);
    const panel = element();
    const items = empty ? [] : [element(), element()];
    panel.contains = el => el === panel || items.includes(el);
    panel.querySelectorAll = () => items;
    panel.querySelector = () => null;
    for (const item of items) item.getClientRects = () => [1];
    ref.current = panel;
    const cleanups = effects.map(effect => effect());
    return { panel, items, unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
  }
  function key(key, options = {}) {
    const event = { key, shiftKey: false, isComposing: false, preventDefault() { this.defaultPrevented = true; }, ...options };
    for (const listener of [...listeners]) listener(event);
    return event;
  }
  return { document, listeners, trigger, mount, key };
}

test('modal wraps Tab in both directions and restores focus across repeated opens', () => {
  const env = setup();
  for (let i = 0; i < 3; i += 1) {
    const modal = env.mount(() => {});
    assert.equal(env.document.activeElement, modal.items[0]);
    env.key('Tab', { shiftKey: true });
    assert.equal(env.document.activeElement, modal.items[1]);
    env.key('Tab');
    assert.equal(env.document.activeElement, modal.items[0]);
    assert.equal(env.key('Escape', { isComposing: true }).defaultPrevented, undefined);
    modal.unmount();
    assert.equal(env.document.activeElement, env.trigger);
    assert.equal(env.listeners.size, 0);
  }
});

test('delayed similarity dialog owns Tab and Escape while Share remains open', () => {
  const env = setup();
  let shareCloses = 0;
  let similarCloses = 0;
  const share = env.mount(() => { shareCloses += 1; }, { current: env.trigger });
  const similar = env.mount(() => { similarCloses += 1; });
  env.key('Tab', { shiftKey: true });
  assert.equal(env.document.activeElement, similar.items[1]);
  env.key('Tab');
  assert.equal(env.document.activeElement, similar.items[0]);
  env.key('Escape');
  assert.equal(similarCloses, 1);
  assert.equal(shareCloses, 0, 'Escape must not also close Share');
  similar.unmount();
  assert.equal(env.document.activeElement, share.items[0]);
  env.key('Escape');
  assert.equal(shareCloses, 1);
  share.unmount();
  assert.equal(env.document.activeElement, env.trigger);
  assert.equal(env.listeners.size, 0);
});

test('closing a lower modal cannot steal focus from the upper modal', () => {
  const env = setup();
  const share = env.mount(() => {}, { current: env.trigger });
  const similar = env.mount(() => {});
  share.unmount();
  assert.equal(env.document.activeElement, similar.items[0]);
  similar.unmount();
  assert.equal(env.listeners.size, 0);
});

test('empty modal contains focus and disconnected return targets are ignored', () => {
  const env = setup();
  const modal = env.mount(() => {}, undefined, true);
  assert.equal(env.document.activeElement, modal.panel);
  assert.equal(env.key('Tab').defaultPrevented, true);
  assert.equal(env.document.activeElement, modal.panel);
  env.trigger.isConnected = false;
  modal.unmount();
  assert.equal(env.document.activeElement, modal.panel);
  assert.equal(env.listeners.size, 0);
});
