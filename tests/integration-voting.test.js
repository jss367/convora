const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { Pool } = require('pg');
const { createVoteStore } = require('../votes');
const { cleanupDiscussions } = require('./helpers/cleanup-discussions.cjs');
const {
  useIntegrationServer,
  claimModerator,
  jsonRequest,
  connectSocket,
  waitForQuestions,
  emitWithAck,
  waitForEvent,
  uniqueTopic,
  waitForQuestionLockWait,
  seedResultsDiscussion,
  asModerator,
  asUser,
  assertResultsHidden,
  assertResultsShown,
  byId,
  joinAs,
  storedVotes,
} = require('./helpers/integration.cjs');

// This test measures how long an acknowledgment takes, so it runs while no
// other test file is loading the machine or the database.
const server = useIntegrationServer(__filename, {
  exclusive: ['a vote is acknowledged promptly while other votes keep arriving'],
});
const { pool, databaseUrl } = server;

for (const { type, value, expected, equivalentIds } of [
  { type: 'Numerical', value: '42', expected: 1 },
  { type: 'Numerical', value: '42', expected: 1, equivalentIds: true },
  { type: 'Open Ended', value: 'An answer', expected: 10 },
  { type: 'Agreement', value: 'Agree', expected: 1 },
  { type: 'Yes/No', value: 'Yes', expected: 1 },
  { type: 'Open Ended', value: 'An idea', expected: 10 },
]) {
  test(`concurrent ${type} submissions${equivalentIds ? ' with equivalent IDs' : ''} store one response per poll and distinct brainstorm idea`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('concurrent-votes') });
    const question = await pool.query(
      'INSERT INTO questions (discussion_id, text, type) VALUES ($1, $2, $3) RETURNING id',
      [created.body.id, 'Concurrent answers', type]
    );
    const questionId = question.rows[0].id;
    const applicationName = uniqueTopic('vote-race');
    const writers = new Pool({ connectionString: databaseUrl, max: 10, application_name: applicationName });
    const { addVote } = createVoteStore(writers);
    const blocker = await pool.connect();
    let submissions = [];
    try {
      // Hold inserts until all ten writers are waiting. Without serialization,
      // each writer reads an absent vote and then inserts its own duplicate.
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE votes IN SHARE MODE');
      const ids = equivalentIds ? [questionId, `00${questionId}`, `+${questionId}`] : [questionId];
      submissions = Array.from({ length: 10 }, (_, index) => addVote(ids[index % ids.length], value, 'same-user', null));
      const deadline = Date.now() + 5000;
      let allWaiting = false;
      while (Date.now() < deadline) {
        const waiting = await pool.query(
          `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE application_name = $1 AND wait_event_type = 'Lock'`, [applicationName]
        );
        if (waiting.rows[0].count === 10) {
          allWaiting = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(allWaiting, 'Concurrent vote writers did not reach the lock');
      await blocker.query('COMMIT');
      await Promise.all(submissions);
      const stored = await pool.query('SELECT value FROM votes WHERE question_id = $1', [questionId]);
      assert.equal(stored.rows.length, expected);
      assert.ok(stored.rows.every(row => row.value === value));
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled(submissions);
      await writers.end();
    }
  });
}

test('a vote that waits for a moderator edit is checked against the edited options', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('edit-then-vote') });
  const inserted = await pool.query(
    `INSERT INTO questions (discussion_id, text, type, options)
     VALUES ($1, 'Which?', 'Multiple Choice', $2) RETURNING id`,
    [created.body.id, JSON.stringify(['Old A', 'Old B'])]
  );
  const questionId = inserted.rows[0].id;
  const editor = await pool.connect();
  let vote;
  try {
    // The moderator's edit holds the row while the vote arrives.
    await editor.query('BEGIN');
    await editor.query('UPDATE questions SET options = $1 WHERE id = $2', [JSON.stringify(['New A', 'New B']), questionId]);
    vote = createVoteStore(pool).addVote(questionId, 'Old A', 'racer', null);
    await waitForQuestionLockWait();
    await editor.query('COMMIT');
    assert.deepEqual(await vote, { added: false, reason: 'invalid' });
    assert.deepEqual(await storedVotes(questionId), []);
    // A vote for one of the new options is stored as usual.
    assert.deepEqual(await createVoteStore(pool).addVote(questionId, 'New A', 'racer', null), { added: true });
  } finally {
    await editor.query('ROLLBACK').catch(() => {});
    editor.release();
    await Promise.allSettled([vote]);
  }
});

