const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createVoteStore } = require('../votes');

// The shared transaction helper must return the store result to the transport.
// SQL behavior and response limits remain integration coverage.
for (const limited of [false, true]) {
  test(`Open Ended ${limited ? 'limited' : 'accepted'} result survives the transaction wrapper`, async () => {
    const calls = [];
    let released = false;
    const store = createVoteStore({ connect: async () => ({
      query: async (sql) => {
        calls.push(sql);
        if (sql.startsWith('SELECT id, type')) return { rows: [{ id: 7, type: 'Open Ended', max_responses: limited ? 1 : null }] };
        if (sql.startsWith('SELECT count')) return { rows: [{ count: 1 }] };
        return { rows: [] };
      },
      release: () => { released = true; },
    }) });
    assert.deepEqual(await store.addVote('07', 'Idea', 'user', 'Name'), limited
      ? { added: false, reason: 'limit' }
      : { added: true });
    assert.equal(calls.filter(sql => sql.startsWith('INSERT')).length, limited ? 0 : 1);
    assert.deepEqual(calls.filter(sql => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)), ['BEGIN', 'COMMIT']);
    assert.equal(released, true);
  });
}
