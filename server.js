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

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'dist')));

// WebSocket handlers
io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('joinDiscussion', async (topic) => {
    socket.join(topic);
    try {
      const questions = await getQuestions(topic);
      socket.emit('questions', questions);
    } catch (error) {
      console.error('Error getting questions:', error);
      socket.emit('error', { message: 'Failed to get questions' });
    }
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

  socket.on('vote', async (topic, questionId, vote, userId) => {
    try {
      await addVote(questionId, vote, userId);
      const questions = await getQuestions(topic);
      io.to(topic).emit('questions', questions);
    } catch (error) {
      console.error('Error handling vote:', error);
      socket.emit('error', { message: 'Failed to handle vote' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
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
      COALESCE(json_agg(
        json_build_object(
          'id', v.id,
          'value', v.value,
          'userId', v.user_id
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
  return result.rows;
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

    // Insert the question
    const questionResult = await client.query(
      'INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [discussionId, question.text, question.type, question.minValue, question.maxValue]
    );

    await client.query('COMMIT');
    console.log('Question added successfully:', questionResult.rows[0]);
    return questionResult.rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function addVote(questionId, vote, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if the user has already voted on this question
    const existingVoteResult = await client.query(
      'SELECT * FROM votes WHERE question_id = $1 AND user_id = $2',
      [questionId, userId]
    );

    if (existingVoteResult.rows.length > 0) {
      // User has already voted
      const existingVote = existingVoteResult.rows[0];
      if (existingVote.value === vote) {
        // If voting for the same option, remove the vote
        await client.query(
          'DELETE FROM votes WHERE id = $1',
          [existingVote.id]
        );
      } else {
        // If voting for a different option, update the vote
        await client.query(
          'UPDATE votes SET value = $1 WHERE id = $2',
          [vote, existingVote.id]
        );
      }
    } else {
      // User hasn't voted yet, add new vote
      await client.query(
        'INSERT INTO votes (question_id, user_id, value) VALUES ($1, $2, $3)',
        [questionId, userId, vote]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Catch-all route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
