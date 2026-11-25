// Tests the integration helper itself, without a database or a server.
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { Client, Pool } = require('pg');

// The helper reads both when it loads, so replace them first. This file runs in
// its own process, so no other test sees the replacements.
process.env.DATABASE_URL = 'postgresql://user:password@127.0.0.1/convora_test';
let spawnServer;
childProcess.spawn = () => spawnServer();
const { useIntegrationServer, fileDatabaseName } = require('./helpers/integration.cjs');

test('teardown holds the shared lock from closing the pool through dropping the database', async t => {
  const events = [];
  const hooks = {};
  for (const name of ['before', 'beforeEach', 'afterEach', 'after']) {
    t.mock.method(test, name, hook => { hooks[name] = hook; });
  }
  t.mock.method(Client.prototype, 'connect', async () => {});
  t.mock.method(Client.prototype, 'query', async sql => { events.push(sql); });
  t.mock.method(Client.prototype, 'end', async () => { events.push('close lock session'); });
  t.mock.method(Pool.prototype, 'end', async () => { events.push('end pool'); });
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true }));
  spawnServer = () => Object.assign(new EventEmitter(), {
    exitCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill(signal) {
      events.push(`server ${signal}`);
      setImmediate(() => { this.exitCode = 0; this.emit('exit', 0); });
    },
  });

  useIntegrationServer(__filename);
  await hooks.before();
  events.length = 0;
  await hooks.after();
  assert.deepEqual(events, [
    "SELECT pg_advisory_lock_shared(hashtext('convora:integration-tests'))",
    'end pool',
    'server SIGTERM',
    'DROP DATABASE IF EXISTS "convora_integration_helper_test" WITH (FORCE)',
    'close lock session',
  ]);
});

test('per-file database names stay distinct within the PostgreSQL name limit', () => {
  const nameFor = (database, file) => fileDatabaseName(`postgresql://localhost/${encodeURIComponent(database)}`, file);
  assert.equal(nameFor('convora_test', '/tests/integration-voting.test.js'), 'convora_integration_voting_test');

  // The first name fits in 63 bytes exactly; one more byte does not.
  const exact = 'a'.repeat(39);
  assert.equal(nameFor(`${exact}_test`, '/tests/integration-voting.test.js'), `${exact}_integration_voting_test`);

  for (const stem of ['a'.repeat(40), 'a'.repeat(58), 'é'.repeat(29), `a${'é'.repeat(28)}`]) {
    const files = ['/tests/integration-voting.test.js', '/tests/integration-results-visibility.test.js'];
    const names = files.map(file => nameFor(`${stem}_test`, file));
    assert.equal(new Set(names).size, files.length);
    assert.deepEqual(files.map(file => nameFor(`${stem}_test`, file)), names);
    for (const name of names) {
      assert.ok(Buffer.byteLength(name) <= 63, name);
      assert.match(name, /_[0-9a-f]{12}_test$/);
      assert.doesNotMatch(name, /�/);
    }
  }
});
