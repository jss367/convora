const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { test } = require('node:test');
const { once } = require('node:events');
const { Pool } = require('pg');
const { io } = require('socket.io-client');
const { createVoteStore } = require('../votes');
const { initializeDatabase } = require('../database');
const { assertSafeTestDatabase } = require('../scripts/test-database');
const { cleanupDiscussions } = require('./helpers/cleanup-discussions.cjs');

const rootDir = path.resolve(__dirname, '..');
const databaseUrl = process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test';

let serverProcess;
let serverOutput = '';
let baseUrl;
let serverPort;
let pool;

test.before(async () => {
  assertSafeTestDatabase(databaseUrl);

  serverPort = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${serverPort}`;
  pool = new Pool({ connectionString: databaseUrl });

  await startServer();
});

test.beforeEach(async () => {
  await cleanupDiscussions(pool);
});

test.after(async () => {
  if (pool) {
    await pool.end();
  }

  await stopServer();
});

test('Google verification issues an expiring session and only a creator can link a discussion', async () => {
  const express = require('express');
  const { registerModeratorAccounts } = require('../moderator-accounts');
  const app = express();
  app.use(express.json());
  const clientId = 'test-client';
  const subject = crypto.randomUUID();
  const google = {
    async verifyIdToken({ idToken, audience }) {
      assert.equal(audience, clientId);
      if (idToken !== 'verified-fixture') throw Error('unverified');
      return { getPayload: () => ({ sub: subject, email: 'moderator@example.test' }) };
    },
  };
  registerModeratorAccounts(app, pool, { clientId, google, secure: false });
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const origin = 'http://127.0.0.1:' + listener.address().port;
  const headers = { 'Content-Type': 'application/json', 'X-Convora-Account': '1' };
  const post = (path, body, extra = {}) => fetch(origin + '/api/account/' + path, {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post('login', { credential: 'unverified' })).status, 401);
    assert.equal((await post('login', { credential: 'verified-fixture' }, { Origin: 'https://other.example' })).status, 403);
    const login = await post('login', { credential: 'verified-fixture' });
    assert.equal(login.status, 204);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);
    headers.Cookie = cookie.split(';')[0];
    const { slug, adminToken, id } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('creator') })).body;
    const promoted = crypto.randomUUID();
    await pool.query('INSERT INTO discussion_moderators (discussion_id, user_id, token) VALUES ($1, $2, $3)',
      [id, crypto.randomUUID(), promoted]);
    const link = async token => (await post('link', { discussions: [{ slug, token }] })).json();
    assert.deepEqual(await link(promoted), { linked: 0 });
    assert.deepEqual(await link(adminToken), { linked: 1 });
    assert.deepEqual(await link(adminToken), { linked: 0 });
    await pool.query("UPDATE moderator_sessions SET expires_at = now() WHERE google_sub = $1", [subject]);
    assert.equal((await fetch(origin + '/api/account/access/' + slug, { headers })).status, 401);
  } finally {
    await new Promise(resolve => listener.close(resolve));
    await pool.query('DELETE FROM moderator_sessions WHERE google_sub = $1', [subject]);
  }
});

test('speaking queues enforce room scope, ownership, lock and moderator access', async () => {
  const room = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('hands') })).body;
  const { rows: [question, queued] } = await pool.query(`INSERT INTO questions (discussion_id,text,type,queued)
    VALUES ($1,'Live','Agreement',false), ($1,'Later','Agreement',true) RETURNING id`, [room.id]);
  const guests = await Promise.all([connectSocket(), connectSocket()]);
  const participants = [crypto.randomUUID(), crypto.randomUUID()];
  const change = (index, extra) => emitWithAck(guests[index], 'changeSpeakingQueue', room.slug, {
    questionId: question.id, userId: participants[index], name: `Speaker ${index}`, action: 'raise', ...extra,
  });
  const read = (index, token) => emitWithAck(guests[index], 'readSpeakingQueue', room.slug, participants[index], token);
  try {
    await Promise.all(guests.map((guest, index) => {
      const joined = waitForEvent(guest, 'discussionState');
      guest.emit('joinDiscussion', room.slug);
      guest.emit('identify', room.slug, participants[index]);
      return joined;
    }));
    assert.equal((await change(0)).ok, false);
    await pool.query('UPDATE discussions SET hands_enabled = true WHERE id = $1', [room.id]);
    assert.equal((await change(0, { questionId: queued.id })).ok, false);
    assert.equal((await change(0)).ok, true);
    assert.equal((await change(0)).ok, true);
    const { entries } = await read(0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].mine, true);
    assert.deepEqual((await read(1, 'invalid')).entries, []);
    assert.equal((await change(1, { action: 'done', entryId: entries[0].id })).ok, false);
    assert.equal((await change(1, { action: 'lower', userId: participants[0] })).ok, true);
    const host = await read(1, room.adminToken);
    assert.equal(host.entries[0].name, 'Speaker 0');
    assert.ok(!JSON.stringify(host.entries).includes(participants[0]));
    await pool.query('UPDATE discussions SET locked = true WHERE id = $1', [room.id]);
    assert.equal((await change(1)).ok, false);
    await pool.query('UPDATE discussions SET locked = false WHERE id = $1', [room.id]);
    assert.equal((await change(1, { action: 'done', entryId: entries[0].id, token: room.adminToken })).ok, true);
    assert.deepEqual((await read(0)).entries, []);
  } finally {
    guests.forEach(guest => guest.disconnect());
  }
});

test('server startup creates schema and applies the pseudonym migration', async () => {
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('discussions', 'questions', 'votes')
    ORDER BY table_name
  `);
  assert.deepEqual(tables.rows.map((row) => row.table_name), ['discussions', 'questions', 'votes']);

  const columns = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND ((table_name = 'votes' AND column_name = 'pseudonym')
        OR (table_name = 'discussions' AND column_name = 'short_code'))
    ORDER BY table_name, column_name
  `);
  assert.deepEqual(columns.rows.map((row) => row.column_name), ['short_code', 'pseudonym']);
});

for (const order of ['delete-first', 'rename-first']) {
  test(`promoted moderator rename and creator deletion serialize when ${order}`, async () => {
    const created = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('rename-delete') })).body;
    const title = uniqueTopic('Requested New Title');
    const token = 'promoted-' + crypto.randomUUID();
    await pool.query('INSERT INTO discussion_moderators (discussion_id, user_id, token) VALUES ($1, $2, $3)', [created.id, 'promoted-renamer', token]);
    const socket = await connectSocket();
    const blocker = await pool.connect();
    let deleting;
    let renaming;
    const waitForLocks = async count => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'");
        if (result.rows[0].n >= count) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Timed out waiting for rename/deletion operations');
    };
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM discussions WHERE id = $1 FOR UPDATE', [created.id]);
      if (order === 'delete-first') deleting = jsonRequest('DELETE', `/api/discussions/${created.slug}`, { adminToken: created.adminToken });
      else renaming = emitWithAck(socket, 'setTopic', created.slug, title, token);
      await waitForLocks(1);
      if (order === 'delete-first') renaming = emitWithAck(socket, 'setTopic', created.slug, title, token);
      else deleting = jsonRequest('DELETE', `/api/discussions/${created.slug}`, { adminToken: created.adminToken });
      await waitForLocks(2);
      await blocker.query('COMMIT');
      const [deleted, renamed] = await Promise.all([deleting, renaming]);
      assert.equal(deleted.status, 200);
      assert.equal(renamed.updated, order === 'rename-first');
      assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent(title)}`)).status, order === 'rename-first' ? 410 : 404);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM discussions WHERE id = $1', [created.id])).rows[0].n, 0);
    } finally {
      await blocker.query('ROLLBACK');
      await Promise.allSettled([deleting, renaming].filter(Boolean));
      blocker.release();
      socket.disconnect();
    }
  });
}

test('deleting rooms with swapped title aliases does not invert lifecycle locks', async () => {
  const a = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('swap-a') })).body;
  const b = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('swap-b') })).body;
  const socket = await connectSocket();
  try {
    assert.equal((await emitWithAck(socket, 'setTopic', a.slug, b.topic + '!', a.adminToken)).updated, true);
    assert.equal((await emitWithAck(socket, 'setTopic', b.slug, a.topic + '!', b.adminToken)).updated, true);
    const results = await withTimeout(Promise.all([
      jsonRequest('DELETE', `/api/discussions/${a.slug}`, { adminToken: a.adminToken }),
      jsonRequest('DELETE', `/api/discussions/${b.slug}`, { adminToken: b.adminToken }),
      jsonRequest('POST', '/api/discussions', { topic: a.topic }),
    ]), 5000, 'Concurrent alias deletion/creation deadlocked');
    assert.deepEqual(results.map(result => result.status), [200, 200, 200]);
  } finally { socket.disconnect(); }
});

test('deletion reserves renamed title aliases without hiding another live canonical room', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('old-title') });
  const title = uniqueTopic('Renamed Title');
  const alias = title.toLowerCase().replace(/\s+/g, '-');
  const { socket } = await joinAs(created.body.slug, 'alias-visitor');
  try {
    assert.equal((await emitWithAck(socket, 'setTopic', created.body.slug, title, created.body.adminToken)).updated, true);
    assert.equal((await jsonRequest('DELETE', `/api/discussions/${created.body.slug}`, { adminToken: created.body.adminToken })).status, 200);
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent(title)}`)).status, 410);
    const missing = waitForEvent(socket, 'discussionDeleted');
    socket.emit('joinDiscussion', alias);
    assert.deepEqual(await missing, { slug: alias });
    assert.equal((await emitWithAck(socket, 'claimModerator', alias)).success, false);
    assert.equal((await emitWithAck(socket, 'addQuestion', alias, { text: 'Stale alias submission', type: 'Agreement' }, true)).added, false);
    const live = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('Collision Room') });
    const original = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('collision-original') });
    const collidingTitle = live.body.topic + '!';
    assert.equal((await emitWithAck(socket, 'setTopic', original.body.slug, collidingTitle, original.body.adminToken)).updated, true);
    assert.equal((await jsonRequest('DELETE', `/api/discussions/${original.body.slug}`, { adminToken: original.body.adminToken })).status, 200);
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent(collidingTitle)}`)).status, 410);
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${live.body.slug}`)).body.id, live.body.id);
    const exactAlias = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('exact-alias-original') });
    assert.equal((await emitWithAck(socket, 'setTopic', exactAlias.body.slug, live.body.slug, exactAlias.body.adminToken)).updated, true);
    assert.equal((await jsonRequest('DELETE', `/api/discussions/${exactAlias.body.slug}`, { adminToken: exactAlias.body.adminToken })).status, 200);
    // Even an exact deleted title equal to another room's canonical slug must
    // not mask that live route in the resolver.
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${live.body.slug}`)).body.id, live.body.id);
    assert.equal((await emitWithAck(socket, 'addQuestion', live.body.slug, { text: 'The other room stays usable', type: 'Agreement' }, true)).added, true);
    await stopServer();
    await startServer();
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent(title)}`)).status, 410);
  } finally { socket.disconnect(); }
});

test('deletion rejects queued and stale question submissions without reusing the deleted slug', async () => {
  const topic = uniqueTopic('delete-race');
  const created = await jsonRequest('POST', '/api/discussions', { topic });
  const { id, slug, adminToken } = created.body;
  const { socket } = await joinAs(slug, 'stale-participant');
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM discussions WHERE id = $1 FOR UPDATE', [id]);
    const deleting = jsonRequest('DELETE', `/api/discussions/${slug}`, { adminToken });
    const waitForLocks = async count => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'");
        if (result.rows[0].n >= count) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Timed out waiting for blocked lifecycle operations');
    };
    await waitForLocks(1);
    const adding = emitWithAck(socket, 'addQuestion', slug, { text: 'A queued stale question', type: 'Agreement' }, true);
    await waitForLocks(2);
    await blocker.query('COMMIT');
    assert.equal((await deleting).status, 200);
    assert.equal((await adding).added, false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM discussions WHERE slug = $1', [slug])).rows[0].n, 0);
    assert.equal((await emitWithAck(socket, 'addQuestion', slug, { text: 'A later stale question', type: 'Agreement' }, true)).added, false);
    assert.equal((await emitWithAck(socket, 'claimModerator', slug)).success, false);
    await stopServer();
    await startServer();
    const restarted = await connectSocket();
    try {
      const deletedJoin = waitForEvent(restarted, 'discussionDeleted');
      restarted.emit('joinDiscussion', slug);
      assert.deepEqual(await deletedJoin, { slug });
    } finally { restarted.disconnect(); }
    const replacement = await jsonRequest('POST', '/api/discussions', { topic });
    assert.equal(replacement.status, 200);
    assert.notEqual(replacement.body.slug, slug);
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${slug}`)).status, 404);
    assert.equal((await jsonRequest('DELETE', `/api/discussions/${replacement.body.slug}`, { adminToken: replacement.body.adminToken })).status, 200);
    const source = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('copy-source') });
    const duplicate = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: source.body.slug, newTopic: topic });
    assert.equal(duplicate.status, 200);
    assert.notEqual(duplicate.body.newSlug, slug);
    assert.notEqual(duplicate.body.newSlug, replacement.body.slug);
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${slug}`)).status, 404);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    socket.disconnect();
  }
});

test('only the creator can delete a discussion, removing all contents and notifying viewers', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('delete') });
  const other = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('keep') });
  const { id, slug, adminToken } = created.body;
  const q = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Idea', 'Brainstorm') RETURNING id", [id])).rows[0].id;
  const v = (await pool.query("INSERT INTO votes (question_id, value, user_id) VALUES ($1, 'Response', 'person') RETURNING id", [q])).rows[0].id;
  await pool.query("INSERT INTO response_votes (response_id, user_id) VALUES ($1, 'other')", [v]);
  await pool.query("INSERT INTO response_ratings (response_id, user_id, quality) VALUES ($1, 'other', 1)", [v]);
  await pool.query("INSERT INTO response_reactions (response_id, user_id, reaction) VALUES ($1, 'other', 'follows')", [v]);
  await pool.query("INSERT INTO response_comments (response_id, user_id, body) VALUES ($1, 'other', 'Comment')", [v]);
  await pool.query("INSERT INTO opinion_snapshots (discussion_id, name, data) VALUES ($1, 'Snapshot', '{}')", [id]);
  await pool.query("INSERT INTO discussion_moderators (discussion_id, user_id, token) VALUES ($1, 'other', 'promoted-token')", [id]);
  await pool.query("INSERT INTO discussion_pseudonyms (discussion_id, user_id, pseudonym) VALUES ($1, 'person', 'Happy Fox')", [id]);
  const endpoint = `/api/discussions/${slug}`;
  for (const token of [undefined, '', {}, 'wrong', 'promoted-token', other.body.adminToken]) {
    assert.equal((await jsonRequest('DELETE', endpoint, { adminToken: token })).status, 403);
  }
  assert.equal((await pool.query('SELECT id FROM votes WHERE id = $1', [v])).rowCount, 1);
  const socket = await connectSocket();
  try {
    const joined = once(socket, 'discussion');
    socket.emit('joinDiscussion', slug);
    await joined;
    const deleted = once(socket, 'discussionDeleted');
    const result = await jsonRequest('DELETE', endpoint, { adminToken });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { deleted: true });
    assert.deepEqual((await deleted)[0], { slug });
    for (const table of ['questions', 'votes', 'response_votes', 'response_ratings', 'response_reactions', 'response_comments', 'opinion_snapshots', 'discussion_moderators', 'discussion_pseudonyms']) {
      assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
    }
    assert.deepEqual((await pool.query('SELECT id FROM discussions')).rows.map(row => row.id), [other.body.id]);
    assert.equal((await jsonRequest('DELETE', endpoint, { adminToken })).status, 403);
  } finally {
    socket.disconnect();
  }
});

async function isolatedMigrationSchema(t) {
  const schema = 'migration_' + crypto.randomBytes(8).toString('hex');
  await pool.query(`CREATE SCHEMA ${schema}`);
  const pools = [];
  t.after(async () => {
    await Promise.all(pools.map(instance => instance.end()));
    await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  });
  return (extraOptions = '') => {
    const instance = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema} ${extraOptions}` });
    pools.push(instance);
    return instance;
  };
}

test('concurrent cold boots install one schema; a warm boot needs no writes', async t => {
  const instance = await isolatedMigrationSchema(t);
  const first = instance();
  await Promise.all([first, instance(), instance(), instance()].map(initializeDatabase));
  const versions = (await first.query('SELECT version FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(versions.map(row => row.version), require('../migrations').map(([version]) => version));
  await first.query("INSERT INTO discussions (topic, slug) VALUES ('renamed', 'permanent-link')");
  await initializeDatabase(instance('-c default_transaction_read_only=on'));
  assert.equal((await first.query('SELECT slug FROM discussions')).rows[0].slug, 'permanent-link');
});

test('failed legacy upgrade rolls back schema, repairs and versions, then retries', async t => {
  const instance = await isolatedMigrationSchema(t);
  const legacy = instance();
  await legacy.query(`
    CREATE TABLE discussions (id serial PRIMARY KEY, topic text NOT NULL, short_code text, admin_token text, locked boolean NOT NULL DEFAULT false);
    INSERT INTO discussions (topic, short_code, admin_token, locked) VALUES
      ('Duplicate', 'dup', NULL, false), ('Duplicate', NULL, 'old-token', true), ('Other', 'dup', NULL, false);
    CREATE TABLE questions (id serial PRIMARY KEY, discussion_id integer REFERENCES discussions, type text NOT NULL);
    INSERT INTO questions (discussion_id, type) VALUES (2, 'Brainstorm');
  `);
  await assert.rejects(initializeDatabase(legacy), { code: '23505' });
  assert.deepEqual((await legacy.query("SELECT to_regclass('schema_migrations') AS ledger, to_regclass('votes') AS votes")).rows[0],
    { ledger: null, votes: null });
  assert.equal((await legacy.query('SELECT discussion_id FROM questions')).rows[0].discussion_id, 2);
  assert.equal((await legacy.query('SELECT * FROM discussions')).rowCount, 3);

  await legacy.query("UPDATE discussions SET short_code = 'other' WHERE topic = 'Other'");
  await initializeDatabase(legacy);
  assert.deepEqual((await legacy.query("SELECT id, admin_token, locked, slug FROM discussions WHERE topic = 'Duplicate'")).rows,
    [{ id: 1, admin_token: 'old-token', locked: true, slug: 'duplicate' }]);
  assert.deepEqual((await legacy.query('SELECT discussion_id, type, show_attribution FROM questions')).rows,
    [{ discussion_id: 1, type: 'Open Ended', show_attribution: false }]);
});

test('pending migrations repair old reaction data without replaying earlier slug or policy changes', async t => {
  const instance = await isolatedMigrationSchema(t);
  const db = instance();
  await initializeDatabase(db);
  await db.query(`
    DELETE FROM schema_migrations WHERE version >= 10;
    INSERT INTO discussions (topic, slug, reactions_enabled) VALUES ('renamed', 'stable-link', true);
    INSERT INTO questions (discussion_id, text, type, max_responses) VALUES (1, 'Written', 'Open Ended', 4);
    INSERT INTO votes (question_id, value) VALUES (1, 'An idea');
    INSERT INTO response_reactions (response_id, user_id, reaction) VALUES
      (1, 'first', 'locally-valid'), (1, 'second', 'locally-invalid');
  `);
  await initializeDatabase(db);
  assert.deepEqual((await db.query('SELECT slug, reactions_enabled FROM discussions')).rows,
    [{ slug: 'stable-link', reactions_enabled: true }]);
  assert.deepEqual((await db.query('SELECT max_responses FROM questions')).rows, [{ max_responses: 4 }]);
  assert.deepEqual((await db.query('SELECT user_id, reaction FROM response_reactions')).rows,
    [{ user_id: 'first', reaction: 'follows' }]);
});

test('initialization adds the vote lookup index to existing databases idempotently', async () => {
  await pool.query('DROP TABLE schema_migrations; DROP INDEX votes_question_id_idx');
  await initializeDatabase(pool);
  await initializeDatabase(pool);
  const index = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'votes' AND indexname = 'votes_question_id_idx'");
  assert.equal(index.rows.length, 1);
  assert.match(index.rows[0].indexdef, /USING btree \(question_id\)/);
});

test('initialization upgrades legacy interaction flags once and preserves later moderator settings', async () => {
  await stopServer();
  try {
    const created = await pool.query(
      "INSERT INTO discussions (topic, slug, theme, locked) VALUES ('Legacy interactions', 'legacy-interactions', 'orange', TRUE) RETURNING id"
    );
    const discussionId = created.rows[0].id;
    await pool.query(
      `INSERT INTO questions (discussion_id, text, type, reactions_enabled, reactions_visible, comments_enabled)
       VALUES ($1, 'Hidden ideas', 'Open Ended', TRUE, FALSE, TRUE),
              ($1, 'Other prompt', 'Agreement', FALSE, TRUE, FALSE)`, [discussionId]
    );
    await pool.query(`DROP TABLE schema_migrations; ALTER TABLE discussions DROP COLUMN reactions_enabled,
      DROP COLUMN reactions_visible, DROP COLUMN comments_enabled`);
    await initializeDatabase(pool);
    const upgraded = await pool.query(
      'SELECT reactions_enabled, reactions_visible, comments_enabled, theme, locked FROM discussions WHERE id = $1', [discussionId]
    );
    assert.deepEqual(upgraded.rows[0], {
      reactions_enabled: true, reactions_visible: false, comments_enabled: true, theme: 'orange', locked: true,
    });

    await pool.query(`UPDATE discussions SET reactions_enabled = FALSE,
      reactions_visible = TRUE, comments_enabled = FALSE WHERE id = $1`, [discussionId]);
    await initializeDatabase(pool);
    const restarted = await pool.query(
      'SELECT reactions_enabled, reactions_visible, comments_enabled, theme, locked FROM discussions WHERE id = $1', [discussionId]
    );
    assert.deepEqual(restarted.rows[0], {
      reactions_enabled: false, reactions_visible: true, comments_enabled: false, theme: 'orange', locked: true,
    });
  } finally {
    await startServer();
  }
});

test('opinion snapshots enforce moderator access and validate names and question types', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('snapshot-auth') });
  const other = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('snapshot-other') });
  const { slug, adminToken } = created.body;
  const url = `/api/discussions/${slug}/snapshots`;
  assert.deepEqual((await jsonRequest('GET', url)).body, { snapshots: [] });
  for (const token of [undefined, 'invalid', other.body.adminToken]) {
    assert.equal((await jsonRequest('POST', url, { name: 'Before', adminToken: token })).status, 403);
  }
  for (const name of ['', '  ', 'x'.repeat(121), 42, {}]) {
    assert.equal((await jsonRequest('POST', url, { name, adminToken })).status, 400);
  }
  assert.equal((await jsonRequest('POST', url, { name: 'Before', adminToken })).status, 400);
  await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Ideas', 'Open Ended')", [created.body.id]);
  assert.equal((await jsonRequest('POST', url, { name: 'Before', adminToken })).status, 400);
  assert.equal((await jsonRequest('GET', '/api/discussions/nonexistent-snapshot-discussion/snapshots')).status, 404);
  assert.deepEqual((await jsonRequest('GET', `/api/discussions/${other.body.slug}/snapshots`)).body, { snapshots: [] });
});

test('snapshots preserve probabilities and opinion distributions across updates, edits, deletion, and restart', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('snapshot-lifecycle') });
  const { id, slug, adminToken } = created.body;
  const url = `/api/discussions/${slug}/snapshots`;
  const questions = await pool.query(
    `INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES
      ($1, 'Probability of success (%)?', 'Numerical', 0, 100),
      ($1, 'We should proceed', 'Agreement', NULL, NULL),
      ($1, 'Proceed?', 'Yes/No', NULL, NULL),
      ($1, 'Why?', 'Open Ended', NULL, NULL)
     RETURNING id`, [id]
  );
  const [numerical, agreement, yesNo, written] = questions.rows.map(q => q.id);
  await pool.query(
    `INSERT INTO votes (question_id, value, user_id, pseudonym) VALUES
      ($1, '30', 'private-snapshot-user-a', 'Private Snapshot Name'),
      ($1, '50', 'private-snapshot-user-b', NULL),
      ($2, 'Agree', 'private-snapshot-user-a', NULL),
      ($2, 'Disagree', 'private-snapshot-user-b', NULL),
      ($3, 'Yes', 'private-snapshot-user-a', NULL),
      ($3, 'No', 'private-snapshot-user-b', NULL),
      ($4, 'private-written-answer', 'private-snapshot-user-a', NULL)`,
    [numerical, agreement, yesNo, written]
  );
  const firstResponse = await jsonRequest('POST', url, { name: ' Before discussion ', adminToken });
  assert.equal(firstResponse.status, 201);
  const first = firstResponse.body;
  assert.equal(first.name, 'Before discussion');
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  assert.equal(first.data.participantCount, 2);
  assert.equal(first.data.questions.length, 3);
  const initialProbability = first.data.questions.find(q => q.id === numerical);
  assert.equal(initialProbability.average, 40);
  assert.equal(initialProbability.responseCount, 2);
  assert.deepEqual(initialProbability.distribution.map(bin => bin.count), [0, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(first.data.questions.find(q => q.id === agreement).optionCounts,
    { 'Strongly Disagree': 0, Disagree: 1, Unsure: 0, Agree: 1, 'Strongly Agree': 0 });
  assert.deepEqual(first.data.questions.find(q => q.id === yesNo).optionCounts, { No: 1, Yes: 1 });
  assert.doesNotMatch(JSON.stringify(first), /private-snapshot|Private Snapshot Name|private-written-answer|user_id|userId|ownerToken|adminToken/);

  const voter = await connectSocket();
  try {
    const updated = waitForQuestions(voter, qs => qs.some(q => q.id === numerical && q.votes.some(v => v.value === '70')), 'updated probability');
    voter.emit('joinDiscussion', slug);
    voter.emit('vote', slug, numerical, 70, 'private-snapshot-user-a', '');
    await updated;
  } finally {
    voter.disconnect();
  }
  await pool.query("UPDATE votes SET value = 'Strongly Agree' WHERE question_id = $1 AND value = 'Disagree'", [agreement]);
  const second = (await jsonRequest('POST', url, { name: 'After discussion', adminToken })).body;
  assert.equal(second.data.questions.find(q => q.id === numerical).average, 60);
  assert.equal(second.data.questions.find(q => q.id === agreement).optionCounts['Strongly Agree'], 1);
  assert.ok(second.id > first.id);
  assert.deepEqual((await jsonRequest('GET', url, undefined, asModerator(adminToken))).body.snapshots, [first, second]);

  await pool.query("UPDATE questions SET text = 'Edited question', max_value = 200 WHERE id = $1", [numerical]);
  await pool.query('DELETE FROM votes WHERE question_id = $1', [yesNo]);
  await pool.query('DELETE FROM questions WHERE id = $1', [yesNo]);
  await stopServer();
  await startServer();
  assert.deepEqual((await jsonRequest('GET', url, undefined, asModerator(adminToken))).body.snapshots, [first, second]);
  assert.deepEqual((await jsonRequest('GET', `/api/discussions/${slug}/summary`)).body.questions.find(q => q.id === numerical).text, 'Edited question');
});

test('persisted categorical snapshots render ordered labels, zero counts, and aligned before/after values', async () => {
  const componentPath = path.join(rootDir, 'client/src/OpinionSnapshots.jsx');
  const { outputFiles } = await require('esbuild').build({ entryPoints: [componentPath], bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
  const componentModule = { exports: {} };
  const loadComponent = vm.runInThisContext(`(function(require, module, exports) { ${outputFiles[0].text}\n})`, { filename: componentPath });
  loadComponent(require, componentModule, componentModule.exports);
  const { QuestionComparison } = componentModule.exports;

  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('snapshot-display') });
  const { id, slug, adminToken } = created.body;
  const url = `/api/discussions/${slug}/snapshots`;
  const cases = [
    { type: 'Agreement', labels: ['Strongly Disagree', 'Disagree', 'Unsure', 'Agree', 'Strongly Agree'], before: [1, 0, 1, 0, 2], after: [0, 2, 0, 1, 1] },
    { type: 'Yes/No', labels: ['No', 'Yes'], before: [1, 0], after: [0, 2] },
    // Author-written options keep the author's order, not alphabetical or key order.
    { type: 'Multiple Choice', labels: ['Lower', 'About the same', 'Higher'], before: [2, 0, 1], after: [0, 1, 2], choice: true },
  ];
  for (const item of cases) {
    const added = await pool.query(
      'INSERT INTO questions (discussion_id, text, type, options) VALUES ($1, $2, $3, $4) RETURNING id',
      [id, `Saved ${item.type} opinions`, item.type, item.choice ? JSON.stringify(item.labels) : null]
    );
    item.id = added.rows[0].id;
  }
  const setResponses = async phase => {
    for (const item of cases) {
      await pool.query('DELETE FROM votes WHERE question_id = $1', [item.id]);
      let user = 0;
      for (let option = 0; option < item.labels.length; option += 1) {
        for (let count = 0; count < item[phase][option]; count += 1) {
          await pool.query('INSERT INTO votes (question_id, value, user_id) VALUES ($1, $2, $3)', [item.id, item.labels[option], `display-user-${user++}`]);
        }
      }
    }
  };
  await setResponses('before');
  assert.equal((await jsonRequest('POST', url, { name: 'Before', adminToken })).status, 201);
  await setResponses('after');
  assert.equal((await jsonRequest('POST', url, { name: 'After', adminToken })).status, 201);
  const { snapshots: [before, after] } = (await jsonRequest('GET', url, undefined, asModerator(adminToken))).body;

  for (const item of cases) {
    const earlier = before.data.questions.find(q => q.id === item.id);
    const later = after.data.questions.find(q => q.id === item.id);
    if (item.type === 'Agreement') assert.notDeepEqual(Object.keys(earlier.optionCounts), item.labels, 'JSONB has reordered the stored keys');
    const html = renderToStaticMarkup(React.createElement(QuestionComparison, {
      before: earlier, after: later, comparing: true, beforeName: before.name, afterName: after.name,
    }));
    const rows = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)]
      .flatMap(body => [...body[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)])
      .map(row => ({
        label: row[1].match(/<th scope="row"[^>]*>([^<]*)<\/th>/)[1],
        counts: [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
          .map(cell => Number(cell[1].replace(/<[^>]+>/g, '').match(/^(\d+) /)[1])),
      }));
    assert.deepEqual(rows, item.labels.map((label, index) => ({ label, counts: [item.before[index], item.after[index]] })));
  }

  // Someone who has not answered gets each Multiple Choice snapshot without its
  // counts, but still sees the options it asked about.
  const choice = cases.find(item => item.choice);
  const { snapshots: [hiddenBefore, hiddenAfter] } = (await jsonRequest('GET', url, undefined, asUser('snapshot-stranger'))).body;
  const hiddenEarlier = hiddenBefore.data.questions.find(q => q.id === choice.id);
  assert.deepEqual(hiddenEarlier, {
    id: choice.id, text: 'Saved Multiple Choice opinions', type: 'Multiple Choice', options: choice.labels, resultsHidden: true,
  });
  const hiddenHtml = renderToStaticMarkup(React.createElement(QuestionComparison, {
    before: hiddenEarlier, after: hiddenAfter.data.questions.find(q => q.id === choice.id),
    comparing: true, beforeName: hiddenBefore.name, afterName: hiddenAfter.name,
  }));
  assert.deepEqual([...hiddenHtml.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map(match => match[1]), choice.labels);
  assert.doesNotMatch(hiddenHtml, /<table|\d+%/);
  // A long unbroken option wraps inside the card rather than overflowing it.
  for (const item of hiddenHtml.matchAll(/<li class="([^"]*)"/g)) {
    assert.match(item[1], /\bmax-w-full\b/);
    assert.match(item[1], /\bbreak-words\b/);
  }
});

test('snapshots support empty responses, numerical bounds, locked rooms, and promoted moderators', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('snapshot-boundaries') });
  const { id, slug, adminToken } = created.body;
  const url = `/api/discussions/${slug}/snapshots`;
  const added = await pool.query(
    "INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES ($1, 'Probability?', 'Numerical', 0, 100) RETURNING id", [id]
  );
  const questionId = added.rows[0].id;
  const empty = (await jsonRequest('POST', url, { name: 'No responses yet', adminToken })).body;
  assert.equal(empty.data.participantCount, 0);
  assert.equal(empty.data.questions[0].average, null);
  assert.equal(empty.data.questions[0].responseCount, 0);
  assert.equal(empty.data.questions[0].distribution.reduce((sum, bin) => sum + bin.count, 0), 0);
  await pool.query(
    "INSERT INTO votes (question_id, value, user_id) VALUES ($1, '0', 'a'), ($1, '100', 'b'), ($1, 'invalid legacy value', 'c')", [questionId]
  );
  await pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [id]);
  const token = crypto.randomBytes(16).toString('hex');
  await pool.query('INSERT INTO discussion_moderators (discussion_id, user_id, token) VALUES ($1, $2, $3)', [id, 'promoted-user', token]);
  const saved = await jsonRequest('POST', url, { name: 'Final opinions', adminToken: token });
  assert.equal(saved.status, 201);
  const probability = saved.body.data.questions[0];
  assert.equal(probability.average, 50);
  assert.equal(probability.responseCount, 2);
  assert.equal(saved.body.data.participantCount, 2);
  assert.equal(probability.distribution[0].count, 1);
  assert.equal(probability.distribution[9].count, 1);
  await pool.query('DELETE FROM discussion_moderators WHERE token = $1', [token]);
  assert.equal((await jsonRequest('POST', url, { name: 'Revoked moderator', adminToken: token })).status, 403);
});

