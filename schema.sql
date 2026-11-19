-- Convora database schema.
--
-- Applied automatically on server startup (see initializeDatabase in database.js), so a
-- fresh/empty Postgres database is ready to use without any manual restore.
-- Every statement is idempotent (IF NOT EXISTS), so it is safe to run on an
-- already-populated database (e.g. one restored from latest.dump) too.

CREATE TABLE IF NOT EXISTS discussions (
  id         SERIAL PRIMARY KEY,
  topic      TEXT NOT NULL,
  slug       TEXT,
  short_code TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Reserve deleted routes so an old client cannot recreate a removed room.
CREATE TABLE IF NOT EXISTS deleted_discussion_slugs (
  slug TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS deleted_discussion_aliases (
  topic TEXT PRIMARY KEY
);

-- discussions.topic is made unique by migrateUniqueDiscussionTopics() after
-- any duplicate rows from older deployments have been collapsed.
-- discussions.slug is populated and made unique by migrateDiscussionSlugs().

CREATE TABLE IF NOT EXISTS questions (
  id            SERIAL PRIMARY KEY,
  discussion_id INTEGER REFERENCES discussions(id),
  text          TEXT NOT NULL,
  type          TEXT NOT NULL,
  min_value     INTEGER,
  max_value     INTEGER,
  options       JSONB,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS votes (
  id          SERIAL PRIMARY KEY,
  question_id INTEGER REFERENCES questions(id),
  value       TEXT NOT NULL,
  user_id     TEXT,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Restrict duplicate-idea checks to one question, including on existing databases.
CREATE INDEX IF NOT EXISTS votes_question_id_idx ON votes(question_id);

-- One row per participant who marked a question as interesting. The count
-- ranks questions under the "Most Interesting" sort.
CREATE TABLE IF NOT EXISTS question_interest (
  id          SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  UNIQUE (question_id, user_id)
);

-- Immutable aggregates: snapshots survive later vote updates and question edits
-- or deletions without retaining participant identities or individual answers.
CREATE TABLE IF NOT EXISTS opinion_snapshots (
  id            SERIAL PRIMARY KEY,
  discussion_id INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  data          JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS opinion_snapshots_discussion_idx
  ON opinion_snapshots (discussion_id, id);

-- Google's immutable subject identifies the creator across devices.
ALTER TABLE discussions ADD COLUMN IF NOT EXISTS creator_google_sub TEXT;
CREATE INDEX IF NOT EXISTS discussions_creator_google_sub_idx
  ON discussions (creator_google_sub) WHERE creator_google_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS moderator_sessions (
  digest TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  email TEXT,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS moderator_sessions_expiry_idx ON moderator_sessions (expires_at);
