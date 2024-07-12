// Add a new question to a discussion
app.post('/api/discussions/:id/questions', async (req, res) => {
  const { id } = req.params;
  const { question } = req.body;
  try {
    // First, check if the discussion exists
    const discussionCheck = await pool.query('SELECT * FROM discussions WHERE id = $1', [id]);
    if (discussionCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Discussion not found' });
    }

    // If discussion exists, add the new question
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

// Vote on a question
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
    // Update the vote count and return the updated question
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
