require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const isProduction = process.env.NODE_ENV === 'production';
const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Enable CORS for your client URL
app.use(cors({
  origin: clientUrl,
  credentials: true,
}));

const io = socketIo(server, {
  cors: {
    origin: clientUrl,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://username:password@localhost:5432/convora',
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

function parseOptions(options) {
  if (Array.isArray(options)) {
    return options;
  }
  if (typeof options === 'string') {
    try {
      const parsed = JSON.parse(options);
      return Array.isArray(parsed) ? parsed : [options];
    } catch (e) {
      console.warn('Failed to parse options as JSON, falling back to comma-separated string:', options);
      return options.split(',').map(opt => opt.trim());
    }
  }
  if (options === null || options === undefined) {
    return [];
  }
  console.warn('Unexpected options type:', typeof options);
  return [String(options)];
}

const AGREEMENT_OPTIONS = [
  'Strongly Disagree',
  'Disagree',
  'Unsure',
  'Agree',
  'Strongly Agree',
];

function sanitizeFilename(value) {
  return String(value || 'discussion')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'discussion';
}

function escapeCsv(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const stringValue = Array.isArray(value) ? JSON.stringify(value) : String(value);
  const neutralizedValue = /^[=+\-@]/.test(stringValue) ? `'${stringValue}` : stringValue;
  return `"${neutralizedValue.replace(/"/g, '""')}"`;
}

function parseStoredVoteValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
}

function getQuestionRange(question) {
  const min = Number.parseInt(question.min_value, 10);
  const max = Number.parseInt(question.max_value, 10);
  return {
    minValue: Number.isNaN(min) ? 0 : min,
    maxValue: Number.isNaN(max) ? 100 : max,
  };
}

function extractResponseText(data) {
  if (typeof data.output_text === 'string') {
    return data.output_text;
  }

  const contentItems = (data.output || [])
    .flatMap(item => Array.isArray(item.content) ? item.content : []);
  const text = contentItems
    .map(item => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();

  return text || null;
}

function buildDeterministicSynthesis(writtenResponses) {
  if (writtenResponses.length === 0) {
    return null;
  }

  const byQuestion = writtenResponses.reduce((acc, response) => {
    if (!acc.has(response.questionText)) {
      acc.set(response.questionText, []);
    }
    acc.get(response.questionText).push(response.value);
    return acc;
  }, new Map());

  const longestResponses = [...writtenResponses]
    .sort((a, b) => b.value.length - a.value.length)
    .slice(0, 3)
    .map(response => ({
      question: response.questionText,
      excerpt: response.value.length > 180 ? `${response.value.slice(0, 177)}...` : response.value,
    }));

  return {
    mode: 'deterministic',
    text: `${writtenResponses.length} written ${writtenResponses.length === 1 ? 'response' : 'responses'} across ${byQuestion.size} ${byQuestion.size === 1 ? 'prompt' : 'prompts'}.`,
    highlights: [...byQuestion.entries()].map(([question, responses]) => ({
      question,
      responseCount: responses.length,
    })),
    excerpts: longestResponses,
  };
}

async function buildLlmSynthesis(writtenResponses) {
  if (
    writtenResponses.length === 0 ||
    process.env.ENABLE_LLM_SYNTHESIS !== 'true' ||
    !process.env.OPENAI_API_KEY
  ) {
    return null;
  }

  const payload = writtenResponses.slice(0, 80).map(response => ({
    question: response.questionText,
    response: response.value,
  }));

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content: 'Summarize open-ended discussion responses for a read-only post-discussion report. Be concise, neutral, and preserve unresolved tensions.',
        },
        {
          role: 'user',
          content: `Return JSON with keys synthesis, commonThemes, unresolvedQuestions, and notableDivergences. Responses: ${JSON.stringify(payload)}`,
        },
      ],
      text: {
        format: {
          type: 'json_object',
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM synthesis failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const outputText = extractResponseText(data);
  if (!outputText) {
    return null;
  }

  return {
    mode: 'llm',
    ...JSON.parse(outputText),
  };
}

function buildSummary(discussion, questions, synthesis) {
  const participantIds = new Set();
  const typeCounts = {};
  let totalResponses = 0;

  const questionSummaries = questions.map((question) => {
    const votes = question.votes || [];
    votes.forEach((vote) => {
      if (vote.userId) {
        participantIds.add(vote.userId);
      }
    });
    totalResponses += votes.length;
    typeCounts[question.type] = (typeCounts[question.type] || 0) + 1;

    const base = {
      id: question.id,
      text: question.text,
      type: question.type,
      createdAt: question.created_at,
      responseCount: votes.length,
    };

    if (question.type === 'Agreement') {
      const optionCounts = AGREEMENT_OPTIONS.reduce((acc, option) => {
        acc[option] = votes.filter(vote => vote.value === option).length;
        return acc;
      }, {});
      const agreeCount = optionCounts.Agree + optionCounts['Strongly Agree'];
      const disagreeCount = optionCounts.Disagree + optionCounts['Strongly Disagree'];
      const decidedCount = agreeCount + disagreeCount;
      const consensusScore = decidedCount > 0 ? Math.max(agreeCount, disagreeCount) / decidedCount : 0;
      const divisiveScore = decidedCount > 0 ? Math.min(agreeCount, disagreeCount) / decidedCount : 0;

      return {
        ...base,
        optionCounts,
        agreeCount,
        disagreeCount,
        unsureCount: optionCounts.Unsure,
        decidedCount,
        consensusScore,
        divisiveScore,
        label: decidedCount < 2 ? 'Not enough votes' : divisiveScore >= 0.4 ? 'Divisive' : consensusScore >= 0.85 ? 'Consensus' : 'Mixed',
        leadingPosition: agreeCount === disagreeCount ? 'Split' : agreeCount > disagreeCount ? 'Agree' : 'Disagree',
      };
    }

    if (question.type === 'Numerical') {
      const values = votes
        .map(vote => Number.parseFloat(vote.value))
        .filter(value => !Number.isNaN(value));
      const average = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const variance = values.length > 0
        ? values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length
        : null;
      const { minValue, maxValue } = getQuestionRange(question);

      return {
        ...base,
        minValue,
        maxValue,
        average,
        minResponse: values.length > 0 ? Math.min(...values) : null,
        maxResponse: values.length > 0 ? Math.max(...values) : null,
        standardDeviation: variance === null ? null : Math.sqrt(variance),
      };
    }

    return {
      ...base,
      responses: votes.map(vote => ({
        id: vote.id,
        pseudonym: vote.pseudonym || 'Anonymous',
        value: parseStoredVoteValue(vote.value),
        createdAt: vote.created_at,
      })),
    };
  });

  const agreementSummaries = questionSummaries.filter(summary => summary.type === 'Agreement' && summary.decidedCount >= 2);
  const topConsensus = [...agreementSummaries]
    .sort((a, b) => b.consensusScore - a.consensusScore || b.responseCount - a.responseCount)
    .slice(0, 5);
  const topDivisive = [...agreementSummaries]
    .sort((a, b) => b.divisiveScore - a.divisiveScore || b.responseCount - a.responseCount)
    .slice(0, 5);

  return {
    discussion: {
      id: discussion.id,
      topic: discussion.topic,
      createdAt: discussion.created_at,
    },
    counts: {
      questions: questions.length,
      responses: totalResponses,
      participants: participantIds.size,
      byType: typeCounts,
    },
    topConsensus,
    topDivisive,
    synthesis,
    questions: questionSummaries,
  };
}

async function getDiscussionByTopic(topic) {
  const result = await pool.query(
    'SELECT id, topic, created_at FROM discussions WHERE topic = $1 ORDER BY id DESC LIMIT 1',
    [topic]
  );
  return result.rows[0] || null;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// Emit the number of clients currently in a discussion room to everyone there.
function emitPresence(topic) {
  if (!topic) return;
  const count = io.sockets.adapter.rooms.get(topic)?.size || 0;
  io.to(topic).emit('presence', count);
}

// Read the lock state and whether a moderator has been claimed.
async function getDiscussionState(topic) {
  const result = await pool.query(
    'SELECT locked, admin_token IS NOT NULL AS has_moderator FROM discussions WHERE topic = $1',
    [topic]
  );
  if (result.rows.length === 0) return { locked: false, hasModerator: false };
  return { locked: result.rows[0].locked === true, hasModerator: result.rows[0].has_moderator === true };
}

async function emitDiscussionState(topic) {
  io.to(topic).emit('discussionState', await getDiscussionState(topic));
}

// WebSocket handlers
io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('joinDiscussion', async (topic) => {
    // If this socket was viewing another discussion, leave it so presence
    // counts stay accurate as the user navigates within the SPA.
    const previousTopic = socket.data.topic;
    if (previousTopic && previousTopic !== topic) {
      socket.leave(previousTopic);
      emitPresence(previousTopic);
    }

    socket.join(topic);
    socket.data.topic = topic;
    emitPresence(topic);

    try {
      const questions = await getQuestions(topic);
      socket.emit('questions', questions);
      socket.emit('discussionState', await getDiscussionState(topic));
    } catch (error) {
      console.error('Error getting questions:', error);
      socket.emit('error', { message: 'Failed to get questions' });
    }
  });

  socket.on('leaveDiscussion', (topic) => {
    // The client unmounted its discussion page; drop it from the room and
    // recompute presence so the counter doesn't over-report lingering viewers.
    const roomToLeave = topic || socket.data.topic;
    if (!roomToLeave) return;
    socket.leave(roomToLeave);
    if (socket.data.topic === roomToLeave) {
      socket.data.topic = null;
    }
    emitPresence(roomToLeave);
  });

  socket.on('addQuestion', async (topic, question, force, ack) => {
    console.log('Received addQuestion event');
    console.log('topic:', topic);
    console.log('question:', question);

    // Report the outcome back to the submitter so the client only clears its
    // draft once the question is actually added — not when it's bounced as a
    // near-duplicate or fails.
    const reply = (result) => {
      if (typeof ack === 'function') ack(result);
    };

    try {
      if (await isDiscussionLocked(topic)) {
        socket.emit('error', { message: 'This discussion is locked.' });
        reply({ added: false, reason: 'locked' });
        return;
      }

      // Surface a near-duplicate so the submitter can vote on the existing
      // statement instead — unless they explicitly chose to post anyway.
      if (!force) {
        const similar = await findSimilarQuestion(topic, question.text);
        if (similar) {
          socket.emit('similarQuestion', { candidate: similar, question });
          reply({ added: false, reason: 'similar' });
          return;
        }
      }

      await addQuestion(topic, question);
      console.log('Question added successfully');
      const updatedQuestions = await getQuestions(topic);
      console.log('Retrieved updated questions:', updatedQuestions);
      io.to(topic).emit('questions', updatedQuestions);
      reply({ added: true });
    } catch (error) {
      console.error('Error adding question:', error);
      socket.emit('error', { message: 'Failed to add question' });
      reply({ added: false, reason: 'error' });
    }
  });

  socket.on('vote', async (topic, questionId, vote, userId, pseudonym) => {
    try {
      // Verify the question actually belongs to this topic AND that the topic is
      // not locked. Without this, a client could bypass a locked discussion by
      // sending the locked question's id under some other (unlocked) topic.
      const target = await getQuestionForTopic(topic, questionId);
      if (!target) {
        socket.emit('error', { message: 'Invalid question for this discussion.' });
        return;
      }
      if (target.locked) {
        socket.emit('error', { message: 'Voting is closed for this discussion.' });
        return;
      }
      await addVote(questionId, vote, userId, pseudonym);
      const questions = await getQuestions(topic);
      io.to(topic).emit('questions', questions);
    } catch (error) {
      console.error('Error handling vote:', error);
      socket.emit('error', { message: 'Failed to handle vote' });
    }
  });

  // First-come moderator claim. Replies via ack callback with the admin token.
  socket.on('claimModerator', async (topic, cb) => {
    try {
      const token = await claimModerator(topic);
      if (token) {
        if (typeof cb === 'function') cb({ success: true, token });
        await emitDiscussionState(topic);
      } else if (typeof cb === 'function') {
        cb({ success: false, error: 'already_claimed' });
      }
    } catch (error) {
      console.error('Error claiming moderator:', error);
      if (typeof cb === 'function') cb({ success: false, error: 'server_error' });
    }
  });

  socket.on('deleteQuestion', async (topic, questionId, token) => {
    try {
      const discussionId = await verifyAdmin(topic, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        return;
      }
      // Scope the vote delete through the question's discussion so a moderator of
      // one discussion can never wipe another discussion's votes by passing a
      // foreign questionId. Delete votes first to satisfy the FK constraint, then
      // the question itself (also constrained by discussion_id).
      await pool.query(
        `DELETE FROM votes
         WHERE question_id = $1
           AND question_id IN (SELECT id FROM questions WHERE discussion_id = $2)`,
        [questionId, discussionId]
      );
      await pool.query('DELETE FROM questions WHERE id = $1 AND discussion_id = $2', [questionId, discussionId]);
      io.to(topic).emit('questions', await getQuestions(topic));
    } catch (error) {
      console.error('Error deleting question:', error);
      socket.emit('error', { message: 'Failed to delete question' });
    }
  });

  socket.on('setLocked', async (topic, locked, token) => {
    try {
      const discussionId = await verifyAdmin(topic, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        return;
      }
      await pool.query('UPDATE discussions SET locked = $1 WHERE id = $2', [!!locked, discussionId]);
      await emitDiscussionState(topic);
    } catch (error) {
      console.error('Error setting lock state:', error);
      socket.emit('error', { message: 'Failed to update discussion' });
    }
  });

  socket.on('setPinned', async (topic, questionId, pinned, token) => {
    try {
      const discussionId = await verifyAdmin(topic, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        return;
      }
      await pool.query('UPDATE questions SET pinned = $1 WHERE id = $2 AND discussion_id = $3', [!!pinned, questionId, discussionId]);
      io.to(topic).emit('questions', await getQuestions(topic));
    } catch (error) {
      console.error('Error setting pin state:', error);
      socket.emit('error', { message: 'Failed to update question' });
    }
  });

  socket.on('toggleResponseVote', async (topic, responseId, userId) => {
    try {
      await toggleResponseVote(topic, responseId, userId);
      const questions = await getQuestions(topic);
      io.to(topic).emit('questions', questions);
    } catch (error) {
      console.error('Error toggling response vote:', error);
      socket.emit('error', { message: 'Failed to upvote response' });
    }
  });

  socket.on('deleteVote', async (topic, voteId, userId) => {
    try {
      await deleteVote(voteId, userId);
      const questions = await getQuestions(topic);
      io.to(topic).emit('questions', questions);
    } catch (error) {
      console.error('Error deleting vote:', error);
      socket.emit('error', { message: 'Failed to delete vote' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
    // The socket has already left its rooms by now, so the count reflects the
    // remaining participants.
    emitPresence(socket.data.topic);
  });
});

app.use((req, res, next) => {
  console.log('Request body:', req.body);
  next();
});

// HTTP routes
app.post('/api/discussions', async (req, res) => {
  const { topic } = req.body;
  try {
    const id = await getOrCreateDiscussion(pool, topic);
    res.json({ success: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/discussions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM discussions WHERE id = $1',
      [id]
    );
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ error: 'Discussion not found' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Database functions
async function getOrCreateDiscussion(db, topic) {
  const result = await db.query(
    `INSERT INTO discussions (topic)
     VALUES ($1)
     ON CONFLICT (topic) DO UPDATE SET topic = EXCLUDED.topic
     RETURNING id`,
    [topic]
  );
  return result.rows[0].id;
}

async function getQuestions(topic) {
  const query = `
    SELECT 
      q.id, 
      q.text, 
      q.type, 
      q.min_value,
      q.max_value,
      q.options,
      q.created_at,
      q.pinned,
      COALESCE(json_agg(
        json_build_object(
          'id', v.id,
          'value', v.value,
          'userId', v.user_id,
          'pseudonym', v.pseudonym,
          'created_at', v.created_at,
          'upvotes', (SELECT COUNT(*) FROM response_votes rv WHERE rv.response_id = v.id),
          'upvoters', (SELECT COALESCE(json_agg(rv.user_id), '[]'::json) FROM response_votes rv WHERE rv.response_id = v.id)
        ) ORDER BY v.id
      ) FILTER (WHERE v.id IS NOT NULL), '[]'::json) as votes
    FROM questions q
    JOIN discussions d ON q.discussion_id = d.id
    LEFT JOIN votes v ON q.id = v.question_id
    WHERE d.topic = $1
    GROUP BY q.id
    ORDER BY q.pinned DESC, q.id
  `;

  const result = await pool.query(query, [topic]);
  return result.rows.map(row => ({
    ...row,
    minValue: row.min_value,
    maxValue: row.max_value,
    options: parseOptions(row.options)
  }));
}

async function addQuestion(topic, question) {
  console.log('Entering addQuestion');
  console.log('Topic:', topic);
  console.log('Question:', question);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const discussionId = await getOrCreateDiscussion(client, topic);

    // Ensure options is a valid JSON array
    const optionsJson = JSON.stringify(Array.isArray(question.options) ? question.options : []);

    // Insert the question
    const questionResult = await client.query(
      'INSERT INTO questions (discussion_id, text, type, min_value, max_value, options) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [discussionId, question.text, question.type, question.minValue, question.maxValue, optionsJson]
    );

    await client.query('COMMIT');
    console.log('Question added successfully:', questionResult.rows[0]);
    return {
      ...questionResult.rows[0],
      options: parseOptions(questionResult.rows[0].options)
    };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error in addQuestion:', e);
    throw e;
  } finally {
    client.release();
  }
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
    console.error('Error migrating discussion topic uniqueness:', e);
    throw e;
  } finally {
    client.release();
  }
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
    console.error('Error creating response_votes table:', e);
    throw e;
  }
}

// Moderation columns: a per-discussion admin token, a discussion lock, and a
// per-question pin flag. Plus the pg_trgm extension for near-duplicate
// statement detection. All idempotent.
async function migrateModerationAndDedup() {
  await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS admin_token TEXT');
  await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE');

  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } catch (e) {
    console.error('pg_trgm extension migration failed; similarity checks will be skipped:', e.message);
  }
  console.log('Moderation + dedup migration completed');
}

// Verify that the supplied token is the discussion's admin token. Returns the
// discussion id when valid, or null otherwise.
async function verifyAdmin(topic, token) {
  if (!token) return null;
  const result = await pool.query(
    'SELECT id FROM discussions WHERE topic = $1 AND admin_token = $2',
    [topic, token]
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
}

// First-come moderator claim: assigns a fresh admin token only if the
// discussion has none yet. Returns the token, or null if already claimed.
// The advisory lock serializes moderator claims for the same topic; the upsert
// also keeps the claim race-safe against non-moderator topic creation paths.
async function claimModerator(topic) {
  const token = crypto.randomBytes(16).toString('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [topic]);

    const claim = await client.query(
      `INSERT INTO discussions (topic, admin_token)
       VALUES ($1, $2)
       ON CONFLICT (topic) DO UPDATE
       SET admin_token = COALESCE(discussions.admin_token, EXCLUDED.admin_token)
       WHERE discussions.admin_token IS NULL
       RETURNING admin_token`,
      [topic, token]
    );

    await client.query('COMMIT');
    return claim.rows.length > 0 ? claim.rows[0].admin_token : null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Whether voting is currently closed for a discussion.
async function isDiscussionLocked(topic) {
  const result = await pool.query('SELECT locked FROM discussions WHERE topic = $1', [topic]);
  return result.rows.length > 0 ? result.rows[0].locked === true : false;
}

// Confirm a question belongs to the given topic and report whether that
// discussion is locked. Returns null when the question does not belong to the
// topic, so callers can reject mismatched/forged questionIds. The join on
// topic means a question id from a different discussion never matches.
async function getQuestionForTopic(topic, questionId) {
  const result = await pool.query(
    `SELECT q.id, d.locked
     FROM questions q
     JOIN discussions d ON q.discussion_id = d.id
     WHERE d.topic = $1 AND q.id = $2`,
    [topic, questionId]
  );
  if (result.rows.length === 0) return null;
  return { id: result.rows[0].id, locked: result.rows[0].locked === true };
}

// Return the text of the most similar existing statement in the discussion if
// it crosses the trigram-similarity threshold, otherwise null.
const SIMILARITY_THRESHOLD = 0.5;
async function findSimilarQuestion(topic, text) {
  if (!text) return null;
  try {
    const result = await pool.query(
      `SELECT q.text, similarity(q.text, $2) AS sim
       FROM questions q
       JOIN discussions d ON q.discussion_id = d.id
       WHERE d.topic = $1 AND similarity(q.text, $2) > $3
       ORDER BY sim DESC
       LIMIT 1`,
      [topic, text, SIMILARITY_THRESHOLD]
    );
    return result.rows.length > 0 ? result.rows[0].text : null;
  } catch (e) {
    // If pg_trgm isn't available, skip dedup rather than blocking submission.
    console.error('Similarity check failed (skipping dedup):', e.message);
    return null;
  }
}

async function addVote(questionId, vote, userId, pseudonym) {
  console.log('Adding vote:', questionId, vote, userId, pseudonym);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Brainstorm questions allow each user to add many separate ideas, so every
    // submission is a brand new row rather than an update to a single answer.
    const typeResult = await client.query(
      'SELECT type FROM questions WHERE id = $1',
      [questionId]
    );
    const questionType = typeResult.rows[0] && typeResult.rows[0].type;

    if (questionType === 'Brainstorm') {
      await client.query(
        'INSERT INTO votes (question_id, user_id, value) VALUES ($1, $2, $3)',
        [questionId, userId, vote]
      );
      await client.query('COMMIT');
      console.log('Brainstorm idea added successfully');
      return;
    }

    // Check if the user has already voted on this question
    const existingVoteResult = await client.query(
      'SELECT * FROM votes WHERE question_id = $1 AND user_id = $2',
      [questionId, userId]
    );

    if (existingVoteResult.rows.length > 0) {
      console.log('User has already voted');
      const existingVote = existingVoteResult.rows[0];
      // Arrays (e.g. multi-value responses) are stored as JSON strings
      if (Array.isArray(vote)) {
        await client.query(
          'UPDATE votes SET value = $1, pseudonym = $2 WHERE id = $3',
          [JSON.stringify(vote), pseudonym, existingVote.id]
        );
      } else if (existingVote.value === vote && questionType === 'Agreement') {
        // Agreement votes toggle: re-selecting your current option undoes it.
        // This must stay scoped to Agreement — for Open Ended, re-submitting the
        // same text means "keep it", not "delete it".
        console.log('Voting for a option they already voted for');
        await client.query(
          'DELETE FROM votes WHERE id = $1',
          [existingVote.id]
        );
      } else {
        console.log('Voting for a different option');
        await client.query(
          'UPDATE votes SET value = $1, pseudonym = $2 WHERE id = $3',
          [vote, pseudonym, existingVote.id]
        );
      }
    } else {
      console.log('User has not voted yet');
      await client.query(
        'INSERT INTO votes (question_id, user_id, value, pseudonym) VALUES ($1, $2, $3, $4)',
        [questionId, userId, Array.isArray(vote) ? JSON.stringify(vote) : vote, pseudonym]
      );
    }

    await client.query('COMMIT');
    console.log('Vote added/updated successfully');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error in addVote:', e);
    throw e;
  } finally {
    client.release();
  }
}

// Toggle a user's upvote on an open-ended response. Adds the upvote if absent,
// removes it if already present.
async function toggleResponseVote(topic, responseId, userId) {
  // Confirm the response belongs to the room's discussion before mutating it.
  // Without the topic join a client in one room could toggle a vote on a
  // response id that lives in another discussion. Also fetch the owner so we
  // can reject self-upvotes below.
  const ownerResult = await pool.query(
    `SELECT v.user_id
     FROM votes v
     JOIN questions q ON v.question_id = q.id
     JOIN discussions d ON q.discussion_id = d.id
     WHERE v.id = $1 AND d.topic = $2`,
    [responseId, topic]
  );
  if (ownerResult.rows.length === 0) {
    return;
  }
  // Reject self-upvotes: the UI disables the button for your own response, but
  // the event can still be emitted from the console, so enforce it server-side.
  if (ownerResult.rows[0].user_id === userId) {
    console.log('Ignoring self-upvote on response', responseId);
    return;
  }
  const deleteResult = await pool.query(
    'DELETE FROM response_votes WHERE response_id = $1 AND user_id = $2',
    [responseId, userId]
  );
  if (deleteResult.rowCount === 0) {
    await pool.query(
      'INSERT INTO response_votes (response_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [responseId, userId]
    );
  }
}

// Removes a single vote (used for Brainstorm ideas). The user_id check ensures a
// participant can only delete their own ideas.
async function deleteVote(voteId, userId) {
  console.log('Deleting vote:', voteId, userId);
  await pool.query(
    'DELETE FROM votes WHERE id = $1 AND user_id = $2',
    [voteId, userId]
  );
  console.log('Vote deleted successfully');
}

app.get('/api/discussions', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, topic, created_at FROM discussions ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function getDiscussionSummary(topic, options = {}) {
  const discussion = await getDiscussionByTopic(topic);
  if (!discussion) {
    return null;
  }

  const questions = await getQuestions(topic);
  const writtenResponses = questions
    .filter(question => question.type === 'Open Ended' || question.type === 'Brainstorm')
    .flatMap(question => (question.votes || [])
      .map(vote => ({
        questionId: question.id,
        questionText: question.text,
        questionType: question.type,
        pseudonym: vote.pseudonym || 'Anonymous',
        value: String(parseStoredVoteValue(vote.value) || '').trim(),
      }))
      .filter(response => response.value !== ''));

  let synthesis = buildDeterministicSynthesis(writtenResponses);
  if (options.llm) {
    if (
      writtenResponses.length > 0 &&
      (process.env.ENABLE_LLM_SYNTHESIS !== 'true' || !process.env.OPENAI_API_KEY)
    ) {
      synthesis = {
        ...synthesis,
        llmError: 'LLM synthesis is not configured, so the deterministic summary is shown.',
      };
    } else {
      try {
        const llmSynthesis = await buildLlmSynthesis(writtenResponses);
        if (llmSynthesis) {
          synthesis = llmSynthesis;
        }
      } catch (error) {
        console.error('Error generating LLM synthesis:', error);
        synthesis = {
          ...synthesis,
          llmError: 'LLM synthesis was unavailable, so the deterministic summary is shown.',
        };
      }
    }
  }

  return buildSummary(discussion, questions, synthesis);
}

app.get('/api/discussions/:topic/summary', async (req, res) => {
  try {
    const summary = await getDiscussionSummary(req.params.topic, {
      llm: req.query.synthesis === 'llm',
    });

    if (!summary) {
      return res.status(404).json({ error: 'Discussion not found' });
    }

    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/discussions/:topic/export.json', async (req, res) => {
  try {
    const summary = await getDiscussionSummary(req.params.topic);

    if (!summary) {
      return res.status(404).json({ error: 'Discussion not found' });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(req.params.topic)}-summary.json"`);
    res.send(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/discussions/:topic/export.csv', async (req, res) => {
  try {
    const discussion = await getDiscussionByTopic(req.params.topic);
    if (!discussion) {
      return res.status(404).json({ error: 'Discussion not found' });
    }

    const questions = await getQuestions(req.params.topic);
    const headers = [
      'discussion_topic',
      'question_id',
      'question_text',
      'question_type',
      'question_created_at',
      'response_id',
      'respondent',
      'response_value',
      'response_created_at',
    ];
    const rows = questions.flatMap(question => {
      const votes = question.votes || [];
      if (votes.length === 0) {
        return [[
          discussion.topic,
          question.id,
          question.text,
          question.type,
          question.created_at,
          '',
          '',
          '',
          '',
        ]];
      }

      return votes.map(vote => [
        discussion.topic,
        question.id,
        question.text,
        question.type,
        question.created_at,
        vote.id,
        vote.pseudonym || 'Anonymous',
        parseStoredVoteValue(vote.value),
        vote.created_at,
      ]);
    });

    const csv = [
      headers.map(escapeCsv).join(','),
      ...rows.map(row => row.map(escapeCsv).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(req.params.topic)}-responses.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/duplicate-discussion', async (req, res) => {
  const { originalTopic, newTopic } = req.body;
  console.log(`Attempting to duplicate discussion. Original: ${originalTopic}, New: ${newTopic}`);

  if (!originalTopic || !newTopic) {
    console.log('Missing required fields');
    return res.status(400).json({ error: 'Original topic and new topic are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get the original discussion
    const originalDiscussionResult = await client.query(
      'SELECT id FROM discussions WHERE topic = $1',
      [originalTopic]
    );

    if (originalDiscussionResult.rows.length === 0) {
      throw new Error('Original discussion not found');
    }

    const originalDiscussionId = originalDiscussionResult.rows[0].id;

    // Create new discussion. Duplicating into an existing topic would merge
    // questions into that discussion, so treat the unique conflict as a user
    // error instead.
    const newDiscussionResult = await client.query(
      `INSERT INTO discussions (topic)
       VALUES ($1)
       ON CONFLICT (topic) DO NOTHING
       RETURNING id`,
      [newTopic]
    );

    if (newDiscussionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Discussion topic already exists' });
    }

    const newDiscussionId = newDiscussionResult.rows[0].id;

    // Copy questions from original to new discussion
    await client.query(`
      INSERT INTO questions (discussion_id, text, type, min_value, max_value, options)
      SELECT $1, text, type, min_value, max_value, options
      FROM questions
      WHERE discussion_id = $2
    `, [newDiscussionId, originalDiscussionId]);

    await client.query('COMMIT');

    res.json({ success: true, newTopic });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error duplicating discussion:', error);
    res.status(500).json({ error: 'Failed to duplicate discussion' });
  } finally {
    client.release();
  }
});

// Catch-all route
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Ensure the database schema exists before serving requests. schema.sql is
// idempotent (CREATE TABLE IF NOT EXISTS), so this is a no-op on a database
// that's already populated (e.g. restored from latest.dump) and creates the
// tables on a fresh, empty database.
async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

const PORT = process.env.PORT || 3001;

// Create the schema on a fresh deploy, then run required migrations before
// accepting connections so that no client can query a column or table that
// doesn't exist yet (e.g. votes.pseudonym, or the response_votes table that
// getQuestions selects from on the first join). Order matters: create tables
// first, then run all migrations against the existing/just-created schema, then
// start listening.
initSchema()
  .then(() => migrateModerationAndDedup())
  .then(() => migrateUniqueDiscussionTopics())
  .then(() => Promise.all([migrateAddPseudonymColumn(), migrateResponseVotesTable()]))
  .then(() => {
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database, exiting:', err);
    process.exit(1);
  });
