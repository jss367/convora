const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { Pool } = require('pg');
const { initializeDatabase } = require('../database');
const {
  useIntegrationServer,
  startServer,
  stopServer,
} = require('./helpers/integration.cjs');

const { pool, databaseUrl } = useIntegrationServer(__filename);

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
