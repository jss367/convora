const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createInterestUpdates } = require('../interest-updates');
const { registerPostingAndVoting } = require('../posting-and-voting');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function handlers({ updates, userId, write, read }) {
  const registered = {}, errors = [];
  const socket = { data: { userId }, on: (name, fn) => { registered[name] = fn; }, emit() {} };
  registerPostingAndVoting(socket, {
    interestUpdates: updates, setQuestionInterest: write,
    pool: { query: read }, emitQuestions: async () => {}, logError: (...args) => errors.push(args),
  });
  return { registered, errors };
}

test('recovery on a replacement socket waits for the prior async transaction and uses pinned identity', async () => {
  const updates = createInterestUpdates(), gate = deferred();
  let interested = false, reads = 0, ack;
  const options = {
    updates, userId: 'fictional-participant',
    write: async () => { await gate.promise; interested = true; return true; },
    read: async (sql, params) => {
      reads++;
      assert.match(sql, /q.id=\$1 AND d.slug=\$2/);
      assert.deepEqual(Array.from(params), [7, 'fictional-room', 'fictional-participant']);
      return { rows: [{ interested }] };
    },
  };
  const first = handlers(options), replacement = handlers(options);
  const write = first.registered.setQuestionInterest('fictional-room', 7, true, 'spoofed', () => {});
  const recovery = replacement.registered.getQuestionInterestState('fictional-room', 7, 'spoofed', result => { ack = result; });
  await new Promise(setImmediate);
  assert.equal(reads, 0, 'a new socket must not read before the old write settles');
  assert.equal(ack, undefined);
  gate.resolve();
  await Promise.all([write, recovery]);
  assert.equal(reads, 1);
  assert.equal(ack.interested, true);
});

test('failed writes still release a recovery barrier and independent questions do not block', async () => {
  const updates = createInterestUpdates(), gate = deferred();
  const failed = updates.run('room', 7, 'participant', async () => { await gate.promise; throw new Error('synthetic rollback'); });
  const failure = assert.rejects(failed, /synthetic rollback/);
  let read = false;
  const recovery = updates.run('room', 7, 'participant', async () => { read = true; return false; });
  assert.equal(await updates.run('room', 8, 'participant', async () => 'independent'), 'independent');
  assert.equal(await updates.run('room', 7, 'someone-else', async () => 'independent'), 'independent');
  assert.equal(read, false);
  gate.resolve();
  await failure;
  assert.equal(await recovery, false);
  assert.equal(read, true);
  assert.equal(await updates.run('room', 7, 'participant', async () => 'reused'), 'reused');
});

test('the recovery event rejects invalid inputs before reading and scopes unknown questions', async () => {
  let reads = 0;
  const { registered } = handlers({
    updates: createInterestUpdates(), userId: null, write: async () => true,
    read: async () => { reads++; return { rows: [] }; },
  });
  let ack;
  await registered.getQuestionInterestState('room', 7, null, result => { ack = result; });
  assert.equal(ack.error, 'invalid_request');
  await registered.getQuestionInterestState('room', '7', 'fictional-participant', result => { ack = result; });
  assert.equal(ack.error, 'invalid_request');
  assert.equal(reads, 0);
  await registered.getQuestionInterestState('other-room', 7, 'fictional-participant', result => { ack = result; });
  assert.equal(ack.error, 'not_found');
});

test('a failed discussion refresh still broadcasts the added question and acknowledges it', async () => {
  const registered = {}, errors = [], broadcasts = [];
  const socket = { data: { userId: 'fictional-participant' }, on: (name, fn) => { registered[name] = fn; }, emit() {} };
  registerPostingAndVoting(socket, {
    addQuestion: async () => ({}),
    emitDiscussion: async () => { throw new Error('synthetic discussion refresh failure'); },
    emitQuestions: async slug => { broadcasts.push(slug); },
    logError: (...args) => errors.push(args),
  });
  let ack;
  await registered.addQuestion('room', { text: 'Fictional question?', type: 'Open Ended' }, true, undefined, result => { ack = result; });
  assert.equal(broadcasts.length, 1, 'the question broadcast must still run');
  assert.deepEqual(ack, { added: true });
  assert.equal(errors.length, 1);
});

test('recovery database errors are acknowledged without inventing an interest state', async () => {
  const { registered, errors } = handlers({
    updates: createInterestUpdates(), userId: 'fictional-participant', write: async () => true,
    read: async () => { throw new Error('synthetic read failure'); },
  });
  let ack;
  await registered.getQuestionInterestState('room', 7, null, result => { ack = result; });
  assert.equal(ack.error, 'unavailable');
  assert.equal('interested' in ack, false);
  assert.equal(errors.length, 1);
});
