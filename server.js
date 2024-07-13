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
const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://username:password@localhost:5432/convora',
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

app.use(cors());
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
    try {
      await addQuestion(topic, question);
      const updatedQuestions = await getQuestions(topic);
      io.to(topic).emit('questions', updatedQuestions);
    } catch (error) {
      console.error('Error adding question:', error);
      socket.emit('error', { message: 'Failed to add question' });
    }
  });

  socket.on('vote', async (discussionId, questionId, vote) => {
    await addVote(questionId, vote);
    const questions = await getQuestions(discussionId);
    io.to(discussionId).emit('questions', questions);
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
async function getQuestions(discussionIdentifier) {
  const result = await pool.query(
    `SELECT questions.*, json_agg(votes.*) as votes 
     FROM questions 
     LEFT JOIN votes ON questions.id = votes.question_id 
     JOIN discussions ON questions.discussion_id = discussions.id
     WHERE discussions.id = $1 OR discussions.topic = $1
     GROUP BY questions.id 
     ORDER BY questions.id`,
    [discussionIdentifier]
  );
  return result.rows;
}

async function addQuestion(topic, question) {
  // First, get the discussion ID for the given topic
  const discussionResult = await pool.query(
    'SELECT id FROM discussions WHERE topic = $1',
    [topic]
  );
  if (discussionResult.rows.length === 0) {
    throw new Error('Discussion not found');
  }
  const discussionId = discussionResult.rows[0].id;

  // Now insert the question using the numeric discussion ID
  const result = await pool.query(
    'INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [discussionId, question.text, question.type, question.minValue, question.maxValue]
  );
  return result.rows[0];
}

async function addVote(questionId, vote) {
  await pool.query(
    'INSERT INTO votes (question_id, value) VALUES ($1, $2)',
    [questionId, vote]
  );
}

// Catch-all route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
