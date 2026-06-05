require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const fs = require('fs');
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
  return `"${stringValue.replace(/"/g, '""')}"`;
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
  const outputText = data.output_text;
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
      q.created_at,
      COALESCE(json_agg(
        json_build_object(
          'id', v.id,
          'value', v.value,
          'userId', v.user_id,
          'pseudonym', v.pseudonym,
          'created_at', v.created_at
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
// accepting connections so that no client can query a column that doesn't
// exist yet (e.g. votes.pseudonym). Order matters: create tables first, then
// migrate the existing/just-created schema, then start listening.
initSchema()
  .then(() => migrateAddPseudonymColumn())
  .then(() => {
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database, exiting:', err);
    process.exit(1);
  });
