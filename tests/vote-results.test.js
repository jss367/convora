const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createVoteStore } = require('../votes');

// The shared transaction helper must return the store result to the transport.
// SQL behavior and cross-participant deduplication remain integration coverage.
for (const duplicate of [false, true]) {
  test(`Brainstorm ${duplicate ? 'duplicate' : 'accepted'} result survives the transaction wrapper`, async () => {
    const calls = [];
    let released = false;
    const store = createVoteStore({ connect: async () => ({
      query: async (sql) => {
        calls.push(sql);
        if (sql.startsWith('SELECT id, type')) return { rows: [{ id: 7, type: 'Brainstorm' }] };
        if (sql.startsWith('SELECT 1 FROM votes')) return { rows: duplicate ? [{}] : [] };
        return { rows: [] };
      },
      release: () => { released = true; },
    }) });
    assert.deepEqual(await store.addVote('07', 'Idea', 'user', 'Name'), duplicate
      ? { added: false, reason: 'duplicate' }
      : { added: true });
    assert.equal(calls.filter(sql => sql.startsWith('INSERT')).length, duplicate ? 0 : 1);
    assert.deepEqual(calls.filter(sql => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)), ['BEGIN', 'COMMIT']);
    assert.equal(released, true);
  });
}
