require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bodyParser = require('body-parser');
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

app.use(bodyParser.json());
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

  socket.on('addQuestion', async (topic, question, force) => {
    console.log('Received addQuestion event');
    console.log('topic:', topic);
    console.log('question:', question);

    try {
      if (await isDiscussionLocked(topic)) {
        socket.emit('error', { message: 'This discussion is locked.' });
        return;
      }

      // Surface a near-duplicate so the submitter can vote on the existing
      // statement instead — unless they explicitly chose to post anyway.
      if (!force) {
        const similar = await findSimilarQuestion(topic, question.text);
        if (similar) {
          socket.emit('similarQuestion', { candidate: similar, question });
          return;
        }
      }

      await addQuestion(topic, question);
      console.log('Question added successfully');
      const updatedQuestions = await getQuestions(topic);
      console.log('Retrieved updated questions:', updatedQuestions);
      io.to(topic).emit('questions', updatedQuestions);
    } catch (error) {
      console.error('Error adding question:', error);
      socket.emit('error', { message: 'Failed to add question' });
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
    const result = await pool.query(
      'INSERT INTO discussions (topic) VALUES ($1) RETURNING id',
      [topic]
    );
    res.json({ success: true, id: result.rows[0].id });
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
async function getQuestions(topic) {
  const query = `
    SELECT 
      q.id, 
      q.text, 
      q.type, 
      q.min_value,
      q.max_value,
      q.options,
      q.pinned,
      COALESCE(json_agg(
        json_build_object(
          'id', v.id,
          'value', v.value,
          'userId', v.user_id,
          'pseudonym', v.pseudonym,
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

    // Get or create discussion
    let discussionId;
    const discussionResult = await client.query(
      'SELECT id FROM discussions WHERE topic = $1',
      [topic]
    );
    if (discussionResult.rows.length === 0) {
      const newDiscussionResult = await client.query(
        'INSERT INTO discussions (topic) VALUES ($1) RETURNING id',
        [topic]
      );
      discussionId = newDiscussionResult.rows[0].id;
    } else {
      discussionId = discussionResult.rows[0].id;
    }

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
  try {
    await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS admin_token TEXT');
    await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    console.log('Moderation + dedup migration completed');
  } catch (e) {
    console.error('Error in moderation/dedup migration:', e);
  }
}
migrateModerationAndDedup().catch(console.error);

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
// (discussions.topic has no unique constraint in this schema, so we avoid
// ON CONFLICT and use SELECT/INSERT like the rest of the app.)
async function claimModerator(topic) {
  const token = crypto.randomBytes(16).toString('hex');
  const existing = await pool.query('SELECT admin_token FROM discussions WHERE topic = $1', [topic]);

  if (existing.rows.length === 0) {
    const inserted = await pool.query(
      'INSERT INTO discussions (topic, admin_token) VALUES ($1, $2) RETURNING admin_token',
      [topic, token]
    );
    return inserted.rows[0].admin_token;
  }

  if (existing.rows[0].admin_token) {
    return null; // already has a moderator
  }

  // Claim the existing, unclaimed discussion atomically (guards against a race).
  const updated = await pool.query(
    'UPDATE discussions SET admin_token = $1 WHERE topic = $2 AND admin_token IS NULL RETURNING admin_token',
    [token, topic]
  );
  return updated.rows.length > 0 ? updated.rows[0].admin_token : null;
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
      } else if (existingVote.value === vote) {
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

    // Create new discussion
    const newDiscussionResult = await client.query(
      'INSERT INTO discussions (topic) VALUES ($1) RETURNING id',
      [newTopic]
    );

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
app.get('*', (req, res) => {
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
  .then(() => Promise.all([migrateAddPseudonymColumn(), migrateResponseVotesTable()]))
  .then(() => {
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database, exiting:', err);
    process.exit(1);
  });
