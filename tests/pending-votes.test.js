const assert = require('node:assert/strict');
const { test } = require('node:test');
const { io } = require('socket.io-client');

function offlineSocket() {
  const socket = io('http://127.0.0.1:1', { autoConnect: false, forceNew: true });
  socket.io.engine = { transport: { writable: true }, _hasPingExpired: () => false };
  socket.packet = () => {};
  return socket;
}

async function track(context, socket = offlineSocket()) {
  const { trackPendingVotes } = await import('../client/src/hooks/pendingVotes.mjs');
  const changes = [];
  const tracker = trackPendingVotes(socket, pending => changes.push(pending));
  context.after(tracker.dispose);
  return { socket, changes, ...tracker };
}

test('votes lock only their own question until acknowledged, including clear and repeated votes', async context => {
  const { socket, changes, sendVote } = await track(context);
  socket.onconnect('online');
  assert.equal(sendVote(7, 'Yes', 'vote', 'room', 7, 'Yes', 'user'), true);
  assert.equal(sendVote(7, null, 'clearVote', 'room', 7, 'user'), false);
  assert.equal(sendVote(8, null, 'clearVote', 'room', 8, 'user'), true);
  socket.onack({ id: 1, data: [{ ok: true }] });
  socket.onack({ id: 0, data: [{ ok: true }] });
  assert.equal(sendVote(7, 'Yes', 'vote', 'room', 7, 'Yes', 'user'), true);
  assert.deepEqual(changes, [{ 7: 'Yes' }, { 7: 'Yes', 8: null }, { 7: 'Yes' }, {}, { 7: 'Yes' }]);
});

test('a buffered vote replays once and delivers the server result after clearing pending', async context => {
  const { socket, changes, sendVote } = await track(context);
  const result = { ok: false, added: false, reason: 'duplicate' };
  const results = [];
  const args = ['room', 7, 'Idea', 'user', 'Name', 'custom'];
  sendVote(7, 'Idea', 'vote', ...args, value => {
    assert.deepEqual(changes.at(-1), {});
    results.push(value);
  });
  assert.equal(sendVote(7, 'Idea', 'vote', ...args, assert.fail), false);
  assert.equal(socket.sendBuffer.length, 1);
  assert.deepEqual(socket.sendBuffer[0].data, ['vote', ...args]);
  const { id } = socket.sendBuffer[0];
  const lateAck = socket.acks[id];
  socket.onconnect('reconnected');
  assert.equal(socket.sendBuffer.length, 0);
  assert.deepEqual(changes, [{ 7: 'Idea' }]);
  socket.onack({ id, data: [result] });
  lateAck({ ok: true });
  assert.deepEqual(results, [result]);
  assert.deepEqual(changes, [{ 7: 'Idea' }, {}]);
});

test('heartbeat timeout drops sent votes but not buffered ones until replay', async context => {
  const { socket, changes, sendVote } = await track(context);
  socket.onconnect('online');
  sendVote(7, null, 'clearVote', 'room', 7, 'user', assert.fail);
  socket.io.engine._hasPingExpired = () => true;
  sendVote(8, 'Idea', 'vote', 'room', 8, 'Idea', 'user', assert.fail);
  assert.equal(socket.sendBuffer.length, 1);
  socket.onclose('ping timeout');
  assert.deepEqual(changes.at(-1), { 8: 'Idea' });
  assert.equal(sendVote(8, null, 'clearVote', 'room', 8, 'user'), false);
  socket.io.engine._hasPingExpired = () => false;
  socket.onconnect('reconnected');
  assert.equal(socket.sendBuffer.length, 0);
  socket.onclose('transport close');
  assert.deepEqual(changes.at(-1), {});
});

test('a late ack after disconnect neither calls back nor clears the replacement vote', async context => {
  const { socket, changes, sendVote } = await track(context);
  socket.onconnect('online');
  sendVote(7, 'Yes', 'vote', 'room', 7, 'Yes', 'user', assert.fail);
  const lateAck = socket.acks[0];
  socket.onclose('transport close');
  assert.equal(sendVote(7, null, 'clearVote', 'room', 7, 'user'), true);
  lateAck({ ok: true });
  assert.deepEqual(changes, [{ 7: 'Yes' }, {}, { 7: null }]);
  socket.onconnect('reconnected');
  socket.onack({ id: 1, data: [{ ok: true }] });
  assert.deepEqual(changes.at(-1), {});
});

test('cleanup detaches listeners and invalidates acks, even after setup on the same socket', async context => {
  const first = await track(context);
  const { socket } = first;
  first.sendVote(7, 'Yes', 'vote', 'room', 7, 'Yes', 'user', assert.fail);
  first.dispose();
  assert.equal(socket.listeners('disconnect').length, 0);
  assert.equal(socket.listenersAnyOutgoing().length, 0);
  const next = await track(context, socket);
  first.dispose();
  assert.equal(socket.listeners('disconnect').length, 1);
  assert.equal(socket.listenersAnyOutgoing().length, 1);
  assert.equal(first.sendVote(8, null, 'clearVote', 'room', 8, 'user'), false);
  assert.equal(next.sendVote(7, 'No', 'vote', 'room', 7, 'No', 'user'), true);
  socket.onconnect('reconnected');
  socket.onack({ id: 0, data: [{ ok: true }] });
  assert.deepEqual(first.changes, [{ 7: 'Yes' }]);
  assert.deepEqual(next.changes, [{ 7: 'No' }]);
  socket.onack({ id: 1, data: [{ ok: true }] });
  assert.deepEqual(next.changes.at(-1), {});
});
