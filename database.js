const fs = require('node:fs');
const path = require('node:path');
const { logError } = require('./logging');
const { slugifyTopic, formatTopicTitle, suffixSlug } = require('./discussion-names');

// Initialize fresh or existing databases before the server accepts connections.
// Migration order and the independent parallel group match the original startup.
async function initializeDatabase(pool) {
  // Ensure the database schema exists before serving requests. schema.sql is
  // idempotent (CREATE TABLE IF NOT EXISTS), so this is a no-op on a database
  // that's already populated (e.g. restored from latest.dump) and creates the
  // tables on a fresh, empty database.
  async function initSchema() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
  }

  // Add the pseudonym column to votes if it doesn't already exist. Idempotent so
  // it's safe to run on every boot. Must complete before the server starts
  // serving questions, since getQuestions() selects v.pseudonym.
  async function migrateAddPseudonymColumn() {
    await pool.query('ALTER TABLE votes ADD COLUMN IF NOT EXISTS pseudonym TEXT');
    console.log('Pseudonym column migration completed');
  }

  // Older deployments could create duplicate discussions because several paths
  // performed SELECT-then-INSERT without a uniqueness guarantee. Collapse those
  // duplicates before adding the unique constraint.
  async function migrateUniqueDiscussionTopics() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        WITH duplicate_topics AS (
          SELECT
            topic,
            MIN(id) AS keep_id,
            MIN(admin_token) AS admin_token,
            BOOL_OR(locked) AS locked
          FROM discussions
          GROUP BY topic
          HAVING COUNT(*) > 1
        ),
        merged_discussions AS (
          UPDATE discussions d
          SET
            admin_token = COALESCE(d.admin_token, duplicate_topics.admin_token),
            locked = d.locked OR duplicate_topics.locked
          FROM duplicate_topics
          WHERE d.id = duplicate_topics.keep_id
          RETURNING d.id
        ),
        moved_questions AS (
          UPDATE questions q
          SET discussion_id = duplicate_topics.keep_id
          FROM duplicate_topics
          JOIN discussions d
            ON d.topic = duplicate_topics.topic
           AND d.id <> duplicate_topics.keep_id
          WHERE q.discussion_id = d.id
          RETURNING q.id
        )
        DELETE FROM discussions d
        USING duplicate_topics
        WHERE d.topic = duplicate_topics.topic
          AND d.id <> duplicate_topics.keep_id
      `);
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            WHERE c.conrelid = 'discussions'::regclass
              AND c.contype = 'u'
              AND c.conkey = ARRAY(
                SELECT a.attnum
                FROM pg_attribute a
                WHERE a.attrelid = 'discussions'::regclass
                  AND a.attname = 'topic'
              )::smallint[]
          ) THEN
            CREATE UNIQUE INDEX IF NOT EXISTS discussions_topic_unique_idx
              ON discussions(topic);
            ALTER TABLE discussions
              ADD CONSTRAINT discussions_topic_unique
              UNIQUE USING INDEX discussions_topic_unique_idx;
          END IF;
        END $$;
      `);
      await client.query('COMMIT');
      console.log('Discussion topic uniqueness migration completed');
    } catch (e) {
      await client.query('ROLLBACK');
      logError('Error migrating discussion topic uniqueness:', e);
      throw e;
    } finally {
      client.release();
    }
  }

  async function migrateDiscussionSlugs() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS slug TEXT');

      const result = await client.query('SELECT id, topic, slug FROM discussions ORDER BY id');
      const rows = result.rows
        .map(row => ({
          ...row,
          baseSlug: getMigrationBaseSlug(row),
          priority: isSlugShapedLegacyTitle(row.topic) ? 0 : 1,
        }))
        .sort((a, b) => a.priority - b.priority || a.id - b.id);
      const usedSlugs = new Set();
      const assignments = [];

      for (const row of rows) {
        let slug = row.baseSlug;
        let suffix = 2;
        while (usedSlugs.has(slug)) {
          slug = suffixSlug(row.baseSlug, suffix);
          suffix += 1;
        }

        usedSlugs.add(slug);
        assignments.push({ id: row.id, currentSlug: row.slug, slug });
      }

      const changedAssignments = assignments.filter(row => row.currentSlug !== row.slug);
      const tempPrefix = `__convora_slug_migration_${process.pid}_`;
      for (const row of changedAssignments) {
        await client.query('UPDATE discussions SET slug = $1 WHERE id = $2', [`${tempPrefix}${row.id}`, row.id]);
      }

      for (const row of changedAssignments) {
        await client.query('UPDATE discussions SET slug = $1 WHERE id = $2', [row.slug, row.id]);
      }

      await client.query(`
        UPDATE discussions
        SET slug = id::text
        WHERE slug IS NULL OR slug = ''
      `);
      await client.query('ALTER TABLE discussions ALTER COLUMN slug SET NOT NULL');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS discussions_slug_unique_idx ON discussions(slug)');
      await client.query('COMMIT');
      console.log('Discussion slug migration completed');
    } catch (e) {
      await client.query('ROLLBACK');
      logError('Error migrating discussion slugs:', e);
      throw e;
    } finally {
      client.release();
    }
  }

  async function migrateDiscussionShortCodes() {
    await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS short_code TEXT');
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS discussions_short_code_unique_idx ON discussions(short_code) WHERE short_code IS NOT NULL');
    console.log('Discussion short-code migration completed');
  }

  function isSlugShapedLegacyTitle(topic) {
    const title = formatTopicTitle(topic);
    return title === slugifyTopic(title);
  }

  function getMigrationBaseSlug(row) {
    if (isSlugShapedLegacyTitle(row.topic)) {
      return slugifyTopic(row.topic);
    }
    return row.slug ? slugifyTopic(row.slug) : slugifyTopic(row.topic);
  }

  // Table for upvotes on individual open-ended responses. One row per
  // (response, user); a response is identified by its votes.id. Idempotent.
  async function migrateResponseVotesTable() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS response_votes (
          id SERIAL PRIMARY KEY,
          response_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          UNIQUE (response_id, user_id)
        )
      `);
      console.log('response_votes table migration completed');
    } catch (e) {
      logError('Error creating response_votes table:', e);
      throw e;
    }
  }

  // Interaction features layered on individual Brainstorm ideas: two-axis ratings
  // (a quality up/down vote and an agreement selection), curated epistemic
  // reactions, and threaded comments. Plus discussion-wide moderator flags:
  // whether reactions/comments are available, and — for reactions — whether
  // they're currently revealed (so a moderator can collect ideas first, then open
  // reactions for an evaluation phase). The flags live on the discussion so a
  // moderator opens them for every brainstorm prompt at once. All idempotent.
  async function migrateBrainstormInteractions() {
    // Detect whether the discussion-level flags already exist BEFORE creating
    // them. This distinguishes a first migration (where we must backfill from the
    // legacy per-question flags) from an already-migrated DB (where the
    // discussion columns are the live source of truth and must not be touched).
    const { rows: existing } = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'discussions' AND column_name = 'reactions_enabled'
    `);
    const discussionFlagsExist = existing.length > 0;

    await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS reactions_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS reactions_visible BOOLEAN NOT NULL DEFAULT TRUE');
    await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT FALSE');

    // Legacy per-question flag columns from when these toggles were per-question
    // (added 2026-06-05, PR #39). Kept idempotently so older databases and a
    // rollback still work, but no longer read or written — the discussion-level
    // columns above are now the source of truth. The ADD COLUMN IF NOT EXISTS
    // also guarantees the backfill query below is valid even on a fresh DB.
    await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS reactions_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS reactions_visible BOOLEAN NOT NULL DEFAULT TRUE');
    await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT FALSE');

    // One-time backfill: only on the FIRST migration that creates the discussion
    // columns. Databases upgrading from PR #39 already carry per-question flags;
    // without this, every existing discussion would default to
    // reactions_enabled=false / comments_enabled=false and any live brainstorm
    // that had interactions open would silently go dark until a moderator
    // reopened them. BOOL_OR rolls each discussion's questions up to "on if any
    // question had it on." This is guarded by the existence check so it runs
    // exactly once — re-running on every boot would clobber later moderator
    // changes by resurrecting stale per-question values. On a fresh DB it's a
    // harmless no-op since all values are at their defaults.
    //
    // enabled/comments roll up with BOOL_OR ("on if any question had it on").
    // Visibility CANNOT roll up the same way: reactions_visible defaults TRUE on
    // every question (including non-brainstorm and reactions-disabled ones), so a
    // BOOL_OR would almost always yield TRUE and would force-reveal a brainstorm
    // that was silently collecting reactions (enabled + hidden) just because some
    // unrelated default-visible question exists. Revealing hidden data is the
    // worse failure, so visibility errs toward hidden: consider only questions
    // that actually had reactions enabled, and keep the discussion hidden if ANY
    // such question was hidden (filtered BOOL_AND, defaulting to visible when no
    // question had reactions enabled).
    if (!discussionFlagsExist) {
      await pool.query(`
        UPDATE discussions d SET
          reactions_enabled = sub.re,
          reactions_visible = sub.rv,
          comments_enabled  = sub.ce
        FROM (
          SELECT discussion_id,
                 BOOL_OR(reactions_enabled) AS re,
                 COALESCE(BOOL_AND(reactions_visible) FILTER (WHERE reactions_enabled), true) AS rv,
                 BOOL_OR(comments_enabled)  AS ce
          FROM questions
          GROUP BY discussion_id
        ) sub
        WHERE d.id = sub.discussion_id
      `);
    }

    // Which epistemic reactions are active for this discussion (a subset of
    // REACTION_CATALOG). NULL means "the creator hasn't customized it" → defaults.
    await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS reaction_keys JSONB');

    // One row per (response, user): that user's quality vote (-1/+1) and/or
    // agreement selection. Either axis may be null when only the other is set.
    // Always aggregated before broadcast, so individual votes stay unattributable.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS response_ratings (
        id SERIAL PRIMARY KEY,
        response_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        quality SMALLINT,
        agreement TEXT,
        UNIQUE (response_id, user_id)
      )
    `);

    // One row per (response, user, reaction); reaction is a curated epistemic tag.
    // Aggregated to counts before broadcast — also unattributable.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS response_reactions (
        id SERIAL PRIMARY KEY,
        response_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        reaction TEXT NOT NULL,
        UNIQUE (response_id, user_id, reaction)
      )
    `);

    // Carry existing reactions across the locally-valid → follows rename, and drop
    // the removed locally-invalid rows, so reactions placed before this change
    // don't strand under keys the catalog no longer renders. Idempotent.
    await pool.query("UPDATE response_reactions SET reaction = 'follows' WHERE reaction = 'locally-valid'");
    await pool.query("DELETE FROM response_reactions WHERE reaction = 'locally-invalid'");

    // Comments on a brainstorm idea. Unlike ratings/reactions these carry their
    // author's pseudonym, since they're conversation rather than an anonymous vote.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS response_comments (
        id SERIAL PRIMARY KEY,
        response_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        pseudonym TEXT,
        body TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);
    console.log('Brainstorm interactions migration completed');
  }

  // Moderation columns: a per-discussion admin token, a discussion lock, a
  // moderator-only-questions flag, and a per-question pin flag. Plus the pg_trgm
  // extension for near-duplicate statement detection. All idempotent.
  async function migrateModerationAndDedup() {
    await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS admin_token TEXT');
    await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE');
    // When true, only moderators may add questions; everyone can still vote. Lets a
    // moderator set the agenda ("here are the questions") and open it to the floor
    // at will, independent of the all-or-nothing `locked` flag.
    await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS moderator_only_questions BOOLEAN NOT NULL DEFAULT FALSE');
    // Per-discussion color theme the moderator picks; 'indigo' is the original look.
    await pool.query("ALTER TABLE discussions ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'indigo'");
    await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE');
    // When participants see the results of tallied questions: 'after_vote' (only
    // once they have answered, the default for existing discussions too) or
    // 'always'. See RESULTS_VISIBILITY_MODES in server.js.
    await pool.query("ALTER TABLE discussions ADD COLUMN IF NOT EXISTS results_visibility TEXT NOT NULL DEFAULT 'after_vote'");

    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    } catch (e) {
      logError('pg_trgm extension migration failed; similarity checks will be skipped:', e);
    }
    console.log('Moderation + dedup migration completed');
  }

  // Per-user moderator grants: when a moderator promotes a participant, that user
  // gets their own token here (one row per user per discussion). verifyAdmin
  // accepts these tokens alongside the creator's admin_token. Idempotent.
  async function migrateModeratorsTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS discussion_moderators (
        id SERIAL PRIMARY KEY,
        discussion_id INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (discussion_id, user_id)
      )
    `);
    console.log('discussion_moderators table migration completed');
  }

  // Per-discussion display-name reservations. One row per (discussion, user); the
  // UNIQUE (discussion_id, pseudonym) constraint is what guarantees no two people
  // in the same discussion are ever handed the same auto-generated handle, so we
  // hand out a different adjective-animal combination on collision rather than a
  // "Tidy Newt 2" suffix. Names are only unique WITHIN a discussion — the same
  // browser can be a different handle in another discussion. Idempotent.
  async function migrateDiscussionPseudonymsTable() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS discussion_pseudonyms (
        discussion_id INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        pseudonym TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (discussion_id, user_id),
        UNIQUE (discussion_id, pseudonym)
      )
    `);
    console.log('discussion_pseudonyms table migration completed');
  }

  await initSchema();
  await migrateModerationAndDedup();
  await migrateUniqueDiscussionTopics();
  await migrateDiscussionSlugs();
  await migrateDiscussionShortCodes();
  await Promise.all([migrateAddPseudonymColumn(), migrateResponseVotesTable(), migrateModeratorsTable()]);
  await migrateDiscussionPseudonymsTable();
  await migrateBrainstormInteractions();
}

module.exports = { initializeDatabase };
