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
    origin: process.env.CLIENT_URL || "https://convora-e40a9ae358dc.herokuapp.com",
    methods: ["GET", "POST"],
    credentials: true
  }
});

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://username:password@localhost:5432/convora',
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

app.use(cors({
  origin: process.env.CLIENT_URL || "https://convora-e40a9ae358dc.herokuapp.com",
  credentials: true
}));
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
    console.log('topic:', topic)
    console.log('question:', question)

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

  socket.on('vote', async (topic, questionId, vote) => {
    await addVote(questionId, vote);
    const questions = await getQuestions(topic);
    io.to(topic).emit('questions', questions);
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
      json_agg(
        json_build_object(
          'id', v.id,
          'value', v.value
        )
      ) FILTER (WHERE v.id IS NOT NULL) as votes 
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
    votes: row.votes || []
  }));
}

async function addQuestion(topic, question) {
  console.log('Entering addQuestion');
  console.log('Topic:', topic);
  console.log('Question:', question);
  // First, get the discussion ID for the given topic
  const discussionResult = await pool.query(
    'SELECT id FROM discussions WHERE topic = $1',
    [topic]
  );

  let discussionId;
  if (discussionResult.rows.length === 0) {
    // If the discussion doesn't exist, create it
    const newDiscussionResult = await pool.query(
      'INSERT INTO discussions (topic) VALUES ($1) RETURNING id',
      [topic]
    );
    discussionId = newDiscussionResult.rows[0].id;
  } else {
    discussionId = discussionResult.rows[0].id;
  }

  // Now insert the question using the numeric discussion ID
  const questionResult = await pool.query(
    'INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [discussionId, question.text, question.type, question.minValue, question.maxValue]
  );
  return questionResult.rows[0];
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
