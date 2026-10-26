-- Convora database schema.
--
-- Applied automatically on server startup (see initSchema in server.js), so a
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