test('HTTP API creates and fetches discussions', async () => {
  const topic = uniqueTopic('http');
  const createResponse = await jsonRequest('POST', '/api/discussions', { topic });

  assert.equal(createResponse.status, 200);
  assert.equal(createResponse.body.success, true);
  assert.ok(Number.isInteger(createResponse.body.id) && createResponse.body.id > 0);
  assert.equal(createResponse.body.topic, topic);
  assert.match(createResponse.body.slug, /^http-/);
  assert.match(createResponse.body.adminToken, /^[a-f0-9]{32}$/);

  const fetchResponse = await jsonRequest('GET', `/api/discussions/resolve/${createResponse.body.slug}`);
  assert.equal(fetchResponse.status, 200);
  assert.equal(fetchResponse.body.topic, topic);
});

test('discussions are unlisted: the listing endpoint returns only slugs the caller already knows', async () => {
  const mine = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('unlisted-mine') });
  const theirs = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('Unlisted Theirs') });

  // An anonymous visitor who knows no slugs learns nothing.
  for (const query of ['', '?slugs=', '?slugs=,', '?admin=anything', '?slugs[]=x', '?slugs=%25', '?slugs=*']) {
    const anonymous = await jsonRequest('GET', `/api/discussions${query}`);
    assert.equal(anonymous.status, 200);
    assert.deepEqual(anonymous.body, [], `GET /api/discussions${query} leaked discussions`);
  }

  // Knowing one slug reveals that discussion and no other.
  const known = await jsonRequest('GET', `/api/discussions?slugs=${mine.body.slug},no-such-discussion`);
  assert.equal(known.status, 200);
  assert.deepEqual(known.body.map(row => row.slug), [mine.body.slug]);
  assert.equal(known.body[0].topic, mine.body.topic);
  assert.deepEqual(Object.keys(known.body[0]).sort(), ['created_at', 'slug', 'topic']);
  assert.equal(JSON.stringify(known.body).includes(theirs.body.slug), false);

  // Only exact slugs match; titles and partial slugs are not a search.
  assert.notEqual(theirs.body.topic, theirs.body.slug);
  const byTitle = await jsonRequest('GET', `/api/discussions?slugs=${encodeURIComponent(theirs.body.topic)}`);
  assert.deepEqual(byTitle.body.filter(row => row.slug === theirs.body.slug), []);
  const byPrefix = await jsonRequest('GET', '/api/discussions?slugs=unlisted');
  assert.deepEqual(byPrefix.body, []);

  // Sequential ids must not be an alternative way to enumerate discussions.
  const byId = await fetch(`${baseUrl}/api/discussions/${theirs.body.id}`);
  assert.equal((await byId.text()).includes(theirs.body.slug), false);

  // Creating a discussion is not announced to unrelated connected clients.
  const bystander = await connectSocket();
  try {
    let announced = false;
    bystander.onAny(() => { announced = true; });
    const quiet = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('unlisted-quiet') });
    assert.equal(quiet.status, 200);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(announced, false);
  } finally {
    bystander.disconnect();
  }
});

test('a creator can list a discussion publicly; everything else stays unlisted', async () => {
  const publicSlugs = async () => {
    const response = await jsonRequest('GET', '/api/discussions/public');
    assert.equal(response.status, 200);
    return response.body.map(row => row.slug);
  };

  // Unlisted by default, and ignored unless it is exactly true.
  const quiet = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('listing-default') });
  const sneaky = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('listing-truthy'), listed: 'yes' });
  assert.deepEqual(await publicSlugs(), []);

  // Listed at creation: shown with only its title, slug and creation time.
  const listed = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('listing-public'), listed: true });
  const list = (await jsonRequest('GET', '/api/discussions/public')).body;
  assert.deepEqual(list.map(row => row.slug), [listed.body.slug]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['created_at', 'slug', 'topic']);
  assert.equal(list[0].topic, listed.body.topic);

  // Typing an existing title joins that discussion and must not change its listing.
  const rejoin = await jsonRequest('POST', '/api/discussions', { topic: quiet.body.topic, listed: true });
  assert.equal(rejoin.body.slug, quiet.body.slug);
  assert.equal(rejoin.body.adminToken, null);
  const unlistAttempt = await jsonRequest('POST', '/api/discussions', { topic: listed.body.topic, listed: false });
  assert.equal(unlistAttempt.body.adminToken, null);
  assert.deepEqual(await publicSlugs(), [listed.body.slug]);

  // Only a moderator can change it, and everyone in the room hears the change.
  const { socket: participant } = await joinAs(quiet.body.slug, 'listing-participant');
  const mod = await connectSocket();
  try {
    const refused = waitForEvent(participant, 'error', error => /not authorized/i.test(error.message));
    participant.emit('setListed', quiet.body.slug, true, 'not-the-token');
    await refused;
    assert.deepEqual(await publicSlugs(), [listed.body.slug]);

    const shown = waitForEvent(participant, 'discussionState', state => state.listed === true);
    mod.emit('setListed', quiet.body.slug, true, quiet.body.adminToken);
    await shown;
    assert.deepEqual((await publicSlugs()).sort(), [listed.body.slug, quiet.body.slug].sort());

    const hidden = waitForEvent(participant, 'discussionState', state => state.listed === false);
    mod.emit('setListed', quiet.body.slug, false, quiet.body.adminToken);
    await hidden;
    assert.deepEqual(await publicSlugs(), [listed.body.slug]);
  } finally {
    participant.disconnect();
    mod.disconnect();
  }

  // A duplicate starts unlisted, whatever the original was.
  const copy = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: listed.body.slug, newTopic: uniqueTopic('listing-copy') });
  assert.equal(copy.status, 200);
  assert.deepEqual(await publicSlugs(), [listed.body.slug]);
  assert.equal((await publicSlugs()).includes(sneaky.body.slug), false);
});

for (const { type, value, expected, equivalentIds } of [
  { type: 'Numerical', value: '42', expected: 1 },
  { type: 'Numerical', value: '42', expected: 1, equivalentIds: true },
  { type: 'Open Ended', value: 'An answer', expected: 10 },
  { type: 'Agreement', value: 'Agree', expected: 1 },
  { type: 'Yes/No', value: 'Yes', expected: 1 },
  { type: 'Open Ended', value: 'An idea', expected: 10 },
]) {
  test(`concurrent ${type} submissions${equivalentIds ? ' with equivalent IDs' : ''} store one response per poll and distinct brainstorm idea`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('concurrent-votes') });
    const question = await pool.query(
      'INSERT INTO questions (discussion_id, text, type) VALUES ($1, $2, $3) RETURNING id',
      [created.body.id, 'Concurrent answers', type]
    );
    const questionId = question.rows[0].id;
    const applicationName = uniqueTopic('vote-race');
    const writers = new Pool({ connectionString: databaseUrl, max: 10, application_name: applicationName });
    const { addVote } = createVoteStore(writers);
    const blocker = await pool.connect();
    let submissions = [];
    try {
      // Hold inserts until all ten writers are waiting. Without serialization,
      // each writer reads an absent vote and then inserts its own duplicate.
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE votes IN SHARE MODE');
      const ids = equivalentIds ? [questionId, `00${questionId}`, `+${questionId}`] : [questionId];
      submissions = Array.from({ length: 10 }, (_, index) => addVote(ids[index % ids.length], value, 'same-user', null));
      const deadline = Date.now() + 5000;
      let allWaiting = false;
      while (Date.now() < deadline) {
        const waiting = await pool.query(
          `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE application_name = $1 AND wait_event_type = 'Lock'`, [applicationName]
        );
        if (waiting.rows[0].count === 10) {
          allWaiting = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(allWaiting, 'Concurrent vote writers did not reach the lock');
      await blocker.query('COMMIT');
      await Promise.all(submissions);
      const stored = await pool.query('SELECT value FROM votes WHERE question_id = $1', [questionId]);
      assert.equal(stored.rows.length, expected);
      assert.ok(stored.rows.every(row => row.value === value));
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled(submissions);
      await writers.end();
    }
  });
}

// Give a racing statement on the questions table up to two seconds to block on
// the row lock the test holds, so the test releases the lock only once the race
// is set up. Without serialization nothing blocks, and the test goes on to
// assert the outcome anyway, which is what catches the bug.
async function waitForQuestionLockWait() {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const waiting = await pool.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE '%questions%'`
    );
    if (waiting.rows[0].count > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('a vote that waits for a moderator edit is checked against the edited options', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('edit-then-vote') });
  const inserted = await pool.query(
    `INSERT INTO questions (discussion_id, text, type, options)
     VALUES ($1, 'Which?', 'Multiple Choice', $2) RETURNING id`,
    [created.body.id, JSON.stringify(['Old A', 'Old B'])]
  );
  const questionId = inserted.rows[0].id;
  const editor = await pool.connect();
  let vote;
  try {
    // The moderator's edit holds the row while the vote arrives.
    await editor.query('BEGIN');
    await editor.query('UPDATE questions SET options = $1 WHERE id = $2', [JSON.stringify(['New A', 'New B']), questionId]);
    vote = createVoteStore(pool).addVote(questionId, 'Old A', 'racer', null);
    await waitForQuestionLockWait();
    await editor.query('COMMIT');
    assert.deepEqual(await vote, { added: false, reason: 'invalid' });
    assert.deepEqual(await storedVotes(questionId), []);
    // A vote for one of the new options is stored as usual.
    assert.deepEqual(await createVoteStore(pool).addVote(questionId, 'New A', 'racer', null), { added: true });
  } finally {
    await editor.query('ROLLBACK').catch(() => {});
    editor.release();
    await Promise.allSettled([vote]);
  }
});

test('a moderator edit that waits for an in-flight vote is refused once the vote is stored', async () => {
  const topic = uniqueTopic('vote-then-edit');
  const mod = await connectSocket();
  const voter = await pool.connect();
  let edit;
  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const added = waitForQuestions(mod, (qs) => qs.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Which?', type: 'Multiple Choice', options: ['Old A', 'Old B'] });
    const question = (await added)[0];

    // A vote is mid-transaction: it has locked the question and stored its
    // answer but not yet committed when the edit arrives.
    await voter.query('BEGIN');
    await voter.query('SELECT id FROM questions WHERE id = $1 FOR SHARE', [question.id]);
    await voter.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'racer', 'Old A')", [question.id]);
    edit = emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Which?', type: 'Multiple Choice', options: ['New A', 'New B'] }, token);
    await waitForQuestionLockWait();
    await voter.query('COMMIT');

    assert.deepEqual(await edit, { updated: false, reason: 'has_responses' });
    const stored = await pool.query('SELECT options FROM questions WHERE id = $1', [question.id]);
    assert.deepEqual(stored.rows[0].options, ['Old A', 'Old B']);
  } finally {
    await voter.query('ROLLBACK').catch(() => {});
    voter.release();
    await Promise.allSettled([edit]);
    mod.disconnect();
  }
});

test('updating a poll repairs legacy duplicates without removing brainstorm ideas', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-duplicates') });
  const questions = await pool.query(
    `INSERT INTO questions (discussion_id, text, type) VALUES
     ($1, 'Estimate', 'Numerical'), ($1, 'Ideas', 'Open Ended') RETURNING id`, [created.body.id]
  );
  const [poll, brainstorm] = questions.rows.map(row => row.id);
  await pool.query(
    `INSERT INTO votes (question_id, user_id, value) VALUES
     ($1, 'same-user', '1'), ($1, 'same-user', '2'), ($1, 'other-user', '3'),
     ($2, 'same-user', 'Idea one'), ($2, 'same-user', 'Idea two')`, [poll, brainstorm]
  );
  await createVoteStore(pool).addVote(poll, '4', 'same-user', null);
  const stored = await pool.query('SELECT value FROM votes WHERE question_id = $1 ORDER BY value', [poll]);
  assert.deepEqual(stored.rows.map(row => row.value), ['3', '4']);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM votes WHERE question_id = $1', [brainstorm])).rows[0].count, 2);
});

for (const { type, first, second } of [
  { type: 'Agreement', first: 'Agree', second: 'Disagree' },
  { type: 'Yes/No', first: 'Yes', second: 'No' },
]) {
  test(`undoing the displayed ${type} vote clears divergent legacy duplicates`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-undo') });
    const questions = await pool.query(
      `INSERT INTO questions (discussion_id, text, type) VALUES
       ($1, 'Opinion', $2), ($1, 'Ideas', 'Open Ended') RETURNING id`, [created.body.id, type]
    );
    const [poll, brainstorm] = questions.rows.map(row => row.id);
    await pool.query(
      `INSERT INTO votes (question_id, user_id, value) VALUES
       ($1, 'same-user', $3), ($1, 'same-user', $4), ($1, 'other-user', $3),
       ($2, 'same-user', 'Idea one'), ($2, 'same-user', 'Idea two')`, [poll, brainstorm, first, second]
    );
    const socket = await connectSocket();
    try {
      const joined = waitForQuestions(socket, qs => qs.length === 2, 'legacy duplicate votes');
      socket.emit('identify', created.body.slug, 'same-user');
      socket.emit('joinDiscussion', created.body.slug);
      const current = (await joined)[0].votes[0];
      assert.equal(current.value, first, 'The client selects its first owned response as current');
      const undone = waitForQuestions(socket, qs => qs[0]?.resultsHidden === true, 'legacy vote undone');
      socket.emit('clearVote', created.body.slug, poll, 'same-user');
      await undone;
      const remaining = await pool.query('SELECT user_id, value FROM votes WHERE question_id = $1', [poll]);
      assert.deepEqual(remaining.rows, [{ user_id: 'other-user', value: first }]);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM votes WHERE question_id = $1', [brainstorm])).rows[0].count, 2);
    } finally {
      socket.disconnect();
    }
  });
}

test('request and vote logs omit credentials, identities, and answer contents', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('private-logs') });
  const { slug, adminToken } = created.body;
  const socket = await connectSocket();
  const privateId = crypto.randomBytes(16).toString('hex');
  const privateName = 'Private Log Name';
  const privateAnswer = 'private-answer-' + crypto.randomBytes(8).toString('hex');
  try {
    socket.emit('joinDiscussion', slug);
    const added = waitForQuestions(socket, qs => qs.length === 1, 'private question');
    socket.emit('addQuestion', slug, { text: 'Written answer', type: 'Open Ended' });
    const question = (await added)[0];
    const answered = waitForQuestions(socket, qs => qs[0]?.votes.length === 1, 'private answer');
    socket.emit('vote', slug, question.id, privateAnswer, privateId, privateName);
    await answered;
    await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken });
    await jsonRequest('GET', `/api/discussions?admin=${adminToken}`);
    // Exercise parser errors too: Express's default handler prints raw input.
    const malformed = await fetch(`${baseUrl}/api/discussions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"secret":"${privateId}" invalid}`,
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'Invalid request' });
    // Invalid integer input creates a PostgreSQL error whose detail contains
    // the supplied value. It must keep a diagnostic code without the payload.
    const failed = waitForEvent(socket, 'error');
    socket.emit('vote', slug, privateAnswer, 'irrelevant', privateId, privateName);
    await failed;
    assert.match(serverOutput, /22P02/);
    for (const secret of [adminToken, privateId, privateName, privateAnswer]) {
      assert.equal(serverOutput.includes(secret), false, 'Sensitive value appeared in server logs');
    }
  } finally {
    socket.disconnect();
  }
});

test('HTTP API creates distinct discussions for colliding slugs', async () => {
  const firstResponse = await jsonRequest('POST', '/api/discussions', { topic: 'C++' });
  const secondResponse = await jsonRequest('POST', '/api/discussions', { topic: 'C#' });

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(firstResponse.body.topic, 'C++');
  assert.equal(secondResponse.body.topic, 'C#');
  assert.equal(firstResponse.body.slug, 'c');
  assert.equal(secondResponse.body.slug, 'c-2');
  assert.match(firstResponse.body.adminToken, /^[a-f0-9]{32}$/);
  assert.match(secondResponse.body.adminToken, /^[a-f0-9]{32}$/);
  assert.notEqual(firstResponse.body.id, secondResponse.body.id);
});

test('HTTP API resolves legacy title routes before falling back to canonical slugs', async () => {
  await jsonRequest('POST', '/api/discussions', { topic: 'C++' });
  await jsonRequest('POST', '/api/discussions', { topic: 'C#' });

  const resolveTitle = await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent('C#')}`);
  assert.equal(resolveTitle.status, 200);
  assert.equal(resolveTitle.body.topic, 'C#');
  assert.equal(resolveTitle.body.slug, 'c-2');

  const resolveSlug = await jsonRequest('GET', '/api/discussions/resolve/c');
  assert.equal(resolveSlug.status, 200);
  assert.equal(resolveSlug.body.topic, 'C++');
  assert.equal(resolveSlug.body.slug, 'c');
});

test('moderators can generate short links that redirect to the discussion', async () => {
  const topic = uniqueTopic('short-link');
  const createResponse = await jsonRequest('POST', '/api/discussions', { topic });
  const { adminToken, slug } = createResponse.body;

  const denied = await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken: 'bogus-token' });
  assert.equal(denied.status, 403);

  const generated = await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken });
  assert.equal(generated.status, 200);
  assert.equal(generated.body.success, true);
  assert.equal(generated.body.slug, slug);
  assert.match(generated.body.shortCode, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{6}$/);
  assert.equal(generated.body.shortPath, `/s/${generated.body.shortCode}`);

  const repeated = await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.shortCode, generated.body.shortCode);

  const redirect = await fetch(`${baseUrl}${generated.body.shortPath}`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), `/discussion/${slug}`);

  const custom = await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken, shortCode: 'AI' });
  assert.equal(custom.status, 200);
  assert.equal(custom.body.shortCode, 'ai');
  assert.equal(custom.body.shortPath, '/s/ai');

  const customRedirect = await fetch(`${baseUrl}/s/ai`, { redirect: 'manual' });
  assert.equal(customRedirect.status, 302);
  assert.equal(customRedirect.headers.get('location'), `/discussion/${slug}`);

  const invalid = await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken, shortCode: '-bad-' });
  assert.equal(invalid.status, 400);

  const other = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('short-link-other') });
  const taken = await jsonRequest('POST', `/api/discussions/${other.body.slug}/short-link`, {
    adminToken: other.body.adminToken,
    shortCode: 'ai',
  });
  assert.equal(taken.status, 409);
});

