const fs = require('node:fs');
const path = require('node:path');
const { logError } = require('../logging');
const { slugifyTopic, slugFromTitle, formatTopicTitle, suffixSlug } = require('../discussion-names');

async function initSchema(client) {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await client.query(schema);
}

async function migrateAddPseudonymColumn(client) {
  await client.query('ALTER TABLE votes ADD COLUMN IF NOT EXISTS pseudonym TEXT');
}

// Older deployments could create duplicate discussions because several paths
// performed SELECT-then-INSERT without a uniqueness guarantee. Collapse those
// duplicates before adding the unique constraint.
async function migrateUniqueDiscussionTopics(client) {
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
}

async function migrateDiscussionSlugs(client) {
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
}

async function migrateDiscussionShortCodes(client) {
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS short_code TEXT');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS discussions_short_code_unique_idx ON discussions(short_code) WHERE short_code IS NOT NULL');
}

function isSlugShapedLegacyTitle(topic) {
  const title = formatTopicTitle(topic);
  return title === slugFromTitle(title);
}

function getMigrationBaseSlug(row) {
  if (isSlugShapedLegacyTitle(row.topic)) {
    return slugifyTopic(row.topic);
  }
  return row.slug ? slugifyTopic(row.slug) : slugFromTitle(row.topic);
}

// Table for upvotes on individual open-ended responses. One row per
// (response, user); a response is identified by its votes.id. Idempotent.
async function migrateResponseVotesTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS response_votes (
      id SERIAL PRIMARY KEY,
      response_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      UNIQUE (response_id, user_id)
    )
  `);
}

// Interaction features layered on individual Brainstorm ideas: two-axis ratings
// (a quality up/down vote and an agreement selection), curated epistemic
// reactions, and threaded comments. Plus discussion-wide moderator flags:
// whether reactions/comments are available, and — for reactions — whether
// they're currently revealed (so a moderator can collect ideas first, then open
// reactions for an evaluation phase). The flags live on the discussion so a
// moderator opens them for every brainstorm prompt at once. All idempotent.
async function migrateBrainstormInteractions(client) {
  // Detect whether the discussion-level flags already exist BEFORE creating
  // them. This distinguishes a first migration (where we must backfill from the
  // legacy per-question flags) from an already-migrated DB (where the
  // discussion columns are the live source of truth and must not be touched).
  const { rows: existing } = await client.query(`
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'discussions'::regclass AND attname = 'reactions_enabled' AND NOT attisdropped
  `);
  const discussionFlagsExist = existing.length > 0;

  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS reactions_enabled BOOLEAN NOT NULL DEFAULT FALSE');
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS reactions_visible BOOLEAN NOT NULL DEFAULT TRUE');
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT FALSE');

  // Legacy per-question flag columns from when these toggles were per-question
  // (added 2026-06-05, PR #39). Kept idempotently so older databases and a
  // rollback still work, but no longer read or written — the discussion-level
  // columns above are now the source of truth. The ADD COLUMN IF NOT EXISTS
  // also guarantees the backfill query below is valid even on a fresh DB.
  await client.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS reactions_enabled BOOLEAN NOT NULL DEFAULT FALSE');
  await client.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS reactions_visible BOOLEAN NOT NULL DEFAULT TRUE');
  await client.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT FALSE');

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
    await client.query(`
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
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS reaction_keys JSONB');

  // One row per (response, user): that user's quality vote (-1/+1) and/or
  // agreement selection. Either axis may be null when only the other is set.
  // Always aggregated before broadcast, so individual votes stay unattributable.
  await client.query(`
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
  await client.query(`
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
  await client.query("UPDATE response_reactions SET reaction = 'follows' WHERE reaction = 'locally-valid'");
  await client.query("DELETE FROM response_reactions WHERE reaction = 'locally-invalid'");

  // Comments on a brainstorm idea. Unlike ratings/reactions these carry their
  // author's pseudonym, since they're conversation rather than an anonymous vote.
  await client.query(`
    CREATE TABLE IF NOT EXISTS response_comments (
      id SERIAL PRIMARY KEY,
      response_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      pseudonym TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )
  `);
}

