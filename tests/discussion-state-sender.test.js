const test = require('node:test');
const assert = require('node:assert/strict');
const { createDiscussionStateSender } = require('../discussion-state-sender');

test('a slow broadcast uses the newer targeted state for every viewer', async () => {
  const pending = [];
  const displayStates = [];
  const participantStates = [];
  const display = { emit: (_, state) => displayStates.push(state) };
  const audience = { emit: (event, state) => {
    display.emit(event, state);
    participantStates.push(state);
  } };
  const send = createDiscussionStateSender(() => new Promise(resolve => pending.push(resolve)), () => audience);
  const broadcast = send('room');
  const refresh = send('room', display);
  pending[1]('moderator');
  await refresh;
  pending[0]('oldest');
  await broadcast;
  assert.deepEqual(displayStates, ['moderator', 'moderator']);
  assert.deepEqual(participantStates, ['moderator']);
});

test('a delivered live settings change supersedes an older display refresh and broadcast', async () => {
  const pending = [];
  const delivered = [];
  const target = { emit: (event, state) => delivered.push([event, state]) };
  const send = createDiscussionStateSender(() => new Promise(resolve => pending.push(resolve)), () => target);
  const refresh = send('room', target);
  const older = send('room');
  const latest = send('room');
  pending[2]('newest');
  await latest;
  pending[0]('compare');
  pending[1]('oldest');
  await Promise.all([refresh, older]);
  assert.deepEqual(delivered, [['discussionState', 'newest']]);
});

test('an unsuccessful broadcast does not suppress a display joining the room', async () => {
  const pending = [];
  const delivered = [];
  const target = { emit: (_, state) => delivered.push(state) };
  const send = createDiscussionStateSender(() => new Promise((resolve, reject) => pending.push({ resolve, reject })), () => target);
  const refresh = send('room', target);
  const update = send('room');
  pending[1].reject(new Error('read failed'));
  await assert.rejects(update, /read failed/);
  pending[0].resolve('moderator');
  await refresh;
  assert.deepEqual(delivered, ['moderator']);
});
