const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { io } = require('socket.io-client');

// Run the actual hook with state/effect scheduling and a synthetic socket. No
// browser, database, listener, or network connection is created.
function mount(realSocket) {
  const slots = [], effects = [], timers = new Map(), listeners = new Map(), emits = [];
  let cursor, dirty, output, props = {
    discussionSlug: 'fictional-room', userId: 'fictional-participant',
    questions: [], interestedQuestionIds: new Set(), interestReady: true,
  };
  const socket = realSocket || {
    connected: true,
    on: (name, fn) => listeners.set(name, fn),
    off: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
    timeout() { return this; },
    get volatile() { return this; },
    emit: (...args) => emits.push(args),
  };
  if (realSocket) {
    const emit = realSocket.emit;
    realSocket.emit = (...args) => { emits.push(args); return emit.apply(realSocket, args); };
  }
  const context = vm.createContext({
    useState(initial) {
      const id = cursor++;
      if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial;
      return [slots[id], update => { slots[id] = typeof update === 'function' ? update(slots[id]) : update; dirty = true; }];
    },
    useRef(initial) {
      const id = cursor++;
      if (!(id in slots)) slots[id] = { current: initial };
      return slots[id];
    },
    useEffect(effect, deps) {
      const id = cursor++;
      if (!slots[id] || deps.some((value, index) => value !== slots[id].deps[index])) {
        effects.push(() => { slots[id]?.cleanup?.(); slots[id] = { deps, cleanup: effect() }; });
      }
    },
    setTimeout(fn) { const id = {}; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const source = readFileSync(require.resolve('../client/src/hooks/useQuestionInterest.js'), 'utf8')
    .replace(/^import .*;\n/m, '').replace('export function', 'function');
  vm.runInContext(source + '\nthis.mount = useQuestionInterest;', context);
  function render(changes = {}) {
    props = { ...props, ...changes };
    let count = 0;
    do {
      assert.ok(count++ < 20, 'hook settled');
      cursor = 0; dirty = false;
      output = context.mount(socket, props);
      while (effects.length) effects.shift()();
    } while (dirty);
    return output;
  }
  render();
  const frame = (interested, ready = true) => render({ questions: [{}], interestedQuestionIds: new Set(interested), interestReady: ready });
  return {
    socket, emits, timers, listeners, render, frame,
    current: () => output,
    writes: () => emits.filter(args => args[0] === 'setQuestionInterest'),
    ack(index, result = { updated: true }, error = null) { const args = this.writes()[index]; args.at(-1)(error, result); render(); },
    disconnect() { socket.connected = false; listeners.get('disconnect')(); render(); },
    expire() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } render(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

for (const initiallyInterested of [false, true]) {
  for (const ackFirst of [false, true]) {
    test(`repeated ${initiallyInterested ? 'remove' : 'add'} waits for ack and ownership (${ackFirst ? 'ack' : 'frame'} first)`, () => {
      const hook = mount();
      hook.frame(initiallyInterested ? [7] : []);
      assert.equal(hook.current().ready, true);
      assert.equal(hook.current().toggle(7), true);
      assert.equal(hook.current().toggle(7), false);
      hook.render();
      assert.equal(hook.current().pending.has(7), true);
      assert.equal(hook.writes().length, 1);
      assert.equal(hook.writes()[0][3], !initiallyInterested);
      if (ackFirst) hook.ack(0);
      hook.frame(initiallyInterested ? [] : [7], false);
      assert.equal(hook.current().toggle(7), false, 'hashing is unresolved');
      hook.render({ interestReady: true });
      if (!ackFirst) {
        assert.equal(hook.current().pending.has(7), true);
        hook.ack(0);
      }
      assert.equal(hook.current().pending.has(7), false);
      assert.equal(hook.current().toggle(7), true);
      assert.equal(hook.writes()[1][3], initiallyInterested);
      hook.unmount();
    });
  }
}

test('unrelated snapshots do not settle a pending interest and other questions stay independent', () => {
  const hook = mount(); hook.frame([]);
  hook.current().toggle(7); hook.ack(0); hook.frame([]);
  assert.equal(hook.current().toggle(7), false);
  assert.equal(hook.current().toggle(8), true);
  hook.frame([7]);
  assert.equal(hook.current().pending.has(7), false);
  assert.equal(hook.current().pending.has(8), true);
  hook.unmount();
});

test('rejected writes release their question without changing its pressed state', () => {
  const hook = mount(); hook.frame([7]);
  hook.current().toggle(7); hook.ack(0, { updated: false });
  assert.equal(hook.current().pending.has(7), false);
  assert.equal(hook.current().toggle(7), true);
  assert.equal(hook.writes()[1][3], false);
  hook.unmount();
});

test('disconnect requires a fresh reconciled snapshot and ignores an old acknowledgment', () => {
  const hook = mount(); hook.frame([]); hook.current().toggle(7);
  hook.disconnect();
  assert.equal(hook.current().toggle(7), false);
  hook.socket.connected = true; hook.render();
  assert.equal(hook.current().ready, false);
  hook.frame([7]); hook.current().toggle(7);
  hook.ack(0);
  assert.equal(hook.current().pending.has(7), true);
  assert.equal(hook.writes()[1][3], false);
  hook.unmount();
});

for (const acknowledged of [false, true]) {
  test(`missing ${acknowledged ? 'broadcast' : 'ack'} times out, refreshes and waits for authoritative recovery`, () => {
    const hook = mount(); hook.frame([]); hook.current().toggle(7);
    if (acknowledged) hook.ack(0);
    hook.expire();
    assert.equal(hook.current().ready, false);
    assert.equal(hook.current().toggle(7), false);
    assert.equal(hook.emits.at(-1)[0], 'joinDiscussion');
    hook.frame([7]);
    assert.equal(hook.current().toggle(7), true);
    assert.equal(hook.writes()[1][3], false);
    hook.unmount();
  });
}

test('ack errors request reconciliation rather than retrying an unknown write', () => {
  const hook = mount(); hook.frame([]); hook.current().toggle(7);
  hook.ack(0, undefined, new Error('synthetic timeout'));
  assert.equal(hook.writes().length, 1);
  assert.equal(hook.current().ready, false);
  hook.frame([]);
  assert.equal(hook.current().toggle(7), true);
  hook.unmount();
});

test('navigation and identity changes isolate pending state and stale callbacks', () => {
  const hook = mount(); hook.frame([]); hook.current().toggle(7);
  hook.render({ discussionSlug: 'another-fictional-room', userId: 'another-participant' });
  assert.equal(hook.current().ready, false);
  hook.frame([7]); hook.current().toggle(7); hook.ack(0);
  assert.equal(hook.current().pending.has(7), true);
  assert.equal(hook.writes()[1][1], 'another-fictional-room');
  assert.equal(hook.writes()[1][4], 'another-participant');
  hook.unmount();
  assert.equal(hook.timers.size, 0);
  assert.equal(hook.listeners.size, 0);
  hook.ack(1);
});

test('the rendered button is disabled while saving or waiting for reconciled ownership', () => {
  const page = readFileSync(require.resolve('../client/src/DiscussionPage.jsx'), 'utf8');
  assert.match(page, /const handleToggleInterest = questionInterest\.toggle/);
  assert.match(page, /disabled=\{locked \|\| !questionInterest\.ready \|\| interestPending\}/);
  assert.match(page, /aria-busy=\{interestPending\}/);
});

for (const expired of [true, false]) {
  test(`a ${expired ? 'heartbeat-expired' : 'nonwritable'} Socket.IO transport cannot buffer an interest write`, () => {
    const socket = io('http://127.0.0.1:1', { autoConnect: false, forceNew: true });
    socket.connected = true;
    socket.packet = () => {};
    socket.io.engine = { transport: { writable: expired }, _hasPingExpired: () => expired, close() {} };
    const hook = mount(socket);
    socket.sendBuffer.length = 0;
    hook.frame([]);
    assert.equal(hook.current().toggle(7), !expired);
    assert.equal(socket.sendBuffer.length, 0);
    if (expired) hook.render(); else hook.expire();
    assert.equal(hook.current().ready, false);
    hook.unmount();
    // Settle ack registrations without connecting to a server.
    for (const id of Object.keys(socket.acks)) socket.onack({ id: Number(id), data: [{ updated: false }] });
    socket.connected = false;
    socket.disconnect();
  });
}

function ownership() {
  const states = [], requests = [];
  let cursor, cleanup, previousDeps;
  const source = readFileSync(require.resolve('../client/src/hooks/useParticipantIdentity.js'), 'utf8');
  const block = source.slice(source.indexOf('    const [ownedVoteIds'), source.indexOf('    // True when `vote`'));
  const context = vm.createContext({
    ownerToken: (key, user) => new Promise(resolve => requests.push({ key, user, resolve })),
    useState(initial) {
      const id = cursor++;
      if (!(id in states)) states[id] = typeof initial === 'function' ? initial() : initial;
      return [states[id], value => { states[id] = value; }];
    },
    useEffect(effect, deps) {
      if (!previousDeps || deps.some((value, index) => value !== previousDeps[index])) {
        cleanup?.(); previousDeps = deps; cleanup = effect();
      }
    },
  });
  vm.runInContext('this.read = function(userId, questions) {' + block
    + ' return { interestedQuestionIds, interestReady }; };', context);
  return { requests, read(user, questions) { cursor = 0; return context.read(user, questions); } };
}

test('interest readiness belongs to the exact participant and asynchronously hashed question snapshot', async () => {
  const hook = ownership();
  const questions = [{ id: 7, interestVoterTokens: ['mine'] }];
  assert.equal(hook.read('fictional-participant', questions).interestReady, false);
  hook.requests[0].resolve('mine');
  await new Promise(setImmediate);
  const settled = hook.read('fictional-participant', questions);
  assert.equal(settled.interestReady, true);
  assert.equal(settled.interestedQuestionIds.has(7), true);
  assert.equal(hook.read('different-participant', questions).interestReady, false);
});

test('an interrupted ownership hash cannot mark a newer question snapshot as reconciled', async () => {
  const hook = ownership();
  const older = [{ id: 7, interestVoterTokens: ['mine'] }];
  const newer = [{ id: 8, interestVoterTokens: ['mine'] }];
  hook.read('fictional-participant', older);
  hook.read('fictional-participant', newer);
  hook.requests[0].resolve('mine');
  await new Promise(setImmediate);
  assert.equal(hook.read('fictional-participant', newer).interestReady, false);
  hook.requests[1].resolve('mine');
  await new Promise(setImmediate);
  const settled = hook.read('fictional-participant', newer);
  assert.equal(settled.interestReady, true);
  assert.equal(settled.interestedQuestionIds.has(7), false);
  assert.equal(settled.interestedQuestionIds.has(8), true);
});