// Moderation columns: a per-discussion admin token, a discussion lock, a
// moderator-only-questions flag, and a per-question pin flag. Plus the pg_trgm
// extension for near-duplicate statement detection. All idempotent.
async function migrateModerationAndDedup(client) {
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS admin_token TEXT');
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE');
  // When true, only moderators may add questions; everyone can still vote. Lets a
  // moderator set the agenda ("here are the questions") and open it to the floor
  // at will, independent of the all-or-nothing `locked` flag.
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS moderator_only_questions BOOLEAN NOT NULL DEFAULT FALSE');
  // Per-discussion color theme the moderator picks; 'indigo' is the original look.
  await client.query("ALTER TABLE discussions ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'indigo'");
  await client.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE');
  // A moderator has shown this question's results to everyone, voted or not
  // (see setResultsRevealed in server.js). Off until a moderator turns it on.
  await client.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS results_revealed BOOLEAN NOT NULL DEFAULT FALSE');
  // When participants see the results of tallied questions: 'after_vote' (only
  // once they have answered, the default for existing discussions too) or
  // 'always'. See RESULTS_VISIBILITY_MODES in server.js.
  await client.query("ALTER TABLE discussions ADD COLUMN IF NOT EXISTS results_visibility TEXT NOT NULL DEFAULT 'after_vote'");
  // Whether the discussion is listed publicly on the home page. Discussions are
  // unlisted unless their moderator chooses otherwise, existing ones included.
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS listed BOOLEAN NOT NULL DEFAULT FALSE');
  // How the room display presents itself: the join QR code large in a sidebar,
  // small in a corner, or hidden ('full', 'corner', 'hidden'), and whether it
  // shows every question, one at a time, or two opinion snapshots side by side
  // ('all', 'focus', 'compare'). See
  // DISPLAY_QR_MODES and DISPLAY_LAYOUTS in server.js.
  await client.query("ALTER TABLE discussions ADD COLUMN IF NOT EXISTS display_qr TEXT NOT NULL DEFAULT 'full'");
  await client.query("ALTER TABLE discussions ADD COLUMN IF NOT EXISTS display_layout TEXT NOT NULL DEFAULT 'all'");
  await client.query("ALTER TABLE discussions ADD COLUMN IF NOT EXISTS display_sort TEXT NOT NULL DEFAULT 'oldest'");
  await client.query("ALTER TABLE discussions ADD COLUMN IF NOT EXISTS display_pinned_first BOOLEAN NOT NULL DEFAULT TRUE");
  // The question a moderator chose to show on the room display in its
  // one-question view (see setDisplaySettings in server.js). Not a foreign
  // key: the id is checked against the discussion's questions when it is read,
  // so deleting a question needs no lock on its discussion.
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS display_question_id INTEGER');
  await client.query("ALTER TABLE discussions ADD COLUMN IF NOT EXISTS display_hidden_question_ids INTEGER[] NOT NULL DEFAULT '{}'");
  // Set on a snapshot the server saved by itself, just before this question's
  // results were first shown to everyone (see saveSnapshotBeforeReveal in
  // server.js). The unique index keeps that to one snapshot per question.
  await client.query('ALTER TABLE opinion_snapshots ADD COLUMN IF NOT EXISTS auto_question_id INTEGER');
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS opinion_snapshots_auto_question_idx
       ON opinion_snapshots (auto_question_id) WHERE auto_question_id IS NOT NULL`
  );
  // The two opinion snapshots the room display compares in its before-and-after
  // view (display_layout 'compare'). Either may be null: the display then uses
  // the first snapshot and the latest one. Checked against the discussion's
  // snapshots when read, like display_question_id.
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS display_before_snapshot_id INTEGER');
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS display_after_snapshot_id INTEGER');
  // A queued question is one a moderator has written but not published yet.
  // Only moderators receive it, and nobody can answer it, until a moderator
  // publishes it (see publishQuestion in server.js).
  await client.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS queued BOOLEAN NOT NULL DEFAULT FALSE');

  await client.query('SAVEPOINT optional_pg_trgm');
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT optional_pg_trgm');
    logError('pg_trgm extension migration failed; similarity checks will be skipped:', e);
  }
  await client.query('RELEASE SAVEPOINT optional_pg_trgm');
}

// Per-user moderator grants: when a moderator promotes a participant, that user
// gets their own token here (one row per user per discussion). verifyAdmin
// accepts these tokens alongside the creator's admin_token. Idempotent.
async function migrateModeratorsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS discussion_moderators (
      id SERIAL PRIMARY KEY,
      discussion_id INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (discussion_id, user_id)
    )
  `);
}

