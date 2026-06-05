require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
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

  socket.on('addQuestion', async (topic, question) => {
    console.log('Received addQuestion event');
    console.log('topic:', topic);
    console.log('question:', question);

    try {
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
      await addVote(questionId, vote, userId, pseudonym);
      const questions = await getQuestions(topic);
      io.to(topic).emit('questions', questions);
    } catch (error) {
      console.error('Error handling vote:', error);
      socket.emit('error', { message: 'Failed to handle vote' });
    }
  });

  socket.on('toggleResponseVote', async (topic, responseId, userId) => {
    try {
      await toggleResponseVote(responseId, userId);
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
    ORDER BY q.id
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

// might get rid of this
async function migrateOptionsToJson() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query('SELECT id, options FROM questions WHERE options IS NOT NULL');

    for (const row of result.rows) {
      const parsedOptions = parseOptions(row.options);
      await client.query('UPDATE questions SET options = $1 WHERE id = $2', [JSON.stringify(parsedOptions), row.id]);
    }

    await client.query('COMMIT');
    console.log('Migration completed successfully');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error during migration:', e);
  } finally {
    client.release();
  }
}
migrateOptionsToJson().catch(console.error);
// might get rid of above

// Add the pseudonym column to votes if it doesn't already exist. Idempotent so
// it's safe to run on every boot.
async function migrateAddPseudonymColumn() {
  try {
    await pool.query('ALTER TABLE votes ADD COLUMN IF NOT EXISTS pseudonym TEXT');
    console.log('Pseudonym column migration completed');
  } catch (e) {
    console.error('Error adding pseudonym column:', e);
  }
}
migrateAddPseudonymColumn().catch(console.error);

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
  }
}
migrateResponseVotesTable().catch(console.error);

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
async function toggleResponseVote(responseId, userId) {
  // Reject self-upvotes: the UI disables the button for your own response, but
  // the event can still be emitted from the console, so enforce it server-side.
  const ownerResult = await pool.query(
    'SELECT user_id FROM votes WHERE id = $1',
    [responseId]
  );
  if (ownerResult.rows.length === 0) {
    return;
  }
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
