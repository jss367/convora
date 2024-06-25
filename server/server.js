const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());

// In-memory storage (replace with a database in production)
let discussions = {};

app.post('/api/discussions', (req, res) => {
  const { id, topic } = req.body;
  discussions[id] = { topic, questions: [] };
  res.json({ success: true, id });
});

app.get('/api/discussions/:id', (req, res) => {
  const { id } = req.params;
  if (discussions[id]) {
    res.json(discussions[id]);
  } else {
    res.status(404).json({ error: 'Discussion not found' });
  }
});

app.post('/api/discussions/:id/questions', (req, res) => {
  const { id } = req.params;
  const { question } = req.body;
  if (discussions[id]) {
    const newQuestion = {
      id: Date.now(),
      text: question,
      votes: {
        'Strongly Agree': 0,
        'Agree': 0,
        'Unsure': 0,
        'Disagree': 0,
        'Strongly Disagree': 0,
      },
    };
    discussions[id].questions.push(newQuestion);
    res.json(newQuestion);
  } else {
    res.status(404).json({ error: 'Discussion not found' });
  }
});

app.post('/api/discussions/:discussionId/questions/:questionId/vote', (req, res) => {
  const { discussionId, questionId } = req.params;
  const { option } = req.body;
  if (discussions[discussionId]) {
    const question = discussions[discussionId].questions.find(q => q.id === parseInt(questionId));
    if (question && question.votes.hasOwnProperty(option)) {
      question.votes[option]++;
      res.json({ success: true, votes: question.votes });
    } else {
      res.status(400).json({ error: 'Invalid question or vote option' });
    }
  } else {
    res.status(404).json({ error: 'Discussion not found' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