test('long titles and suffixed collisions produce links that resolve to the intended discussion', async () => {
  const prefix = 'a'.repeat(77);
  const titles = [prefix + ' bc first', prefix + ' bc second', 'x'.repeat(79) + ' final word'];
  for (const [index, topic] of titles.entries()) {
    const created = await jsonRequest('POST', '/api/discussions', { topic });
    assert.equal(created.status, 200);
    const slug = created.body.slug;
    assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(slug.length <= 80);
    if (index === 1) assert.ok(slug.endsWith('-2'));
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${slug}`)).body.id, created.body.id);
  }
});

test('previously issued truncated links survive startup and still open their own room', async () => {
  const prefix = 'z'.repeat(79);
  const slugs = [prefix, prefix + '-', 'w'.repeat(77) + '--2'];
  for (const [index, slug] of slugs.entries()) {
    await pool.query('INSERT INTO discussions (topic, slug) VALUES ($1, $2)', [`Saved room ${index}`, slug]);
  }
  await stopServer();
  await startServer();
  const display = await connectSocket();
  try {
    for (const [index, slug] of slugs.entries()) {
      const resolved = await jsonRequest('GET', `/api/discussions/resolve/${slug}`);
      assert.equal(resolved.body.topic, `Saved room ${index}`);
      const joined = waitForEvent(display, 'discussion');
      display.emit('joinDisplay', slug);
      assert.equal((await joined).slug, slug);
    }
  } finally { display.disconnect(); }
});

test('slug migration preserves literal slug-shaped legacy titles', async () => {
  await stopServer();
  await pool.query('DROP TABLE schema_migrations; TRUNCATE TABLE votes, questions, discussions RESTART IDENTITY CASCADE');
  await pool.query(`
    INSERT INTO discussions (topic, slug)
    VALUES
      ('C++', 'c'),
      ('c', 'c-2')
  `);

  await startServer();

  const migrated = await pool.query('SELECT topic, slug FROM discussions ORDER BY topic');
  assert.deepEqual(migrated.rows, [
    { topic: 'C++', slug: 'c-2' },
    { topic: 'c', slug: 'c' },
  ]);

  const resolveSlug = await jsonRequest('GET', '/api/discussions/resolve/c');
  assert.equal(resolveSlug.status, 200);
  assert.equal(resolveSlug.body.topic, 'c');
  assert.equal(resolveSlug.body.slug, 'c');
});

test('creating a discussion makes the creator its moderator', async () => {
  const topic = uniqueTopic('creator-mod');

  const createResponse = await jsonRequest('POST', '/api/discussions', { topic });
  assert.equal(createResponse.status, 200);
  // The creator gets a moderator token back on the request that establishes it.
  assert.match(createResponse.body.adminToken, /^[a-f0-9]{32}$/);
  assert.match(createResponse.body.slug, /^creator-mod-/);

  // The returned token is the discussion's stored admin token — i.e. it really
  // grants moderation (verifyAdmin matches on this exact value).
  const stored = await pool.query('SELECT admin_token FROM discussions WHERE topic = $1', [topic]);
  assert.equal(stored.rows[0].admin_token, createResponse.body.adminToken);
});

test('re-creating an already-moderated discussion does not hand over moderation', async () => {
  const topic = uniqueTopic('creator-mod-repeat');

  const first = await jsonRequest('POST', '/api/discussions', { topic });
  const firstToken = first.body.adminToken;
  assert.match(firstToken, /^[a-f0-9]{32}$/);

  // A second create for the same topic must NOT mint or disclose a token —
  // otherwise anyone could seize moderation by re-submitting an existing topic.
  const second = await jsonRequest('POST', '/api/discussions', { topic });
  assert.equal(second.status, 200);
  assert.equal(second.body.success, true);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.slug, first.body.slug);
  assert.equal(second.body.adminToken, null);

  // The original moderator's token is untouched.
  const stored = await pool.query('SELECT admin_token FROM discussions WHERE topic = $1', [topic]);
  assert.equal(stored.rows[0].admin_token, firstToken);
});

test('Socket.IO adds questions and broadcasts votes with pseudonyms', async () => {
  const topic = uniqueTopic('socket');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    const authorInitialQuestions = waitForQuestions(author, (questions) => Array.isArray(questions), 'author join');
    author.emit('joinDiscussion', topic);
    assert.deepEqual(await authorInitialQuestions, []);

    const voterInitialQuestions = waitForQuestions(voter, (questions) => Array.isArray(questions), 'voter join');
    voter.emit('joinDiscussion', topic);
    assert.deepEqual(await voterInitialQuestions, []);

    const questionUpdate = waitForQuestions(
      author,
      (questions) => questions.length === 1 && questions[0].text === 'Should this harness exist?',
      'question broadcast'
    );

    author.emit('addQuestion', topic, {
      text: 'Should this harness exist?',
      type: 'Agreement',
      minValue: null,
      maxValue: null,
      options: [],
    });

    const questions = await questionUpdate;
    const question = questions[0];
    assert.equal(question.type, 'Agreement');
    assert.deepEqual(question.options, []);

    // Results reach participants who have answered, so the voter observes it.
    const voteUpdate = waitForQuestions(
      voter,
      (updatedQuestions) => updatedQuestions[0] && updatedQuestions[0].votes.length === 1,
      'vote broadcast'
    );

    voter.emit('vote', topic, question.id, 'Agree', 'user-1', 'Careful Tester');

    const updatedQuestions = await voteUpdate;
    const broadcastVote = updatedQuestions[0].votes[0];
    assert.equal(broadcastVote.value, 'Agree');
    assert.equal(broadcastVote.pseudonym, 'Careful Tester');
    // The broadcast must NOT carry the raw stable userId — that would let a
    // socket observer correlate a participant's responses across prompts. It
    // carries a per-response, non-reversible ownership token instead, keyed by
    // the vote's own row id.
    assert.equal('userId' in broadcastVote, false);
    assert.equal(broadcastVote.upvoters, undefined);
    const expectedToken = crypto
      .createHash('sha256')
      .update(`${broadcastVote.id}:user-1`)
      .digest('hex');
    assert.equal(broadcastVote.ownerToken, expectedToken);
    assert.deepEqual(broadcastVote.upvoterTokens, []);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('Yes/No questions record a single choice that only an explicit clear removes', async () => {
  const topic = uniqueTopic('yesno');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    const authorInitialQuestions = waitForQuestions(author, (questions) => Array.isArray(questions), 'author join');
    author.emit('joinDiscussion', topic);
    await authorInitialQuestions;
    voter.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(
      author,
      (questions) => questions.length === 1 && questions[0].text === 'Ship it?',
      'yes/no question broadcast'
    );
    author.emit('addQuestion', topic, {
      text: 'Ship it?',
      type: 'Yes/No',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];
    assert.equal(question.type, 'Yes/No');

    // Vote Yes.
    const yesUpdate = waitForQuestions(
      voter,
      (qs) => qs[0] && qs[0].votes.length === 1 && qs[0].votes[0].value === 'Yes',
      'yes vote'
    );
    voter.emit('vote', topic, question.id, 'Yes', 'yn-user', 'Decider');
    await yesUpdate;

    // Switching to No replaces the single choice rather than adding a row.
    const noUpdate = waitForQuestions(
      voter,
      (qs) => qs[0] && qs[0].votes.length === 1 && qs[0].votes[0].value === 'No',
      'switch to no'
    );
    voter.emit('vote', topic, question.id, 'No', 'yn-user', 'Decider');
    await noUpdate;

    // Re-selecting the current choice keeps it: a vote sets, it never toggles.
    const reselected = await new Promise((resolve) => {
      voter.emit('vote', topic, question.id, 'No', 'yn-user', 'Decider', undefined, resolve);
    });
    assert.deepEqual(reselected, { ok: true });
    assert.deepEqual(await storedVotes(question.id), [{ user_id: 'yn-user', value: 'No' }]);

    // Undo is its own action, and repeating it is harmless.
    const clearedUpdate = waitForQuestions(
      voter,
      (qs) => qs[0] && qs[0].votes.length === 0,
      'explicit clear'
    );
    voter.emit('clearVote', topic, question.id, 'yn-user');
    await clearedUpdate;
    const clearedAgain = await new Promise((resolve) => {
      voter.emit('clearVote', topic, question.id, 'yn-user', resolve);
    });
    assert.deepEqual(clearedAgain, { ok: true });
    assert.deepEqual(await storedVotes(question.id), []);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('Multiple Choice questions validate their options and accept only those options as votes', async () => {
  const topic = uniqueTopic('multiple-choice');
  const author = await connectSocket();
  const voter = await connectSocket();
  const pdoom = ['Higher', 'Lower', 'About the same'];

  try {
    const joined = waitForQuestions(author, (questions) => Array.isArray(questions), 'author join');
    author.emit('joinDiscussion', topic);
    await joined;
    voter.emit('joinDiscussion', topic);

    // Each malformed option list is refused before anything is stored.
    for (const options of [
      undefined,
      'Higher, Lower',
      ['Only one'],
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      ['Higher', '   '],
      ['Higher', 42],
      ['Higher', 'x'.repeat(101)],
      ['Higher', ' higher  '],
    ]) {
      const ack = await emitWithAck(author, 'addQuestion', topic,
        { text: 'Did your p(doom) change?', type: 'Multiple Choice', options }, true);
      assert.deepEqual(ack, { added: false, reason: 'invalid' }, `rejects ${JSON.stringify(options)}`);
    }
    const stored = await pool.query(
      "SELECT count(*)::int AS count FROM questions q JOIN discussions d ON d.id = q.discussion_id WHERE d.slug = $1",
      [topic]
    );
    assert.equal(stored.rows[0].count, 0);

    // Options are trimmed and kept in the author's order.
    const added = waitForQuestions(author, (qs) => qs.length === 1, 'multiple choice broadcast');
    const ack = await emitWithAck(author, 'addQuestion', topic, {
      text: 'In the last year, did your p(doom) get higher or lower?',
      type: 'Multiple Choice',
      options: ['  Higher ', 'Lower', '  ', 'About   the same'],
    }, true);
    assert.deepEqual(ack, { added: true });
    const question = (await added)[0];
    assert.equal(question.type, 'Multiple Choice');
    assert.deepEqual(question.options, pdoom);

    const vote = (value) => emitWithAck(voter, 'vote', topic, question.id, value, 'mc-user', 'Chooser', undefined);
    assert.deepEqual(await vote('Higher'), { ok: true });
    assert.deepEqual(await storedVotes(question.id), [{ user_id: 'mc-user', value: 'Higher' }]);

    // Switching replaces the single choice; re-selecting keeps it.
    assert.deepEqual(await vote('About the same'), { ok: true });
    assert.deepEqual(await vote('About the same'), { ok: true });
    assert.deepEqual(await storedVotes(question.id), [{ user_id: 'mc-user', value: 'About the same' }]);

    // Anything that is not one of this question's options is rejected,
    // including another type's options and a near-match.
    for (const invalid of ['Agree', 'Yes', 'higher', 'Higher ', '', null, ['Higher']]) {
      assert.deepEqual(await vote(invalid), { ok: false }, `rejects ${JSON.stringify(invalid)}`);
    }
    assert.deepEqual(await storedVotes(question.id), [{ user_id: 'mc-user', value: 'About the same' }]);

    // Undo is the explicit clear, as for the other single-choice types.
    assert.deepEqual(await emitWithAck(voter, 'clearVote', topic, question.id, 'mc-user'), { ok: true });
    assert.deepEqual(await storedVotes(question.id), []);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('Multiple Choice results stay hidden until a participant votes, and snapshots keep the options', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('mc-results') });
  const { id, slug, adminToken } = created.body;
  const inserted = await pool.query(
    `INSERT INTO questions (discussion_id, text, type, options)
     VALUES ($1, 'p(doom) over the last year?', 'Multiple Choice', $2) RETURNING id`,
    [id, JSON.stringify(['Higher', 'Lower', 'About the same'])]
  );
  const questionId = inserted.rows[0].id;
  await pool.query(
    `INSERT INTO votes (question_id, value, user_id, pseudonym) VALUES
      ($1, 'Higher', 'seed-a', 'Seed A'), ($1, 'Higher', 'seed-b', 'Seed B'), ($1, 'Lower', 'seed-c', 'Seed C')`,
    [questionId]
  );

  const { socket, questions } = await joinAs(slug, 'mc-newcomer');
  try {
    const hidden = byId(questions, questionId);
    assertResultsHidden(hidden, 'unanswered multiple choice');
    // The options are the question, not its results, so they stay visible.
    assert.deepEqual(hidden.options, ['Higher', 'Lower', 'About the same']);

    const shown = waitForQuestions(socket, qs => byId(qs, questionId)?.resultsHidden === false, 'results after voting');
    socket.emit('vote', slug, questionId, 'About the same', 'mc-newcomer', 'Newcomer');
    assertResultsShown(byId(await shown, questionId), ['Higher', 'Higher', 'Lower', 'About the same'], 'answered multiple choice');
  } finally {
    socket.disconnect();
  }

  // The summary reports per-option counts in the author's order and keeps the
  // question out of the agree/disagree rankings.
  const summary = (await jsonRequest('GET', `/api/discussions/${slug}/summary`, undefined, asModerator(adminToken))).body;
  const summarized = summary.questions.find(q => q.id === questionId);
  assert.deepEqual(summarized.options, ['Higher', 'Lower', 'About the same']);
  assert.deepEqual(summarized.optionCounts, { Higher: 2, Lower: 1, 'About the same': 1 });
  assert.deepEqual(summarized.leadingOptions, ['Higher']);
  assert.equal(summary.topDivisive.some(q => q.id === questionId), false);

  // Someone who has not answered gets the options, which are part of the
  // question, but no tallies.
  const hiddenSummary = (await jsonRequest('GET', `/api/discussions/${slug}/summary`, undefined, asUser('mc-stranger'))).body
    .questions.find(q => q.id === questionId);
  assert.deepEqual(hiddenSummary.options, ['Higher', 'Lower', 'About the same']);
  assert.equal(hiddenSummary.resultsHidden, true);
  assert.equal('optionCounts' in hiddenSummary || 'responseCount' in hiddenSummary || 'leadingOptions' in hiddenSummary, false);

  const url = `/api/discussions/${slug}/snapshots`;
  const saved = await jsonRequest('POST', url, { name: 'Before', adminToken });
  assert.equal(saved.status, 201);
  const snapshotQuestion = saved.body.data.questions.find(q => q.id === questionId);
  assert.deepEqual(snapshotQuestion.options, ['Higher', 'Lower', 'About the same']);
  assert.deepEqual(snapshotQuestion.optionCounts, { Higher: 2, Lower: 1, 'About the same': 1 });
  assert.equal(snapshotQuestion.responseCount, 4);

  // A participant who has not answered gets the snapshot without its tallies.
  const redacted = (await jsonRequest('GET', url, undefined, asUser('mc-stranger'))).body.snapshots[0];
  assert.deepEqual(redacted.data.questions.find(q => q.id === questionId),
    {
      id: questionId, text: 'p(doom) over the last year?', type: 'Multiple Choice',
      options: ['Higher', 'Lower', 'About the same'], resultsHidden: true,
    });

  // A moderator can reveal a Multiple Choice question's results to everyone.
  const moderator = await connectSocket();
  try {
    moderator.emit('joinDiscussion', slug);
    const revealed = waitForQuestions(moderator, qs => byId(qs, questionId)?.resultsRevealed === true, 'results revealed');
    moderator.emit('setResultsRevealed', slug, questionId, true, adminToken);
    await revealed;
  } finally {
    moderator.disconnect();
  }
  const strangerSummary = (await jsonRequest('GET', `/api/discussions/${slug}/summary`, undefined, asUser('mc-stranger'))).body;
  const revealedSummary = strangerSummary.questions.find(q => q.id === questionId);
  assert.notEqual(revealedSummary.resultsHidden, true);
  assert.deepEqual(revealedSummary.optionCounts, { Higher: 2, Lower: 1, 'About the same': 1 });
});

test('the CSV export preserves Multiple Choice option labels as literal strings', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('mc-csv-literals') });
  const { id, slug, adminToken } = created.body;
  const options = ['null', '"quoted"', '["A"]', '{"x":1}', 'true', '=SUM(A1)'];
  const inserted = await pool.query(
    'INSERT INTO questions (discussion_id, text, type, options) VALUES ($1, $2, $3, $4) RETURNING id',
    [id, 'Pick a literal label', 'Multiple Choice', JSON.stringify(options)]
  );
  for (const [index, value] of options.entries()) {
    await pool.query('INSERT INTO votes (question_id, value, user_id) VALUES ($1, $2, $3)',
      [inserted.rows[0].id, value, 'literal-voter-' + index]);
  }

  const response = await fetch(baseUrl + '/api/discussions/' + slug + '/export.csv', {
    headers: asModerator(adminToken),
  });
  assert.equal(response.status, 200);
  const csv = await response.text();
  const values = csv.split('\n').slice(1).map(line => {
    const fields = Array.from(line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g), match => match[1]);
    const value = fields[7];
    return value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value;
  });
  // Literal JSON-looking labels survive unchanged; the existing CSV formula
  // neutralization still applies to a formula-looking option.
  assert.deepEqual(values, ['null', '"quoted"', '["A"]', '{"x":1}', 'true', "'=SUM(A1)"]);
});

test('a moderator can edit a question to Multiple Choice, and options are saved with the edit', async () => {
  const topic = uniqueTopic('edit-mc');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    const added = waitForQuestions(mod, (qs) => qs.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Agree?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await added)[0];
    assert.deepEqual(question.options, []);

    // Missing or invalid options make the edit invalid.
    const invalid = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Which?', type: 'Multiple Choice', options: ['Only one'] }, token);
    assert.deepEqual(invalid, { updated: false, reason: 'invalid' });

    const toChoice = waitForQuestions(mod, (qs) => qs[0]?.type === 'Multiple Choice', 'edit to multiple choice');
    const ack = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Which?', type: 'Multiple Choice', options: ['Red', 'Blue'] }, token);
    assert.equal(ack.updated, true);
    assert.deepEqual((await toChoice)[0].options, ['Red', 'Blue']);

    // Switching away clears the options, so a stale list cannot linger.
    const back = waitForQuestions(mod, (qs) => qs[0]?.type === 'Yes/No', 'edit back to yes/no');
    await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Yes?', type: 'Yes/No', options: ['Red', 'Blue'] }, token);
    assert.deepEqual((await back)[0].options, []);
  } finally {
    mod.disconnect();
  }
});

// ---- Results visibility (issue #76) ----------------------------------------

// A discussion with one question of each tallied type plus an Open Ended one,
// each already answered by two other participants.
async function seedResultsDiscussion(prefix) {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic(prefix) });
  const { id, slug, adminToken } = created.body;
  const inserted = await pool.query(
    `INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES
      ($1, 'We should proceed', 'Agreement', NULL, NULL),
      ($1, 'Proceed now?', 'Yes/No', NULL, NULL),
      ($1, 'Chance of success?', 'Numerical', 0, 100),
      ($1, 'Why?', 'Open Ended', NULL, NULL)
     RETURNING id`, [id]
  );
  const [agreement, yesNo, numerical, written] = inserted.rows.map(row => row.id);
  await pool.query(
    `INSERT INTO votes (question_id, value, user_id, pseudonym) VALUES
      ($1, 'Agree', 'seed-a', 'Seed A'), ($1, 'Disagree', 'seed-b', 'Seed B'),
      ($2, 'Yes', 'seed-a', 'Seed A'), ($2, 'No', 'seed-b', 'Seed B'),
      ($3, '30', 'seed-a', 'Seed A'), ($3, '50', 'seed-b', 'Seed B'),
      ($4, 'Because reasons', 'seed-a', 'Seed A')`,
    [agreement, yesNo, numerical, written]
  );
  return { id, slug, adminToken, agreement, yesNo, numerical, written };
}

const asModerator = token => ({ 'X-Convora-Moderator': token });
const asUser = userId => ({ 'X-Convora-User': userId });

// Nothing a tally could be rebuilt from may be present on a hidden question.
// Interest marks say who wants to discuss a question, not how anyone answered
// it, so they stay visible.
function assertResultsHidden(question, label) {
  assert.equal(question.resultsHidden, true, `${label}: marked hidden`);
  assert.deepEqual(question.votes, [], `${label}: no votes on the wire`);
  assert.deepEqual(
    Object.keys(question).filter(key => !['maxResponses', 'max_responses', 'interestCount', 'interestVoterTokens', 'downvoteCount', 'downvoterTokens'].includes(key) && /vote|count|tally|result|average|response|distribution/i.test(key)).sort(),
    ['resultsHidden', 'resultsRevealed', 'votes'], `${label}: no other result fields`
  );
  assert.equal(question.resultsRevealed, false, `${label}: not revealed`);
  assert.doesNotMatch(JSON.stringify(question), /Seed A|Seed B|ownerToken|"value"/, `${label}: no vote data`);
}

function assertResultsShown(question, expectedValues, label) {
  assert.equal(question.resultsHidden, false, `${label}: not marked hidden`);
  assert.deepEqual(question.votes.map(vote => vote.value).sort(), [...expectedValues].sort(), `${label}: all votes present`);
}

const byId = (questions, id) => questions.find(question => question.id === id);
const nextQuestions = (socket, description) => waitForQuestions(socket, () => true, description);

async function joinAs(slug, userId) {
  const socket = await connectSocket();
  const joined = nextQuestions(socket, `join as ${userId || 'anonymous'}`);
  if (userId) socket.emit('identify', slug, userId);
  socket.emit('joinDiscussion', slug);
  return { socket, questions: await joined };
}

for (const mode of ['always', 'after_vote']) {
  test(`independent answers stay private across viewers until moderator reveal (${mode})`, async t => {
    const { id, slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('independent') })).body;
    const base = `/api/discussions/${slug}`;
    await pool.query('UPDATE discussions SET results_visibility=$2, reactions_enabled=true, comments_enabled=true WHERE id=$1', [id, mode]);
    const user = crypto.randomUUID();
    const { socket: author } = await joinAs(slug, user);
    const moderator = await joinAsModerator(slug, adminToken);
    t.after(() => { author.disconnect(); moderator.disconnect(); });
    const prompt = { text: 'Write an idea', type: 'Brainstorm', independentAnswers: true };
    assert.equal((await emitWithAck(author, 'addQuestion', slug, prompt, true)).reason, 'not_authorized');
    assert.equal((await emitWithAck(moderator, 'addQuestion', slug, prompt, true, adminToken)).added, true);
    const { rows: [question] } = await pool.query('SELECT id, independent_answers FROM questions WHERE discussion_id=$1', [id]);
    assert.equal(question.independent_answers, true);
    for (const independentAnswers of [false, true]) {
      assert.equal((await emitWithAck(moderator, 'editQuestion', slug, question.id, { ...prompt, independentAnswers }, adminToken)).updated, true);
      assert.equal((await pool.query('SELECT independent_answers FROM questions WHERE id=$1', [question.id])).rows[0].independent_answers, independentAnswers);
    }
    const secret = 'private-written-response-fixture';
    const own = waitForQuestions(author, list => byId(list, question.id)?.votes.length === 1, 'own independent answer');
    assert.equal((await emitWithAck(author, 'vote', slug, question.id, secret, user, 'Author', 'custom')).ok, true);
    const vote = byId(await own, question.id).votes[0];
    assert.equal(vote.value, secret);
    const { socket: peer, questions } = await joinAs(slug, 'another-author');
    const display = await connectSocket();
    t.after(() => { peer.disconnect(); display.disconnect(); });
    assert.deepEqual(byId(questions, question.id).votes, []);
    const projected = nextQuestions(display, 'private display');
    display.emit('joinDisplay', slug);
    assert.deepEqual(byId(await projected, question.id).votes, []);
    const ownPeer = waitForQuestions(peer, list => byId(list, question.id)?.votes.some(row => row.value === 'peer-only'), 'second independent answer');
    const modView = waitForQuestions(moderator, list => byId(list, question.id)?.votes.length === 2, 'moderator view');
    await emitWithAck(peer, 'vote', slug, question.id, 'peer-only', 'another-author', 'Other', 'custom');
    assert.deepEqual(byId(await ownPeer, question.id).votes.map(row => row.value), ['peer-only']);
    await modView;
    const denied = waitForEvent(peer, 'error');
    peer.emit('setResultsRevealed', slug, question.id, true, 'wrong');
    await denied;
    assert.equal((await emitWithAck(peer, 'setResponseRating', slug, vote.id, 'quality', 1, 'another-author')).updated, false);
    assert.equal((await emitWithAck(peer, 'addResponseComment', slug, vote.id, 'early comment', 'another-author', 'Other')).added, false);
    const legacy = nextQuestions(peer, 'legacy feedback check');
    peer.emit('toggleResponseVote', slug, vote.id, 'another-author');
    await legacy;
    peer.emit('toggleResponseReaction', slug, vote.id, 'crux', 'another-author');
    await pool.query("INSERT INTO questions (discussion_id,text,type) VALUES ($1,'Public poll','Agreement')", [id]);
    const saved = await jsonRequest('POST', `${base}/snapshots`, { adminToken, name: 'During collection' });
    assert.equal(saved.status, 201);
    assert.deepEqual(saved.body.data.questions.map(row => row.text), ['Public poll']);
    for (const route of ['summary', 'export.json', 'export.csv', 'report.html', 'snapshots', 'clusters']) {
      const result = await fetch(`${baseUrl}${base}/${route}`, { headers: asUser(user) });
      assert.equal(result.status, 200, route);
      assert.doesNotMatch(await result.text(), /private-written-response-fixture|peer-only/, route);
    }
    assert.equal((await jsonRequest('GET', `${base}/summary`, undefined, asModerator(adminToken))).body.counts.responses, 2);
    const feedback = await pool.query(`SELECT (SELECT count(*) FROM response_votes WHERE response_id=$1) +
      (SELECT count(*) FROM response_ratings WHERE response_id=$1) + (SELECT count(*) FROM response_reactions WHERE response_id=$1) AS total`, [vote.id]);
    assert.equal(Number(feedback.rows[0].total), 0);
    const shared = [author, peer, display].map(socket => waitForQuestions(socket, list => byId(list, question.id)?.resultsRevealed, 'moderator reveal'));
    moderator.emit('setResultsRevealed', slug, question.id, true, adminToken);
    for (const list of await Promise.all(shared)) assert.deepEqual(byId(list, question.id).votes.map(row => row.value), [secret, 'peer-only']);
    assert.equal((await emitWithAck(peer, 'setResponseRating', slug, vote.id, 'quality', 1, 'another-author')).updated, true);
    assert.equal((await jsonRequest('GET', `${base}/summary`)).body.counts.responses, 2);
    const reset = await fetch(`${baseUrl}${base}/responses`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken }) });
    assert.equal(reset.status, 204);
    assert.deepEqual((await pool.query('SELECT independent_answers, results_revealed FROM questions WHERE id=$1', [question.id])).rows[0],
      { independent_answers: true, results_revealed: false });
  });
}

test('new and existing discussions default to showing results after voting', async () => {
  await stopServer();
  try {
    await pool.query("INSERT INTO discussions (topic, slug) VALUES ('Before the setting', 'before-the-setting')");
    await pool.query('DROP TABLE schema_migrations; ALTER TABLE discussions DROP COLUMN results_visibility');
    await initializeDatabase(pool);
    const read = () => pool.query("SELECT results_visibility FROM discussions WHERE slug = 'before-the-setting'");
    assert.equal((await read()).rows[0].results_visibility, 'after_vote');
    await pool.query("UPDATE discussions SET results_visibility = 'always' WHERE slug = 'before-the-setting'");
    await initializeDatabase(pool);
    assert.equal((await read()).rows[0].results_visibility, 'always', 'a restart keeps the moderator choice');
  } finally {
    await startServer();
  }
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('results-default') });
  const { socket } = await joinAs(created.body.slug, null);
  try {
    const state = waitForEvent(socket, 'discussionState');
    socket.emit('joinDiscussion', created.body.slug);
    assert.equal((await state).resultsVisibility, 'after_vote');
  } finally {
    socket.disconnect();
  }
});

test('results are withheld from a participant until they vote, including in live broadcasts', async () => {
  const seed = await seedResultsDiscussion('results-hidden');
  const tallied = [seed.agreement, seed.yesNo, seed.numerical];
  const { socket: watcher, questions: initial } = await joinAs(seed.slug, 'watcher');
  const { socket: other } = await joinAs(seed.slug, 'seed-c');
  try {
    // Initial payload: every tallied question is stripped, Open Ended is not.
    assert.equal(initial.length, 4);
    for (const id of tallied) assertResultsHidden(byId(initial, id), `initial ${byId(initial, id).type}`);
    assert.deepEqual(byId(initial, seed.written).votes.map(vote => vote.value), ['Because reasons']);
    assert.equal(byId(initial, seed.written).resultsHidden, false);

    // Someone else votes: the watcher gets the broadcast, still with nothing in it.
    for (const [id, value] of [[seed.agreement, 'Strongly Agree'], [seed.yesNo, 'Yes'], [seed.numerical, 90]]) {
      const broadcast = nextQuestions(watcher, 'broadcast after another vote');
      assert.deepEqual(await emitWithAck(other, 'vote', seed.slug, id, value, 'seed-c', 'Seed C', undefined), { ok: true });
      const questions = await broadcast;
      for (const hiddenId of tallied) assertResultsHidden(byId(questions, hiddenId), `after another vote on ${id}`);
      assert.doesNotMatch(JSON.stringify(questions.filter(q => tallied.includes(q.id))), /Seed C|Strongly Agree/);
    }

    // Each question opens up only once the watcher answers that question.
    const expected = {
      [seed.agreement]: ['Agree', 'Disagree', 'Strongly Agree'],
      [seed.yesNo]: ['Yes', 'No', 'Yes'],
      [seed.numerical]: ['30', '50', '90'],
    };
    const answers = [[seed.agreement, 'Unsure'], [seed.yesNo, 'No'], [seed.numerical, 10]];
    for (let index = 0; index < answers.length; index += 1) {
      const [id, value] = answers[index];
      const broadcast = nextQuestions(watcher, 'broadcast after own vote');
      assert.deepEqual(await emitWithAck(watcher, 'vote', seed.slug, id, value, 'watcher', 'Watcher', undefined), { ok: true });
      const questions = await broadcast;
      expected[id].push(String(value));
      answers.forEach(([answeredId], position) => {
        if (position <= index) assertResultsShown(byId(questions, answeredId), expected[answeredId], 'answered question');
        else assertResultsHidden(byId(questions, answeredId), 'question not answered yet');
      });
    }

    // Having answered, the watcher now receives live updates as before.
    const live = nextQuestions(watcher, 'live update after voting');
    assert.deepEqual(await emitWithAck(other, 'vote', seed.slug, seed.agreement, 'Disagree', 'seed-c', 'Seed C', undefined), { ok: true });
    assertResultsShown(byId(await live, seed.agreement), ['Agree', 'Disagree', 'Disagree', 'Unsure'], 'live update');
  } finally {
    watcher.disconnect();
    other.disconnect();
  }
});

test('clearing a vote hides that question\'s results again', async () => {
  const seed = await seedResultsDiscussion('results-clear');
  const { socket: watcher } = await joinAs(seed.slug, 'watcher');
  const { socket: other } = await joinAs(seed.slug, 'seed-c');
  try {
    for (const [id, value, cleared] of [[seed.agreement, 'Agree', 'Disagree'], [seed.yesNo, 'Yes', 'No']]) {
      const shown = nextQuestions(watcher, 'results after voting');
      await emitWithAck(watcher, 'vote', seed.slug, id, value, 'watcher', 'Watcher', undefined);
      assert.equal(byId(await shown, id).votes.length, 3);

      const hidden = nextQuestions(watcher, 'results after clearing');
      assert.deepEqual(await emitWithAck(watcher, 'clearVote', seed.slug, id, 'watcher'), { ok: true });
      assertResultsHidden(byId(await hidden, id), 'after clearVote');

      // Later votes by others stay hidden too, and nobody else's vote was removed.
      const later = nextQuestions(watcher, 'broadcast after clearing');
      await emitWithAck(other, 'vote', seed.slug, id, cleared, 'seed-c', 'Seed C', undefined);
      assertResultsHidden(byId(await later, id), 'vote by another participant after clearVote');
      assert.equal((await storedVotes(id)).length, 3);
    }
  } finally {
    watcher.disconnect();
    other.disconnect();
  }
});

test('a socket is shown results only for the participant it identifies as', async () => {
  const seed = await seedResultsDiscussion('results-identity');
  // No identity at all: nothing is shown.
  const { socket: anonymous, questions: anonymousView } = await joinAs(seed.slug, null);
  try {
    for (const id of [seed.agreement, seed.yesNo, seed.numerical]) assertResultsHidden(byId(anonymousView, id), 'anonymous join');
    // The page joins first and identifies afterwards; the view follows.
    const resent = nextQuestions(anonymous, 'questions resent after identify');
    anonymous.emit('identify', seed.slug, 'seed-a');
    const identified = await resent;
    assertResultsShown(byId(identified, seed.agreement), ['Agree', 'Disagree'], 'own answered question');
    assertResultsShown(byId(identified, seed.numerical), ['30', '50'], 'own answered question');
    // A socket cannot switch to another participant's identity to see more.
    await pool.query('DELETE FROM votes WHERE question_id = $1 AND user_id = $2', [seed.yesNo, 'seed-a']);
    const afterSwitch = nextQuestions(anonymous, 'broadcast after identity switch attempt');
    anonymous.emit('identify', seed.slug, 'seed-b');
    anonymous.emit('updateDisplayName', seed.slug, 'seed-b', 'Seed A');
    assertResultsHidden(byId(await afterSwitch, seed.yesNo), 'question answered only by the other identity');
  } finally {
    anonymous.disconnect();
  }
});

test('moderators always see results, and lose them when their access is revoked', async () => {
  const seed = await seedResultsDiscussion('results-moderator');
  const { socket: creator, questions: beforeCheck } = await joinAs(seed.slug, 'creator-user');
  const { socket: helper } = await joinAs(seed.slug, 'helper-user');
  try {
    assertResultsHidden(byId(beforeCheck, seed.agreement), 'before proving the token');

    // A wrong token proves nothing.
    assert.equal((await emitWithAck(creator, 'checkModerator', seed.slug, 'not-the-token')).isModerator, false);

    const full = nextQuestions(creator, 'moderator view');
    assert.equal((await emitWithAck(creator, 'checkModerator', seed.slug, seed.adminToken)).isModerator, true);
    const moderatorView = await full;
    assertResultsShown(byId(moderatorView, seed.agreement), ['Agree', 'Disagree'], 'moderator');
    assertResultsShown(byId(moderatorView, seed.yesNo), ['Yes', 'No'], 'moderator');
    assertResultsShown(byId(moderatorView, seed.numerical), ['30', '50'], 'moderator');

    // The moderator's token works only for its own discussion.
    const elsewhere = await seedResultsDiscussion('results-moderator-other');
    const { socket: visitor, questions: visitorView } = await joinAs(elsewhere.slug, 'creator-user');
    try {
      assert.equal((await emitWithAck(visitor, 'checkModerator', elsewhere.slug, seed.adminToken)).isModerator, false);
      assertResultsHidden(byId(visitorView, elsewhere.agreement), 'another discussion');
    } finally {
      visitor.disconnect();
    }

    // Promote a participant: they see everything without having answered it.
    const helperVoted = nextQuestions(helper, 'helper vote');
    await emitWithAck(helper, 'vote', seed.slug, seed.yesNo, 'Yes', 'helper-user', 'Helper', undefined);
    assertResultsHidden(byId(await helperVoted, seed.agreement), 'helper before promotion');
    const helperId = `participant-${crypto.createHash('sha256').update('helper-user').digest('hex').slice(0, 16)}`;
    const granted = waitForEvent(helper, 'moderatorGranted');
    assert.equal((await emitWithAck(creator, 'promoteModerator', seed.slug, seed.adminToken, helperId)).success, true);
    const helperToken = (await granted).token;
    const promotedView = nextQuestions(helper, 'promoted moderator view');
    assert.equal((await emitWithAck(helper, 'checkModerator', seed.slug, helperToken)).isModerator, true);
    assertResultsShown(byId(await promotedView, seed.agreement), ['Agree', 'Disagree'], 'promoted moderator');

    // Demote them: the very next payload hides what they have not answered.
    const demotedView = waitForQuestions(helper, qs => byId(qs, seed.agreement)?.resultsHidden === true, 'demoted view');
    assert.equal((await emitWithAck(creator, 'demoteModerator', seed.slug, seed.adminToken, helperId)).success, true);
    const demoted = await demotedView;
    assertResultsHidden(byId(demoted, seed.numerical), 'demoted moderator');
    assertResultsShown(byId(demoted, seed.yesNo), ['Yes', 'No', 'Yes'], 'question the demoted moderator answered');
    const afterDemotion = nextQuestions(helper, 'broadcast after demotion');
    await emitWithAck(creator, 'vote', seed.slug, seed.agreement, 'Agree', 'creator-user', 'Creator', undefined);
    assertResultsHidden(byId(await afterDemotion, seed.agreement), 'demoted moderator, later broadcast');
  } finally {
    creator.disconnect();
    helper.disconnect();
  }
});

test('only a moderator can change the results setting, and "always show" sends everyone the results', async () => {
  const seed = await seedResultsDiscussion('results-always');
  const { socket: watcher } = await joinAs(seed.slug, 'watcher');
  const { socket: other } = await joinAs(seed.slug, 'seed-c');
  const mod = await connectSocket();
  try {
    // Without a valid token, or with an unknown mode, nothing changes.
    const refused = waitForEvent(watcher, 'error', error => /not authorized/i.test(error.message));
    watcher.emit('setResultsVisibility', seed.slug, 'always', 'not-the-token');
    await refused;
    const unknown = waitForEvent(mod, 'error', error => /unknown results setting/i.test(error.message));
    mod.emit('setResultsVisibility', seed.slug, 'moderator_reveals', seed.adminToken);
    await unknown;
    const stored = () => pool.query('SELECT results_visibility FROM discussions WHERE id = $1', [seed.id]);
    assert.equal((await stored()).rows[0].results_visibility, 'after_vote');

    // Always show: a participant who has not voted gets everything, as before.
    const state = waitForEvent(watcher, 'discussionState', s => s.resultsVisibility === 'always');
    const opened = nextQuestions(watcher, 'questions after switching to always');
    mod.emit('setResultsVisibility', seed.slug, 'always', seed.adminToken);
    await state;
    const all = await opened;
    assertResultsShown(byId(all, seed.agreement), ['Agree', 'Disagree'], 'always: agreement');
    assertResultsShown(byId(all, seed.yesNo), ['Yes', 'No'], 'always: yes/no');
    assertResultsShown(byId(all, seed.numerical), ['30', '50'], 'always: numerical');
    assert.equal((await stored()).rows[0].results_visibility, 'always');

    // Live broadcasts and a fresh anonymous join carry the results too.
    const live = nextQuestions(watcher, 'always: live broadcast');
    await emitWithAck(other, 'vote', seed.slug, seed.agreement, 'Unsure', 'seed-c', 'Seed C', undefined);
    assertResultsShown(byId(await live, seed.agreement), ['Agree', 'Disagree', 'Unsure'], 'always: live');
    const { socket: anonymous, questions: anonymousView } = await joinAs(seed.slug, null);
    anonymous.disconnect();
    assertResultsShown(byId(anonymousView, seed.agreement), ['Agree', 'Disagree', 'Unsure'], 'always: anonymous join');

    // So do the REST endpoints, with no identity at all.
    const summary = (await jsonRequest('GET', `/api/discussions/${seed.slug}/summary`)).body;
    assert.equal(summary.counts.hiddenResults, 0);
    assert.equal(summary.questions.find(q => q.id === seed.agreement).responseCount, 3);
    const csv = await (await fetch(`${baseUrl}/api/discussions/${seed.slug}/export.csv`)).text();
    assert.match(csv, /"Strongly Agree"|"Unsure"/);
    assert.doesNotMatch(csv, /results hidden/);

    // A duplicate keeps the setting.
    const copy = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: seed.slug, newTopic: uniqueTopic('results-copy') });
    const copied = await pool.query('SELECT results_visibility FROM discussions WHERE slug = $1', [copy.body.newSlug]);
    assert.equal(copied.rows[0].results_visibility, 'always');

    // Switching back hides them again at once.
    const closed = waitForQuestions(watcher, qs => byId(qs, seed.agreement)?.resultsHidden === true, 'questions after switching back');
    mod.emit('setResultsVisibility', seed.slug, 'after_vote', seed.adminToken);
    for (const id of [seed.agreement, seed.yesNo, seed.numerical]) assertResultsHidden(byId(await closed, id), 'back to after_vote');
  } finally {
    watcher.disconnect();
    other.disconnect();
    mod.disconnect();
  }
});

test('REST endpoints withhold results the caller has not voted on', async () => {
  const seed = await seedResultsDiscussion('results-rest');
  // Enough agreement votes for opinion groups: four participants, two statements.
  const second = (await pool.query(
    "INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'We should wait', 'Agreement') RETURNING id", [seed.id]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO votes (question_id, value, user_id) VALUES
      ($1, 'Strongly Agree', 'seed-c'), ($1, 'Strongly Disagree', 'seed-d'),
      ($2, 'Disagree', 'seed-a'), ($2, 'Agree', 'seed-b'), ($2, 'Strongly Disagree', 'seed-c'), ($2, 'Strongly Agree', 'seed-d')`,
    [seed.agreement, second]
  );
  const base = `/api/discussions/${seed.slug}`;
  const tallied = [seed.agreement, seed.yesNo, seed.numerical, second];
  const text = async (path, headers) => (await fetch(`${baseUrl}${base}${path}`, { headers })).text();
  const saved = await jsonRequest('POST', `${base}/snapshots`, { name: 'Before', adminToken: seed.adminToken });
  assert.equal(saved.status, 201);

  // seed-e has answered only the yes/no question.
  await pool.query("INSERT INTO votes (question_id, value, user_id) VALUES ($1, 'Yes', 'seed-e')", [seed.yesNo]);
  const leak = /seed-[a-e]|Strongly Agree|Strongly Disagree|optionCounts|"average"|agreeCount|distribution/;

  for (const [label, headers, visible] of [
    ['no identity', {}, []],
    ['unknown participant', asUser('nobody'), []],
    ['wrong moderator token', asModerator('not-the-token'), []],
    ['participant who answered one question', asUser('seed-e'), [seed.yesNo]],
  ]) {
    const hidden = tallied.filter(id => !visible.includes(id));

    // Summary and its JSON export.
    for (const path of ['/summary', '/export.json']) {
      const summary = JSON.parse(await text(path, headers));
      assert.equal(summary.counts.hiddenResults, hidden.length, `${label} ${path}`);
      for (const id of hidden) {
        assert.deepEqual(Object.keys(summary.questions.find(q => q.id === id)).sort(),
          ['createdAt', 'id', 'resultsHidden', 'text', 'type'], `${label} ${path}: hidden question carries no results`);
      }
      // Only what the caller may see is counted: the written response, plus the yes/no votes if visible.
      assert.equal(summary.counts.responses, 1 + (visible.length ? 3 : 0), `${label} ${path}: responses`);
      assert.deepEqual(summary.topConsensus.concat(summary.topDivisive).filter(item => hidden.includes(item.id)), []);
      assert.deepEqual(summary.facilitatorDashboard.unansweredPrompts.filter(item => hidden.includes(item.id)), []);
      if (!visible.length) assert.doesNotMatch(JSON.stringify(summary), leak, `${label} ${path}`);
      else assert.equal(summary.questions.find(q => q.id === seed.yesNo).responseCount, 3);
    }

    // Printable report and CSV.
    const report = await text('/report.html', headers);
    assert.equal(report.match(/Hidden until you vote/g).length, hidden.length, `${label} report`);
    assert.doesNotMatch(report, /agree \/|Avg /, `${label} report: no agreement or numerical signal`);
    const csv = await text('/export.csv', headers);
    assert.equal(csv.match(/results hidden until you vote/g).length, hidden.length, `${label} csv`);
    assert.doesNotMatch(csv, /Strongly|"Agree"|"Disagree"/, `${label} csv`);
    assert.equal(/"Yes"|"No"/.test(csv), visible.length > 0, `${label} csv: yes/no rows`);
    assert.match(csv, /Because reasons/, 'Open Ended responses are unaffected');

    // Opinion groups are computed without the hidden statements.
    const clusters = (await jsonRequest('GET', `${base}/clusters`, undefined, headers)).body;
    assert.equal(clusters.eligible, false, `${label} clusters`);
    assert.equal(clusters.hiddenStatementCount, 2);
    assert.equal(clusters.participantCount, 0);
    assert.equal(clusters.statementCount, 0);
    assert.doesNotMatch(JSON.stringify(clusters), /clusters"|bridging|divisive/);

    // Saved snapshots hold the same tallies and are redacted the same way.
    const { snapshots } = (await jsonRequest('GET', `${base}/snapshots`, undefined, headers)).body;
    assert.equal(snapshots[0].data.participantCount, null, `${label} snapshot`);
    for (const question of snapshots[0].data.questions) {
      if (visible.includes(question.id)) assert.deepEqual(question.optionCounts, { No: 1, Yes: 1 });
      else assert.deepEqual(Object.keys(question).sort(), ['id', 'resultsHidden', 'text', 'type'], `${label} snapshot question`);
    }
  }

  // A participant who answered everything, and a moderator, get the lot.
  for (const [label, headers] of [['participant who answered everything', asUser('seed-a')], ['moderator', asModerator(seed.adminToken)]]) {
    const summary = (await jsonRequest('GET', `${base}/summary`, undefined, headers)).body;
    assert.equal(summary.counts.hiddenResults, 0, label);
    assert.equal(summary.questions.find(q => q.id === seed.agreement).responseCount, 4, label);
    assert.equal(summary.questions.find(q => q.id === seed.numerical).average, 40, label);
    assert.doesNotMatch(await text('/export.csv', headers), /results hidden/, label);
    assert.doesNotMatch(await text('/report.html', headers), /Hidden until you vote/, label);
    const clusters = (await jsonRequest('GET', `${base}/clusters`, undefined, headers)).body;
    assert.equal(clusters.hiddenStatementCount, 0, label);
    assert.equal(clusters.statementCount, 2, label);
    assert.equal(clusters.participantCount, 4, label);
    const { snapshots } = (await jsonRequest('GET', `${base}/snapshots`, undefined, headers)).body;
    assert.deepEqual(snapshots, [saved.body], label);
  }
});

test('Open Ended and Brainstorm responses are not affected by the results setting', async () => {
  const topic = uniqueTopic('results-written');
  const author = await connectSocket();
  const reader = await connectSocket();
  try {
    author.emit('joinDiscussion', topic);
    reader.emit('joinDiscussion', topic);
    const brainstorm = await addBrainstormQuestion(author, topic, 'Ideas?');
    const seen = waitForQuestions(reader, qs => qs[0]?.votes.length === 1, 'idea visible to a reader who has not answered');
    author.emit('vote', topic, brainstorm.id, 'An idea', 'author-user', 'Author');
    const [question] = await seen;
    assert.equal(question.resultsHidden, false);
    assert.equal(question.votes[0].value, 'An idea');
  } finally {
    author.disconnect();
    reader.disconnect();
  }
});

// A room display joins as a display, never as a participant.
async function joinDisplay(slug) {
  const socket = await connectSocket();
  const joined = nextQuestions(socket, 'room display join');
  socket.emit('joinDisplay', slug);
  return { socket, questions: await joined };
}

// A hidden question on the display carries its response count and nothing else
// a tally could be rebuilt from.
function assertDisplayHidden(question, responseCount, label) {
  const { responseCount: count, ...rest } = question;
  assert.equal(count, responseCount, `${label}: response count`);
  assertResultsHidden(rest, label);
}

test('a moderator sets how the room display shows the QR code and questions', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('display-settings') });
  const { slug, adminToken } = created.body;
  const display = await connectSocket();
  const mod = await connectSocket();
  try {
    const initial = waitForEvent(display, 'discussionState', () => true);
    display.emit('joinDisplay', slug);
    const state = await initial;
    assert.equal(state.displayQr, 'full');
    assert.equal(state.displayLayout, 'all');
    assert.equal(state.displaySort, 'oldest');
    assert.equal(state.displayPinnedFirst, true);

    const outsider = await connectSocket();
    try {
      const refused = waitForEvent(outsider, 'error', error => /not authorized/i.test(error.message));
      outsider.emit('setDisplaySettings', slug, { qr: 'hidden' }, 'not-the-token');
      await refused;
    } finally {
      outsider.disconnect();
    }
    // The display itself is read-only, even holding the moderator token: the
    // request is dropped, so the next change below starts from the default.
    display.emit('setDisplaySettings', slug, { layout: 'focus' }, adminToken);

    const rejected = waitForEvent(mod, 'error', error => /room display setting/i.test(error.message));
    mod.emit('setDisplaySettings', slug, { qr: 'huge' }, adminToken);
    await rejected;

    // Each field changes on its own and leaves the other alone.
    const corner = waitForEvent(display, 'discussionState', s => s.displayQr === 'corner');
    mod.emit('setDisplaySettings', slug, { qr: 'corner' }, adminToken);
    assert.equal((await corner).displayLayout, 'all');
    const focus = waitForEvent(display, 'discussionState', s => s.displayLayout === 'focus');
    mod.emit('setDisplaySettings', slug, { layout: 'focus' }, adminToken);
    assert.equal((await focus).displayQr, 'corner');
    for (const sort of ['oldest', 'newest', 'interesting', 'agreement', 'disagreement', 'controversial']) {
      const changed = waitForEvent(display, 'discussionState', s => s.displaySort === sort && s.displayPinnedFirst === false);
      mod.emit('setDisplaySettings', slug, { sort, pinnedFirst: false }, adminToken);
      assert.equal((await changed).displayLayout, 'focus');
    }
    for (const settings of [{ sort: 'invalid' }, { sort: null }, { pinnedFirst: 'false' }, { pinnedFirst: null }]) {
      const invalid = waitForEvent(mod, 'error', error => /room display setting/i.test(error.message));
      mod.emit('setDisplaySettings', slug, settings, adminToken);
      await invalid;
    }
    const stored = await pool.query('SELECT display_sort, display_pinned_first FROM discussions WHERE slug = $1', [slug]);
    assert.deepEqual(stored.rows[0], { display_sort: 'controversial', display_pinned_first: false });

  } finally {
    display.disconnect();
    mod.disconnect();
  }
});