// Per-discussion display-name reservations. One row per (discussion, user); the
// UNIQUE (discussion_id, pseudonym) constraint is what guarantees no two people
// in the same discussion are ever handed the same auto-generated handle, so we
// hand out a different adjective-animal combination on collision rather than a
// "Tidy Newt 2" suffix. Names are only unique WITHIN a discussion — the same
// browser can be a different handle in another discussion. Idempotent.
async function migrateDiscussionPseudonymsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS discussion_pseudonyms (
      discussion_id INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      pseudonym TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (discussion_id, user_id),
      UNIQUE (discussion_id, pseudonym)
    )
  `);
}

async function migrateUnifiedResponses(client) {
  const existing = await client.query("SELECT 1 FROM pg_attribute WHERE attrelid = 'questions'::regclass AND attname = 'max_responses' AND NOT attisdropped");
  if (!existing.rows.length) {
    await client.query('ALTER TABLE questions ADD COLUMN max_responses INTEGER CHECK (max_responses > 0), ADD COLUMN show_attribution BOOLEAN NOT NULL DEFAULT TRUE');
    await client.query("UPDATE questions SET max_responses = 1 WHERE type = 'Open Ended'");
    await client.query("UPDATE questions SET type = 'Open Ended', show_attribution = FALSE WHERE type = 'Brainstorm'");
    await client.query(`INSERT INTO response_ratings (response_id, user_id, quality)
      SELECT response_id, user_id, 1 FROM response_votes
      ON CONFLICT (response_id, user_id) DO UPDATE
      SET quality = COALESCE(response_ratings.quality, EXCLUDED.quality)`);
  }
  await client.query('ALTER TABLE votes ADD COLUMN IF NOT EXISTS request_id TEXT');
  await client.query('CREATE UNIQUE INDEX IF NOT EXISTS votes_request_id ON votes (question_id, user_id, request_id)');
}

async function migrateQuestionDownvotes(client) {
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS question_downvotes_enabled BOOLEAN NOT NULL DEFAULT FALSE');
  await client.query('ALTER TABLE question_interest ADD COLUMN IF NOT EXISTS downvote BOOLEAN NOT NULL DEFAULT FALSE');
}

async function migrateIndependentAnswers(client) {
  await client.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS independent_answers BOOLEAN NOT NULL DEFAULT FALSE');
}

async function migrateSpeakingQueue(client) {
  await client.query(`ALTER TABLE discussions ADD COLUMN IF NOT EXISTS hands_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS speaking_queue (
      id SERIAL PRIMARY KEY,
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      UNIQUE (question_id, user_id)
    )`);
}

async function migrateQuestionTools(client) {
  await client.query(`
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS tools text[] NOT NULL DEFAULT '{}';
    CREATE TABLE IF NOT EXISTS question_tool_notes (
      id serial PRIMARY KEY,
      question_id integer NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('clarification', 'explanation', 'suggestion')),
      body text NOT NULL,
      vote_id integer REFERENCES votes(id) ON DELETE CASCADE,
      CHECK ((kind = 'explanation') = (vote_id IS NOT NULL)),
      UNIQUE (question_id, user_id, kind)
    );
    CREATE INDEX IF NOT EXISTS question_tool_notes_vote ON question_tool_notes(vote_id) WHERE vote_id IS NOT NULL;
  `);
}

async function migrateQuestionApproval(client) {
  await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS question_approval_required BOOLEAN NOT NULL DEFAULT FALSE');
  await client.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS participant_suggested BOOLEAN NOT NULL DEFAULT FALSE');
}

module.exports = [
  [1, initSchema],
  [2, migrateModerationAndDedup],
  [3, migrateUniqueDiscussionTopics],
  [4, migrateDiscussionSlugs],
  [5, migrateDiscussionShortCodes],
  [6, migrateAddPseudonymColumn],
  [7, migrateResponseVotesTable],
  [8, migrateModeratorsTable],
  [9, migrateDiscussionPseudonymsTable],
  [10, migrateBrainstormInteractions],
  [11, migrateUnifiedResponses],
  [12, migrateQuestionDownvotes],
  [13, migrateQuestionApproval],
  [14, migrateQuestionTools],
  [15, migrateIndependentAnswers],
  [16, migrateSpeakingQueue],
];
