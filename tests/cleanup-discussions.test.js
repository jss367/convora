const assert = require('node:assert/strict');
const { test } = require('node:test');
const { cleanupDiscussions } = require('./helpers/cleanup-discussions.cjs');

function fixture(query) {
  let released = false;
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (query) await query(sql);
    },
    release() { released = true; },
  };
  return {
    statements,
    released: () => released,
    pool: {
      connect: async () => client,
      query() { assert.fail('the transaction must stay on one checked-out connection'); },
    },
  };
}

test('cleanup removes dependent roots atomically without locks that block plain readers or ID reuse', async () => {
  const db = fixture();
  await cleanupDiscussions(db.pool);
  assert.equal(db.statements[0], 'BEGIN');
  assert.equal(db.statements.at(-1), 'COMMIT');
  const deletes = db.statements.slice(1, -1);
  // votes -> questions -> discussions have non-cascading foreign keys. Their
  // dependent interaction and moderator rows use ON DELETE CASCADE.
  assert.deepEqual(deletes, ['DELETE FROM votes', 'DELETE FROM questions', 'DELETE FROM discussions']);
  assert.ok(db.statements.every(sql => !/TRUNCATE|LOCK|ALTER|setval/i.test(sql)));
  assert.equal(db.released(), true);
});

test('cleanup waits for a child deletion before deleting its parent or committing', async () => {
  let finish;
  const deletingVotes = new Promise(resolve => { finish = resolve; });
  const db = fixture(sql => sql === 'DELETE FROM votes' ? deletingVotes : undefined);
  const cleanup = cleanupDiscussions(db.pool);
  // Let the connect/BEGIN continuations reach the suspended DELETE.
  while (!db.statements.includes('DELETE FROM votes')) await Promise.resolve();
  assert.equal(db.statements.includes('DELETE FROM questions'), false);
  assert.equal(db.statements.includes('COMMIT'), false);
  assert.equal(db.released(), false);
  finish();
  await cleanup;
  assert.equal(db.statements.at(-1), 'COMMIT');
  assert.equal(db.released(), true);
});

test('a failed cleanup rolls back and propagates the failure without retrying', async () => {
  const failure = Error('delete failed');
  const db = fixture(sql => { if (sql === 'DELETE FROM questions') throw failure; });
  await assert.rejects(cleanupDiscussions(db.pool), error => error === failure);
  assert.equal(db.statements.at(-1), 'ROLLBACK');
  assert.equal(db.statements.includes('DELETE FROM discussions'), false);
  assert.equal(db.statements.includes('COMMIT'), false);
  assert.equal(db.statements.filter(sql => sql === 'DELETE FROM questions').length, 1);
  assert.equal(db.released(), true);
});

test('a failed connection propagates before any cleanup starts', async () => {
  const failure = Error('no connection');
  await assert.rejects(cleanupDiscussions({ connect: async () => { throw failure; } }), error => error === failure);
});
