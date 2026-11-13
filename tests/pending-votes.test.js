const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { io } = require('socket.io-client');

// Exercise the hook with the real Socket.IO buffering/ack implementation, without
// opening a connection. Only React's state/effect scheduling is supplied here.
function mountPendingVotes(socket) {
  let state;
  const effects = [];
  const source = readFileSync(path.join(__dirname, '../client/src/hooks/useDiscussionRoom.js'), 'utf8');
  const hook = source.slice(source.indexOf('export function usePendingVotes('), source.indexOf('// Subscribe once per room.'))
    .replace('export function', 'function');
  const context = {
    useState: initial => {
      state = initial;
      return [state, update => { state = update(state); }];
    },
    useRef: current => ({ current }),
    useEffect: effect => effects.push(effect),
    useCallback: callback => callback,
  };
  vm.createContext(context);
  vm.runInContext(`${hook}\nthis.mount = usePendingVotes;`, context);
  const [, sendVote] = context.mount(socket);
  const cleanups = effects.map(effect => effect());
  return { sendVote, pending: () => state, unmount: () => cleanups.forEach(cleanup => cleanup()) };
}

function disconnectedSocket() {
  return io('http://127.0.0.1:1', { autoConnect: false, forceNew: true });
}

test('buffered votes block repeat submissions until the real acknowledgment', () => {
  const socket = disconnectedSocket();
  const hook = mountPendingVotes(socket);
  assert.equal(hook.sendVote(7, 'Yes', 'vote', 'room', 7, 'Yes', 'user'), true);
  assert.equal(hook.sendVote(7, 'No', 'vote', 'room', 7, 'No', 'user'), false);
  assert.equal(socket.sendBuffer.length, 1);
  socket.onack({ id: socket.sendBuffer[0].id, data: [{ ok: true }] });
  assert.equal(hook.pending()[7], undefined);
  hook.unmount();
});

test('a vote buffered after heartbeat expiry stays pending through disconnect', () => {
  const socket = disconnectedSocket();
  socket.connected = true;
  socket.io.engine = { transport: { writable: true }, _hasPingExpired: () => true };
  const hook = mountPendingVotes(socket);
  hook.sendVote(7, 'Idea', 'vote', 'room', 7, 'Idea', 'user');
  assert.equal(socket.sendBuffer.length, 1, 'Socket.IO buffered despite connected=true');
  socket.onclose('ping timeout');
  assert.equal(hook.pending()[7], 'Idea');
  assert.equal(hook.sendVote(7, 'Idea', 'vote', 'room', 7, 'Idea', 'user'), false);
  assert.equal(socket.sendBuffer.length, 1);
  // Reconnect flushes the packet before emitting `connect`. It must now count
  // as sent, so another disconnect does not strand its pending marker.
  socket.packet = () => {};
  socket.onconnect('reconnected');
  assert.equal(socket.sendBuffer.length, 0);
  socket.onclose('transport close');
  assert.equal(hook.pending()[7], undefined);
  hook.unmount();
});

test('sent votes clear on disconnect and stale acks cannot clear a newer answer', () => {
  const socket = disconnectedSocket();
  socket.connected = true;
  socket.io.engine = { transport: { writable: true }, _hasPingExpired: () => false };
  socket.packet = () => {};
  const hook = mountPendingVotes(socket);
  hook.sendVote(7, 'Yes', 'vote', 'room', 7, 'Yes', 'user');
  const oldAck = socket.acks[0];
  socket.onclose('transport close');
  assert.equal(hook.pending()[7], undefined);
  assert.equal(hook.sendVote(7, null, 'clearVote', 'room', 7, 'user'), true);
  oldAck({ ok: true });
  assert.equal(hook.pending()[7], null);
  hook.unmount();
});

test('leaving a discussion removes its pending-vote listeners', () => {
  const socket = disconnectedSocket();
  const hook = mountPendingVotes(socket);
  hook.unmount();
  assert.equal(socket.listeners('disconnect').length, 0);
  assert.equal(socket.listenersAnyOutgoing().length, 0);
});

test('a duplicate result clears pending and reaches the Brainstorm notice callback', () => {
  const socket = disconnectedSocket();
  const hook = mountPendingVotes(socket);
  const result = { ok: false, added: false, reason: 'duplicate' };
  let received;
  hook.sendVote(7, 'Idea', 'vote', 'room', 7, 'Idea', 'user', 'Name', 'custom', value => { received = value; });
  assert.equal(socket.sendBuffer[0].data.length, 7, 'only the wire arguments reach Socket.IO');
  socket.onack({ id: socket.sendBuffer[0].id, data: [result] });
  assert.equal(hook.pending()[7], undefined);
  assert.equal(received, result);
  assert.equal(hook.sendVote(7, 'Another idea', 'vote', 'room', 7, 'Another idea', 'user'), true);
  hook.unmount();
});