test('a room display shows response counts but no results while results are shown after voting', async () => {
  const seed = await seedResultsDiscussion('display-hidden');
  const { socket: display, questions: initial } = await joinDisplay(seed.slug);
  const { socket: voter } = await joinAs(seed.slug, 'seed-c');
  const mod = await connectSocket();
  try {
    for (const id of [seed.agreement, seed.yesNo, seed.numerical]) assertDisplayHidden(byId(initial, id), 2, 'initial display view');
    // Open Ended responses are the discussion itself and stay visible.
    assert.deepEqual(byId(initial, seed.written).votes.map(vote => vote.value), ['Because reasons']);
    assert.equal(byId(initial, seed.written).resultsHidden, false);

    // Live votes update the counts and still reveal nothing.
    const broadcast = nextQuestions(display, 'display broadcast after a vote');
    assert.deepEqual(await emitWithAck(voter, 'vote', seed.slug, seed.agreement, 'Strongly Agree', 'seed-c', 'Seed C', undefined), { ok: true });
    const updated = await broadcast;
    assertDisplayHidden(byId(updated, seed.agreement), 3, 'after a vote');
    assertDisplayHidden(byId(updated, seed.yesNo), 2, 'question nobody new answered');
    assert.doesNotMatch(JSON.stringify(updated.filter(q => q.id !== seed.written)), /Seed C|Strongly Agree/);

    // A moderator acting elsewhere does not turn the display into a moderator view.
    assert.equal((await emitWithAck(mod, 'checkModerator', seed.slug, seed.adminToken)).isModerator, true);
    const afterPin = nextQuestions(display, 'display broadcast after a moderator action');
    mod.emit('setPinned', seed.slug, seed.numerical, true, seed.adminToken);
    assertDisplayHidden(byId(await afterPin, seed.numerical), 2, 'after a moderator action');
  } finally {
    display.disconnect();
    voter.disconnect();
    mod.disconnect();
  }
});

test('a room display shows live results when the moderator always shows them', async () => {
  const seed = await seedResultsDiscussion('display-always');
  const { socket: display } = await joinDisplay(seed.slug);
  const { socket: voter } = await joinAs(seed.slug, 'seed-c');
  const mod = await connectSocket();
  try {
    const opened = waitForQuestions(display, qs => byId(qs, seed.agreement)?.resultsHidden === false, 'display after switching to always');
    const state = waitForEvent(display, 'discussionState', s => s.resultsVisibility === 'always');
    mod.emit('setResultsVisibility', seed.slug, 'always', seed.adminToken);
    await state;
    const all = await opened;
    assertResultsShown(byId(all, seed.agreement), ['Agree', 'Disagree'], 'display: agreement');
    assertResultsShown(byId(all, seed.yesNo), ['Yes', 'No'], 'display: yes/no');
    assertResultsShown(byId(all, seed.numerical), ['30', '50'], 'display: numerical');

    const live = nextQuestions(display, 'display live broadcast');
    await emitWithAck(voter, 'vote', seed.slug, seed.agreement, 'Unsure', 'seed-c', 'Seed C', undefined);
    assertResultsShown(byId(await live, seed.agreement), ['Agree', 'Disagree', 'Unsure'], 'display: live');

    // A display opened while results are always shown gets them at once, and
    // loses them as soon as the moderator switches back.
    const { socket: late, questions: lateView } = await joinDisplay(seed.slug);
    try {
      assertResultsShown(byId(lateView, seed.numerical), ['30', '50'], 'late display');
      const closed = waitForQuestions(late, qs => byId(qs, seed.agreement)?.resultsHidden === true, 'display after switching back');
      mod.emit('setResultsVisibility', seed.slug, 'after_vote', seed.adminToken);
      assertDisplayHidden(byId(await closed, seed.agreement), 3, 'back to after_vote');
    } finally {
      late.disconnect();
    }
  } finally {
    display.disconnect();
    voter.disconnect();
    mod.disconnect();
  }
});

test('a room display that switches discussions ends up showing only the last one', async () => {
  const first = await seedResultsDiscussion('display-switch-a');
  const second = await seedResultsDiscussion('display-switch-b');
  const display = await connectSocket();
  try {
    const received = [];
    display.on('discussion', payload => received.push(['discussion', payload?.slug]));
    display.on('questions', payload => received.push(['questions', payload[0]?.id === first.agreement ? first.slug : second.slug]));
    // A -> B -> A, sent back to back so the joins overlap.
    const settled = waitForEvent(display, 'discussionState');
    display.emit('joinDisplay', first.slug);
    display.emit('joinDisplay', second.slug);
    display.emit('joinDisplay', first.slug);
    await settled;
    // Give any superseded join time to finish; it must send nothing after this.
    await new Promise(resolve => setTimeout(resolve, 300));
    const last = kind => received.filter(([event]) => event === kind).at(-1)?.[1];
    assert.equal(last('discussion'), first.slug);
    assert.equal(last('questions'), first.slug);
  } finally {
    display.disconnect();
  }
});

test('a moderator can reveal one question\'s results to everyone, including the room display', async () => {
  const seed = await seedResultsDiscussion('reveal-results');
  const other = await seedResultsDiscussion('reveal-results-other');
  const { socket: display } = await joinDisplay(seed.slug);
  const { socket: watcher } = await joinAs(seed.slug, 'watcher');
  const mod = await connectSocket();
  try {
    // Only this discussion's moderator can reveal, and only its own questions.
    const refused = waitForEvent(watcher, 'error', error => /not authorized/i.test(error.message));
    watcher.emit('setResultsRevealed', seed.slug, seed.agreement, true, 'not-the-token');
    await refused;
    const quiet = nextQuestions(display, 'questions after a cross-discussion attempt');
    mod.emit('setResultsRevealed', other.slug, seed.agreement, true, other.adminToken);
    mod.emit('setPinned', seed.slug, seed.numerical, true, seed.adminToken);
    assertDisplayHidden(byId(await quiet, seed.agreement), 2, 'after a cross-discussion attempt');
    assert.equal((await pool.query('SELECT results_revealed FROM questions WHERE id = $1', [seed.agreement])).rows[0].results_revealed, false);

    // Revealed: the display and a participant who has not voted both get it,
    // while the other questions stay hidden.
    const shownOnDisplay = waitForQuestions(display, qs => byId(qs, seed.agreement)?.resultsRevealed === true, 'display after reveal');
    const shownToWatcher = waitForQuestions(watcher, qs => byId(qs, seed.agreement)?.resultsRevealed === true, 'watcher after reveal');
    mod.emit('setResultsRevealed', seed.slug, seed.agreement, true, seed.adminToken);
    for (const [view, label] of [[await shownOnDisplay, 'display'], [await shownToWatcher, 'participant']]) {
      assertResultsShown(byId(view, seed.agreement), ['Agree', 'Disagree'], `${label}: revealed question`);
      assert.equal(byId(view, seed.yesNo).resultsHidden, true, `${label}: other question still hidden`);
      assert.equal(byId(view, seed.yesNo).resultsRevealed, false);
    }

    // Live votes on a revealed question reach everyone.
    const live = nextQuestions(display, 'display after a vote on a revealed question');
    await emitWithAck(watcher, 'vote', seed.slug, seed.yesNo, 'Yes', 'watcher', 'Watcher', undefined);
    const { socket: voter } = await joinAs(seed.slug, 'seed-c');
    try {
      const next = waitForQuestions(display, qs => byId(qs, seed.agreement)?.votes.length === 3, 'display after another vote');
      await live;
      await emitWithAck(voter, 'vote', seed.slug, seed.agreement, 'Unsure', 'seed-c', 'Seed C', undefined);
      assertResultsShown(byId(await next, seed.agreement), ['Agree', 'Disagree', 'Unsure'], 'display: live on revealed');
    } finally {
      voter.disconnect();
    }

    // The REST views follow the same switch, for a caller with no identity.
    const summary = (await jsonRequest('GET', `/api/discussions/${seed.slug}/summary`)).body;
    assert.equal(summary.counts.hiddenResults, 2);
    assert.equal(summary.questions.find(q => q.id === seed.agreement).responseCount, 3);

    // Hiding it again goes back to showing results only after voting.
    const hiddenAgain = waitForQuestions(display, qs => byId(qs, seed.agreement)?.resultsRevealed === false, 'display after hiding');
    const watcherHidden = waitForQuestions(watcher, qs => byId(qs, seed.agreement)?.resultsRevealed === false, 'watcher after hiding');
    mod.emit('setResultsRevealed', seed.slug, seed.agreement, false, seed.adminToken);
    assertDisplayHidden(byId(await hiddenAgain, seed.agreement), 3, 'display after hiding');
    assertResultsHidden(byId(await watcherHidden, seed.agreement), 'participant after hiding');
  } finally {
    display.disconnect();
    watcher.disconnect();
    mod.disconnect();
  }
});

test('rapid show and hide leave every screen matching the stored reveal state', async () => {
  const seed = await seedResultsDiscussion('reveal-race');
  const { socket: display } = await joinDisplay(seed.slug);
  const { socket: watcher } = await joinAs(seed.slug, 'watcher');
  const mod = await connectSocket();
  try {
    const last = { display: null, watcher: null };
    display.on('questions', qs => { last.display = byId(qs, seed.agreement); });
    watcher.on('questions', qs => { last.watcher = byId(qs, seed.agreement); });
    // Overlapping refreshes must not deliver an older payload after a newer one.
    for (let i = 0; i < 10; i += 1) {
      mod.emit('setResultsRevealed', seed.slug, seed.agreement, i % 2 === 0, seed.adminToken);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    const stored = (await pool.query('SELECT results_revealed FROM questions WHERE id = $1', [seed.agreement])).rows[0].results_revealed;
    for (const [label, question] of Object.entries(last)) {
      assert.ok(question, `${label} received questions`);
      assert.equal(question.resultsRevealed, stored, `${label} matches the stored state`);
      assert.equal(question.resultsHidden, !stored, `${label} hides results exactly when not revealed`);
    }
  } finally {
    display.disconnect();
    watcher.disconnect();
    mod.disconnect();
  }
});

test('cleanup waits for a pending vote before deleting its rows', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('cleanup-vote-order') });
  const question = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Pending vote', 'Agreement') RETURNING id", [created.body.id])).rows[0];
  const vote = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'pending-voter', 'Agree') RETURNING id", [question.id])).rows[0];
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('SELECT id FROM questions WHERE id = $1 FOR SHARE', [question.id]);
    // Start cleanup while a writer already holds the production parent lock.
    // Child-first cleanup takes the vote row then blocks on that parent,
    // forming a cycle when the writer updates the vote below.
    const cleaned = cleanupDiscussions(pool).then(() => ({ ok: true }), error => ({ ok: false, code: error.code }));
    await waitForQuestionLockWait();
    let written;
    try {
      await writer.query("UPDATE votes SET value = 'Disagree' WHERE id = $1", [vote.id]);
      await writer.query('COMMIT');
      written = { ok: true };
    } catch (error) {
      await writer.query('ROLLBACK');
      written = { ok: false, code: error.code };
    }
    assert.deepEqual([written, await cleaned], [{ ok: true }, { ok: true }]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM discussions')).rows[0].n, 0);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
});

test('a vote is acknowledged promptly while other votes keep arriving', async () => {
  const seed = await seedResultsDiscussion('busy-room');
  const { socket: busy } = await joinAs(seed.slug, 'busy-voter');
  const { socket: voter } = await joinAs(seed.slug, 'patient-voter');
  let loading = true;
  // A vote every few milliseconds for two seconds, so a new request lands
  // during every send. An acknowledgment that waits for a quiet moment arrives
  // only after this stops.
  const stop = setTimeout(() => { loading = false; }, 2000);
  const pump = (async () => {
    for (let i = 0; loading; i += 1) {
      busy.emit('vote', seed.slug, seed.yesNo, i % 2 === 0 ? 'Yes' : 'No', 'busy-voter', 'Busy', undefined);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })();
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const started = Date.now();
    assert.deepEqual(await emitWithAck(voter, 'vote', seed.slug, seed.agreement, 'Agree', 'patient-voter', 'Patient', undefined), { ok: true });
    assert.equal(loading, true, 'acknowledged while the other votes were still arriving');
    assert.ok(Date.now() - started < 1500, `acknowledged in ${Date.now() - started} ms`);
  } finally {
    clearTimeout(stop);
    loading = false;
    await pump;
    busy.disconnect();
    voter.disconnect();
  }
});

test('a room display is not a participant and cannot vote, write or moderate', async () => {
  const seed = await seedResultsDiscussion('display-read-only');
  const { socket: participant } = await joinAs(seed.slug, 'seed-c');
  try {
    // The display gets the presence count, which does not include itself.
    const display = await connectSocket();
    try {
      const presence = waitForEvent(display, 'presence');
      const questions = nextQuestions(display, 'display join');
      display.emit('joinDisplay', seed.slug);
      assert.equal(await presence, 1);
      await questions;

      // A participant joining is counted, and the display hears about it.
      const secondJoined = waitForEvent(display, 'presence', count => count === 2);
      const { socket: second } = await joinAs(seed.slug, 'seed-d');
      // Subscribe before disconnecting too: both broadcasts can arrive before
      // the asynchronous join/disconnect helpers return control to this test.
      const secondLeft = waitForEvent(participant, 'presence', count => count === 1);
      try {
        assert.equal(await secondJoined, 2);
      } finally {
        second.disconnect();
      }
      assert.equal(await secondLeft, 1);

      // Even if it claims an identity, it cannot vote, add anything or moderate.
      display.emit('identify', seed.slug, 'seed-display');
      assert.deepEqual(await emitWithAck(display, 'vote', seed.slug, seed.agreement, 'Agree', 'seed-display', 'Display', undefined),
        { ok: false, success: false, error: 'display_read_only' });
      assert.equal((await emitWithAck(display, 'addQuestion', seed.slug, { text: 'From the screen', type: 'Open Ended' }, true, null)).ok, false);
      assert.equal((await emitWithAck(display, 'checkModerator', seed.slug, seed.adminToken)).ok, false);
      assert.equal((await emitWithAck(display, 'claimModerator', seed.slug)).success, false);
      // Nor can it switch itself into the participant room.
      display.emit('joinDiscussion', seed.slug);
      const stillHidden = nextQuestions(display, 'display after attempted switch');
      await emitWithAck(participant, 'vote', seed.slug, seed.agreement, 'Agree', 'seed-c', 'Seed C', undefined);
      assertDisplayHidden(byId(await stillHidden, seed.agreement), 3, 'after identify and moderator attempts');

      const stored = await pool.query(
        `SELECT COUNT(*)::int AS count FROM votes WHERE user_id = 'seed-display'
          OR question_id IN (SELECT id FROM questions WHERE text = 'From the screen')`
      );
      assert.equal(stored.rows[0].count, 0);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM questions WHERE text = 'From the screen'")).rows[0].count, 0);
      const participants = await emitWithAck(participant, 'listParticipants', seed.slug, seed.adminToken);
      assert.equal(participants.participants.some(p => p.pseudonym === 'Display'), false);
    } finally {
      display.disconnect();
    }
    // Closing the display does not change the participant count either.
    const after = waitForEvent(participant, 'presence');
    const { socket: third } = await joinAs(seed.slug, 'seed-e');
    third.disconnect();
    assert.equal(await after, 2);
  } finally {
    participant.disconnect();
  }
});

function storedVotes(questionId) {
  return pool.query('SELECT user_id, value FROM votes WHERE question_id = $1 ORDER BY id', [questionId])
    .then(result => result.rows);
}

// Regression for #72: on a slow connection a participant taps the same option
// twice and both emits arrive back to back. The vote must stay set.
for (const { type, first, second } of [
  { type: 'Agreement', first: 'Agree', second: 'Disagree' },
  { type: 'Yes/No', first: 'Yes', second: 'No' },
]) {
  test(`two identical ${type} vote emits in a row leave the vote set`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('double-tap') });
    const inserted = await pool.query(
      'INSERT INTO questions (discussion_id, text, type) VALUES ($1, $2, $3) RETURNING id',
      [created.body.id, 'Double tap', type]
    );
    const questionId = inserted.rows[0].id;
    const socket = await connectSocket();
    const vote = value => new Promise((resolve) => {
      socket.emit('vote', created.body.slug, questionId, value, 'double-tapper', 'Tapper', undefined, resolve);
    });
    try {
      // A first vote tapped twice.
      assert.deepEqual(await Promise.all([vote(first), vote(first)]), [{ ok: true }, { ok: true }]);
      assert.deepEqual(await storedVotes(questionId), [{ user_id: 'double-tapper', value: first }]);

      // The reported case: change the vote, tapping the new option twice.
      assert.deepEqual(await Promise.all([vote(second), vote(second)]), [{ ok: true }, { ok: true }]);
      assert.deepEqual(await storedVotes(questionId), [{ user_id: 'double-tapper', value: second }]);

      // A rejected vote is acknowledged as failed and changes nothing.
      assert.deepEqual(await vote('Maybe so'), { ok: false });
      assert.deepEqual(await storedVotes(questionId), [{ user_id: 'double-tapper', value: second }]);
    } finally {
      socket.disconnect();
    }
  });
}

test('clearing a vote only applies to single-choice polls in an unlocked discussion', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('clear-scope') });
  const inserted = await pool.query(
    `INSERT INTO questions (discussion_id, text, type) VALUES
     ($1, 'Opinion', 'Agreement'), ($1, 'Estimate', 'Numerical'), ($1, 'Ideas', 'Open Ended') RETURNING id`,
    [created.body.id]
  );
  const [agreement, numerical, brainstorm] = inserted.rows.map(row => row.id);
  await pool.query(
    `INSERT INTO votes (question_id, user_id, value) VALUES
     ($1, 'clearer', 'Agree'), ($1, 'bystander', 'Agree'), ($2, 'clearer', '7'), ($3, 'clearer', 'An idea')`,
    [agreement, numerical, brainstorm]
  );
  const socket = await connectSocket();
  const clear = (questionId, userId = 'clearer') => new Promise((resolve) => {
    socket.emit('clearVote', created.body.slug, questionId, userId, resolve);
  });
  try {
    assert.deepEqual(await clear(numerical), { ok: false });
    assert.deepEqual(await clear(brainstorm), { ok: false });
    assert.equal((await storedVotes(numerical)).length, 1);
    assert.equal((await storedVotes(brainstorm)).length, 1);

    await pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [created.body.id]);
    assert.deepEqual(await clear(agreement), { ok: false });
    assert.equal((await storedVotes(agreement)).length, 2);

    await pool.query('UPDATE discussions SET locked = FALSE WHERE id = $1', [created.body.id]);
    assert.deepEqual(await clear(agreement), { ok: true });
    // Only the caller's own vote goes; the socket is pinned to its first identity.
    assert.deepEqual(await storedVotes(agreement), [{ user_id: 'bystander', value: 'Agree' }]);
    assert.deepEqual(await clear(agreement, 'bystander'), { ok: true });
    assert.deepEqual(await storedVotes(agreement), [{ user_id: 'bystander', value: 'Agree' }]);
  } finally {
    socket.disconnect();
  }
});

test('crafted invalid questions are rejected, not stored', async () => {
  const topic = uniqueTopic('question-validation');
  const author = await connectSocket();

  async function expectInvalidQuestion(payload) {
    const error = waitForEvent(author, 'error', (e) => /invalid question/i.test(e.message));
    const ack = await new Promise((resolve) => {
      author.emit('addQuestion', topic, payload, false, null, resolve);
    });
    await error;
    assert.deepEqual(ack, { added: false, reason: 'invalid' });
  }

  try {
    const initialQuestions = waitForQuestions(author, (questions) => Array.isArray(questions), 'author join');
    author.emit('joinDiscussion', topic);
    await initialQuestions;

    await expectInvalidQuestion({ text: '', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    await expectInvalidQuestion({ text: 'Mystery?', type: 'NotAType', minValue: null, maxValue: null, options: [] });
    await expectInvalidQuestion({ text: 'Budget?', type: 'Numerical', minValue: 10, maxValue: 0, options: [] });

    const stored = await pool.query('SELECT COUNT(*)::int AS n FROM questions');
    assert.equal(stored.rows[0].n, 0);
  } finally {
    author.disconnect();
  }
});

test('a crafted Agreement/Yes-No vote with an unknown value is rejected, not stored', async () => {
  const topic = uniqueTopic('vote-validation');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const agreeAdded = waitForQuestions(author, (qs) => qs.some((q) => q.text === 'Agree?'), 'agreement added');
    author.emit('addQuestion', topic, { text: 'Agree?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const agree = (await agreeAdded).find((q) => q.text === 'Agree?');

    const ynAdded = waitForQuestions(author, (qs) => qs.some((q) => q.text === 'Ship?'), 'yes/no added');
    author.emit('addQuestion', topic, { text: 'Ship?', type: 'Yes/No', minValue: null, maxValue: null, options: [] });
    const yn = (await ynAdded).find((q) => q.text === 'Ship?');

    // "constructor" is an Object.prototype key — the kind of value that used to
    // slip through clustering's `in` check and corrupt the analysis.
    const agreeRejected = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, agree.id, 'constructor', 'attacker', 'Mallory');
    await agreeRejected;

    const ynRejected = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, yn.id, 'Maybe', 'attacker', 'Mallory');
    await ynRejected;

    // Nothing was written for either crafted value.
    const stored = await pool.query('SELECT COUNT(*)::int AS n FROM votes');
    assert.equal(stored.rows[0].n, 0);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('a Numerical vote outside the question range (or non-numeric) is rejected, not stored', async () => {
  const topic = uniqueTopic('numerical-validation');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const added = waitForQuestions(author, (qs) => qs.some((q) => q.text === 'Budget?'), 'numerical added');
    author.emit('addQuestion', topic, { text: 'Budget?', type: 'Numerical', minValue: 0, maxValue: 10, options: [] });
    const question = (await added).find((q) => q.text === 'Budget?');

    // An out-of-range value is rejected server-side: the range is otherwise only
    // enforced at create/edit time, so an unchecked vote would silently skew the
    // average / std-dev / spread shown in the summary.
    const tooHigh = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, question.id, '999', 'attacker', 'Mallory');
    await tooHigh;

    // A non-numeric value is rejected too.
    const notNumeric = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, question.id, 'lots', 'attacker', 'Mallory');
    await notNumeric;

    // Payloads that Number() silently coerces to 0 ('' and []) must NOT slip
    // through just because this question's range includes 0.
    const blank = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, question.id, '', 'attacker', 'Mallory');
    await blank;

    const nonScalar = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, question.id, [], 'attacker', 'Mallory');
    await nonScalar;

    // None of the crafted values were written.
    const rejected = await pool.query('SELECT COUNT(*)::int AS n FROM votes');
    assert.equal(rejected.rows[0].n, 0);

    // An in-range value is accepted and stored normally.
    const accepted = waitForQuestions(
      voter,
      (qs) => qs[0] && qs[0].votes.length === 1,
      'in-range vote broadcast'
    );
    voter.emit('vote', topic, question.id, '5', 'good-user', 'Honest Heron');
    assert.equal((await accepted)[0].votes[0].value, '5');
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('a Numerical vote may be a decimal and is stored to two places', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('numerical-decimals') });
  const { slug, adminToken } = created.body;
  const first = await connectSocket();
  const second = await connectSocket();
  try {
    first.emit('joinDiscussion', slug);
    const added = waitForQuestions(first, qs => qs.some(q => q.text === 'Chance of rain?'), 'numerical added');
    first.emit('addQuestion', slug, { text: 'Chance of rain?', type: 'Numerical', minValue: 0, maxValue: 100, options: [] });
    const question = (await added).find(q => q.text === 'Chance of rain?');

    // A probability below 1% keeps its value instead of becoming 0 or 1.
    assert.deepEqual(await emitWithAck(first, 'vote', slug, question.id, 0.5, 'decimal-a', 'A', undefined), { ok: true });
    // More precision than two places is rounded, whether sent as a number or text.
    assert.deepEqual(await emitWithAck(second, 'vote', slug, question.id, '33.337', 'decimal-b', 'B', undefined), { ok: true });
    assert.deepEqual((await storedVotes(question.id)).map(vote => vote.value), ['0.5', '33.34']);

    // Rounding cannot carry an answer past the bounds, and the bounds still hold.
    const tooHigh = waitForEvent(second, 'error', e => /invalid vote/i.test(e.message));
    second.emit('vote', slug, question.id, 100.004, 'decimal-b', 'B');
    await tooHigh;
    assert.deepEqual(await emitWithAck(second, 'vote', slug, question.id, 99.999, 'decimal-b', 'B', undefined), { ok: true });
    assert.deepEqual((await storedVotes(question.id)).map(vote => vote.value), ['0.5', '100']);

    // Averages and snapshots are built from the decimals, not from truncated values.
    const saved = await jsonRequest('POST', `/api/discussions/${slug}/snapshots`, { name: 'Decimals', adminToken });
    const snapshot = saved.body.data.questions.find(q => q.id === question.id);
    assert.equal(snapshot.average, 50.25);
    assert.equal(snapshot.distribution[0].count, 1);
    assert.equal(snapshot.distribution[9].count, 1);
    const summary = await jsonRequest('GET', `/api/discussions/${slug}/summary`, undefined, asModerator(adminToken));
    const summarized = summary.body.questions.find(q => q.id === question.id);
    assert.equal(summarized.average, 50.25);
    assert.equal(summarized.minResponse, 0.5);
  } finally {
    first.disconnect();
    second.disconnect();
  }
});

test('Socket.IO sanitizes display names: anonymous stores null, long names are clamped', async () => {
  const topic = uniqueTopic('names');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(
      author,
      (questions) => questions.length === 1,
      'question broadcast'
    );
    author.emit('addQuestion', topic, {
      text: 'Pick a name mode',
      type: 'Open Ended',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];

    // Anonymous mode sends a blank name; the server stores null so the display
    // layer falls back to "Anonymous".
    const anonUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'idea-anon'),
      'anonymous vote'
    );
    voter.emit('vote', topic, question.id, 'idea-anon', 'anon-user', '   ');
    const anonVote = (await anonUpdate)[0].votes.find((v) => v.value === 'idea-anon');
    assert.equal(anonVote.pseudonym, null);

    // A typed-in name longer than the cap is clamped to 40 characters.
    const longName = 'X'.repeat(100);
    const longUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'idea-long'),
      'long-name vote'
    );
    voter.emit('vote', topic, question.id, 'idea-long', 'long-user', longName);
    const longVote = (await longUpdate)[0].votes.find((v) => v.value === 'idea-long');
    assert.equal(longVote.pseudonym, 'X'.repeat(40));
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('client pure-JS SHA-256 fallback matches the server ownership-token hash', async () => {
  // The client uses crypto.subtle when available, but falls back to this pure-JS
  // SHA-256 in insecure contexts (e.g. served over a plain http:// LAN IP via the
  // join-QR flow). The fallback MUST produce the same hex digest the server uses
  // for ownership tokens, or participants there can't recognize their own votes.
  const { sha256Hex } = await import('../client/src/sha256.mjs');
  const inputs = ['123:abcDEF', '42:café 🦦', 'x:y', '', 'a'.repeat(200), '9f3a:Mellow Otter'];
  for (const s of inputs) {
    const fallback = sha256Hex(new TextEncoder().encode(s));
    const node = crypto.createHash('sha256').update(s).digest('hex');
    assert.equal(fallback, node, `SHA-256 mismatch for ${JSON.stringify(s)}`);
  }
});

test('participant handle formula matches between client and server', async () => {
  // The moderator panel hides promote/remove on the viewer's own row by matching
  // the server's opaque handle: "participant-" + first 16 hex of sha256(userId).
  // The client computes it from the same sha256Hex this asserts against the
  // server hash, so they must agree — otherwise the self row fails open to
  // showing its own controls again. The shared SHA module has an explicit .mjs
  // extension so this check also works on older supported Node 20 releases.
  const { sha256Hex } = await import('../client/src/sha256.mjs');
  const ids = ['user-1', 'guest-user-1', 'Z9f3a2b1c0d4e5f6', 'a'.repeat(80)];
  for (const id of ids) {
    const client = `participant-${sha256Hex(new TextEncoder().encode(String(id))).slice(0, 16)}`;
    const server = `participant-${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16)}`;
    assert.equal(client, server, `participant handle mismatch for ${JSON.stringify(id)}`);
  }
});

