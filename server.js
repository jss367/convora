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

  socket.on('joinDiscussion', async (discussionId) => {
    socket.join(discussionId);
    const questions = await getQuestions(discussionId);
    socket.emit('questions', questions);
  });

  socket.on('addQuestion', async (discussionId, question) => {
    await addQuestion(discussionId, question);
    const questions = await getQuestions(discussionId);
    io.to(discussionId).emit('questions', questions);
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
async function getQuestions(discussionId) {
  const result = await pool.query(
    'SELECT questions.*, json_agg(votes.*) as votes FROM questions LEFT JOIN votes ON questions.id = votes.question_id WHERE discussion_id = $1 GROUP BY questions.id ORDER BY questions.id',
    [discussionId]
  );
  return result.rows;
}

async function addQuestion(discussionId, question) {
  await pool.query(
    'INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES ($1, $2, $3, $4, $5)',
    [discussionId, question.text, question.type, question.minValue, question.maxValue]
  );
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