test('a moderator edit that waits for an in-flight vote is refused once the vote is stored', async () => {
  const topic = uniqueTopic('vote-then-edit');
  const mod = await connectSocket();
  const voter = await pool.connect();
  let edit;
  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const added = waitForQuestions(mod, (qs) => qs.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Which?', type: 'Multiple Choice', options: ['Old A', 'Old B'] });
    const question = (await added)[0];

    // A vote is mid-transaction: it has locked the question and stored its
    // answer but not yet committed when the edit arrives.
    await voter.query('BEGIN');
    await voter.query('SELECT id FROM questions WHERE id = $1 FOR SHARE', [question.id]);
    await voter.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'racer', 'Old A')", [question.id]);
    edit = emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Which?', type: 'Multiple Choice', options: ['New A', 'New B'] }, token);
    await waitForQuestionLockWait();
    await voter.query('COMMIT');

    assert.deepEqual(await edit, { updated: false, reason: 'has_responses' });
    const stored = await pool.query('SELECT options FROM questions WHERE id = $1', [question.id]);
    assert.deepEqual(stored.rows[0].options, ['Old A', 'Old B']);
  } finally {
    await voter.query('ROLLBACK').catch(() => {});
    voter.release();
    await Promise.allSettled([edit]);
    mod.disconnect();
  }
});

test('updating a poll repairs legacy duplicates without removing brainstorm ideas', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-duplicates') });
  const questions = await pool.query(
    `INSERT INTO questions (discussion_id, text, type) VALUES
     ($1, 'Estimate', 'Numerical'), ($1, 'Ideas', 'Open Ended') RETURNING id`, [created.body.id]
  );
  const [poll, brainstorm] = questions.rows.map(row => row.id);
  await pool.query(
    `INSERT INTO votes (question_id, user_id, value) VALUES
     ($1, 'same-user', '1'), ($1, 'same-user', '2'), ($1, 'other-user', '3'),
     ($2, 'same-user', 'Idea one'), ($2, 'same-user', 'Idea two')`, [poll, brainstorm]
  );
  await createVoteStore(pool).addVote(poll, '4', 'same-user', null);
  const stored = await pool.query('SELECT value FROM votes WHERE question_id = $1 ORDER BY value', [poll]);
  assert.deepEqual(stored.rows.map(row => row.value), ['3', '4']);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM votes WHERE question_id = $1', [brainstorm])).rows[0].count, 2);
});

for (const { type, first, second } of [
  { type: 'Agreement', first: 'Agree', second: 'Disagree' },
  { type: 'Yes/No', first: 'Yes', second: 'No' },
]) {
  test(`undoing the displayed ${type} vote clears divergent legacy duplicates`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-undo') });
    const questions = await pool.query(
      `INSERT INTO questions (discussion_id, text, type) VALUES
       ($1, 'Opinion', $2), ($1, 'Ideas', 'Open Ended') RETURNING id`, [created.body.id, type]
    );
    const [poll, brainstorm] = questions.rows.map(row => row.id);
    await pool.query(
      `INSERT INTO votes (question_id, user_id, value) VALUES
       ($1, 'same-user', $3), ($1, 'same-user', $4), ($1, 'other-user', $3),
       ($2, 'same-user', 'Idea one'), ($2, 'same-user', 'Idea two')`, [poll, brainstorm, first, second]
    );
    const socket = await connectSocket();
    try {
      const joined = waitForQuestions(socket, qs => qs.length === 2, 'legacy duplicate votes');
      socket.emit('identify', created.body.slug, 'same-user');
      socket.emit('joinDiscussion', created.body.slug);
      const current = (await joined)[0].votes[0];
      assert.equal(current.value, first, 'The client selects its first owned response as current');
      const undone = waitForQuestions(socket, qs => qs[0]?.resultsHidden === true, 'legacy vote undone');
      socket.emit('clearVote', created.body.slug, poll, 'same-user');
      await undone;
      const remaining = await pool.query('SELECT user_id, value FROM votes WHERE question_id = $1', [poll]);
      assert.deepEqual(remaining.rows, [{ user_id: 'other-user', value: first }]);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM votes WHERE question_id = $1', [brainstorm])).rows[0].count, 2);
    } finally {
      socket.disconnect();
    }
  });
}