test('Socket.IO ownership tokens hide stable ids and differ per response', async () => {
  const topic = uniqueTopic('tokens');
  const author = await connectSocket();
  const voter = await connectSocket();

  // Tokens are keyed by the response's own row id, not the question id.
  const tokenFor = (voteId, userId) =>
    crypto.createHash('sha256').update(`${voteId}:${userId}`).digest('hex');

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    // Two open-ended questions, both answered by the SAME browser (same userId).
    const q1Update = waitForQuestions(author, (qs) => qs.length === 1, 'q1 broadcast');
    author.emit('addQuestion', topic, {
      text: 'Prompt one?', type: 'Open Ended', minValue: null, maxValue: null, options: [],
    });
    const q1 = (await q1Update)[0];

    const q2Update = waitForQuestions(author, (qs) => qs.length === 2, 'q2 broadcast');
    author.emit('addQuestion', topic, {
      text: 'Prompt two?', type: 'Open Ended', minValue: null, maxValue: null, options: [],
    });
    const q2 = (await q2Update).find((q) => q.id !== q1.id);

    const v1Update = waitForQuestions(
      author,
      (qs) => qs.find((q) => q.id === q1.id)?.votes?.length === 1,
      'q1 vote'
    );
    voter.emit('vote', topic, q1.id, 'answer one', 'same-browser', 'Same Browser');
    const vote1 = (await v1Update).find((q) => q.id === q1.id).votes[0];

    const v2Update = waitForQuestions(
      author,
      (qs) => qs.find((q) => q.id === q2.id)?.votes?.length === 1,
      'q2 vote'
    );
    voter.emit('vote', topic, q2.id, 'answer two', 'same-browser', 'Same Browser');
    const vote2 = (await v2Update).find((q) => q.id === q2.id).votes[0];

    // No raw ids leak, and the same browser gets a DIFFERENT token per response
    // (here, across two prompts) — so a socket observer can't correlate them.
    // The token is self-matchable from the response's own id.
    assert.equal('userId' in vote1, false);
    assert.equal(vote1.ownerToken, tokenFor(vote1.id, 'same-browser'));
    assert.equal(vote2.ownerToken, tokenFor(vote2.id, 'same-browser'));
    assert.notEqual(vote1.ownerToken, vote2.ownerToken);

    await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE WHERE id = (SELECT discussion_id FROM questions WHERE id = $1)', [q1.id]);
    // Upvoter ids are likewise tokenized per response (and self-matchable).
    const upUpdate = waitForQuestions(
      author,
      (qs) => qs.find((q) => q.id === q1.id)?.votes?.[0]?.upvotes === 1,
      'q1 upvote'
    );
    author.emit('toggleResponseVote', topic, vote1.id, 'upvoter-x');
    const upvoted = (await upUpdate).find((q) => q.id === q1.id).votes[0];
    assert.equal(upvoted.upvoters, undefined);
    assert.deepEqual(upvoted.upvoterTokens, [tokenFor(vote1.id, 'upvoter-x')]);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test("Socket.IO de-correlates one participant's multiple Brainstorm ideas", async () => {
  const topic = uniqueTopic('brainstorm-tokens');
  const author = await connectSocket();
  const voter = await connectSocket();

  const tokenFor = (voteId, userId) =>
    crypto.createHash('sha256').update(`${voteId}:${userId}`).digest('hex');

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const qUpdate = waitForQuestions(author, (qs) => qs.length === 1, 'brainstorm prompt');
    author.emit('addQuestion', topic, {
      text: 'Brainstorm anything', type: 'Open Ended', minValue: null, maxValue: null, options: [],
    });
    const question = (await qUpdate)[0];

    // The SAME anonymous browser submits two separate ideas to the same prompt.
    const idea1Update = waitForQuestions(
      author,
      (qs) => qs[0]?.votes?.some((v) => v.value === 'idea one'),
      'first idea'
    );
    voter.emit('vote', topic, question.id, 'idea one', 'one-browser', '   ');
    await idea1Update;

    const idea2Update = waitForQuestions(
      author,
      (qs) => qs[0]?.votes?.length === 2,
      'second idea'
    );
    voter.emit('vote', topic, question.id, 'idea two', 'one-browser', '   ');
    const votes = (await idea2Update)[0].votes;

    const v1 = votes.find((v) => v.value === 'idea one');
    const v2 = votes.find((v) => v.value === 'idea two');

    // Both ideas are anonymous and come from the same browser, yet each carries
    // a DIFFERENT ownerToken (keyed by the response's own id) — so a socket
    // observer can't group them as one participant's. Under the old per-question
    // scheme these tokens would have been identical.
    assert.equal('userId' in v1, false);
    assert.equal('userId' in v2, false);
    assert.notEqual(v1.ownerToken, v2.ownerToken);

    // Each token is still self-matchable from the response's id, so the author's
    // own client can recognize both ideas as theirs.
    assert.equal(v1.ownerToken, tokenFor(v1.id, 'one-browser'));
    assert.equal(v2.ownerToken, tokenFor(v2.id, 'one-browser'));
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('repeated responses are accepted from the same or different participants', async () => {
  const topic = uniqueTopic('brainstorm-duplicates');
  const first = await connectSocket();
  const second = await connectSocket();

  try {
    first.emit('joinDiscussion', topic);
    second.emit('joinDiscussion', topic);
    const question = await addBrainstormQuestion(first, topic, 'How can students explore careers?');
    const other = await addBrainstormQuestion(first, topic, 'What else would help?');
    const vote = (socket, questionId, value, userId) =>
      emitWithAck(socket, 'vote', topic, questionId, value, userId, 'Name', 'custom');

    assert.deepEqual(
      await vote(first, question.id, 'Internships and job shadowing', 'user-one'), { ok: true, added: true });
    // Another participant and the original author can both repeat an idea.
    assert.deepEqual(
      await vote(second, question.id, '  internships   and JOB\tshadowing ', 'user-two'),
      { ok: true, added: true });
    assert.deepEqual(
      await vote(first, question.id, 'Internships and job shadowing', 'user-one'),
      { ok: true, added: true });
    // A different idea, and the same idea on another prompt, are still accepted.
    assert.deepEqual(await vote(second, question.id, 'Internships', 'user-two'), { ok: true, added: true });
    assert.deepEqual(
      await vote(second, other.id, 'Internships and job shadowing', 'user-two'), { ok: true, added: true });

    const stored = await pool.query(
      'SELECT question_id, value FROM votes WHERE question_id = ANY($1) ORDER BY id', [[question.id, other.id]]);
    assert.deepEqual(stored.rows, [
      { question_id: question.id, value: 'Internships and job shadowing' },
      { question_id: question.id, value: 'internships   and JOB\tshadowing' },
      { question_id: question.id, value: 'Internships and job shadowing' },
      { question_id: question.id, value: 'Internships' },
      { question_id: other.id, value: 'Internships and job shadowing' },
    ]);
  } finally {
    first.disconnect();
    second.disconnect();
  }
});

test('Summary counts anonymous participants distinctly and never leaks raw user ids', async () => {
  const topic = uniqueTopic('summary-anon');
  const author = await connectSocket();
  const voterA = await connectSocket();
  const voterB = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voterA.emit('joinDiscussion', topic);
    voterB.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(author, (qs) => qs.length === 1, 'question broadcast');
    author.emit('addQuestion', topic, {
      text: 'What do you think?',
      type: 'Open Ended',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];

    // Two distinct browsers (different stable user ids) both submit anonymously,
    // so both broadcast pseudonyms collapse to "Anonymous". They must still be
    // counted as TWO participants in the summary (which reads the real user_id
    // internally), not merged into one.
    const firstVote = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'first anon answer'),
      'first anon vote'
    );
    voterA.emit('vote', topic, question.id, 'first anon answer', 'browser-aaaaaaaa1', '   ');
    await firstVote;

    const secondVote = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'second anon answer'),
      'second anon vote'
    );
    voterB.emit('vote', topic, question.id, 'second anon answer', 'browser-bbbbbbbb2', '   ');
    await secondVote;

    const summaryResponse = await jsonRequest('GET', `/api/discussions/${topic}/summary`);
    assert.equal(summaryResponse.status, 200);
    assert.equal(summaryResponse.body.counts.participants, 2);

    // The client-facing summary must not echo any raw 16-char user id. The real
    // ids used here are 'browser-aaaaaaaa1' / 'browser-bbbbbbbb2'; assert neither
    // appears, and that no participant entry carries a raw id field.
    const serialized = JSON.stringify(summaryResponse.body);
    assert.equal(serialized.includes('browser-aaaaaaaa1'), false);
    assert.equal(serialized.includes('browser-bbbbbbbb2'), false);
    for (const participant of summaryResponse.body.facilitatorDashboard.participantStats) {
      assert.match(participant.id, /^participant-\d+$/);
    }
  } finally {
    author.disconnect();
    voterA.disconnect();
    voterB.disconnect();
  }
});

test('updateDisplayName retroactively renames a participant\'s prior responses', async () => {
  const topic = uniqueTopic('rename');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(author, (qs) => qs.length === 1, 'question broadcast');
    author.emit('addQuestion', topic, {
      text: 'Share a thought',
      type: 'Open Ended',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];

    const voteUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.length === 1,
      'initial vote'
    );
    voter.emit('vote', topic, question.id, 'my response', 'rename-user', 'Original Name');
    const initial = (await voteUpdate)[0].votes[0];
    assert.equal(initial.pseudonym, 'Original Name');

    // Switching to a new display name must rewrite the existing response.
    const renamed = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes[0] && qs[0].votes[0].pseudonym === 'Renamed Person',
      'renamed broadcast'
    );
    voter.emit('updateDisplayName', topic, 'rename-user', 'Renamed Person');
    const after = (await renamed)[0].votes[0];
    assert.equal(after.pseudonym, 'Renamed Person');

    // Switching to anonymous (blank name) clears the stored pseudonym to null.
    const anonymized = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes[0] && qs[0].votes[0].pseudonym === null,
      'anonymized broadcast'
    );
    voter.emit('updateDisplayName', topic, 'rename-user', '   ');
    const anon = (await anonymized)[0].votes[0];
    assert.equal(anon.pseudonym, null);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('a moderator can promote a participant, granting them working controls', async () => {
  const topic = uniqueTopic('promote');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'guest-user-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    // The guest identifies so the server can route a moderator grant to them.
    guest.emit('identify', topic, guestUserId);

    // Add a question and have the guest vote, so they become a known participant.
    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, {
      text: 'Promote me?',
      type: 'Agreement',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Guest Otter');
    await voteRecorded;

    // The moderator sees the guest via an opaque, stable handle — never a raw
    // user id, and not a positional index.
    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(list.success, true);
    assert.equal(list.participants.length, 1);
    assert.match(list.participants[0].id, /^participant-[a-f0-9]{16}$/);
    assert.equal(list.participants[0].pseudonym, 'Guest Otter');
    assert.equal(list.participants[0].isModerator, false);
    assert.equal(list.participants[0].userId, undefined);
    const guestHandle = list.participants[0].id;

    // Promotion delivers a token to the guest live and flips their flag.
    const granted = waitForEvent(guest, 'moderatorGranted');
    const promote = await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    assert.equal(promote.success, true);
    assert.equal(promote.participants[0].isModerator, true);

    const grant = await granted;
    assert.match(grant.token, /^[a-f0-9]{32}$/);

    // The granted token really moderates: the guest can now lock the discussion.
    guest.emit('setLocked', topic, true, grant.token);
    const locked = await waitForEvent(mod, 'discussionState', (state) => state.locked === true);
    assert.equal(locked.locked, true);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a moderator sets the discussion color theme and it broadcasts to everyone', async () => {
  const topic = uniqueTopic('theme');
  const mod = await connectSocket();
  const guest = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    // A fresh discussion defaults to the original 'indigo' look.
    const claimed = await waitForEvent(guest, 'discussionState', (s) => s.hasModerator === true);
    assert.equal(claimed.theme, 'indigo');

    // The moderator switches theme; every participant receives the new value.
    const themed = waitForEvent(guest, 'discussionState', (s) => s.theme === 'orange');
    mod.emit('setTheme', topic, 'orange', token);
    assert.equal((await themed).theme, 'orange');

    // An unknown theme is rejected (error to the sender) and never broadcast.
    const rejected = waitForEvent(mod, 'error', (e) => /theme/i.test(e.message));
    mod.emit('setTheme', topic, 'chartreuse', token);
    await rejected;

    // The stored theme is unchanged: a fresh join still reports 'orange'.
    const rejoin = await connectSocket();
    try {
      rejoin.emit('joinDiscussion', topic);
      const state = await waitForEvent(rejoin, 'discussionState');
      assert.equal(state.theme, 'orange');
    } finally {
      rejoin.disconnect();
    }
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a non-moderator cannot set the discussion theme', async () => {
  const topic = uniqueTopic('theme-deny');
  await jsonRequest('POST', '/api/discussions', { topic });

  const stranger = await connectSocket();
  try {
    stranger.emit('joinDiscussion', topic);
    const rejected = waitForEvent(stranger, 'error', (e) => /authoriz/i.test(e.message));
    stranger.emit('setTheme', topic, 'orange', 'bogus-token');
    await rejected;

    // The theme stays at the default for everyone who joins afterward.
    const observer = await connectSocket();
    try {
      observer.emit('joinDiscussion', topic);
      const state = await waitForEvent(observer, 'discussionState');
      assert.equal(state.theme, 'indigo');
    } finally {
      observer.disconnect();
    }
  } finally {
    stranger.disconnect();
  }
});

test('a moderator can rename the discussion while the slug stays stable', async () => {
  const topic = uniqueTopic('rename');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;
  const slug = creator.body.slug;

  const mod = await connectSocket();
  const guest = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    await waitForEvent(guest, 'discussion', (d) => d && d.topic === topic);

    // The moderator renames; everyone in the room receives the new title on the
    // same 'discussion' channel that delivered it on join.
    const renamed = waitForEvent(guest, 'discussion', (d) => d && d.topic === 'Renamed Topic');
    const ack = await emitWithAck(mod, 'setTopic', slug, 'Renamed Topic', adminToken);
    assert.deepEqual(ack, { updated: true });
    const broadcast = await renamed;

    // Only the display title changed: the slug (the routing key every URL and
    // socket room is keyed on) is untouched, so existing links stay valid.
    assert.equal(broadcast.slug, slug);

    // The rename persists: a fresh join, addressing the discussion by its
    // unchanged slug, reports the new title.
    const rejoin = await connectSocket();
    try {
      rejoin.emit('joinDiscussion', slug);
      const state = await waitForEvent(rejoin, 'discussion', (d) => d && d.slug === slug);
      assert.equal(state.topic, 'Renamed Topic');
    } finally {
      rejoin.disconnect();
    }
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('renaming is rejected for non-moderators and blank titles', async () => {
  const topic = uniqueTopic('rename-deny');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;
  const slug = creator.body.slug;

  const stranger = await connectSocket();
  const mod = await connectSocket();

  try {
    stranger.emit('joinDiscussion', topic);
    mod.emit('joinDiscussion', topic);

    // No valid moderator token: rejected, with an error surfaced to the sender.
    const rejected = waitForEvent(stranger, 'error', (e) => /authoriz/i.test(e.message));
    const denyAck = await emitWithAck(stranger, 'setTopic', slug, 'Hijacked', 'bogus-token');
    assert.deepEqual(denyAck, { updated: false, reason: 'not_authorized' });
    await rejected;

    // A moderator submitting a blank title is rejected rather than renamed to
    // the 'Discussion' placeholder formatTopicTitle would otherwise produce.
    const blankAck = await emitWithAck(mod, 'setTopic', slug, '   ', adminToken);
    assert.deepEqual(blankAck, { updated: false, reason: 'invalid' });

    // Neither attempt changed the stored title.
    const observer = await connectSocket();
    try {
      observer.emit('joinDiscussion', slug);
      const state = await waitForEvent(observer, 'discussion', (d) => d && d.slug === slug);
      assert.equal(state.topic, topic);
    } finally {
      observer.disconnect();
    }
  } finally {
    stranger.disconnect();
    mod.disconnect();
  }
});

test('renaming to an existing discussion title is rejected as a duplicate', async () => {
  // discussions.topic is unique, so renaming one discussion to another's exact
  // title raises a Postgres unique-violation. The server should surface that as
  // a distinct 'duplicate' reason (not a generic error) and leave both titles
  // untouched so the moderator can pick a different name.
  const topicA = uniqueTopic('rename-dup-a');
  const topicB = uniqueTopic('rename-dup-b');
  const creatorA = await jsonRequest('POST', '/api/discussions', { topic: topicA });
  const creatorB = await jsonRequest('POST', '/api/discussions', { topic: topicB });
  const adminTokenA = creatorA.body.adminToken;
  const slugA = creatorA.body.slug;
  const slugB = creatorB.body.slug;

  const mod = await connectSocket();
  try {
    mod.emit('joinDiscussion', topicA);

    // Moderator of A tries to rename A to B's exact title: rejected as duplicate.
    const dupAck = await emitWithAck(mod, 'setTopic', slugA, topicB, adminTokenA);
    assert.deepEqual(dupAck, { updated: false, reason: 'duplicate' });

    // Neither title changed: A still reads topicA, B still reads topicB.
    const observerA = await connectSocket();
    const observerB = await connectSocket();
    try {
      observerA.emit('joinDiscussion', slugA);
      const stateA = await waitForEvent(observerA, 'discussion', (d) => d && d.slug === slugA);
      assert.equal(stateA.topic, topicA);

      observerB.emit('joinDiscussion', slugB);
      const stateB = await waitForEvent(observerB, 'discussion', (d) => d && d.slug === slugB);
      assert.equal(stateB.topic, topicB);
    } finally {
      observerA.disconnect();
      observerB.disconnect();
    }
  } finally {
    mod.disconnect();
  }
});

test('a non-moderator cannot list or promote participants', async () => {
  const topic = uniqueTopic('promote-deny');
  await jsonRequest('POST', '/api/discussions', { topic });

  const stranger = await connectSocket();
  try {
    stranger.emit('joinDiscussion', topic);

    const list = await emitWithAck(stranger, 'listParticipants', topic, 'bogus-token');
    assert.equal(list.success, false);
    assert.equal(list.error, 'not_authorized');

    const promote = await emitWithAck(stranger, 'promoteModerator', topic, 'bogus-token', 'participant-1');
    assert.equal(promote.success, false);
    assert.equal(promote.error, 'not_authorized');
  } finally {
    stranger.disconnect();
  }
});

test('promoting an offline participant fails and does not leave a dangling grant', async () => {
  const topic = uniqueTopic('promote-offline');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'offline-guest-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Offline?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Absent Owl');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;

    // Guest leaves before being promoted. Wait until the server has processed
    // the disconnect (presence drops to just the moderator) so the promote can't
    // find a socket to deliver to.
    const presenceDropped = waitForEvent(mod, 'presence', (count) => count === 1);
    guest.disconnect();
    await presenceDropped;

    const promote = await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    assert.equal(promote.success, false);
    assert.equal(promote.error, 'participant_offline');

    // The grant was rolled back — the participant is not left marked a moderator.
    const after = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(after.participants[0].isModerator, false);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('presence counts distinct people, not sockets', async () => {
  const topic = uniqueTopic('presence-dedup');
  await jsonRequest('POST', '/api/discussions', { topic });

  const tabA = await connectSocket();
  const tabB = await connectSocket();
  const other = await connectSocket();

  // Join + identify a socket, then wait until its presence count settles to
  // `expected`. Also wait for the server's per-join 'questions' emit so the
  // join's DB reads have flushed before we move on — otherwise a read left in
  // flight when the test ends can deadlock the next test's TRUNCATE.
  const joinAs = async (sock, userId, expected) => {
    const ready = waitForQuestions(sock, () => true, `${userId} join`);
    const settled = waitForEvent(sock, 'presence', (count) => count === expected);
    sock.emit('joinDiscussion', topic);
    sock.emit('identify', topic, userId);
    await ready;
    assert.equal(await settled, expected);
  };

  try {
    await joinAs(tabA, 'person-1', 1);  // one person opens the discussion
    await joinAs(tabB, 'person-1', 1);  // same person, second tab → still one person
    await joinAs(other, 'person-2', 2); // a genuinely different person → two

    // The first person closes one of their two tabs. They are still here via the
    // other tab, so the count broadcast on that disconnect must remain 2.
    const afterTabClose = waitForEvent(other, 'presence');
    tabB.disconnect();
    assert.equal(await afterTabClose, 2);
  } finally {
    tabA.disconnect();
    tabB.disconnect();
    other.disconnect();
  }
});

test('the creator can remove a moderator, revoking their access live', async () => {
  const topic = uniqueTopic('demote');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'demote-guest-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Demote me?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Doomed Crab');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(list.canDemote, true); // the creator may remove moderators
    const guestHandle = list.participants[0].id;

    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    const grant = await granted;

    // The granted token works before demotion (a promoted mod is not the creator).
    const asMod = await emitWithAck(guest, 'listParticipants', topic, grant.token);
    assert.equal(asMod.success, true);
    assert.equal(asMod.canDemote, false);

    // The creator removes them: the guest is told live and the flag clears.
    const revoked = waitForEvent(guest, 'moderatorRevoked');
    const demote = await emitWithAck(mod, 'demoteModerator', topic, adminToken, guestHandle);
    assert.equal(demote.success, true);
    assert.equal(demote.participants[0].isModerator, false);
    await revoked;

    // Their token no longer grants moderation.
    const afterRevoke = await emitWithAck(guest, 'listParticipants', topic, grant.token);
    assert.equal(afterRevoke.success, false);
    assert.equal(afterRevoke.error, 'not_authorized');
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a promoted moderator cannot remove moderators (creator-only)', async () => {
  const topic = uniqueTopic('demote-deny');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'demote-deny-guest';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Q?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Power Hungry Yak');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;

    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    const grant = await granted;

    // A promoted moderator is not the creator: their own token can't demote.
    const demote = await emitWithAck(guest, 'demoteModerator', topic, grant.token, guestHandle);
    assert.equal(demote.success, false);
    assert.equal(demote.error, 'not_authorized');

    // Still a moderator — the rejected attempt revoked nothing.
    const after = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(after.participants[0].isModerator, true);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a moderator who deleted their only response can still be removed', async () => {
  const topic = uniqueTopic('demote-novotes');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'novotes-guest';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    // The guest becomes a participant by posting a Brainstorm idea.
    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Ideas?', type: 'Open Ended', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const ideaPosted = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'idea posted');
    guest.emit('vote', topic, questionId, 'My only idea', guestUserId, 'Fleeting Crab');
    const voteId = (await ideaPosted)[0].votes[0].id;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;
    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    await granted;

    // The guest deletes their only idea — they now have no votes, so the
    // vote-derived list would normally drop them.
    const ideaRemoved = waitForQuestions(mod, (questions) => questions[0] && questions[0].votes.length === 0, 'idea removed');
    guest.emit('deleteVote', topic, voteId, guestUserId);
    await ideaRemoved;

    // They must still appear as a moderator so the creator can remove them.
    const afterDelete = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const stillListed = afterDelete.participants.find((p) => p.id === guestHandle);
    assert.ok(stillListed, 'a vote-less moderator should still be listed');
    assert.equal(stillListed.isModerator, true);

    // ...and the creator can demote them; afterwards they have neither votes nor
    // a grant, so they drop out of the list entirely.
    const demote = await emitWithAck(mod, 'demoteModerator', topic, adminToken, guestHandle);
    assert.equal(demote.success, true);
    assert.equal(demote.participants.find((p) => p.id === guestHandle), undefined);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('checkModerator rejects a revoked token so offline demotions clear stale UI', async () => {
  const topic = uniqueTopic('check-mod');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'check-guest-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Q?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Soon Gone Fox');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;
    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    const grant = await granted;

    // While granted, the token checks out — but as a per-user grant, not the
    // creator token, so isCreator is false (the client uses this to avoid
    // setting canDemote for a mere moderator).
    assert.deepEqual(await emitWithAck(guest, 'checkModerator', topic, grant.token), { ok: true, isModerator: true, isCreator: false });

    // After removal the same token no longer checks out — this is what lets an
    // offline-demoted user's client drop its stale token on next load.
    await emitWithAck(mod, 'demoteModerator', topic, adminToken, guestHandle);
    assert.deepEqual(await emitWithAck(guest, 'checkModerator', topic, grant.token), { ok: true, isModerator: false, isCreator: false });

    // The creator's own token still checks out, and is flagged as the creator
    // token so a creator who never opened the participant panel still gets
    // canDemote initialized on load — preventing a moderatorGranted push from
    // clobbering the real creator token.
    assert.deepEqual(await emitWithAck(mod, 'checkModerator', topic, adminToken), { ok: true, isModerator: true, isCreator: true });
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('Brainstorm ratings broadcast as aggregates without exposing who voted', async () => {
  const topic = uniqueTopic('brainstorm-rate');
  const mod = await connectSocket();
  const participant = await connectSocket();
  // A separate browser does the rating: identity is pinned per socket, so the
  // idea's author socket can't also stand in as the rater (that would be a
  // self-rating, which is rejected).
  const rater = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    rater.emit('joinDiscussion', topic);

    const token = await claimModerator(mod, topic);

    const question = await addBrainstormQuestion(mod, topic, 'How should we cut costs?');

    const ideaUpdate = waitForQuestions(
      mod,
      (questions) => questions[0] && questions[0].votes.length === 1,
      'brainstorm idea added'
    );
    participant.emit('vote', topic, question.id, 'Switch to solar', 'user-idea', 'Sunny');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // Reactions are off by default, so a rating should be ignored until enabled.
    const enabledUpdate = waitForQuestions(
      mod,
      (questions) => questions[0] && questions[0].reactionsEnabled === true,
      'reactions enabled'
    );
    // Socket handlers run concurrently: finish the rejected rating before
    // enabling feedback, so this checks disabled feedback rather than a race.
    assert.deepEqual(await emitWithAck(mod, 'setResponseRating', topic, responseId, 'quality', 1, 'user-early'), { updated: false });
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true }, token);
    const afterEnable = (await enabledUpdate)[0].votes[0];
    assert.equal(afterEnable.qualityUp, 0, 'rating before enabling reactions must be rejected');

    // Now ratings are accepted and surface as aggregate tallies.
    const ratingUpdate = waitForQuestions(
      mod,
      (questions) => questions[0] && questions[0].votes[0] && questions[0].votes[0].qualityUp === 1,
      'quality rating broadcast'
    );
    rater.emit('setResponseRating', topic, responseId, 'quality', 1, 'user-rater');
    const rated = (await ratingUpdate)[0].votes[0];

    assert.equal(rated.qualityUp, 1);
    assert.equal(rated.qualityDown, 0);
    // The payload exposes counts only — never a list of who rated or reacted.
    assert.equal(rated.raters, undefined);
    assert.equal(rated.reactors, undefined);
    assert.deepEqual(rated.reactionCounts, {});
  } finally {
    mod.disconnect();
    participant.disconnect();
    rater.disconnect();
  }
});

test('Brainstorm agreement votes accumulate into a distribution', async () => {
  const topic = uniqueTopic('brainstorm-agree');
  const mod = await connectSocket();
  // Two separate browsers cast the agreement ratings; the author socket can't
  // double as a rater (per-socket identity, and self-rating is rejected anyway).
  const raterA = await connectSocket();
  const raterB = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    raterA.emit('joinDiscussion', topic);
    raterB.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Pick a direction');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'Build the thing', 'user-idea', 'Maker');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].reactionsEnabled === true, 'reactions enabled');
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true }, token);
    await enabledUpdate;

    const agreeUpdate = waitForQuestions(
      mod,
      (qs) => {
        const counts = qs[0]?.votes[0]?.agreementCounts || {};
        return counts['Strongly Agree'] === 1 && counts.Disagree === 1;
      },
      'both agreement votes counted'
    );
    raterA.emit('setResponseRating', topic, responseId, 'agreement', 'Strongly Agree', 'user-a');
    raterB.emit('setResponseRating', topic, responseId, 'agreement', 'Disagree', 'user-b');
    const counts = (await agreeUpdate)[0].votes[0].agreementCounts;

    assert.equal(counts['Strongly Agree'], 1);
    assert.equal(counts['Disagree'], 1);
  } finally {
    mod.disconnect();
    raterA.disconnect();
    raterB.disconnect();
  }
});

test('Brainstorm comments can be added, listed with pseudonyms, and deleted', async () => {
  const topic = uniqueTopic('brainstorm-comment');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'What should we try?');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'Run a pilot', 'user-idea', 'Planner');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // Comments are rejected until enabled.
    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    const rejected = await new Promise((resolve) =>
      participant.emit('addResponseComment', topic, responseId, 'too early', 'user-c', 'Critic', resolve));
    assert.equal(rejected.added, false, 'comment before enabling must be rejected');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabledUpdate;

    const commentUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1,
      'comment added'
    );
    const ack = await new Promise((resolve) =>
      participant.emit('addResponseComment', topic, responseId, 'Scope it to one team', 'user-c', 'Critic', resolve));
    assert.equal(ack.added, true);
    const comment = (await commentUpdate)[0].votes[0].comments[0];
    assert.equal(comment.body, 'Scope it to one team');
    assert.equal(comment.pseudonym, 'Critic');

    const deleteUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 0,
      'comment deleted'
    );
    participant.emit('deleteResponseComment', topic, comment.id, 'user-c');
    const afterDelete = (await deleteUpdate)[0].votes[0].comments;
    assert.deepEqual(afterDelete, []);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('a participant cannot act as another by supplying their userId (issue #38)', async () => {
  const topic = uniqueTopic('identity-spoof');
  const mod = await connectSocket();
  const victim = await connectSocket();
  const attacker = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    victim.emit('joinDiscussion', topic);
    attacker.emit('joinDiscussion', topic);
    // Each socket pins to its own identity up front, exactly as a real client
    // does on connect. From here on the server attributes every action to the
    // connection's pinned identity, never to a userId named in the message.
    victim.emit('identify', topic, 'victim-user');
    attacker.emit('identify', topic, 'attacker-user');

    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Ideas?');

    // The victim posts an idea and a comment on it.
    const victimIdea = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'victim idea');
    victim.emit('vote', topic, question.id, "victim's idea", 'victim-user', 'Victim');
    const victimResponseId = (await victimIdea)[0].votes[0].id;

    const commentsOn = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await commentsOn;

    const victimComment = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1, 'victim comment');
    victim.emit('addResponseComment', topic, victimResponseId, "victim's comment", 'victim-user', 'Victim');
    const victimCommentId = (await victimComment)[0].votes[0].comments[0].id;

    // The attacker also posts their own idea, so we can show what their socket can
    // actually delete (its own content) versus what it cannot (the victim's).
    const attackerIdea = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 2, 'attacker idea');
    attacker.emit('vote', topic, question.id, "attacker's idea", 'attacker-user', 'Attacker');
    const attackerResponseId = (await attackerIdea)[0].votes.find((v) => v.id !== victimResponseId).id;

    // ATTACK 1: delete the victim's idea by naming the victim's userId. The handler
    // ignores the supplied id and acts as the attacker's pinned identity, so the
    // delete matches nothing and the victim's idea survives. deleteVote always
    // re-broadcasts, so the next 'questions' event confirms the query ran.
    const afterDelete = waitForQuestions(mod, (qs) => qs[0], 'state after spoofed delete');
    attacker.emit('deleteVote', topic, victimResponseId, 'victim-user');
    const afterDeleteVotes = (await afterDelete)[0].votes;
    assert.ok(afterDeleteVotes.find((v) => v.id === victimResponseId), "victim's idea must survive a spoofed delete");

    // ATTACK 2: delete the victim's comment by naming their userId — must survive.
    const afterCommentDelete = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes.find((v) => v.id === victimResponseId), 'state after spoofed comment delete');
    attacker.emit('deleteResponseComment', topic, victimCommentId, 'victim-user');
    const survivingComments = (await afterCommentDelete)[0].votes.find((v) => v.id === victimResponseId).comments || [];
    assert.ok(survivingComments.find((c) => c.id === victimCommentId), "victim's comment must survive a spoofed delete");

    // ATTACK 3: rename the victim's responses by naming their userId — must not take.
    const afterRename = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes.find((v) => v.id === victimResponseId), 'state after spoofed rename');
    attacker.emit('updateDisplayName', topic, 'victim-user', 'PWNED');
    const victimVoteAfter = (await afterRename)[0].votes.find((v) => v.id === victimResponseId);
    assert.equal(victimVoteAfter.pseudonym, 'Victim', "victim's display name must be unchanged by a spoofer");

    // The supplied id is IGNORED, not honored: the attacker passing 'victim-user'
    // to deleteVote deletes the ATTACKER'S OWN idea (their connection's pinned
    // identity), proving ownership is the socket's, not the message's.
    const ownDeleted = waitForQuestions(
      mod, (qs) => qs[0] && !qs[0].votes.find((v) => v.id === attackerResponseId), 'attacker own idea removed');
    attacker.emit('deleteVote', topic, attackerResponseId, 'victim-user');
    const remaining = (await ownDeleted)[0].votes;
    assert.ok(remaining.find((v) => v.id === victimResponseId), "victim's idea is still present");
    assert.ok(!remaining.find((v) => v.id === attackerResponseId), "the attacker's own idea is what got deleted");
  } finally {
    mod.disconnect();
    victim.disconnect();
    attacker.disconnect();
  }
});

test("a moderator can delete any participant's response (spam control)", async () => {
  const topic = uniqueTopic('mod-delete-idea');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Ideas?');

    // A participant (not the moderator) posts the response.
    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'spam spam spam', 'spammer-1', 'Spammer');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // The moderator removes it even though they did not author it.
    const deleteUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 0, 'idea removed by moderator');
    mod.emit('moderatorDeleteVote', topic, responseId, token);
    assert.deepEqual((await deleteUpdate)[0].votes, []);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test("a non-moderator cannot delete another participant's response", async () => {
  const topic = uniqueTopic('mod-delete-deny');
  const mod = await connectSocket();
  const stranger = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    stranger.emit('joinDiscussion', topic);
    await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Ideas?');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'keep me', 'author-1', 'Author');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // A stranger with a bogus token is rejected, not silently obeyed.
    const denied = waitForEvent(stranger, 'error');
    stranger.emit('moderatorDeleteVote', topic, responseId, 'bogus-token');
    await denied;

    // Re-joining re-sends the current state; the response is still there.
    const refreshed = waitForQuestions(stranger, (qs) => qs[0] && qs[0].id === question.id, 'state refreshed');
    stranger.emit('joinDiscussion', topic);
    const votes = (await refreshed)[0].votes;
    assert.equal(votes.length, 1);
    assert.equal(votes[0].id, responseId);
  } finally {
    mod.disconnect();
    stranger.disconnect();
  }
});

