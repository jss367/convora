const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { createInterestUpdates } = require('../interest-updates');
const { slugifyTopic } = require('../discussion-names');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function handlers({ updates, userId, write, read }) {
  const source = readFileSync(require.resolve('../server.js'), 'utf8');
  const start = source.indexOf("  socket.on('setQuestionInterest'");
  const end = source.indexOf("  socket.on('toggleResponseVote'", start);
  const bindStart = source.indexOf('function bindSocketUser(');
  const bindEnd = source.indexOf('\n}', bindStart) + 2;
  const registered = {}, errors = [];
  const context = {
    socket: { data: { userId }, on: (name, fn) => { registered[name] = fn; }, emit() {} },
    slugifyTopic, interestUpdates: updates, setQuestionInterest: write,
    pool: { query: read }, emitQuestions: async () => {}, logError: (...args) => errors.push(args),
  };
  vm.runInNewContext(source.slice(bindStart, bindEnd) + source.slice(start, end), context);
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