test('request and vote logs omit credentials, identities, and answer contents', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('private-logs') });
  const { slug, adminToken } = created.body;
  const socket = await connectSocket();
  const privateId = crypto.randomBytes(16).toString('hex');
  const privateName = 'Private Log Name';
  const privateAnswer = 'private-answer-' + crypto.randomBytes(8).toString('hex');
  try {
    socket.emit('joinDiscussion', slug);
    const added = waitForQuestions(socket, qs => qs.length === 1, 'private question');
    socket.emit('addQuestion', slug, { text: 'Written answer', type: 'Open Ended' });
    const question = (await added)[0];
    const answered = waitForQuestions(socket, qs => qs[0]?.votes.length === 1, 'private answer');
    socket.emit('vote', slug, question.id, privateAnswer, privateId, privateName);
    await answered;
    await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken });
    await jsonRequest('GET', `/api/discussions?admin=${adminToken}`);
    // Exercise parser errors too: Express's default handler prints raw input.
    const malformed = await fetch(`${server.baseUrl}/api/discussions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: `{"secret":"${privateId}" invalid}`,
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: 'Invalid request' });
    // Invalid integer input creates a PostgreSQL error whose detail contains
    // the supplied value. It must keep a diagnostic code without the payload.
    const failed = waitForEvent(socket, 'error');
    socket.emit('vote', slug, privateAnswer, 'irrelevant', privateId, privateName);
    await failed;
    assert.match(server.output, /22P02/);
    for (const secret of [adminToken, privateId, privateName, privateAnswer]) {
      assert.equal(server.output.includes(secret), false, 'Sensitive value appeared in server logs');
    }
  } finally {
    socket.disconnect();
  }
});

test('Socket.IO adds questions and broadcasts votes with pseudonyms', async () => {
  const topic = uniqueTopic('socket');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    const authorInitialQuestions = waitForQuestions(author, (questions) => Array.isArray(questions), 'author join');
    author.emit('joinDiscussion', topic);
    assert.deepEqual(await authorInitialQuestions, []);

    const voterInitialQuestions = waitForQuestions(voter, (questions) => Array.isArray(questions), 'voter join');
    voter.emit('joinDiscussion', topic);
    assert.deepEqual(await voterInitialQuestions, []);

    const questionUpdate = waitForQuestions(
      author,
      (questions) => questions.length === 1 && questions[0].text === 'Should this harness exist?',
      'question broadcast'
    );

    author.emit('addQuestion', topic, {
      text: 'Should this harness exist?',
      type: 'Agreement',
      minValue: null,
      maxValue: null,
      options: [],
    });

    const questions = await questionUpdate;
    const question = questions[0];
    assert.equal(question.type, 'Agreement');
    assert.deepEqual(question.options, []);

    // Results reach participants who have answered, so the voter observes it.
    const voteUpdate = waitForQuestions(
      voter,
      (updatedQuestions) => updatedQuestions[0] && updatedQuestions[0].votes.length === 1,
      'vote broadcast'
    );

    voter.emit('vote', topic, question.id, 'Agree', 'user-1', 'Careful Tester');

    const updatedQuestions = await voteUpdate;
    const broadcastVote = updatedQuestions[0].votes[0];
    assert.equal(broadcastVote.value, 'Agree');
    assert.equal(broadcastVote.pseudonym, 'Careful Tester');
    // The broadcast must NOT carry the raw stable userId — that would let a
    // socket observer correlate a participant's responses across prompts. It
    // carries a per-response, non-reversible ownership token instead, keyed by
    // the vote's own row id.
    assert.equal('userId' in broadcastVote, false);
    assert.equal(broadcastVote.upvoters, undefined);
    const expectedToken = crypto
      .createHash('sha256')
      .update(`${broadcastVote.id}:user-1`)
      .digest('hex');
    assert.equal(broadcastVote.ownerToken, expectedToken);
    assert.deepEqual(broadcastVote.upvoterTokens, []);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('Yes/No questions record a single choice that only an explicit clear removes', async () => {
  const topic = uniqueTopic('yesno');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    const authorInitialQuestions = waitForQuestions(author, (questions) => Array.isArray(questions), 'author join');
    author.emit('joinDiscussion', topic);
    await authorInitialQuestions;
    voter.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(
      author,
      (questions) => questions.length === 1 && questions[0].text === 'Ship it?',
      'yes/no question broadcast'
    );
    author.emit('addQuestion', topic, {
      text: 'Ship it?',
      type: 'Yes/No',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];
    assert.equal(question.type, 'Yes/No');

    // Vote Yes.
    const yesUpdate = waitForQuestions(
      voter,
      (qs) => qs[0] && qs[0].votes.length === 1 && qs[0].votes[0].value === 'Yes',
      'yes vote'
    );
    voter.emit('vote', topic, question.id, 'Yes', 'yn-user', 'Decider');
    await yesUpdate;

    // Switching to No replaces the single choice rather than adding a row.
    const noUpdate = waitForQuestions(
      voter,
      (qs) => qs[0] && qs[0].votes.length === 1 && qs[0].votes[0].value === 'No',
      'switch to no'
    );
    voter.emit('vote', topic, question.id, 'No', 'yn-user', 'Decider');
    await noUpdate;

    // Re-selecting the current choice keeps it: a vote sets, it never toggles.
    const reselected = await new Promise((resolve) => {
      voter.emit('vote', topic, question.id, 'No', 'yn-user', 'Decider', undefined, resolve);
    });
    assert.deepEqual(reselected, { ok: true });
    assert.deepEqual(await storedVotes(question.id), [{ user_id: 'yn-user', value: 'No' }]);

    // Undo is its own action, and repeating it is harmless.
    const clearedUpdate = waitForQuestions(
      voter,
      (qs) => qs[0] && qs[0].votes.length === 0,
      'explicit clear'
    );
    voter.emit('clearVote', topic, question.id, 'yn-user');
    await clearedUpdate;
    const clearedAgain = await new Promise((resolve) => {
      voter.emit('clearVote', topic, question.id, 'yn-user', resolve);
    });
    assert.deepEqual(clearedAgain, { ok: true });
    assert.deepEqual(await storedVotes(question.id), []);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('Multiple Choice questions validate their options and accept only those options as votes', async () => {
  const topic = uniqueTopic('multiple-choice');
  const author = await connectSocket();
  const voter = await connectSocket();
  const pdoom = ['Higher', 'Lower', 'About the same'];

  try {
    const joined = waitForQuestions(author, (questions) => Array.isArray(questions), 'author join');
    author.emit('joinDiscussion', topic);
    await joined;
    voter.emit('joinDiscussion', topic);

    // Each malformed option list is refused before anything is stored.
    for (const options of [
      undefined,
      'Higher, Lower',
      ['Only one'],
      ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      ['Higher', '   '],
      ['Higher', 42],
      ['Higher', 'x'.repeat(101)],
      ['Higher', ' higher  '],
    ]) {
      const ack = await emitWithAck(author, 'addQuestion', topic,
        { text: 'Did your p(doom) change?', type: 'Multiple Choice', options }, true);
      assert.deepEqual(ack, { added: false, reason: 'invalid' }, `rejects ${JSON.stringify(options)}`);
    }
    const stored = await pool.query(
      "SELECT count(*)::int AS count FROM questions q JOIN discussions d ON d.id = q.discussion_id WHERE d.slug = $1",
      [topic]
    );
    assert.equal(stored.rows[0].count, 0);

    // Options are trimmed and kept in the author's order.
    const added = waitForQuestions(author, (qs) => qs.length === 1, 'multiple choice broadcast');
    const ack = await emitWithAck(author, 'addQuestion', topic, {
      text: 'In the last year, did your p(doom) get higher or lower?',
      type: 'Multiple Choice',
      options: ['  Higher ', 'Lower', '  ', 'About   the same'],
    }, true);
    assert.deepEqual(ack, { added: true });
    const question = (await added)[0];
    assert.equal(question.type, 'Multiple Choice');
    assert.deepEqual(question.options, pdoom);

    const vote = (value) => emitWithAck(voter, 'vote', topic, question.id, value, 'mc-user', 'Chooser', undefined);
    assert.deepEqual(await vote('Higher'), { ok: true });
    assert.deepEqual(await storedVotes(question.id), [{ user_id: 'mc-user', value: 'Higher' }]);

    // Switching replaces the single choice; re-selecting keeps it.
    assert.deepEqual(await vote('About the same'), { ok: true });
    assert.deepEqual(await vote('About the same'), { ok: true });
    assert.deepEqual(await storedVotes(question.id), [{ user_id: 'mc-user', value: 'About the same' }]);

    // Anything that is not one of this question's options is rejected,
    // including another type's options and a near-match.
    for (const invalid of ['Agree', 'Yes', 'higher', 'Higher ', '', null, ['Higher']]) {
      assert.deepEqual(await vote(invalid), { ok: false }, `rejects ${JSON.stringify(invalid)}`);
    }
    assert.deepEqual(await storedVotes(question.id), [{ user_id: 'mc-user', value: 'About the same' }]);

    // Undo is the explicit clear, as for the other single-choice types.
    assert.deepEqual(await emitWithAck(voter, 'clearVote', topic, question.id, 'mc-user'), { ok: true });
    assert.deepEqual(await storedVotes(question.id), []);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('Multiple Choice results stay hidden until a participant votes, and snapshots keep the options', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('mc-results') });
  const { id, slug, adminToken } = created.body;
  const inserted = await pool.query(
    `INSERT INTO questions (discussion_id, text, type, options)
     VALUES ($1, 'p(doom) over the last year?', 'Multiple Choice', $2) RETURNING id`,
    [id, JSON.stringify(['Higher', 'Lower', 'About the same'])]
  );
  const questionId = inserted.rows[0].id;
  await pool.query(
    `INSERT INTO votes (question_id, value, user_id, pseudonym) VALUES
      ($1, 'Higher', 'seed-a', 'Seed A'), ($1, 'Higher', 'seed-b', 'Seed B'), ($1, 'Lower', 'seed-c', 'Seed C')`,
    [questionId]
  );

  const { socket, questions } = await joinAs(slug, 'mc-newcomer');
  try {
    const hidden = byId(questions, questionId);
    assertResultsHidden(hidden, 'unanswered multiple choice');
    // The options are the question, not its results, so they stay visible.
    assert.deepEqual(hidden.options, ['Higher', 'Lower', 'About the same']);

    const shown = waitForQuestions(socket, qs => byId(qs, questionId)?.resultsHidden === false, 'results after voting');
    socket.emit('vote', slug, questionId, 'About the same', 'mc-newcomer', 'Newcomer');
    assertResultsShown(byId(await shown, questionId), ['Higher', 'Higher', 'Lower', 'About the same'], 'answered multiple choice');
  } finally {
    socket.disconnect();
  }

  // The summary reports per-option counts in the author's order and keeps the
  // question out of the agree/disagree rankings.
  const summary = (await jsonRequest('GET', `/api/discussions/${slug}/summary`, undefined, asModerator(adminToken))).body;
  const summarized = summary.questions.find(q => q.id === questionId);
  assert.deepEqual(summarized.options, ['Higher', 'Lower', 'About the same']);
  assert.deepEqual(summarized.optionCounts, { Higher: 2, Lower: 1, 'About the same': 1 });
  assert.deepEqual(summarized.leadingOptions, ['Higher']);
  assert.equal(summary.topDivisive.some(q => q.id === questionId), false);

  // Someone who has not answered gets the options, which are part of the
  // question, but no tallies.
  const hiddenSummary = (await jsonRequest('GET', `/api/discussions/${slug}/summary`, undefined, asUser('mc-stranger'))).body
    .questions.find(q => q.id === questionId);
  assert.deepEqual(hiddenSummary.options, ['Higher', 'Lower', 'About the same']);
  assert.equal(hiddenSummary.resultsHidden, true);
  assert.equal('optionCounts' in hiddenSummary || 'responseCount' in hiddenSummary || 'leadingOptions' in hiddenSummary, false);

  const url = `/api/discussions/${slug}/snapshots`;
  const saved = await jsonRequest('POST', url, { name: 'Before', adminToken });
  assert.equal(saved.status, 201);
  const snapshotQuestion = saved.body.data.questions.find(q => q.id === questionId);
  assert.deepEqual(snapshotQuestion.options, ['Higher', 'Lower', 'About the same']);
  assert.deepEqual(snapshotQuestion.optionCounts, { Higher: 2, Lower: 1, 'About the same': 1 });
  assert.equal(snapshotQuestion.responseCount, 4);

  // A participant who has not answered gets the snapshot without its tallies.
  const redacted = (await jsonRequest('GET', url, undefined, asUser('mc-stranger'))).body.snapshots[0];
  assert.deepEqual(redacted.data.questions.find(q => q.id === questionId),
    {
      id: questionId, text: 'p(doom) over the last year?', type: 'Multiple Choice',
      options: ['Higher', 'Lower', 'About the same'], resultsHidden: true,
    });

  // A moderator can reveal a Multiple Choice question's results to everyone.
  const moderator = await connectSocket();
  try {
    moderator.emit('joinDiscussion', slug);
    const revealed = waitForQuestions(moderator, qs => byId(qs, questionId)?.resultsRevealed === true, 'results revealed');
    moderator.emit('setResultsRevealed', slug, questionId, true, adminToken);
    await revealed;
  } finally {
    moderator.disconnect();
  }
  const strangerSummary = (await jsonRequest('GET', `/api/discussions/${slug}/summary`, undefined, asUser('mc-stranger'))).body;
  const revealedSummary = strangerSummary.questions.find(q => q.id === questionId);
  assert.notEqual(revealedSummary.resultsHidden, true);
  assert.deepEqual(revealedSummary.optionCounts, { Higher: 2, Lower: 1, 'About the same': 1 });
});

test('the CSV export preserves Multiple Choice option labels as literal strings', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('mc-csv-literals') });
  const { id, slug, adminToken } = created.body;
  const options = ['null', '"quoted"', '["A"]', '{"x":1}', 'true', '=SUM(A1)'];
  const inserted = await pool.query(
    'INSERT INTO questions (discussion_id, text, type, options) VALUES ($1, $2, $3, $4) RETURNING id',
    [id, 'Pick a literal label', 'Multiple Choice', JSON.stringify(options)]
  );
  for (const [index, value] of options.entries()) {
    await pool.query('INSERT INTO votes (question_id, value, user_id) VALUES ($1, $2, $3)',
      [inserted.rows[0].id, value, 'literal-voter-' + index]);
  }

  const response = await fetch(server.baseUrl + '/api/discussions/' + slug + '/export.csv', {
    headers: asModerator(adminToken),
  });
  assert.equal(response.status, 200);
  const csv = await response.text();
  const values = csv.split('\n').slice(1).map(line => {
    const fields = Array.from(line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g), match => match[1]);
    const value = fields[7];
    return value.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value;
  });
  // Literal JSON-looking labels survive unchanged; the existing CSV formula
  // neutralization still applies to a formula-looking option.
  assert.deepEqual(values, ['null', '"quoted"', '["A"]', '{"x":1}', 'true', "'=SUM(A1)"]);
});

test('cleanup waits for a pending vote before deleting its rows', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('cleanup-vote-order') });
  const question = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Pending vote', 'Agreement') RETURNING id", [created.body.id])).rows[0];
  const vote = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'pending-voter', 'Agree') RETURNING id", [question.id])).rows[0];
  const writer = await pool.connect();
  try {
    await writer.query('BEGIN');
    await writer.query('SELECT id FROM questions WHERE id = $1 FOR SHARE', [question.id]);
    // Start cleanup while a writer already holds the production parent lock.
    // Child-first cleanup takes the vote row then blocks on that parent,
    // forming a cycle when the writer updates the vote below.
    const cleaned = cleanupDiscussions(pool).then(() => ({ ok: true }), error => ({ ok: false, code: error.code }));
    await waitForQuestionLockWait();
    let written;
    try {
      await writer.query("UPDATE votes SET value = 'Disagree' WHERE id = $1", [vote.id]);
      await writer.query('COMMIT');
      written = { ok: true };
    } catch (error) {
      await writer.query('ROLLBACK');
      written = { ok: false, code: error.code };
    }
    assert.deepEqual([written, await cleaned], [{ ok: true }, { ok: true }]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM discussions')).rows[0].n, 0);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
  }
});

test('a vote is acknowledged promptly while other votes keep arriving', async () => {
  const seed = await seedResultsDiscussion('busy-room');
  const { socket: busy } = await joinAs(seed.slug, 'busy-voter');
  const { socket: voter } = await joinAs(seed.slug, 'patient-voter');
  let loading = true;
  // A vote every few milliseconds for two seconds, so a new request lands
  // during every send. An acknowledgment that waits for a quiet moment arrives
  // only after this stops.
  const stop = setTimeout(() => { loading = false; }, 2000);
  const pump = (async () => {
    for (let i = 0; loading; i += 1) {
      busy.emit('vote', seed.slug, seed.yesNo, i % 2 === 0 ? 'Yes' : 'No', 'busy-voter', 'Busy', undefined);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })();
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const started = Date.now();
    assert.deepEqual(await emitWithAck(voter, 'vote', seed.slug, seed.agreement, 'Agree', 'patient-voter', 'Patient', undefined), { ok: true });
    assert.equal(loading, true, 'acknowledged while the other votes were still arriving');
    assert.ok(Date.now() - started < 1500, `acknowledged in ${Date.now() - started} ms`);
  } finally {
    clearTimeout(stop);
    loading = false;
    await pump;
    busy.disconnect();
    voter.disconnect();
  }
});

// Regression for #72: on a slow connection a participant taps the same option
// twice and both emits arrive back to back. The vote must stay set.
for (const { type, first, second } of [
  { type: 'Agreement', first: 'Agree', second: 'Disagree' },
  { type: 'Yes/No', first: 'Yes', second: 'No' },
]) {
  test(`two identical ${type} vote emits in a row leave the vote set`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('double-tap') });
    const inserted = await pool.query(
      'INSERT INTO questions (discussion_id, text, type) VALUES ($1, $2, $3) RETURNING id',
      [created.body.id, 'Double tap', type]
    );
    const questionId = inserted.rows[0].id;
    const socket = await connectSocket();
    const vote = value => new Promise((resolve) => {
      socket.emit('vote', created.body.slug, questionId, value, 'double-tapper', 'Tapper', undefined, resolve);
    });
    try {
      // A first vote tapped twice.
      assert.deepEqual(await Promise.all([vote(first), vote(first)]), [{ ok: true }, { ok: true }]);
      assert.deepEqual(await storedVotes(questionId), [{ user_id: 'double-tapper', value: first }]);

      // The reported case: change the vote, tapping the new option twice.
      assert.deepEqual(await Promise.all([vote(second), vote(second)]), [{ ok: true }, { ok: true }]);
      assert.deepEqual(await storedVotes(questionId), [{ user_id: 'double-tapper', value: second }]);

      // A rejected vote is acknowledged as failed and changes nothing.
      assert.deepEqual(await vote('Maybe so'), { ok: false });
      assert.deepEqual(await storedVotes(questionId), [{ user_id: 'double-tapper', value: second }]);
    } finally {
      socket.disconnect();
    }
  });
}

test('clearing a vote only applies to single-choice polls in an unlocked discussion', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('clear-scope') });
  const inserted = await pool.query(
    `INSERT INTO questions (discussion_id, text, type) VALUES
     ($1, 'Opinion', 'Agreement'), ($1, 'Estimate', 'Numerical'), ($1, 'Ideas', 'Open Ended') RETURNING id`,
    [created.body.id]
  );
  const [agreement, numerical, brainstorm] = inserted.rows.map(row => row.id);
  await pool.query(
    `INSERT INTO votes (question_id, user_id, value) VALUES
     ($1, 'clearer', 'Agree'), ($1, 'bystander', 'Agree'), ($2, 'clearer', '7'), ($3, 'clearer', 'An idea')`,
    [agreement, numerical, brainstorm]
  );
  const socket = await connectSocket();
  const clear = (questionId, userId = 'clearer') => new Promise((resolve) => {
    socket.emit('clearVote', created.body.slug, questionId, userId, resolve);
  });
  try {
    assert.deepEqual(await clear(numerical), { ok: false });
    assert.deepEqual(await clear(brainstorm), { ok: false });
    assert.equal((await storedVotes(numerical)).length, 1);
    assert.equal((await storedVotes(brainstorm)).length, 1);

    await pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [created.body.id]);
    assert.deepEqual(await clear(agreement), { ok: false });
    assert.equal((await storedVotes(agreement)).length, 2);

    await pool.query('UPDATE discussions SET locked = FALSE WHERE id = $1', [created.body.id]);
    assert.deepEqual(await clear(agreement), { ok: true });
    // Only the caller's own vote goes; the socket is pinned to its first identity.
    assert.deepEqual(await storedVotes(agreement), [{ user_id: 'bystander', value: 'Agree' }]);
    assert.deepEqual(await clear(agreement, 'bystander'), { ok: true });
    assert.deepEqual(await storedVotes(agreement), [{ user_id: 'bystander', value: 'Agree' }]);
  } finally {
    socket.disconnect();
  }
});

test('a crafted Agreement/Yes-No vote with an unknown value is rejected, not stored', async () => {
  const topic = uniqueTopic('vote-validation');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const agreeAdded = waitForQuestions(author, (qs) => qs.some((q) => q.text === 'Agree?'), 'agreement added');
    author.emit('addQuestion', topic, { text: 'Agree?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const agree = (await agreeAdded).find((q) => q.text === 'Agree?');

    const ynAdded = waitForQuestions(author, (qs) => qs.some((q) => q.text === 'Ship?'), 'yes/no added');
    author.emit('addQuestion', topic, { text: 'Ship?', type: 'Yes/No', minValue: null, maxValue: null, options: [] });
    const yn = (await ynAdded).find((q) => q.text === 'Ship?');

    // "constructor" is an Object.prototype key — the kind of value that used to
    // slip through clustering's `in` check and corrupt the analysis.
    const agreeRejected = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, agree.id, 'constructor', 'attacker', 'Mallory');
    await agreeRejected;

    const ynRejected = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, yn.id, 'Maybe', 'attacker', 'Mallory');
    await ynRejected;

    // Nothing was written for either crafted value.
    const stored = await pool.query('SELECT COUNT(*)::int AS n FROM votes');
    assert.equal(stored.rows[0].n, 0);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('a Numerical vote outside the question range (or non-numeric) is rejected, not stored', async () => {
  const topic = uniqueTopic('numerical-validation');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const added = waitForQuestions(author, (qs) => qs.some((q) => q.text === 'Budget?'), 'numerical added');
    author.emit('addQuestion', topic, { text: 'Budget?', type: 'Numerical', minValue: 0, maxValue: 10, options: [] });
    const question = (await added).find((q) => q.text === 'Budget?');

    // An out-of-range value is rejected server-side: the range is otherwise only
    // enforced at create/edit time, so an unchecked vote would silently skew the
    // average / std-dev / spread shown in the summary.
    const tooHigh = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, question.id, '999', 'attacker', 'Mallory');
    await tooHigh;

    // A non-numeric value is rejected too.
    const notNumeric = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, question.id, 'lots', 'attacker', 'Mallory');
    await notNumeric;

    // Payloads that Number() silently coerces to 0 ('' and []) must NOT slip
    // through just because this question's range includes 0.
    const blank = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, question.id, '', 'attacker', 'Mallory');
    await blank;

    const nonScalar = waitForEvent(voter, 'error', (e) => /invalid vote/i.test(e.message));
    voter.emit('vote', topic, question.id, [], 'attacker', 'Mallory');
    await nonScalar;

    // None of the crafted values were written.
    const rejected = await pool.query('SELECT COUNT(*)::int AS n FROM votes');
    assert.equal(rejected.rows[0].n, 0);

    // An in-range value is accepted and stored normally.
    const accepted = waitForQuestions(
      voter,
      (qs) => qs[0] && qs[0].votes.length === 1,
      'in-range vote broadcast'
    );
    voter.emit('vote', topic, question.id, '5', 'good-user', 'Honest Heron');
    assert.equal((await accepted)[0].votes[0].value, '5');
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('a Numerical vote may be a decimal and is stored to two places', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('numerical-decimals') });
  const { slug, adminToken } = created.body;
  const first = await connectSocket();
  const second = await connectSocket();
  try {
    first.emit('joinDiscussion', slug);
    const added = waitForQuestions(first, qs => qs.some(q => q.text === 'Chance of rain?'), 'numerical added');
    first.emit('addQuestion', slug, { text: 'Chance of rain?', type: 'Numerical', minValue: 0, maxValue: 100, options: [] });
    const question = (await added).find(q => q.text === 'Chance of rain?');

    // A probability below 1% keeps its value instead of becoming 0 or 1.
    assert.deepEqual(await emitWithAck(first, 'vote', slug, question.id, 0.5, 'decimal-a', 'A', undefined), { ok: true });
    // More precision than two places is rounded, whether sent as a number or text.
    assert.deepEqual(await emitWithAck(second, 'vote', slug, question.id, '33.337', 'decimal-b', 'B', undefined), { ok: true });
    assert.deepEqual((await storedVotes(question.id)).map(vote => vote.value), ['0.5', '33.34']);

    // Rounding cannot carry an answer past the bounds, and the bounds still hold.
    const tooHigh = waitForEvent(second, 'error', e => /invalid vote/i.test(e.message));
    second.emit('vote', slug, question.id, 100.004, 'decimal-b', 'B');
    await tooHigh;
    assert.deepEqual(await emitWithAck(second, 'vote', slug, question.id, 99.999, 'decimal-b', 'B', undefined), { ok: true });
    assert.deepEqual((await storedVotes(question.id)).map(vote => vote.value), ['0.5', '100']);

    // Averages and snapshots are built from the decimals, not from truncated values.
    const saved = await jsonRequest('POST', `/api/discussions/${slug}/snapshots`, { name: 'Decimals', adminToken });
    const snapshot = saved.body.data.questions.find(q => q.id === question.id);
    assert.equal(snapshot.average, 50.25);
    assert.equal(snapshot.distribution[0].count, 1);
    assert.equal(snapshot.distribution[9].count, 1);
    const summary = await jsonRequest('GET', `/api/discussions/${slug}/summary`, undefined, asModerator(adminToken));
    const summarized = summary.body.questions.find(q => q.id === question.id);
    assert.equal(summarized.average, 50.25);
    assert.equal(summarized.minResponse, 0.5);
  } finally {
    first.disconnect();
    second.disconnect();
  }
});