test("a moderator can delete any participant's comment (spam control)", async () => {
  const topic = uniqueTopic('mod-delete-comment');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'What should we try?');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'A real idea', 'user-idea', 'Planner');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabledUpdate;

    const commentUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1,
      'comment added'
    );
    const ack = await emitWithAck(
      participant, 'addResponseComment', topic, responseId, 'buy now at spam.example', 'spammer-2', 'Spammer');
    assert.equal(ack.added, true);
    const comment = (await commentUpdate)[0].votes[0].comments[0];

    // The moderator removes a comment they did not author.
    const deleteUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 0,
      'comment removed by moderator'
    );
    mod.emit('moderatorDeleteResponseComment', topic, comment.id, token);
    assert.deepEqual((await deleteUpdate)[0].votes[0].comments, []);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('a moderator cannot delete a poll vote via moderatorDeleteVote (aggregate data)', async () => {
  const topic = uniqueTopic('mod-delete-poll-deny');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    // Agreement polls are aggregate data, not spammable free text. The
    // moderator-delete feature is scoped to written responses, so the backend
    // must refuse to remove a poll vote even with a valid token.
    const questionAdded = waitForQuestions(mod, (qs) => qs.length === 1, 'poll added');
    mod.emit('addQuestion', topic, { text: 'Agree?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await questionAdded)[0];

    const voteUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'poll vote recorded');
    participant.emit('vote', topic, question.id, 'Agree', 'poll-voter', 'Voter');
    const voteId = (await voteUpdate)[0].votes[0].id;

    // The moderator targets the poll vote id directly, as if from the console.
    // The handler always re-broadcasts questions after running, so waiting for
    // that broadcast guarantees the (no-op) delete query has completed before
    // we assert. The poll vote must still be there.
    const afterDelete = waitForQuestions(mod, (qs) => qs[0] && qs[0].id === question.id, 'state after delete');
    mod.emit('moderatorDeleteVote', topic, voteId, token);
    const votes = (await afterDelete)[0].votes;
    assert.equal(votes.length, 1);
    assert.equal(votes[0].id, voteId);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('Brainstorm ratings, reactions, and comments are rejected once the discussion is locked', async () => {
  const topic = uniqueTopic('brainstorm-locked');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Locked-phase ideas');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'An idea', 'user-idea', 'Thinker');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // Reactions and comments are enabled...
    const enabledUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].reactionsEnabled === true && qs[0].commentsEnabled === true,
      'reactions + comments enabled'
    );
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true, comments_enabled: true }, token);
    await enabledUpdate;

    // ...then the discussion is locked, which should close all of them.
    const lockedState = waitForEvent(mod, 'discussionState', (s) => s.locked === true);
    mod.emit('setLocked', topic, true, token);
    await lockedState;

    const commentAck = await emitWithAck(
      participant, 'addResponseComment', topic, responseId, 'sneaking in', 'user-c', 'Critic');
    assert.equal(commentAck.added, false, 'comment must be rejected while locked');

    participant.emit('setResponseRating', topic, responseId, 'quality', 1, 'user-r');
    participant.emit('toggleResponseReaction', topic, responseId, 'crux', 'user-r');

    // Neither the rating nor the reaction should have been recorded for the user.
    const mine = await emitWithAck(participant, 'getBrainstormState', topic, 'user-r');
    assert.deepEqual(mine.ratings, {}, 'rating must be rejected while locked');
    assert.deepEqual(mine.reactions, {}, 'reaction must be rejected while locked');
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

async function waitForFeedbackLockWait(fragment) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1", [`%${fragment}%`]);
    if (result.rows[0].n) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

for (const action of ['quality', 'agreement', 'reaction', 'comment']) {
  test(`a ${action} waiting for a moderator lock cannot write feedback`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic(`feedback-lock-${action}`) });
    await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE, comments_enabled = TRUE WHERE id = $1', [created.body.id]);
    const q = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
    const response = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'A response') RETURNING id", [q.id])).rows[0];
    const { socket } = await joinAs(created.body.slug, 'critic');
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [created.body.id]);
      let comment;
      if (action === 'comment') comment = emitWithAck(socket, 'addResponseComment', created.body.slug, response.id, 'A comment', 'critic', 'Critic', 'custom');
      else if (action === 'reaction') socket.emit('toggleResponseReaction', created.body.slug, response.id, 'crux', 'critic');
      else socket.emit('setResponseRating', created.body.slug, response.id, action, action === 'quality' ? 1 : 'Agree', 'critic');
      const waited = await waitForFeedbackLockWait('FOR SHARE OF d');
      await blocker.query('COMMIT');
      if (comment) assert.equal((await comment).added, false);
      await emitWithAck(socket, 'getBrainstormState', created.body.slug, 'critic');
      for (const table of ['response_votes', 'response_ratings', 'response_reactions', 'response_comments']) {
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE response_id = $1`, [response.id])).rows[0].n, 0, `${table} stays unchanged`);
      }
      assert.equal(waited, true, 'feedback validation waits for the moderator transaction');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      socket.disconnect();
    }
  });
}

for (const [action, table] of [['quality', 'response_ratings'], ['reaction', 'response_reactions'], ['comment', 'response_comments']]) {
  test(`a moderator lock waits for an in-progress ${action} write`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic(`feedback-write-${action}`) });
    await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE, comments_enabled = TRUE WHERE id = $1', [created.body.id]);
    const q = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
    const response = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'A response') RETURNING id", [q.id])).rows[0];
    const { socket } = await joinAs(created.body.slug, 'critic');
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE ${table} IN SHARE MODE`);
      let comment;
      if (action === 'comment') comment = emitWithAck(socket, 'addResponseComment', created.body.slug, response.id, 'A comment', 'critic', 'Critic', 'custom');
      else if (action === 'reaction') socket.emit('toggleResponseReaction', created.body.slug, response.id, 'crux', 'critic');
      else socket.emit('setResponseRating', created.body.slug, response.id, 'quality', 1, 'critic');
      assert.equal(await waitForFeedbackLockWait(table), true, 'feedback write reached its transaction gate');
      let locked = false;
      const locking = pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [created.body.id]).then(() => { locked = true; });
      const waited = await waitForFeedbackLockWait('UPDATE discussions SET locked');
      const committedEarly = locked;
      await blocker.query('COMMIT');
      await locking;
      if (comment) assert.equal((await comment).added, true);
      assert.equal(waited, true, 'moderator lock waits until the feedback write commits');
      assert.equal(committedEarly, false);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE response_id = $1`, [response.id])).rows[0].n, 1);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      socket.disconnect();
    }
  });
}

test('moderator-only mode lets only moderators add questions while voting stays open', async () => {
  const topic = uniqueTopic('mod-only-questions');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    // Turn on moderator-only questions and wait for the state to broadcast.
    const restricted = waitForEvent(participant, 'discussionState', (s) => s.moderatorOnly === true);
    mod.emit('setModeratorOnly', topic, true, token);
    await restricted;

    // A participant with no moderator token is bounced...
    const rejected = await emitWithAck(
      participant,
      'addQuestion',
      topic,
      { text: 'Can I ask this?', type: 'Agreement', minValue: null, maxValue: null, options: [] },
      false,
      null
    );
    assert.equal(rejected.added, false, 'participant submission must be rejected');
    assert.equal(rejected.reason, 'moderator_only');

    // ...but the moderator can add a question with their token. Register the
    // listener before emitting: the server broadcasts 'questions' before it acks.
    const questionAdded = waitForQuestions(mod, (qs) => qs.length === 1, 'moderator question added');
    const modAdded = await emitWithAck(
      mod,
      'addQuestion',
      topic,
      { text: 'Moderator agenda item', type: 'Agreement', minValue: null, maxValue: null, options: [] },
      false,
      token
    );
    assert.equal(modAdded.added, true, 'moderator submission must be accepted');

    const questions = await questionAdded;
    const questionId = questions[0].id;
    assert.equal(questions[0].text, 'Moderator agenda item');

    // Voting stays open for everyone even while questions are restricted.
    const voted = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'participant vote recorded');
    participant.emit('vote', topic, questionId, 'Agree', 'user-voter', 'Voter');
    await voted;

    // Reopening lets participants add questions again.
    const opened = waitForEvent(participant, 'discussionState', (s) => s.moderatorOnly === false);
    mod.emit('setModeratorOnly', topic, false, token);
    await opened;

    const accepted = await emitWithAck(
      participant,
      'addQuestion',
      topic,
      { text: 'Now I can ask', type: 'Agreement', minValue: null, maxValue: null, options: [] },
      false,
      null
    );
    assert.equal(accepted.added, true, 'participant submission must be accepted once reopened');
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('setModeratorOnly rejects callers without a valid moderator token', async () => {
  const topic = uniqueTopic('mod-only-auth');
  const mod = await connectSocket();
  const intruder = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    intruder.emit('joinDiscussion', topic);
    await claimModerator(mod, topic);

    // An attempt with a bogus token must not change the discussion's state.
    const errored = waitForEvent(intruder, 'error');
    intruder.emit('setModeratorOnly', topic, true, 'not-a-real-token');
    await errored;

    // beforeEach truncates, and only the moderator's claim created a discussion,
    // so the single row reflects whether the bogus token managed to flip the flag.
    const state = await pool.query('SELECT moderator_only_questions FROM discussions');
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].moderator_only_questions, false);
  } finally {
    mod.disconnect();
    intruder.disconnect();
  }
});

test('Renaming updates stored comment pseudonyms, and comment tokens are namespaced', async () => {
  const topic = uniqueTopic('brainstorm-rename');
  const mod = await connectSocket();
  const participant = await connectSocket();
  // The commenter is a different participant from the idea's author, on its own
  // socket — identity is pinned per connection, so one socket can't post the idea
  // as 'user-idea' and the comment as 'user-c'.
  const commenter = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    commenter.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Rename test');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'An idea', 'user-idea', 'Ideator');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabledUpdate;

    const commentUpdate = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1, 'comment added');
    await emitWithAck(commenter, 'addResponseComment', topic, responseId, 'My take', 'user-c', 'Critic');
    const comment = (await commentUpdate)[0].votes[0].comments[0];
    assert.equal(comment.pseudonym, 'Critic');

    // The comment token is namespaced (`comment:<id>`) so it can never equal a
    // vote token of the same numeric id and de-anonymize the author.
    const namespaced = crypto.createHash('sha256').update(`comment:${comment.id}:user-c`).digest('hex');
    const collidingVoteToken = crypto.createHash('sha256').update(`${comment.id}:user-c`).digest('hex');
    assert.equal(comment.ownerToken, namespaced);
    assert.notEqual(comment.ownerToken, collidingVoteToken);

    // Renaming the author updates the persisted comment pseudonym too.
    const renamed = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || [])[0] &&
        qs[0].votes[0].comments[0].pseudonym === 'Reformed Critic',
      'comment renamed'
    );
    commenter.emit('updateDisplayName', topic, 'user-c', 'Reformed Critic');
    await renamed;
  } finally {
    mod.disconnect();
    participant.disconnect();
    commenter.disconnect();
  }
});

test('Brainstorm authors cannot rate or react to their own idea', async () => {
  const topic = uniqueTopic('brainstorm-self');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'No self-rating');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'My own idea', 'user-self', 'Author');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].reactionsEnabled === true, 'reactions enabled');
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true }, token);
    await enabledUpdate;

    // The author tries to rate and react to their own idea.
    mod.emit('setResponseRating', topic, responseId, 'quality', 1, 'user-self');
    mod.emit('toggleResponseReaction', topic, responseId, 'key-insight', 'user-self');

    const mine = await emitWithAck(mod, 'getBrainstormState', topic, 'user-self');
    assert.deepEqual(mine.ratings, {}, 'self-rating must be rejected');
    assert.deepEqual(mine.reactions, {}, 'self-reaction must be rejected');
  } finally {
    mod.disconnect();
  }
});

test('Brainstorm reactions can be narrowed to a creator-chosen set', async () => {
  const topic = uniqueTopic('brainstorm-reactset');
  const mod = await connectSocket();
  // A separate browser reacts; the author socket can't also be the reactor
  // (per-socket identity, and reacting to your own idea is rejected).
  const reactor = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    reactor.emit('joinDiscussion', topic);
    // A fresh discussion broadcasts the full default reaction catalog.
    const initial = await waitForEvent(mod, 'discussionState', (s) => Array.isArray(s.reactionKeys));
    assert.deepEqual(initial.reactionKeys, ['changed-mind', 'crux', 'follows', 'citation-needed', 'key-insight']);

    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Narrow the reactions');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'An idea', 'user-idea', 'Ideator');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // The creator narrows the active set (and passes a bogus key, which is dropped
    // and the rest re-ordered to catalog order).
    const narrowed = waitForEvent(
      mod, 'discussionState', (s) => Array.isArray(s.reactionKeys) && s.reactionKeys.length === 1);
    mod.emit('setReactionKeys', topic, ['bogus', 'crux'], token);
    assert.deepEqual((await narrowed).reactionKeys, ['crux']);

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].reactionsEnabled === true, 'reactions enabled');
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true }, token);
    await enabledUpdate;

    // A reaction outside the active set is rejected; one inside is accepted.
    const reactUpdate = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].reactionCounts || {}).crux === 1, 'crux counted');
    reactor.emit('toggleResponseReaction', topic, responseId, 'key-insight', 'user-react');
    reactor.emit('toggleResponseReaction', topic, responseId, 'crux', 'user-react');
    const counts = (await reactUpdate)[0].votes[0].reactionCounts;
    assert.equal(counts.crux, 1);
    assert.equal(counts['key-insight'], undefined, 'reaction outside the active set must be rejected');
  } finally {
    mod.disconnect();
    reactor.disconnect();
  }
});

test('Only a moderator can change the brainstorm reaction set', async () => {
  const topic = uniqueTopic('brainstorm-reactset-auth');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    await claimModerator(mod, topic);

    // A non-moderator attempt is rejected and leaves the set at its defaults.
    const errored = waitForEvent(mod, 'error', (e) => /Not authorized/.test(e.message));
    mod.emit('setReactionKeys', topic, ['crux'], 'bogus-token');
    await errored;

    // Re-joining re-broadcasts discussionState, confirming the set is untouched.
    const state = waitForEvent(mod, 'discussionState', (s) => Array.isArray(s.reactionKeys));
    mod.emit('joinDiscussion', topic);
    assert.deepEqual((await state).reactionKeys, ['changed-mind', 'crux', 'follows', 'citation-needed', 'key-insight']);
  } finally {
    mod.disconnect();
  }
});

test('Brainstorm comment pseudonyms are sanitized before storage', async () => {
  const topic = uniqueTopic('brainstorm-sanitize');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Sanitize names');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'An idea', 'user-idea', 'Ideator');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabledUpdate;

    const oversized = 'x'.repeat(120);
    const commentUpdate = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1, 'comment added');
    await emitWithAck(participant, 'addResponseComment', topic, responseId, 'A point', 'user-c', `  ${oversized}  `);
    const comment = (await commentUpdate)[0].votes[0].comments[0];

    // Trimmed and capped to the same 40-char limit votes use.
    assert.equal(comment.pseudonym, oversized.slice(0, 40));
    assert.equal(comment.pseudonym.length, 40);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('Duplicating a discussion preserves brainstorm interaction flags', async () => {
  const topic = uniqueTopic('brainstorm-dup');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    await addBrainstormQuestion(mod, topic, 'Carry flags');

    // Enable reactions but hide them, and enable comments — all non-default.
    const flaggedUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].reactionsEnabled === true && qs[0].reactionsVisible === false && qs[0].commentsEnabled === true,
      'flags set'
    );
    mod.emit('setDiscussionFlags', topic,
      { reactions_enabled: true, reactions_visible: false, comments_enabled: true }, token);
    await flaggedUpdate;

    // Also narrow the session-level reaction set to a non-default subset.
    const narrowed = waitForEvent(
      mod, 'discussionState', (s) => Array.isArray(s.reactionKeys) && s.reactionKeys.length === 2);
    mod.emit('setReactionKeys', topic, ['crux', 'follows'], token);
    await narrowed;

    // And pick a non-default color theme; the duplicate should keep it too.
    const themed = waitForEvent(mod, 'discussionState', (s) => s.theme === 'orange');
    mod.emit('setTheme', topic, 'orange', token);
    await themed;

    const newTopic = uniqueTopic('brainstorm-dup-copy');
    const dup = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: topic, newTopic });
    assert.equal(dup.status, 200);

    // The duplicate must keep the same flags, reaction set, and theme, not reset to defaults.
    const copy = await connectSocket();
    try {
      const copyQuestions = waitForQuestions(
        copy, (qs) => qs.length === 1 && qs[0].type === 'Open Ended', 'copy questions');
      const copyState = waitForEvent(copy, 'discussionState', (s) => Array.isArray(s.reactionKeys));
      copy.emit('joinDiscussion', dup.body.newTopic);
      const q = (await copyQuestions)[0];
      assert.equal(q.reactionsEnabled, true);
      assert.equal(q.reactionsVisible, false);
      assert.equal(q.commentsEnabled, true);
      const state = await copyState;
      assert.deepEqual(state.reactionKeys, ['crux', 'follows']);
      assert.equal(state.theme, 'orange');
    } finally {
      copy.disconnect();
    }
  } finally {
    mod.disconnect();
  }
});

// Create a discussion row (assignPseudonym only reserves once one exists) by
// seeding it with a question, the way the first contributor would.
async function seedDiscussion(topic) {
  const seed = await connectSocket();
  try {
    seed.emit('joinDiscussion', topic);
    await addBrainstormQuestion(seed, topic, 'Seed');
  } finally {
    seed.disconnect();
  }
}

test('Two participants proposing the same handle get distinct ones — no numbered duplicate', async () => {
  const topic = uniqueTopic('pseudonym-unique');
  await seedDiscussion(topic);

  const a = await connectSocket();
  const b = await connectSocket();
  try {
    const ra = await emitWithAck(a, 'requestPseudonym', topic, 'user-a', 'Tidy Newt');
    const rb = await emitWithAck(b, 'requestPseudonym', topic, 'user-b', 'Tidy Newt');

    // First claimant keeps the proposed name; the second is handed a different
    // adjective-animal combination, never "Tidy Newt 2".
    assert.equal(ra.pseudonym, 'Tidy Newt');
    assert.ok(rb.pseudonym, 'second participant should receive a handle');
    assert.notEqual(rb.pseudonym, 'Tidy Newt');
    assert.ok(!/\d/.test(rb.pseudonym), `deconflicted handle should have no number suffix: ${rb.pseudonym}`);
  } finally {
    a.disconnect();
    b.disconnect();
  }
});

test('A handle is stable for a returning user and reusable across discussions', async () => {
  const topicA = uniqueTopic('pseudonym-stable-a');
  const topicB = uniqueTopic('pseudonym-stable-b');
  await seedDiscussion(topicA);
  await seedDiscussion(topicB);

  const socket = await connectSocket();
  try {
    const first = await emitWithAck(socket, 'requestPseudonym', topicA, 'user-x', 'Tidy Newt');
    assert.equal(first.pseudonym, 'Tidy Newt');

    // Re-requesting (e.g. after a reload) returns the same reservation, even if a
    // different name is proposed.
    const again = await emitWithAck(socket, 'requestPseudonym', topicA, 'user-x', 'Brave Fox');
    assert.equal(again.pseudonym, 'Tidy Newt');

    // The same handle is free in a separate discussion, so the user can hold it
    // there too — uniqueness is only enforced within a discussion.
    const other = await emitWithAck(socket, 'requestPseudonym', topicB, 'user-x', 'Tidy Newt');
    assert.equal(other.pseudonym, 'Tidy Newt');
  } finally {
    socket.disconnect();
  }
});

test('Regenerating yields a different handle that stays unique', async () => {
  const topic = uniqueTopic('pseudonym-regen');
  await seedDiscussion(topic);

  const a = await connectSocket();
  const b = await connectSocket();
  try {
    const original = await emitWithAck(a, 'requestPseudonym', topic, 'user-a', 'Tidy Newt');
    assert.equal(original.pseudonym, 'Tidy Newt');
    // Someone else holds "Brave Fox" so a shuffle can't land on it.
    await emitWithAck(b, 'requestPseudonym', topic, 'user-b', 'Brave Fox');

    const shuffled = await emitWithAck(a, 'regeneratePseudonym', topic, 'user-a');
    assert.ok(shuffled.pseudonym, 'shuffle should return a handle');
    assert.notEqual(shuffled.pseudonym, 'Tidy Newt'); // must change
    assert.notEqual(shuffled.pseudonym, 'Brave Fox');  // must stay unique

    // The new handle is now the stable one for this user.
    const after = await emitWithAck(a, 'requestPseudonym', topic, 'user-a', 'Tidy Newt');
    assert.equal(after.pseudonym, shuffled.pseudonym);
  } finally {
    a.disconnect();
    b.disconnect();
  }
});

test('Before the discussion exists, handles are previews (unreserved) and reserve once it does', async () => {
  const topic = uniqueTopic('pseudonym-preview');
  const socket = await connectSocket();
  try {
    // No question has been added yet, so there is no discussion row to reserve
    // against. The server must flag these as unreserved so the client keeps
    // asking — otherwise the handle would never be inserted and could collide.
    const preview = await emitWithAck(socket, 'requestPseudonym', topic, 'user-a', 'Tidy Newt');
    assert.equal(preview.pseudonym, 'Tidy Newt');
    assert.equal(preview.reserved, false);

    const shufflePreview = await emitWithAck(socket, 'regeneratePseudonym', topic, 'user-a');
    assert.ok(shufflePreview.pseudonym);
    assert.equal(shufflePreview.reserved, false);

    // Nothing was persisted while the discussion didn't exist.
    const beforeRows = await pool.query('SELECT COUNT(*)::int AS n FROM discussion_pseudonyms');
    assert.equal(beforeRows.rows[0].n, 0);

    // Once the discussion exists, the same request reserves for real.
    await seedDiscussion(topic);
    const reserved = await emitWithAck(socket, 'requestPseudonym', topic, 'user-a', 'Tidy Newt');
    assert.equal(reserved.pseudonym, 'Tidy Newt');
    assert.equal(reserved.reserved, true);

    const afterRows = await pool.query(
      'SELECT pseudonym FROM discussion_pseudonyms WHERE user_id = $1', ['user-a']);
    assert.equal(afterRows.rows.length, 1);
    assert.equal(afterRows.rows[0].pseudonym, 'Tidy Newt');
  } finally {
    socket.disconnect();
  }
});

test('Shuffling in one tab syncs the new handle to the same user\'s other tabs', async () => {
  const topic = uniqueTopic('pseudonym-sync');
  await seedDiscussion(topic);
  const tabA = await connectSocket();
  const tabB = await connectSocket();
  try {
    // Two tabs of the same browser share a userId. Each must join the room and
    // identify so the server can route a shuffle's sync to the other tab.
    tabA.emit('joinDiscussion', topic);
    tabB.emit('joinDiscussion', topic);
    tabA.emit('identify', topic, 'user-tabs');
    tabB.emit('identify', topic, 'user-tabs');
    const first = await emitWithAck(tabA, 'requestPseudonym', topic, 'user-tabs', 'Tidy Newt');
    assert.equal(first.pseudonym, 'Tidy Newt');
    // The second tab shares the reservation (same userId).
    const shared = await emitWithAck(tabB, 'requestPseudonym', topic, 'user-tabs', 'Tidy Newt');
    assert.equal(shared.pseudonym, 'Tidy Newt');

    // Tab A shuffles; Tab B should be told the new handle so it stops using the
    // now-freed "Tidy Newt".
    const synced = waitForEvent(tabB, 'pseudonymSync');
    const shuffled = await emitWithAck(tabA, 'regeneratePseudonym', topic, 'user-tabs');
    const payload = await synced;
    assert.equal(payload.pseudonym, shuffled.pseudonym);
    assert.notEqual(payload.pseudonym, 'Tidy Newt');
  } finally {
    tabA.disconnect();
    tabB.disconnect();
  }
});

test('A newcomer avoids a handle already shown on a pre-existing response', async () => {
  const topic = uniqueTopic('pseudonym-backfill');
  const seeder = await connectSocket();
  try {
    seeder.emit('joinDiscussion', topic);
    const question = await addBrainstormQuestion(seeder, topic, 'Ideas?');
    // Simulate a participant who responded BEFORE this feature shipped: a vote
    // carrying a handle, with no row in discussion_pseudonyms.
    const idea = waitForQuestions(seeder, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    seeder.emit('vote', topic, question.id, 'My idea', 'old-user', 'Tidy Newt');
    await idea;
  } finally {
    seeder.disconnect();
  }

  // No reservation row exists yet, but "Tidy Newt" is already displayed.
  const reservations = await pool.query('SELECT COUNT(*)::int AS n FROM discussion_pseudonyms');
  assert.equal(reservations.rows[0].n, 0);

  const newcomer = await connectSocket();
  const returning = await connectSocket();
  try {
    // A new participant proposing the same handle must be deconflicted away from
    // the one an existing response already shows.
    const fresh = await emitWithAck(newcomer, 'requestPseudonym', topic, 'user-new', 'Tidy Newt');
    assert.equal(fresh.reserved, true);
    assert.notEqual(fresh.pseudonym, 'Tidy Newt');

    // The original responder (same userId) can still reclaim the handle their
    // existing response already shows.
    const reclaimed = await emitWithAck(returning, 'requestPseudonym', topic, 'old-user', 'Tidy Newt');
    assert.equal(reclaimed.pseudonym, 'Tidy Newt');
  } finally {
    newcomer.disconnect();
    returning.disconnect();
  }
});

test('A pseudonym-mode vote sent before the reservation ack persists under the reserved handle (#57)', async () => {
  const topic = uniqueTopic('pseudonym-canon-vote');
  const holder = await connectSocket();
  const latecomer = await connectSocket();
  try {
    holder.emit('joinDiscussion', topic);
    latecomer.emit('joinDiscussion', topic);
    // Adding a question creates the discussion row so handles can be reserved.
    const question = await addBrainstormQuestion(holder, topic, 'Ideas?');

    // "Tidy Newt" is already taken in this discussion.
    const taken = await emitWithAck(holder, 'requestPseudonym', topic, 'user-holder', 'Tidy Newt');
    assert.equal(taken.pseudonym, 'Tidy Newt');

    // The latecomer's local pick collides, so the server reserves a DIFFERENT
    // handle. That reservation exists server-side while the client is still — for
    // the round-trip window — showing and sending its unreserved local pick.
    const reserved = await emitWithAck(latecomer, 'requestPseudonym', topic, 'user-late', 'Tidy Newt');
    assert.notEqual(reserved.pseudonym, 'Tidy Newt');

    // Simulate the race: the latecomer votes in pseudonym mode but still sends the
    // colliding pre-reservation name. The server must store the reserved handle so
    // no duplicate "Tidy Newt" ever appears.
    const ideaUpdate = waitForQuestions(holder, (qs) => {
      const q = qs.find((x) => x.id === question.id);
      return q && q.votes.length === 1;
    }, 'latecomer idea');
    latecomer.emit('vote', topic, question.id, 'My idea', 'user-late', 'Tidy Newt', 'pseudonym');
    const stored = (await ideaUpdate).find((x) => x.id === question.id).votes[0];

    assert.equal(stored.pseudonym, reserved.pseudonym, 'vote should persist under the reserved handle');
    assert.notEqual(stored.pseudonym, 'Tidy Newt', 'no duplicate "Tidy Newt" should be stored');
  } finally {
    holder.disconnect();
    latecomer.disconnect();
  }
});

test('A pseudonym-mode vote with NO prior reservation still gets a unique handle, not the colliding pick (#57)', async () => {
  const topic = uniqueTopic('pseudonym-canon-noreserve');
  const holder = await connectSocket();
  const latecomer = await connectSocket();
  try {
    holder.emit('joinDiscussion', topic);
    latecomer.emit('joinDiscussion', topic);
    const question = await addBrainstormQuestion(holder, topic, 'Ideas?');

    // "Tidy Newt" is taken in this discussion.
    const taken = await emitWithAck(holder, 'requestPseudonym', topic, 'user-holder', 'Tidy Newt');
    assert.equal(taken.pseudonym, 'Tidy Newt');

    // The harder race (Codex P2 on #58): the latecomer's vote BEATS its own
    // requestPseudonym round-trip, so no reservation row exists for them yet — and
    // it sends the colliding local pick. The server must create/await a reservation
    // at write time rather than fall back to storing "Tidy Newt".
    const ideaUpdate = waitForQuestions(holder, (qs) => {
      const q = qs.find((x) => x.id === question.id);
      return q && q.votes.length === 1;
    }, 'latecomer idea');
    latecomer.emit('vote', topic, question.id, 'My idea', 'user-late', 'Tidy Newt', 'pseudonym');
    const stored = (await ideaUpdate).find((x) => x.id === question.id).votes[0];

    assert.notEqual(stored.pseudonym, 'Tidy Newt', 'must not store the colliding handle');
    assert.ok(stored.pseudonym, 'a deconflicted handle should be stored');

    // The created reservation is now the stable handle for this user, so a later
    // requestPseudonym returns the SAME name the vote was stored under (no rename).
    const reserved = await emitWithAck(latecomer, 'requestPseudonym', topic, 'user-late', 'Tidy Newt');
    assert.equal(reserved.pseudonym, stored.pseudonym, 'write-path reservation should be stable');
  } finally {
    holder.disconnect();
    latecomer.disconnect();
  }
});

test('Concurrent reservations for the same user converge to one handle, not an overwrite (#58)', async () => {
  const topic = uniqueTopic('pseudonym-converge');
  const holder = await connectSocket();
  const tabA = await connectSocket();
  const tabB = await connectSocket();
  try {
    holder.emit('joinDiscussion', topic);
    tabA.emit('joinDiscussion', topic);
    tabB.emit('joinDiscussion', topic);
    await addBrainstormQuestion(holder, topic, 'Ideas?');

    // "Tidy Newt" is taken, so the same new user gets deconflicted either way —
    // forcing the allocation path, not the cheap "already reserved" early return.
    await emitWithAck(holder, 'requestPseudonym', topic, 'user-holder', 'Tidy Newt');

    // Two tabs of the SAME user race their reservation at once (the vote/comment
    // write path and requestPseudonym hit this same allocator). First-wins must
    // make them agree; the old DO UPDATE could let the second overwrite the first,
    // splitting the handle across the user's responses.
    const [ra, rb] = await Promise.all([
      emitWithAck(tabA, 'requestPseudonym', topic, 'race-user', 'Tidy Newt'),
      emitWithAck(tabB, 'requestPseudonym', topic, 'race-user', 'Tidy Newt'),
    ]);
    assert.notEqual(ra.pseudonym, 'Tidy Newt');
    assert.equal(ra.pseudonym, rb.pseudonym, 'both tabs must converge on one handle');

    const rows = await pool.query(
      "SELECT COUNT(*)::int AS n FROM discussion_pseudonyms WHERE user_id = 'race-user'");
    assert.equal(rows.rows[0].n, 1, 'exactly one reservation row for the user');
  } finally {
    holder.disconnect();
    tabA.disconnect();
    tabB.disconnect();
  }
});

test('A pseudonym-mode comment sent before the reservation ack persists under the reserved handle (#57)', async () => {
  const topic = uniqueTopic('pseudonym-canon-comment');
  const mod = await connectSocket();
  const holder = await connectSocket();
  const latecomer = await connectSocket();
  try {
    mod.emit('joinDiscussion', topic);
    holder.emit('joinDiscussion', topic);
    latecomer.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'What should we try?');

    // A dedicated participant occupies "Tidy Newt" so it's taken in this discussion.
    const taken = await emitWithAck(holder, 'requestPseudonym', topic, 'user-holder', 'Tidy Newt');
    assert.equal(taken.pseudonym, 'Tidy Newt');

    // An idea for the latecomer to comment on.
    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'Run a pilot', 'user-mod', 'Planner', 'pseudonym');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabled = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabled;

    // "Tidy Newt" is taken, so the latecomer is reserved a different handle.
    const reserved = await emitWithAck(latecomer, 'requestPseudonym', topic, 'user-late', 'Tidy Newt');
    assert.notEqual(reserved.pseudonym, 'Tidy Newt');

    // Race: comment in pseudonym mode but still sending the colliding local pick.
    const commentUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1,
      'comment added'
    );
    const ack = await emitWithAck(
      latecomer, 'addResponseComment', topic, responseId, 'A point', 'user-late', 'Tidy Newt', 'pseudonym');
    assert.equal(ack.added, true);
    const comment = (await commentUpdate)[0].votes[0].comments[0];

    assert.equal(comment.pseudonym, reserved.pseudonym, 'comment should persist under the reserved handle');
    assert.notEqual(comment.pseudonym, 'Tidy Newt', 'no duplicate "Tidy Newt" should be stored');
  } finally {
    mod.disconnect();
    holder.disconnect();
    latecomer.disconnect();
  }
});

test('Custom names are stored verbatim, never replaced by the reserved handle (#57)', async () => {
  const topic = uniqueTopic('pseudonym-canon-custom');
  const mod = await connectSocket();
  const user = await connectSocket();
  try {
    mod.emit('joinDiscussion', topic);
    user.emit('joinDiscussion', topic);
    const question = await addBrainstormQuestion(mod, topic, 'Ideas?');

    // The user holds a reserved pseudonym in this discussion...
    const reserved = await emitWithAck(user, 'requestPseudonym', topic, 'user-1', 'Tidy Newt');
    assert.equal(reserved.pseudonym, 'Tidy Newt');

    // ...but submits in CUSTOM mode: their typed name must be stored as-is, never
    // canonicalized to the reserved handle (custom is a deliberate user choice).
    const customUpdate = waitForQuestions(mod, (qs) => {
      const q = qs.find((x) => x.id === question.id);
      return q && q.votes.length === 1;
    }, 'custom-mode idea');
    user.emit('vote', topic, question.id, 'My idea', 'user-1', 'Dr. Real Name', 'custom');
    const stored = (await customUpdate).find((x) => x.id === question.id).votes[0];

    assert.equal(stored.pseudonym, 'Dr. Real Name');
  } finally {
    mod.disconnect();
    user.disconnect();
  }
});

test('a moderator can edit a question before anyone responds', async () => {
  const topic = uniqueTopic('edit-question');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    const added = waitForQuestions(mod, (qs) => qs.some((q) => q.text === 'Typoo?'), 'question added');
    mod.emit('addQuestion', topic, { text: 'Typoo?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await added).find((q) => q.text === 'Typoo?');

    // Edit both the wording and the type (to Numerical, so min/max are applied).
    const editedUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].text === 'Pick a budget', 'edit broadcast');
    const ack = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Pick a budget', type: 'Numerical', minValue: 0, maxValue: 10 }, token);
    assert.equal(ack.updated, true);

    const edited = (await editedUpdate)[0];
    assert.equal(edited.text, 'Pick a budget');
    assert.equal(edited.type, 'Numerical');
    assert.equal(edited.minValue, 0);
    assert.equal(edited.maxValue, 10);
  } finally {
    mod.disconnect();
  }
});

test('a moderator can edit a question to and from the Yes/No type', async () => {
  const topic = uniqueTopic('edit-yesno');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    const added = waitForQuestions(mod, (qs) => qs.some((q) => q.text === 'Agree?'), 'question added');
    mod.emit('addQuestion', topic, { text: 'Agree?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await added).find((q) => q.text === 'Agree?');

    // Switching an unanswered question to Yes/No must be accepted (Yes/No is a
    // valid type, so the server-side edit validation has to allow it).
    const toYesNo = waitForQuestions(mod, (qs) => qs[0] && qs[0].type === 'Yes/No', 'edit to Yes/No');
    const ack = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Yes or no?', type: 'Yes/No' }, token);
    assert.equal(ack.updated, true);

    const edited = (await toYesNo)[0];
    assert.equal(edited.text, 'Yes or no?');
    assert.equal(edited.type, 'Yes/No');

    // Editing an existing Yes/No question (its form always re-submits type:
    // 'Yes/No') must likewise succeed rather than be rejected as invalid.
    const reword = waitForQuestions(mod, (qs) => qs[0] && qs[0].text === 'Yes or no, really?', 'reword broadcast');
    const ack2 = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Yes or no, really?', type: 'Yes/No' }, token);
    assert.equal(ack2.updated, true);
    assert.equal((await reword)[0].type, 'Yes/No');
  } finally {
    mod.disconnect();
  }
});

test('editing a question is refused once it has responses', async () => {
  const topic = uniqueTopic('edit-locked');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    const added = waitForQuestions(mod, (qs) => qs.some((q) => q.text === 'Keep cars?'), 'question added');
    mod.emit('addQuestion', topic, { text: 'Keep cars?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await added).find((q) => q.text === 'Keep cars?');

    const voted = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'vote recorded');
    participant.emit('vote', topic, question.id, 'Agree', 'user-voter', 'Voter');
    await voted;

    const ack = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Restrict cars?', type: 'Agreement' }, token);
    assert.equal(ack.updated, false);
    assert.equal(ack.reason, 'has_responses');

    // The original wording must be untouched — the response was made against it.
    const row = await pool.query('SELECT text FROM questions WHERE id = $1', [question.id]);
    assert.equal(row.rows[0].text, 'Keep cars?');
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('a non-moderator cannot edit a question', async () => {
  const topic = uniqueTopic('edit-authz');
  const mod = await connectSocket();
  const stranger = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    await claimModerator(mod, topic);

    const added = waitForQuestions(mod, (qs) => qs.some((q) => q.text === 'Original?'), 'question added');
    mod.emit('addQuestion', topic, { text: 'Original?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await added).find((q) => q.text === 'Original?');

    const ack = await emitWithAck(stranger, 'editQuestion', topic, question.id,
      { text: 'Hijacked?', type: 'Agreement' }, 'bogus-token');
    assert.equal(ack.updated, false);
    assert.equal(ack.reason, 'not_authorized');

    const row = await pool.query('SELECT text FROM questions WHERE id = $1', [question.id]);
    assert.equal(row.rows[0].text, 'Original?');
  } finally {
    mod.disconnect();
    stranger.disconnect();
  }
});

function claimModerator(socket, topic) {
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.emit('claimModerator', topic, (resp) => {
        if (resp && resp.success) resolve(resp.token);
        else reject(new Error('Failed to claim moderator'));
      });
    }),
    5000,
    'Timed out claiming moderator'
  );
}

async function addBrainstormQuestion(socket, topic, text) {
  const update = waitForQuestions(
    socket,
    (questions) => questions.some((q) => q.text === text && q.type === 'Open Ended'),
    'brainstorm question added'
  );
  socket.emit('addQuestion', topic, { text, type: 'Open Ended', minValue: null, maxValue: null, options: [] });
  const questions = await update;
  return questions.find((q) => q.text === text);
}

async function jsonRequest(method, urlPath, body, headers = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function connectSocket() {
  const socket = io(baseUrl, {
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });

  return withTimeout(
    new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    }),
    5000,
    'Timed out connecting Socket.IO client'
  );
}

async function startServer() {
  serverOutput = '';
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(serverPort),
      DATABASE_URL: databaseUrl,
      CLIENT_URL: baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', collectServerOutput);
  serverProcess.stderr.on('data', collectServerOutput);

  await waitForServer(baseUrl, serverProcess);
}

async function stopServer() {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await waitForExit(serverProcess);
  }
}

function waitForQuestions(socket, predicate, description) {
  return withTimeout(
    new Promise((resolve) => {
      const handler = (questions) => {
        if (predicate(questions)) {
          socket.off('questions', handler);
          resolve(questions);
        }
      };

      socket.on('questions', handler);
    }),
    5000,
    `Timed out waiting for ${description}`
  );
}

// Emit an event whose last argument is an ack callback, and resolve with the
// server's ack payload.
function emitWithAck(socket, event, ...args) {
  return withTimeout(
    new Promise((resolve) => {
      socket.emit(event, ...args, resolve);
    }),
    5000,
    `Timed out waiting for ack of ${event}`
  );
}

// Resolve with the first occurrence of an event (optionally matching predicate).
function waitForEvent(socket, event, predicate) {
  return withTimeout(
    new Promise((resolve) => {
      const handler = (payload) => {
        if (!predicate || predicate(payload)) {
          socket.off(event, handler);
          resolve(payload);
        }
      };

      socket.on(event, handler);
    }),
    5000,
    `Timed out waiting for ${event}`
  );
}

function waitForServer(url, childProcess) {
  let interval;
  const readiness = new Promise((resolve, reject) => {
    interval = setInterval(async () => {
      if (childProcess.exitCode !== null) {
        reject(new Error(`Server exited early with code ${childProcess.exitCode}\n${serverOutput}`));
        return;
      }

      try {
        const response = await fetch(`${url}/api/discussions`);
        if (response.ok) {
          resolve();
        }
      } catch {
        // Keep polling until the server accepts connections or the timeout wins.
      }
    }, 100);
  });

  return withTimeout(
    readiness,
    10000,
    `Timed out waiting for server to start\n${serverOutput}`
  ).finally(() => clearInterval(interval));
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForExit(childProcess) {
  try {
    await withTimeout(once(childProcess, 'exit'), 5000, 'Timed out waiting for server process to exit');
  } catch {
    childProcess.kill('SIGKILL');
    await once(childProcess, 'exit');
  }
}

function withTimeout(promise, milliseconds, message) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function collectServerOutput(chunk) {
  serverOutput += chunk.toString();
  if (serverOutput.length > 8000) {
    serverOutput = serverOutput.slice(-8000);
  }
}

function uniqueTopic(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

test('free-text limits serialize writes; retries, edits, and identical contributions remain independent', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('response-limits') });
  const inserted = await pool.query("INSERT INTO questions (discussion_id, text, type, max_responses) VALUES ($1, 'Responses', 'Open Ended', 2) RETURNING id", [created.body.id]);
  const id = inserted.rows[0].id;
  const store = createVoteStore(pool);
  const write = (requestId, user = 'author') => store.addVote(id, { text: 'Same text', requestId }, user, 'Author');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => write(`request-${i}`)));
  assert.equal(results.filter(r => r.added).length, 2);
  assert.equal(results.filter(r => r.reason === 'limit').length, 6);
  const rows = (await pool.query('SELECT * FROM votes WHERE question_id = $1 ORDER BY id', [id])).rows;
  assert.deepEqual(await write(rows[0].request_id), { added: false, repeated: true });
  assert.deepEqual(await write('another-author', 'other'), { added: true });
  assert.deepEqual(await store.addVote(id, { text: 'Edited', responseId: rows[0].id }, 'other', 'Other'), { added: false, updated: false });
  assert.deepEqual(await store.addVote(id, { text: 'Edited', responseId: rows[0].id }, 'author', 'Author'), { added: false, updated: true });
  assert.equal((await pool.query('SELECT value FROM votes WHERE id = $1', [rows[0].id])).rows[0].value, 'Edited');
});

test('response settings persist, copy, validate, and hide attribution on public payloads', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('response-settings') });
  const { socket } = await joinAs(created.body.slug, 'settings-author');
  try {
    const payload = { text: 'Private authors', type: 'Open Ended', maxResponses: 3, showAttribution: false };
    assert.equal((await emitWithAck(socket, 'addQuestion', created.body.slug, payload, false, created.body.adminToken)).added, true);
    const question = (await pool.query('SELECT * FROM questions WHERE discussion_id = $1', [created.body.id])).rows[0];
    assert.equal(question.max_responses, 3);
    assert.equal(question.show_attribution, false);
    const update = waitForQuestions(socket, qs => qs[0]?.votes.length === 1, 'anonymous response');
    await emitWithAck(socket, 'vote', created.body.slug, question.id, { text: 'Response', requestId: 'one' }, 'settings-author', 'Secret author', 'custom');
    const questions = await update;
    assert.equal(questions[0].maxResponses, 3);
    assert.equal(questions[0].showAttribution, false);
    assert.equal(questions[0].votes[0].pseudonym, null);
    const copy = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: created.body.slug, newTopic: uniqueTopic('response-copy') });
    const copied = (await pool.query('SELECT max_responses, show_attribution FROM questions WHERE discussion_id = $1', [(await pool.query('SELECT id FROM discussions WHERE slug = $1', [copy.body.newSlug])).rows[0].id])).rows[0];
    assert.deepEqual(copied, { max_responses: 3, show_attribution: false });
  } finally { socket.disconnect(); }
});

test('a legacy Brainstorm creation keeps response authors hidden on socket and CSV views', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-brainstorm-privacy') });
  const { socket } = await joinAs(created.body.slug, 'legacy-author');
  try {
    assert.equal((await emitWithAck(socket, 'addQuestion', created.body.slug, { text: 'Legacy ideas', type: 'Brainstorm' }, false, created.body.adminToken)).added, true);
    const question = (await pool.query('SELECT id, type, show_attribution FROM questions WHERE discussion_id = $1', [created.body.id])).rows[0];
    assert.equal(question.type, 'Open Ended');
    assert.equal(question.show_attribution, false);
    const update = waitForQuestions(socket, qs => qs.some(q => q.id === question.id && q.votes.length === 1), 'legacy anonymous response');
    await emitWithAck(socket, 'vote', created.body.slug, question.id, 'Legacy contribution', 'legacy-author', 'Legacy Secret Author', 'custom');
    assert.equal((await update).find(q => q.id === question.id).votes[0].pseudonym, null);
    const csv = await fetch(`${baseUrl}/api/discussions/${created.body.slug}/export.csv`);
    assert.equal((await csv.text()).includes('Legacy Secret Author'), false);
  } finally { socket.disconnect(); }
});

test('legacy scalar answers update single-response questions but keep unlimited response creation', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-scalar-update') });
  const questions = (await pool.query("INSERT INTO questions (discussion_id, text, type, max_responses) VALUES ($1, 'Legacy written', 'Open Ended', 1), ($1, 'Former ideas', 'Open Ended', NULL) RETURNING id", [created.body.id])).rows;
  const store = createVoteStore(pool);
  await store.addVote(questions[0].id, 'Original', 'author', 'Author');
  assert.deepEqual(await store.addVote(questions[0].id, 'Updated scalar', 'author', 'Author'), { added: false, updated: true });
  assert.deepEqual((await pool.query('SELECT value FROM votes WHERE question_id = $1', [questions[0].id])).rows, [{ value: 'Updated scalar' }]);
  assert.equal((await store.addVote(questions[0].id, { text: 'New object response', requestId: 'new-create' }, 'author', 'Author')).reason, 'limit');
  await store.addVote(questions[1].id, 'First idea', 'author', 'Author');
  await store.addVote(questions[1].id, 'Second idea', 'author', 'Author');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM votes WHERE question_id = $1', [questions[1].id])).rows[0].n, 2);
});

test('a legacy upvote waiting for a moderator lock changes neither feedback store', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-lock-race') });
  await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE WHERE id = $1', [created.body.id]);
  const q = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Locked feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
  const vote = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'Keep locked') RETURNING id", [q.id])).rows[0];
  const { socket } = await joinAs(created.body.slug, 'legacy-voter');
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [created.body.id]);
    const update = waitForQuestions(socket, qs => qs.find(question => question.id === q.id)?.votes[0]?.upvotes === 0, 'toggle after lock commits');
    socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
    await waitForQuestionLockWait();
    await blocker.query('COMMIT');
    await update;
    for (const table of ['response_votes', 'response_ratings']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE response_id = $1`, [vote.id])).rows[0].n, 0);
    }
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    socket.disconnect();
  }
});

