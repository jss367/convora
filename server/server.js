const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.use(cors());
app.use(bodyParser.json());

// Serve static files from the React app
app.use(express.static(path.join(__dirname, '../dist')));

// Your routes go here
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.post('/api/discussions/:id/questions', async (req, res) => {
  const { id } = req.params;
  const { question } = req.body;
  try {
    const discussionCheck = await pool.query('SELECT * FROM discussions WHERE id = $1', [id]);
    if (discussionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Discussion not found' });
    }

    const result = await pool.query(
      'INSERT INTO questions (discussion_id, text) VALUES ($1, $2) RETURNING *',
      [id, question]
    );

    const newQuestion = result.rows[0];
    res.json({
      id: newQuestion.id,
      text: newQuestion.text,
      votes: {
        'Strongly Agree': newQuestion.strongly_agree,
        'Agree': newQuestion.agree,
        'Unsure': newQuestion.unsure,
        'Disagree': newQuestion.disagree,
        'Strongly Disagree': newQuestion.strongly_disagree,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/discussions/:discussionId/questions/:questionId/vote', async (req, res) => {
  const { discussionId, questionId } = req.params;
  const { option } = req.body;

  const voteOptions = {
    'Strongly Agree': 'strongly_agree',
    'Agree': 'agree',
    'Unsure': 'unsure',
    'Disagree': 'disagree',
    'Strongly Disagree': 'strongly_disagree',
  };

  if (!voteOptions[option]) {
    return res.status(400).json({ error: 'Invalid vote option' });
  }

  try {
    const result = await pool.query(
      `UPDATE questions 
       SET ${voteOptions[option]} = ${voteOptions[option]} + 1 
       WHERE id = $1 AND discussion_id = $2 
       RETURNING *`,
      [questionId, discussionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Question not found' });
    }

    const updatedQuestion = result.rows[0];
    res.json({
      success: true,
      votes: {
        'Strongly Agree': updatedQuestion.strongly_agree,
        'Agree': updatedQuestion.agree,
        'Unsure': updatedQuestion.unsure,
        'Disagree': updatedQuestion.disagree,
        'Strongly Disagree': updatedQuestion.strongly_disagree,
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