test('legacy upvote toggles and new quality ratings stay synchronized after migration', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-feedback-sync') });
  await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE WHERE id = $1', [created.body.id]);
  const question = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
  const vote = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'Keep feedback') RETURNING id", [question.id])).rows[0];
  const { socket } = await joinAs(created.body.slug, 'legacy-voter');
  const rating = async () => (await pool.query('SELECT quality, agreement FROM response_ratings WHERE response_id = $1 AND user_id = $2', [vote.id, 'legacy-voter'])).rows[0];
  try {
    let update = waitForQuestions(socket, qs => qs[0]?.votes[0]?.upvotes === 1, 'legacy upvote added');
    socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
    await update;
    assert.equal((await rating())?.quality, 1);
    await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE WHERE id = $1', [created.body.id]);
    update = waitForQuestions(socket, qs => qs[0]?.votes[0]?.qualityDown === 1, 'new quality downvote');
    socket.emit('setResponseRating', created.body.slug, vote.id, 'quality', -1, 'legacy-voter');
    assert.equal((await update)[0].votes[0].upvotes, 0);
    await pool.query("UPDATE response_ratings SET agreement = 'Agree' WHERE response_id = $1", [vote.id]);
    update = waitForQuestions(socket, qs => qs[0]?.votes[0]?.qualityUp === 1, 'legacy upvote after new rating');
    socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
    await update;
    assert.deepEqual(await rating(), { quality: 1, agreement: 'Agree' });
    update = waitForQuestions(socket, qs => qs[0]?.votes[0]?.upvotes === 0 && qs[0]?.votes[0]?.qualityUp === 0, 'legacy upvote removed');
    socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
    await update;
    assert.deepEqual(await rating(), { quality: null, agreement: 'Agree' });
    await pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [created.body.id]);
    update = waitForQuestions(socket, qs => qs[0]?.votes[0]?.upvotes === 0, 'locked legacy upvote rejected');
    socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
    await update;
    assert.deepEqual(await rating(), { quality: null, agreement: 'Agree' });
  } finally { socket.disconnect(); }
});

test('unified response migration preserves attribution, limits and upvotes without resetting later changes', async () => {
  await stopServer();
  try {
    await pool.query('DROP TABLE schema_migrations; ALTER TABLE questions DROP COLUMN max_responses, DROP COLUMN show_attribution');
    const d = (await pool.query("INSERT INTO discussions (topic, slug) VALUES ('Migration', 'migration') RETURNING id")).rows[0].id;
    const qs = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Written', 'Open Ended'), ($1, 'Ideas', 'Brainstorm') RETURNING id", [d])).rows;
    const v = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'Keep me') RETURNING id", [qs[0].id])).rows[0].id;
    await pool.query("INSERT INTO response_votes (response_id, user_id) VALUES ($1, 'voter')", [v]);
    await pool.query("INSERT INTO response_votes (response_id, user_id) VALUES ($1, 'agreement-voter'), ($1, 'quality-voter')", [v]);
    await pool.query("INSERT INTO response_ratings (response_id, user_id, quality, agreement) VALUES ($1, 'agreement-voter', NULL, 'Agree'), ($1, 'quality-voter', -1, 'Disagree')", [v]);
    await initializeDatabase(pool);
    const migrated = (await pool.query('SELECT type, max_responses, show_attribution FROM questions WHERE discussion_id = $1 ORDER BY id', [d])).rows;
    assert.deepEqual(migrated, [{ type: 'Open Ended', max_responses: 1, show_attribution: true }, { type: 'Open Ended', max_responses: null, show_attribution: false }]);
    assert.equal((await pool.query("SELECT quality FROM response_ratings WHERE response_id = $1 AND user_id = 'voter'", [v])).rows[0].quality, 1);
    assert.deepEqual((await pool.query("SELECT user_id, quality, agreement FROM response_ratings WHERE response_id = $1 AND user_id <> 'voter' ORDER BY user_id", [v])).rows,
      [{ user_id: 'agreement-voter', quality: 1, agreement: 'Agree' }, { user_id: 'quality-voter', quality: -1, agreement: 'Disagree' }]);
    await pool.query('UPDATE questions SET max_responses = 4 WHERE id = $1', [qs[0].id]);
    await initializeDatabase(pool);
    assert.equal((await pool.query('SELECT max_responses FROM questions WHERE id = $1', [qs[0].id])).rows[0].max_responses, 4);
  } finally { await startServer(); }
});

test('hidden feedback redacts legacy aliases of positive quality ratings', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('hidden-quality-alias') });
  const question = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
  const vote = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'Answer') RETURNING id", [question.id])).rows[0];
  await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE WHERE id = $1', [created.body.id]);
  const { socket } = await joinAs(created.body.slug, 'critic');
  try {
    const rated = waitForQuestions(socket, qs => qs[0]?.votes[0]?.qualityUp === 1, 'quality rating recorded');
    socket.emit('setResponseRating', created.body.slug, vote.id, 'quality', 1, 'critic');
    const visible = (await rated)[0].votes[0];
    assert.equal(visible.upvotes, 1);
    assert.equal(visible.upvoterTokens.length, 1);
    for (const enabled of [true, false]) {
      await pool.query('UPDATE discussions SET reactions_visible = FALSE, reactions_enabled = $2 WHERE id = $1', [created.body.id, enabled]);
      const visitor = await joinAs(created.body.slug, 'observer');
      try {
        const hidden = visitor.questions[0].votes[0];
        assert.equal(hidden.upvotes, 0);
        assert.deepEqual(hidden.upvoterTokens, []);
        assert.equal(hidden.qualityUp, undefined);
        assert.equal(hidden.upvoters, undefined);
      } finally { visitor.socket.disconnect(); }
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM response_votes WHERE response_id = $1', [vote.id])).rows[0].n, 1);
  } finally { socket.disconnect(); }
});

for (const [enabled, visible] of [[false, true], [true, false], [false, false]]) {
  test(`legacy upvotes cannot add or remove feedback when enabled=${enabled}, visible=${visible}`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-feedback-flags') });
    const q = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
    const vote = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'Answer') RETURNING id", [q.id])).rows[0];
    await pool.query('UPDATE discussions SET reactions_enabled = $2, reactions_visible = $3 WHERE id = $1', [created.body.id, enabled, visible]);
    const { socket } = await joinAs(created.body.slug, 'legacy-voter');
    try {
      for (const existing of [false, true]) {
        if (existing) {
          await pool.query("INSERT INTO response_votes (response_id, user_id) VALUES ($1, 'legacy-voter')", [vote.id]);
          await pool.query("INSERT INTO response_ratings (response_id, user_id, quality, agreement) VALUES ($1, 'legacy-voter', 1, 'Agree')", [vote.id]);
        }
        // This handler always broadcasts after completing, including rejection.
        const update = waitForQuestions(socket, qs => qs[0]?.id === q.id, 'legacy toggle completed');
        socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
        await update;
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM response_votes WHERE response_id = $1', [vote.id])).rows[0].n, existing ? 1 : 0);
        assert.deepEqual((await pool.query('SELECT quality, agreement FROM response_ratings WHERE response_id = $1', [vote.id])).rows,
          existing ? [{ quality: 1, agreement: 'Agree' }] : []);
      }
    } finally { socket.disconnect(); }
  });
}

const interestCount = async questionId =>
  (await pool.query('SELECT count(*)::int AS n FROM question_interest WHERE question_id = $1', [questionId])).rows[0].n;

test('question downvotes require moderator opt-in and share one vote with upvotes', async () => {
  const seed = await seedResultsDiscussion('optional-downvotes');
  const { socket } = await joinAs(seed.slug, 'downvoter');
  const vote = direction => emitWithAck(socket, 'setQuestionInterest', seed.slug, seed.agreement, direction, 'downvoter');
  const recover = () => emitWithAck(socket, 'getQuestionInterestState', seed.slug, seed.agreement, 'downvoter');
  const enable = async enabled => {
    const changed = waitForEvent(socket, 'discussionState', state => state.questionDownvotesEnabled === enabled);
    socket.emit('setDiscussionFlags', seed.slug, { question_downvotes_enabled: enabled }, seed.adminToken);
    await changed;
  };
  try {
    const refused = waitForEvent(socket, 'error');
    socket.emit('setDiscussionFlags', seed.slug, { question_downvotes_enabled: true }, 'not-the-moderator');
    await refused;
    assert.deepEqual(await vote('down'), { updated: false });
    await enable(true);
    const broadcast = waitForQuestions(socket, qs => byId(qs, seed.agreement).downvoteCount === 1, 'downvote');
    assert.deepEqual(await vote('down'), { updated: true });
    const question = byId(await broadcast, seed.agreement);
    assert.deepEqual(question.downvoterTokens, [crypto.createHash('sha256').update(`question:${seed.agreement}:downvoter`).digest('hex')]);
    assert.equal(question.interestCount, 0);
    assert.deepEqual(await recover(), { interested: false, downvoted: true });
    await enable(false);
    assert.deepEqual(await recover(), { interested: false, downvoted: false });
    assert.deepEqual(await vote('down'), { updated: false });
    assert.deepEqual(await vote(true), { updated: true });
    await enable(true);
    assert.deepEqual(await recover(), { interested: true, downvoted: false });
    assert.equal(await interestCount(seed.agreement), 1);
    await pool.query('UPDATE discussions SET locked = TRUE WHERE id=$1', [seed.id]);
    assert.deepEqual(await vote('down'), { updated: false });
  } finally { socket.disconnect(); }
});

test('participants mark questions as interesting; counts broadcast with tokens instead of user ids', async () => {
  const seed = await seedResultsDiscussion('interest');
  const tokenFor = (questionId, userId) =>
    crypto.createHash('sha256').update(`question:${questionId}:${userId}`).digest('hex');
  const { socket: first, questions: initial } = await joinAs(seed.slug, 'interest-a');
  const { socket: second } = await joinAs(seed.slug, 'interest-b');
  try {
    for (const question of initial) {
      assert.equal(question.interestCount, 0);
      assert.deepEqual(question.interestVoterTokens, []);
    }

    // The count reaches a participant who has not answered the question, whose
    // results are still hidden from them.
    let broadcast = waitForQuestions(second, qs => byId(qs, seed.agreement).interestCount === 1, 'first interest');
    assert.deepEqual(await emitWithAck(first, 'setQuestionInterest', seed.slug, seed.agreement, true, 'interest-a'), { updated: true });
    let question = byId(await broadcast, seed.agreement);
    assert.equal(question.resultsHidden, true);
    assert.deepEqual(question.interestVoterTokens, [tokenFor(seed.agreement, 'interest-a')]);

    // Repeating the same request changes nothing.
    assert.deepEqual(await emitWithAck(first, 'setQuestionInterest', seed.slug, seed.agreement, true, 'interest-a'), { updated: true });
    assert.equal(await interestCount(seed.agreement), 1);

    broadcast = waitForQuestions(first, qs => byId(qs, seed.agreement).interestCount === 2, 'second interest');
    // The socket's pinned identity is used, not the id named in the message.
    assert.deepEqual(await emitWithAck(second, 'setQuestionInterest', seed.slug, seed.agreement, true, 'interest-a'), { updated: true });
    const questions = await broadcast;
    question = byId(questions, seed.agreement);
    assert.deepEqual(question.interestVoterTokens, [tokenFor(seed.agreement, 'interest-a'), tokenFor(seed.agreement, 'interest-b')]);
    assert.equal(byId(questions, seed.written).interestCount, 0);
    assert.equal('interest_voters' in question, false);
    assert.doesNotMatch(JSON.stringify(questions), /interest-a|interest-b/);

    broadcast = waitForQuestions(second, qs => byId(qs, seed.agreement).interestCount === 1, 'interest removed');
    assert.deepEqual(await emitWithAck(first, 'setQuestionInterest', seed.slug, seed.agreement, false, 'interest-a'), { updated: true });
    assert.deepEqual(byId(await broadcast, seed.agreement).interestVoterTokens, [tokenFor(seed.agreement, 'interest-b')]);
  } finally {
    first.disconnect();
    second.disconnect();
  }
});

test('interest marks are refused for other discussions, bad payloads, room displays and locked discussions', async () => {
  const seed = await seedResultsDiscussion('interest-guards');
  const other = await seedResultsDiscussion('interest-other');
  const { socket } = await joinAs(seed.slug, 'interest-guard');
  const display = await connectSocket();
  try {
    const refused = { updated: false };
    // A question id from another discussion does not match this room.
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, other.agreement, true, 'interest-guard'), refused);
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, String(seed.agreement), true, 'interest-guard'), refused);
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, seed.agreement, 'yes', 'interest-guard'), refused);
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, 2147483648, true, 'interest-guard'), refused);

    const joined = nextQuestions(display, 'display join');
    display.emit('joinDisplay', seed.slug);
    await joined;
    assert.equal((await emitWithAck(display, 'setQuestionInterest', seed.slug, seed.agreement, true, 'interest-display')).error, 'display_read_only');

    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, seed.written, true, 'interest-guard'), { updated: true });
    const locked = waitForEvent(socket, 'discussionState', state => state.locked === true);
    socket.emit('setLocked', seed.slug, true, seed.adminToken);
    await locked;
    // Locking closes voting: marks can be neither added nor removed.
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, seed.agreement, true, 'interest-guard'), refused);
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, seed.written, false, 'interest-guard'), refused);

    assert.equal(await interestCount(seed.agreement), 0);
    assert.equal(await interestCount(seed.written), 1);
    assert.equal(await interestCount(other.agreement), 0);
  } finally {
    socket.disconnect();
    display.disconnect();
  }
});

test('deleting a question or its discussion removes the interest marks', async () => {
  const seed = await seedResultsDiscussion('interest-delete');
  const { socket } = await joinAs(seed.slug, 'interest-deleter');
  try {
    for (const id of [seed.agreement, seed.written]) {
      assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, id, true, 'interest-deleter'), { updated: true });
    }
    const removed = waitForQuestions(socket, qs => !byId(qs, seed.agreement), 'question deleted');
    socket.emit('deleteQuestion', seed.slug, seed.agreement, seed.adminToken);
    await removed;
    assert.equal(await interestCount(seed.agreement), 0);
    assert.equal(await interestCount(seed.written), 1);

    assert.equal((await jsonRequest('DELETE', `/api/discussions/${seed.slug}`, { adminToken: seed.adminToken })).status, 200);
    assert.equal(await interestCount(seed.written), 0);
  } finally {
    socket.disconnect();
  }
});

// A moderator socket: joined, identified by nothing but its proven token.
async function joinAsModerator(slug, adminToken) {
  const { socket } = await joinAs(slug, null);
  assert.equal((await emitWithAck(socket, 'checkModerator', slug, adminToken)).isModerator, true);
  return socket;
}

test('duplicating a room leaves pending suggestions behind but keeps published suggestions and authorized moderator drafts', async () => {
  const { id, slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('suggestion-source') })).body;
  await pool.query(`INSERT INTO questions (discussion_id, text, type, queued, participant_suggested) VALUES
    ($1, 'Moderator draft', 'Agreement', true, false),
    ($1, 'Pending suggestion', 'Agreement', true, true),
    ($1, 'Published suggestion', 'Agreement', false, true)`, [id]);
  const questions = async roomSlug => (await pool.query(`SELECT text, queued FROM questions
    JOIN discussions ON discussions.id = questions.discussion_id WHERE slug = $1 ORDER BY text`, [roomSlug])).rows;
  const published = { text: 'Published suggestion', queued: false };
  const draft = { text: 'Moderator draft', queued: true };
  for (const [credentials, expected] of [[{ adminToken }, [draft, published]], [{}, [published]]]) {
    const copy = await jsonRequest('POST', '/api/duplicate-discussion', {
      originalTopic: slug, newTopic: uniqueTopic('suggestion-copy'), ...credentials,
    });
    assert.equal(copy.status, 200);
    assert.deepEqual(await questions(copy.body.newSlug), expected);
  }
  assert.deepEqual(await questions(slug), [draft, { text: 'Pending suggestion', queued: true }, published]);
});

test('a private note prevents edits before the first vote and retains its original question', async () => {
  const { id, slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('edit-after-note') })).body;
  const moderator = await joinAsModerator(slug, adminToken);
  const { socket: participant } = await joinAs(slug, 'note-author');
  try {
    for (const [kind, body] of [['clarification', 'Which day?'], ['suggestion', 'Thursday']]) {
      const { rows: [question] } = await pool.query(`INSERT INTO questions (discussion_id, text, type, options, tools)
        VALUES ($1, 'When?', 'Multiple Choice', $2, $3) RETURNING id`, [id, JSON.stringify(['Monday', 'Tuesday']), [kind]]);
      assert.deepEqual(await emitWithAck(participant, 'submitQuestionNote', slug, question.id, { kind, body }), { ok: true });
      assert.deepEqual(await emitWithAck(moderator, 'editQuestion', slug, question.id, { text: 'How many?', type: 'Numerical', minValue: 0, maxValue: 10, tools: [] }, adminToken),
        { updated: false, reason: 'has_notes' });
      const saved = (await pool.query('SELECT text, type, tools FROM questions WHERE id = $1', [question.id])).rows[0];
      assert.deepEqual(saved, { text: 'When?', type: 'Multiple Choice', tools: [kind] });
      const { notes } = await emitWithAck(moderator, 'getQuestionNotes', slug, question.id, { token: adminToken });
      assert.deepEqual(notes.map(note => [note.kind, note.body]), [[kind, body]]);
    }
  } finally {
    moderator.disconnect();
    participant.disconnect();
  }
});

test('posting approval migration preserves old rooms and moderator drafts', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE discussions (moderator_only_questions boolean); CREATE TEMP TABLE questions (queued boolean)');
    await client.query('INSERT INTO discussions VALUES (true), (false); INSERT INTO questions VALUES (true), (false)');
    const migrate = require('../migrations').find(([, migration]) => migration.name === 'migrateQuestionApproval')[1];
    await migrate(client);
    const rooms = (await client.query('SELECT * FROM discussions ORDER BY moderator_only_questions')).rows;
    assert.deepEqual(rooms.map(require('../question-posting').postingMode), ['open', 'moderator_only']);
    assert.deepEqual((await client.query('SELECT queued, participant_suggested FROM questions ORDER BY queued')).rows,
      [{ queued: false, participant_suggested: false }, { queued: true, participant_suggested: false }]);
    await client.query('UPDATE discussions SET question_approval_required = TRUE WHERE NOT moderator_only_questions');
    await migrate(client);
    assert.equal((await client.query('SELECT question_approval_required FROM discussions WHERE NOT moderator_only_questions')).rows[0].question_approval_required, true);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('posting approval routes legacy and forced submissions to the private queue until published', async () => {
  const { slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('posting-approval') })).body;
  const mod = await joinAsModerator(slug, adminToken);
  const { socket: participant } = await joinAs(slug, 'suggester');
  const { socket: display } = await joinDisplay(slug);
  try {
    const forbidden = waitForEvent(participant, 'error');
    participant.emit('setPostingMode', slug, 'approval', 'invalid');
    assert.match((await forbidden).message, /not authorized/i);
    const invalid = waitForEvent(mod, 'error');
    mod.emit('setPostingMode', slug, 'unknown', adminToken);
    assert.match((await invalid).message, /invalid/i);

    const switched = waitForEvent(participant, 'discussionState', state => state.postingMode === 'approval');
    mod.emit('setPostingMode', slug, 'approval', adminToken);
    assert.equal((await switched).moderatorOnly, false);
    const modList = waitForQuestions(mod, list => list.some(question => question.suggested), 'suggestion in moderator queue');
    const participantList = nextQuestions(participant, 'participant view');
    const displayList = nextQuestions(display, 'display view');
    const payload = { text: 'Where should we meet?', type: 'Agreement', queued: false };
    assert.deepEqual(await emitWithAck(participant, 'addQuestion', slug, payload, true), { added: true, queued: true, suggested: true });
    const [suggestion] = await modList;
    assert.equal(suggestion.queued, true);
    assert.deepEqual(await participantList, []);
    assert.deepEqual(await displayList, []);
    assert.equal((await emitWithAck(participant, 'publishQuestion', slug, suggestion.id, 'invalid')).published, false);

    const publicPayload = { text: 'Transport costs will rise', type: 'Agreement' };
    assert.deepEqual(await emitWithAck(mod, 'addQuestion', slug, publicPayload, true, adminToken), { added: true });
    const duplicate = waitForEvent(participant, 'similarQuestion');
    assert.equal((await emitWithAck(participant, 'addQuestion', slug, publicPayload, false)).reason, 'similar');
    const retry = (await duplicate).question;
    assert.equal(retry.queued, true);
    const opened = waitForEvent(participant, 'discussionState', state => state.postingMode === 'open');
    mod.emit('setModeratorOnly', slug, false, adminToken);
    await opened;
    assert.equal((await emitWithAck(participant, 'addQuestion', slug, retry, true)).reason, 'not_authorized');
    const published = waitForQuestions(participant, list => list.some(question => question.id === suggestion.id), 'approved suggestion');
    assert.equal((await emitWithAck(mod, 'publishQuestion', slug, suggestion.id, adminToken)).published, true);
    assert.equal((await published).find(question => question.id === suggestion.id).queued, false);
  } finally {
    mod.disconnect(); participant.disconnect(); display.disconnect();
  }
});

test('a queued question reaches moderators only, and nobody can answer it, until it is published', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('queue') });
  const { slug, adminToken } = created.body;
  const mod = await joinAsModerator(slug, adminToken);
  const { socket: participant } = await joinAs(slug, 'queue-participant');
  const { socket: display } = await joinDisplay(slug);
  try {
    const queuedPayload = { text: 'Takeover within a year is likely', type: 'Agreement', options: [], queued: true };

    // Only a moderator can queue. A refused request adds nothing, because
    // adding it unqueued would show the question to the whole room.
    assert.deepEqual(
      await emitWithAck(participant, 'addQuestion', slug, queuedPayload, false, undefined),
      { added: false, reason: 'not_authorized' }
    );
    assert.deepEqual(
      await emitWithAck(participant, 'addQuestion', slug, queuedPayload, false, 'not-the-token'),
      { added: false, reason: 'not_authorized' }
    );
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM questions')).rows[0].n, 0);

    const modSees = waitForQuestions(mod, qs => qs.length === 1, 'moderator receives the queued question');
    const participantSees = nextQuestions(participant, 'participant broadcast after queueing');
    const displaySees = nextQuestions(display, 'display broadcast after queueing');
    assert.deepEqual(await emitWithAck(mod, 'addQuestion', slug, queuedPayload, false, adminToken), { added: true });
    const [queued] = await modSees;
    assert.equal(queued.queued, true);
    assert.deepEqual(await participantSees, []);
    assert.deepEqual(await displaySees, []);

    // Its id is easy to guess, so every way to answer it is refused as if the
    // question did not exist.
    const refusedVote = waitForEvent(participant, 'error', e => /invalid question/i.test(e.message));
    assert.deepEqual(await emitWithAck(participant, 'vote', slug, queued.id, 'Agree', 'queue-participant', 'P', undefined), { ok: false });
    await refusedVote;
    assert.deepEqual(await emitWithAck(participant, 'clearVote', slug, queued.id, 'queue-participant'), { ok: false });
    assert.deepEqual(await emitWithAck(participant, 'setQuestionInterest', slug, queued.id, true, 'queue-participant'), { updated: false });
    assert.deepEqual(await emitWithAck(participant, 'getQuestionInterestState', slug, queued.id, 'queue-participant'), { error: 'not_found' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM votes')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM question_interest')).rows[0].n, 0);

    // A participant who writes the same statement is not shown the queued
    // wording as "a similar statement"; theirs is simply added.
    const publicAdded = waitForQuestions(participant, qs => qs.length === 1, 'participant question added');
    assert.deepEqual(
      await emitWithAck(participant, 'addQuestion', slug, { ...queuedPayload, queued: undefined }, false, undefined),
      { added: true }
    );
    const [publicQuestion] = await publicAdded;
    assert.equal(publicQuestion.queued, false);
    assert.notEqual(publicQuestion.id, queued.id);

    // A moderator queueing a near-duplicate is asked first, and "Post anyway"
    // (which sends the echoed question back) still queues it.
    const similar = waitForEvent(mod, 'similarQuestion');
    assert.deepEqual(
      await emitWithAck(mod, 'addQuestion', slug, { ...queuedPayload, text: 'Takeover within a year is likely!' }, false, adminToken),
      { added: false, reason: 'similar' }
    );
    const echoed = (await similar).question;
    assert.equal(echoed.queued, true);
    assert.deepEqual(await emitWithAck(mod, 'addQuestion', slug, echoed, true, adminToken), { added: true });
    const flags = async () => (await pool.query('SELECT text, queued FROM questions ORDER BY id')).rows.map(row => row.queued);
    assert.deepEqual(await flags(), [true, false, true]);

    // Summaries, exports and snapshots leave queued questions out for everyone.
    const base = `/api/discussions/${slug}`;
    for (const headers of [{}, asUser('queue-participant'), asModerator(adminToken)]) {
      const summary = (await jsonRequest('GET', `${base}/summary`, undefined, headers)).body;
      assert.deepEqual(summary.questions.map(q => q.id), [publicQuestion.id]);
      assert.equal(summary.counts.questions, 1);
      const csv = await fetch(`${baseUrl}${base}/export.csv`, { headers });
      assert.equal((await csv.text()).split('\n').length, 2, 'header and the one published question');
    }
    const snapshot = await jsonRequest('POST', `${base}/snapshots`, { name: 'Queue', adminToken });
    assert.deepEqual(snapshot.body.data.questions.map(q => q.id), [publicQuestion.id]);

    // Showing results to everyone does not show queued questions to everyone.
    const alwaysForParticipant = waitForEvent(participant, 'discussionState', state => state.resultsVisibility === 'always');
    const alwaysQuestions = nextQuestions(participant, 'participant broadcast in always mode');
    const alwaysForMod = nextQuestions(mod, 'moderator broadcast in always mode');
    const alwaysForDisplay = nextQuestions(display, 'display broadcast in always mode');
    mod.emit('setResultsVisibility', slug, 'always', adminToken);
    await alwaysForParticipant;
    assert.deepEqual((await alwaysQuestions).map(q => q.id), [publicQuestion.id]);
    assert.deepEqual((await alwaysForDisplay).map(q => q.id), [publicQuestion.id]);
    assert.equal((await alwaysForMod).length, 3);
    // Someone who joins or proves a moderator token in that mode gets the right list.
    const late = await joinAs(slug, 'queue-latecomer');
    try {
      assert.deepEqual(late.questions.map(q => q.id), [publicQuestion.id]);
      const promoted = waitForQuestions(late.socket, qs => qs.length === 3, 'queued questions after proving a token');
      assert.equal((await emitWithAck(late.socket, 'checkModerator', slug, adminToken)).isModerator, true);
      await promoted;
    } finally {
      late.socket.disconnect();
    }

    // Only a moderator can publish.
    const refusedPublish = waitForEvent(participant, 'error', e => /not authorized/i.test(e.message));
    assert.deepEqual(await emitWithAck(participant, 'publishQuestion', slug, queued.id, 'not-the-token'), { published: false, reason: 'not_authorized' });
    await refusedPublish;
    assert.deepEqual(await flags(), [true, false, true]);

    // Publishing shows the question to everyone as the newest one.
    const published = waitForQuestions(participant, qs => qs.length === 2, 'participant receives the published question');
    const publishedOnDisplay = waitForQuestions(display, qs => qs.length === 2, 'display receives the published question');
    assert.deepEqual(await emitWithAck(mod, 'publishQuestion', slug, queued.id, adminToken), { published: true });
    assert.deepEqual((await published).map(q => q.id), [publicQuestion.id, queued.id]);
    const onDisplay = await publishedOnDisplay;
    assert.deepEqual(onDisplay.map(q => q.id), [publicQuestion.id, queued.id]);
    assert.equal(onDisplay[1].queued, false);
    assert.ok(Date.parse(onDisplay[1].created_at) > Date.parse(onDisplay[0].created_at), 'published now, so it sorts as the most recent');
    // Publishing twice changes nothing, and neither does an id from elsewhere.
    assert.deepEqual(await emitWithAck(mod, 'publishQuestion', slug, queued.id, adminToken), { published: false });
    assert.deepEqual(await emitWithAck(mod, 'publishQuestion', slug, 'not-an-id', adminToken), { published: false });

    // Now it can be answered.
    assert.deepEqual(await emitWithAck(participant, 'vote', slug, queued.id, 'Agree', 'queue-participant', 'P', undefined), { ok: true });

    // A moderator's duplicate keeps the rest of the agenda queued.
    const copiedQuestions = async newSlug => (await pool.query(
      'SELECT q.text, q.queued FROM questions q JOIN discussions d ON d.id = q.discussion_id WHERE d.slug = $1 ORDER BY q.id',
      [newSlug]
    )).rows;
    const copy = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: slug, newTopic: uniqueTopic('queue-copy'), adminToken });
    const copied = await copiedQuestions(copy.body.newSlug);
    assert.deepEqual(copied.map(row => row.queued), [false, false, true]);
    assert.equal(copied[2].text, 'Takeover within a year is likely!');
    // Anyone can duplicate a discussion and moderates the copy, so a duplicate
    // made without the original's moderator token leaves the queue behind.
    for (const body of [{}, { adminToken: 'not-the-token' }, { adminToken: copy.body.adminToken }]) {
      const stranger = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: slug, newTopic: uniqueTopic('queue-stranger-copy'), ...body });
      assert.equal(stranger.status, 200);
      assert.deepEqual((await copiedQuestions(stranger.body.newSlug)).map(row => row.queued), [false, false]);
    }

    // Locking closes new questions, and publishing would add one for the room.
    const lockedState = waitForEvent(mod, 'discussionState', state => state.locked === true);
    mod.emit('setLocked', slug, true, adminToken);
    await lockedState;
    const remaining = (await pool.query('SELECT id FROM questions WHERE queued AND discussion_id = $1', [created.body.id])).rows[0].id;
    assert.deepEqual(await emitWithAck(mod, 'publishQuestion', slug, remaining, adminToken), { published: false, reason: 'locked' });
    assert.equal((await pool.query('SELECT queued FROM questions WHERE id = $1', [remaining])).rows[0].queued, true);
  } finally {
    mod.disconnect();
    participant.disconnect();
    display.disconnect();
  }
});

test('queue moves require moderator access and the same adjacent unpublished questions', async () => {
  const { body: room } = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('queue-order') });
  const mod = await joinAsModerator(room.slug, room.adminToken);
  const insert = async (text, queued) => (await pool.query(
    "INSERT INTO questions (discussion_id, text, type, queued) VALUES ($1, $2, 'Agreement', $3) RETURNING id",
    [room.id, text, queued])).rows[0].id;
  try {
    const first = await insert('First', true), second = await insert('Second', true), third = await insert('Third', true);
    const live = await insert('Live', false);
    const swap = (earlier, later, token = room.adminToken) => mod.emit('swapQueuedQuestions', room.slug, earlier, later, token);
    const refused = waitForEvent(mod, 'error', error => /not authorized/i.test(error.message));
    swap(first, second, 'wrong');
    await refused;
    const reordered = waitForQuestions(mod, questions => questions.filter(question => question.queued)[0]?.id === second, 'saved queue order');
    swap(first, second);
    await reordered;
    for (const pair of [[first, second], [second, third], [third, live]]) {
      const stale = waitForEvent(mod, 'error', error => /queue has changed/i.test(error.message));
      swap(...pair);
      await stale;
    }
    await insert('Last', true);
    const { body: copy } = await jsonRequest('POST', '/api/duplicate-discussion', {
      originalTopic: room.slug, newTopic: uniqueTopic('ordered-copy'), adminToken: room.adminToken,
    });
    const copied = await pool.query(`SELECT text FROM questions JOIN discussions ON discussions.id = discussion_id
      WHERE slug = $1 AND queued ORDER BY COALESCE(queue_position, questions.id)`, [copy.newSlug]);
    assert.deepEqual(copied.rows.map(question => question.text), ['Second', 'First', 'Third', 'Last']);
  } finally {
    mod.disconnect();
  }
});

test('published moves require a moderator and adjacent questions in the same room and pin group', async () => {
  const { body: room } = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('published-order') });
  const { body: other } = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('other-order') });
  const mod = await joinAsModerator(room.slug, room.adminToken);
  const insert = async (roomId, text, pinned = false, queued = false) => (await pool.query(
    "INSERT INTO questions (discussion_id, text, type, pinned, queued) VALUES ($1, $2, 'Agreement', $3, $4) RETURNING id",
    [roomId, text, pinned, queued])).rows[0].id;
  try {
    const oldest = await insert(room.id, 'Oldest'), middle = await insert(room.id, 'Middle'), newest = await insert(room.id, 'Newest');
    const pinned = await insert(room.id, 'Pinned', true), queued = await insert(room.id, 'Queued', false, true);
    const elsewhere = await insert(other.id, 'Elsewhere');
    const swap = (earlier, later, token = room.adminToken) => mod.emit('swapPublishedQuestions', room.slug, earlier, later, token);
    const refused = waitForEvent(mod, 'error', error => /not authorized/i.test(error.message));
    swap(newest, middle, 'wrong');
    await refused;
    for (const pair of [[newest, oldest], [pinned, newest], [newest, queued], [newest, elsewhere]]) {
      const rejected = waitForEvent(mod, 'error', error => /order has changed/i.test(error.message));
      swap(...pair);
      await rejected;
    }
    const moved = waitForQuestions(mod, questions => questions.find(question => question.id === middle)?.moderatorOrder === 2, 'stored moderator order');
    swap(newest, middle);
    await moved;
    const stale = waitForEvent(mod, 'error', error => /order has changed/i.test(error.message));
    swap(newest, middle);
    await stale;
    const added = await insert(room.id, 'New submission');
    const { rows } = await pool.query('SELECT id FROM questions WHERE discussion_id = $1 AND NOT queued ORDER BY pinned DESC, published_position NULLS LAST', [room.id]);
    assert.deepEqual(rows.map(row => row.id), [pinned, middle, newest, oldest, added]);
  } finally {
    mod.disconnect();
  }
});

test('existing questions are published when the queue column is added', async () => {
  await stopServer();
  try {
    const discussion = await pool.query("INSERT INTO discussions (topic, slug) VALUES ('Before the queue', 'before-the-queue') RETURNING id");
    await pool.query('DROP TABLE schema_migrations; ALTER TABLE questions DROP COLUMN queued');
    await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Older question', 'Agreement')", [discussion.rows[0].id]);
    await initializeDatabase(pool);
    assert.equal((await pool.query("SELECT queued FROM questions WHERE text = 'Older question'")).rows[0].queued, false);
  } finally {
    await startServer();
  }
});

test('a moderator chooses which question the room display shows on its own', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('display-question') });
  const other = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('display-question-other') });
  const { slug, adminToken } = created.body;
  const mod = await joinAsModerator(slug, adminToken);
  const display = await connectSocket();
  const add = async (socket, where, token, question) => {
    assert.deepEqual(await emitWithAck(socket, 'addQuestion', where, { type: 'Agreement', options: [], ...question }, true, token), { added: true });
    return (await pool.query('SELECT id FROM questions WHERE text = $1', [question.text])).rows[0].id;
  };
  const stateWhere = predicate => waitForEvent(display, 'discussionState', predicate);
  const refusal = pattern => waitForEvent(mod, 'error', error => pattern.test(error.message));
  try {
    const first = await add(mod, slug, adminToken, { text: 'First statement' });
    const second = await add(mod, slug, adminToken, { text: 'Second statement' });
    const queued = await add(mod, slug, adminToken, { text: 'Queued statement', queued: true });
    const foreign = await add(mod, other.body.slug, other.body.adminToken, { text: 'Another room' });

    const initial = stateWhere(() => true);
    display.emit('joinDisplay', slug);
    assert.equal((await initial).displayQuestionId, null);

    // Choosing a question also switches a display that lists every question to
    // the one-question view, so one click puts the question on the screen.
    let changed = stateWhere(state => state.displayQuestionId === first);
    mod.emit('setDisplaySettings', slug, { questionId: first }, adminToken);
    assert.equal((await changed).displayLayout, 'focus');

    // An explicit layout wins, and the choice is kept for when the moderator
    // goes back to one question.
    changed = stateWhere(state => state.displayQuestionId === second);
    mod.emit('setDisplaySettings', slug, { questionId: second, layout: 'all' }, adminToken);
    assert.equal((await changed).displayLayout, 'all');
    changed = stateWhere(state => state.displayLayout === 'focus');
    mod.emit('setDisplaySettings', slug, { layout: 'focus' }, adminToken);
    assert.equal((await changed).displayQuestionId, second);

    // Other settings leave the chosen question alone.
    changed = stateWhere(state => state.displayQr === 'hidden');
    mod.emit('setDisplaySettings', slug, { qr: 'hidden' }, adminToken);
    assert.equal((await changed).displayQuestionId, second);

    // Only a published question of this discussion can be chosen.
    for (const [questionId, pattern] of [
      [queued, /cannot be shown/i], [foreign, /cannot be shown/i], [999999999, /cannot be shown/i],
      ['7', /room display setting/i], [1.5, /room display setting/i], [0, /room display setting/i],
    ]) {
      const refused = refusal(pattern);
      mod.emit('setDisplaySettings', slug, { questionId }, adminToken);
      await refused;
    }
    const outsider = await connectSocket();
    try {
      const refused = waitForEvent(outsider, 'error', error => /not authorized/i.test(error.message));
      outsider.emit('setDisplaySettings', slug, { questionId: first }, 'not-the-token');
      await refused;
    } finally {
      outsider.disconnect();
    }
    assert.equal((await pool.query('SELECT display_question_id FROM discussions WHERE slug = $1', [slug])).rows[0].display_question_id, second);

    // A new question from the room does not take over the screen.
    await add(mod, slug, undefined, { text: 'A participant statement' });
    assert.equal((await pool.query('SELECT display_question_id FROM discussions WHERE slug = $1', [slug])).rows[0].display_question_id, second);

    // Clearing the choice keeps the layout.
    changed = stateWhere(state => state.displayQuestionId === null);
    mod.emit('setDisplaySettings', slug, { questionId: null }, adminToken);
    assert.equal((await changed).displayLayout, 'focus');

    // Deleting the chosen question clears the choice for everyone watching.
    changed = stateWhere(state => state.displayQuestionId === first);
    mod.emit('setDisplaySettings', slug, { questionId: first }, adminToken);
    await changed;
    changed = stateWhere(state => state.displayQuestionId === null);
    mod.emit('deleteQuestion', slug, first, adminToken);
    await changed;
    assert.equal((await pool.query('SELECT display_question_id FROM discussions WHERE slug = $1', [slug])).rows[0].display_question_id, null);
  } finally {
    mod.disconnect();
    display.disconnect();
  }
});

test('showing a question\'s results for the first time saves a "before" snapshot by itself', async () => {
  const seed = await seedResultsDiscussion('auto-snapshot');
  const { slug, adminToken } = seed;
  const url = `/api/discussions/${slug}/snapshots`;
  const mod = await joinAsModerator(slug, adminToken);
  const { socket: voter } = await joinAs(slug, 'seed-c');
  const { socket: display } = await joinDisplay(slug);
  const snapshots = async (headers = asModerator(adminToken)) => (await jsonRequest('GET', url, undefined, headers)).body.snapshots;
  // Show or hide a question's results and wait until the room has been told.
  const setRevealed = async (questionId, revealed) => {
    const told = waitForQuestions(mod, qs => byId(qs, questionId)?.resultsRevealed === revealed, `results ${revealed ? 'shown' : 'hidden'}`);
    mod.emit('setResultsRevealed', slug, questionId, revealed, adminToken);
    await told;
  };
  try {
    assert.deepEqual(await snapshots(), []);

    // Everyone watching is told, so an open snapshot panel and the room display reload.
    const voterTold = waitForEvent(voter, 'snapshotsChanged');
    const displayTold = waitForEvent(display, 'snapshotsChanged');
    await setRevealed(seed.agreement, true);
    await Promise.all([voterTold, displayTold]);
    const [first, ...rest] = await snapshots();
    assert.deepEqual(rest, []);
    assert.equal(first.name, 'Before results shown: We should proceed');
    // Like any snapshot, it covers every tallied question, as the room stood.
    assert.deepEqual(first.data.questions.map(q => [q.id, q.responseCount]), [[seed.agreement, 2], [seed.yesNo, 2], [seed.numerical, 2]]);
    assert.doesNotMatch(JSON.stringify(first), /seed-a|seed-b|Seed A|Seed B|auto_question_id|autoQuestionId/);
    // The revealed question's saved results are open to everyone, like its live ones.
    const forDisplay = (await snapshots({}))[0].data.questions;
    assert.equal(byId(forDisplay, seed.agreement).responseCount, 2);
    assert.equal(byId(forDisplay, seed.yesNo).resultsHidden, true);

    // Answers change once people have seen the results. Hiding and showing the
    // same question again keeps the one snapshot from before.
    assert.deepEqual(await emitWithAck(voter, 'vote', slug, seed.agreement, 'Strongly Agree', 'seed-c', 'Seed C', undefined), { ok: true });
    await setRevealed(seed.agreement, false);
    await setRevealed(seed.agreement, true);
    assert.deepEqual(await snapshots(), [first]);

    // Nothing is saved for a question nobody has answered yet...
    const added = waitForQuestions(mod, qs => qs.some(q => q.text === 'Nobody answered this'), 'unanswered question added');
    mod.emit('addQuestion', slug, { text: 'Nobody answered this', type: 'Yes/No', options: [] }, true, adminToken);
    const unanswered = (await added).find(q => q.text === 'Nobody answered this').id;
    await setRevealed(unanswered, true);
    assert.deepEqual(await snapshots(), [first]);
    // ...but once it has answers, its first showing after that does save one.
    await setRevealed(unanswered, false);
    assert.deepEqual(await emitWithAck(voter, 'vote', slug, unanswered, 'Yes', 'seed-c', 'Seed C', undefined), { ok: true });
    await setRevealed(unanswered, true);
    const afterUnanswered = await snapshots();
    assert.deepEqual(afterUnanswered.map(snapshot => snapshot.name), [first.name, 'Before results shown: Nobody answered this']);
    // It records the earlier question as it is now, after people updated.
    assert.equal(byId(afterUnanswered[1].data.questions, seed.agreement).responseCount, 3);

    // Someone without a moderator token changes nothing.
    const refused = waitForEvent(voter, 'error', error => /not authorized/i.test(error.message));
    voter.emit('setResultsRevealed', slug, seed.yesNo, true, 'not-the-token');
    await refused;
    assert.equal((await snapshots()).length, 2);

    // While results are always shown there is no "before" to keep.
    const always = waitForEvent(mod, 'discussionState', state => state.resultsVisibility === 'always');
    mod.emit('setResultsVisibility', slug, 'always', adminToken);
    await always;
    await setRevealed(seed.yesNo, true);
    assert.equal((await snapshots()).length, 2);
    await setRevealed(seed.yesNo, false);
    const afterVote = waitForEvent(mod, 'discussionState', state => state.resultsVisibility === 'after_vote');
    mod.emit('setResultsVisibility', slug, 'after_vote', adminToken);
    await afterVote;
    await setRevealed(seed.yesNo, true);
    assert.equal((await snapshots()).length, 3);

    // Written questions have no tally, so showing "results" for one saves nothing.
    mod.emit('setResultsRevealed', slug, seed.written, true, adminToken);
    // A long question is cut to fit the 120-character snapshot name.
    const longText = `How likely is it that ${'the room changes its mind '.repeat(8)}after talking?`;
    const longAdded = waitForQuestions(mod, qs => qs.some(q => q.text === longText.trim()), 'long question added');
    mod.emit('addQuestion', slug, { text: longText, type: 'Numerical', minValue: 0, maxValue: 100, options: [] }, true, adminToken);
    const longId = (await longAdded).find(q => q.text === longText.trim()).id;
    assert.deepEqual(await emitWithAck(voter, 'vote', slug, longId, 12.5, 'seed-c', 'Seed C', undefined), { ok: true });
    await setRevealed(longId, true);
    const all = await snapshots();
    assert.equal(all.length, 4);
    assert.equal(all[3].name.length, 120);
    assert.match(all[3].name, /^Before results shown: How likely is it that the room changes its mind .*…$/);
    assert.equal(byId(all[3].data.questions, longId).average, 12.5);

    // A snapshot a moderator saves by hand is announced the same way and is
    // unaffected by the one-per-question rule.
    const told = waitForEvent(voter, 'snapshotsChanged');
    const manual = await jsonRequest('POST', url, { name: 'After discussion', adminToken });
    assert.equal(manual.status, 201);
    await told;
    assert.deepEqual((await snapshots()).map(snapshot => snapshot.id), [...all.map(snapshot => snapshot.id), manual.body.id]);
  } finally {
    mod.disconnect();
    voter.disconnect();
    display.disconnect();
  }
});

test('a moderator puts a comparison of two opinion snapshots on the room display', async () => {
  const seed = await seedResultsDiscussion('display-compare');
  const other = await seedResultsDiscussion('display-compare-other');
  const { slug, adminToken } = seed;
  const mod = await joinAsModerator(slug, adminToken);
  const display = await connectSocket();
  const save = async (room, name) => (await jsonRequest('POST', `/api/discussions/${room.slug}/snapshots`, { name, adminToken: room.adminToken })).body.id;
  const stateWhere = predicate => waitForEvent(display, 'discussionState', predicate);
  const stored = async () => (await pool.query(
    'SELECT display_layout, display_question_id, display_before_snapshot_id, display_after_snapshot_id FROM discussions WHERE slug = $1', [slug]
  )).rows[0];
  try {
    const before = await save(seed, 'Before');
    const middle = await save(seed, 'Middle');
    const after = await save(seed, 'After');
    const foreign = await save(other, 'Another room');

    const initial = stateWhere(() => true);
    display.emit('joinDisplay', slug);
    const state = await initial;
    assert.equal(state.displayBeforeSnapshotId, null);
    assert.equal(state.displayAfterSnapshotId, null);

    // The layout alone: the display picks the first and the latest snapshot.
    let changed = stateWhere(s => s.displayLayout === 'compare');
    mod.emit('setDisplaySettings', slug, { layout: 'compare' }, adminToken);
    assert.equal((await changed).displayBeforeSnapshotId, null);

    // A chosen pair.
    changed = stateWhere(s => s.displayAfterSnapshotId === after);
    mod.emit('setDisplaySettings', slug, { beforeSnapshotId: middle, afterSnapshotId: after }, adminToken);
    assert.equal((await changed).displayBeforeSnapshotId, middle);
    // Each id changes on its own, and null goes back to the display's own pick.
    changed = stateWhere(s => s.displayBeforeSnapshotId === before);
    mod.emit('setDisplaySettings', slug, { beforeSnapshotId: before }, adminToken);
    assert.equal((await changed).displayAfterSnapshotId, after);
    changed = stateWhere(s => s.displayAfterSnapshotId === null);
    mod.emit('setDisplaySettings', slug, { afterSnapshotId: null }, adminToken);
    assert.equal((await changed).displayBeforeSnapshotId, before);

    // Choosing a question narrows the comparison to it and keeps the layout.
    changed = stateWhere(s => s.displayQuestionId === seed.numerical);
    mod.emit('setDisplaySettings', slug, { questionId: seed.numerical }, adminToken);
    assert.equal((await changed).displayLayout, 'compare');

    // Only this discussion's snapshots, in order, can be chosen.
    for (const [settings, pattern] of [
      [{ beforeSnapshotId: foreign }, /snapshot cannot be shown/i],
      [{ afterSnapshotId: 999999999 }, /snapshot cannot be shown/i],
      [{ beforeSnapshotId: after, afterSnapshotId: before }, /room display setting/i],
      [{ beforeSnapshotId: before, afterSnapshotId: before }, /room display setting/i],
      [{ beforeSnapshotId: String(before) }, /room display setting/i],
      [{ layout: 'sideways' }, /room display setting/i],
    ]) {
      const refused = waitForEvent(mod, 'error', error => pattern.test(error.message));
      mod.emit('setDisplaySettings', slug, settings, adminToken);
      await refused;
    }
    assert.deepEqual(await stored(), {
      display_layout: 'compare', display_question_id: seed.numerical,
      display_before_snapshot_id: before, display_after_snapshot_id: null,
    });

    // The display reads the snapshots as someone who has answered nothing, so
    // it gets results only for questions the moderator has shown to everyone.
    const hidden = (await jsonRequest('GET', `/api/discussions/${slug}/snapshots`)).body.snapshots;
    assert.deepEqual(hidden.map(snapshot => snapshot.id), [before, middle, after]);
    assert.ok(hidden[0].data.questions.every(question => question.resultsHidden === true));
    const revealed = waitForQuestions(mod, qs => byId(qs, seed.numerical)?.resultsRevealed === true, 'numerical results shown');
    mod.emit('setResultsRevealed', slug, seed.numerical, true, adminToken);
    await revealed;
    const shown = (await jsonRequest('GET', `/api/discussions/${slug}/snapshots`)).body.snapshots;
    assert.equal(byId(shown[0].data.questions, seed.numerical).average, 40);
    assert.equal(byId(shown[0].data.questions, seed.agreement).resultsHidden, true);
  } finally {
    mod.disconnect();
    display.disconnect();
  }
});

test('automatic baseline includes an in-flight vote committed while reveal waits for the question lock', async () => {
  const { id, slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('synthetic-reveal-mvcc') })).body;
  const questionId = (await pool.query(
    "INSERT INTO questions(discussion_id,text,type,min_value,max_value) VALUES ($1,'Fictional scale','Numerical',0,5) RETURNING id", [id]
  )).rows[0].id;
  await pool.query("INSERT INTO votes(question_id,value,user_id) VALUES ($1,'0','fictional-first')", [questionId]);
  const moderator = await connectSocket();
  const voter = await pool.connect();
  let committed = false;
  try {
    const joined = waitForQuestions(moderator, questions => questions.some(q => q.id === questionId), 'synthetic question joined');
    moderator.emit('joinDiscussion', slug); await joined;
    await voter.query('BEGIN');
    await voter.query('SELECT id FROM questions WHERE id=$1 FOR SHARE', [questionId]);
    await voter.query("INSERT INTO votes(question_id,value,user_id) VALUES ($1,'5','fictional-in-flight')", [questionId]);
    const announced = waitForEvent(moderator, 'snapshotsChanged');
    const shown = waitForQuestions(moderator, questions => questions.some(q => q.id === questionId && q.votes.length === 2), 'both committed votes shown');
    moderator.emit('setResultsRevealed', slug, questionId, true, adminToken);
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM questions%FOR UPDATE'");
      if (result.rows.length) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'reveal is observably blocked by the in-flight vote');
    await voter.query('COMMIT'); committed = true;
    await Promise.all([announced, shown]);
    const snapshots = (await jsonRequest('GET', `/api/discussions/${slug}/snapshots`, undefined, asModerator(adminToken))).body.snapshots;
    const baseline = snapshots[0].data.questions.find(q => q.id === questionId);
    assert.equal(baseline.responseCount, 2);
    assert.equal(baseline.average, 2.5);
  } finally {
    if (!committed) await voter.query('ROLLBACK');
    voter.release(); moderator.disconnect();
  }
});

test('a real failed reveal rolls back its baseline before a successful retry captures changed answers', async () => {
  const { id, slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('synthetic-reveal-rollback') })).body;
  const questionId = (await pool.query(
    "INSERT INTO questions(discussion_id,text,type,min_value,max_value) VALUES ($1,'Fictional rollback scale','Numerical',0,5) RETURNING id", [id]
  )).rows[0].id;
  await pool.query("INSERT INTO votes(question_id,value,user_id) VALUES ($1,'1','fictional-voter')", [questionId]);
  await pool.query(`CREATE FUNCTION synthetic_reveal_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic reveal failure'; END $$`);
  await pool.query('CREATE TRIGGER synthetic_reveal_failure BEFORE UPDATE OF results_revealed ON questions FOR EACH ROW EXECUTE FUNCTION synthetic_reveal_failure()');
  const moderator = await connectSocket();
  try {
    const joined = waitForQuestions(moderator, questions => questions.some(q => q.id === questionId), 'rollback question joined');
    moderator.emit('joinDiscussion', slug); await joined;
    const failed = waitForEvent(moderator, 'error', error => /Failed to update question/.test(error.message));
    moderator.emit('setResultsRevealed', slug, questionId, true, adminToken); await failed;
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM opinion_snapshots WHERE discussion_id=$1', [id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT results_revealed FROM questions WHERE id=$1', [questionId])).rows[0].results_revealed, false);
    await pool.query('DROP TRIGGER synthetic_reveal_failure ON questions');
    await pool.query("UPDATE votes SET value='4' WHERE question_id=$1", [questionId]);
    const saved = waitForEvent(moderator, 'snapshotsChanged');
    moderator.emit('setResultsRevealed', slug, questionId, true, adminToken); await saved;
    const snapshots = (await jsonRequest('GET', `/api/discussions/${slug}/snapshots`, undefined, asModerator(adminToken))).body.snapshots;
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].data.questions.find(q => q.id === questionId).average, 4);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS synthetic_reveal_failure ON questions');
    await pool.query('DROP FUNCTION IF EXISTS synthetic_reveal_failure()');
    moderator.disconnect();
  }
});
