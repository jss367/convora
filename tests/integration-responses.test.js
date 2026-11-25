const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createVoteStore } = require('../votes');
const { initializeDatabase } = require('../database');
const {
  useIntegrationServer,
  addBrainstormQuestion,
  jsonRequest,
  connectSocket,
  startServer,
  stopServer,
  waitForQuestions,
  emitWithAck,
  uniqueTopic,
  waitForQuestionLockWait,
  joinAs,
} = require('./helpers/integration.cjs');

const server = useIntegrationServer(__filename);
const { pool } = server;

test('repeated responses are accepted from the same or different participants', async () => {
  const topic = uniqueTopic('brainstorm-duplicates');
  const first = await connectSocket();
  const second = await connectSocket();

  try {
    first.emit('joinDiscussion', topic);
    second.emit('joinDiscussion', topic);
    const question = await addBrainstormQuestion(first, topic, 'How can students explore careers?');
    const other = await addBrainstormQuestion(first, topic, 'What else would help?');
    const vote = (socket, questionId, value, userId) =>
      emitWithAck(socket, 'vote', topic, questionId, value, userId, 'Name', 'custom');

    assert.deepEqual(
      await vote(first, question.id, 'Internships and job shadowing', 'user-one'), { ok: true, added: true });
    // Another participant and the original author can both repeat an idea.
    assert.deepEqual(
      await vote(second, question.id, '  internships   and JOB\tshadowing ', 'user-two'),
      { ok: true, added: true });
    assert.deepEqual(
      await vote(first, question.id, 'Internships and job shadowing', 'user-one'),
      { ok: true, added: true });
    // A different idea, and the same idea on another prompt, are still accepted.
    assert.deepEqual(await vote(second, question.id, 'Internships', 'user-two'), { ok: true, added: true });
    assert.deepEqual(
      await vote(second, other.id, 'Internships and job shadowing', 'user-two'), { ok: true, added: true });

    const stored = await pool.query(
      'SELECT question_id, value FROM votes WHERE question_id = ANY($1) ORDER BY id', [[question.id, other.id]]);
    assert.deepEqual(stored.rows, [
      { question_id: question.id, value: 'Internships and job shadowing' },
      { question_id: question.id, value: 'internships   and JOB\tshadowing' },
      { question_id: question.id, value: 'Internships and job shadowing' },
      { question_id: question.id, value: 'Internships' },
      { question_id: other.id, value: 'Internships and job shadowing' },
    ]);
  } finally {
    first.disconnect();
    second.disconnect();
  }
});

test('free-text limits serialize writes; retries, edits, and identical contributions remain independent', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('response-limits') });
  const inserted = await pool.query("INSERT INTO questions (discussion_id, text, type, max_responses) VALUES ($1, 'Responses', 'Open Ended', 2) RETURNING id", [created.body.id]);
  const id = inserted.rows[0].id;
  const store = createVoteStore(pool);
  const write = (requestId, user = 'author') => store.addVote(id, { text: 'Same text', requestId }, user, 'Author');
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => write(`request-${i}`)));
  assert.equal(results.filter(r => r.added).length, 2);
  assert.equal(results.filter(r => r.reason === 'limit').length, 6);
  const rows = (await pool.query('SELECT * FROM votes WHERE question_id = $1 ORDER BY id', [id])).rows;
  assert.deepEqual(await write(rows[0].request_id), { added: false, repeated: true });
  assert.deepEqual(await write('another-author', 'other'), { added: true });
  assert.deepEqual(await store.addVote(id, { text: 'Edited', responseId: rows[0].id }, 'other', 'Other'), { added: false, updated: false });
  assert.deepEqual(await store.addVote(id, { text: 'Edited', responseId: rows[0].id }, 'author', 'Author'), { added: false, updated: true });
  assert.equal((await pool.query('SELECT value FROM votes WHERE id = $1', [rows[0].id])).rows[0].value, 'Edited');
});

test('response settings persist, copy, validate, and hide attribution on public payloads', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('response-settings') });
  const { socket } = await joinAs(created.body.slug, 'settings-author');
  try {
    const payload = { text: 'Private authors', type: 'Open Ended', maxResponses: 3, showAttribution: false };
    assert.equal((await emitWithAck(socket, 'addQuestion', created.body.slug, payload, false, created.body.adminToken)).added, true);
    const question = (await pool.query('SELECT * FROM questions WHERE discussion_id = $1', [created.body.id])).rows[0];
    assert.equal(question.max_responses, 3);
    assert.equal(question.show_attribution, false);
    const update = waitForQuestions(socket, qs => qs[0]?.votes.length === 1, 'anonymous response');
    await emitWithAck(socket, 'vote', created.body.slug, question.id, { text: 'Response', requestId: 'one' }, 'settings-author', 'Secret author', 'custom');
    const questions = await update;
    assert.equal(questions[0].maxResponses, 3);
    assert.equal(questions[0].showAttribution, false);
    assert.equal(questions[0].votes[0].pseudonym, null);
    const copy = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: created.body.slug, newTopic: uniqueTopic('response-copy') });
    const copied = (await pool.query('SELECT max_responses, show_attribution FROM questions WHERE discussion_id = $1', [(await pool.query('SELECT id FROM discussions WHERE slug = $1', [copy.body.newSlug])).rows[0].id])).rows[0];
    assert.deepEqual(copied, { max_responses: 3, show_attribution: false });
  } finally { socket.disconnect(); }
});

test('a legacy Brainstorm creation keeps response authors hidden on socket and CSV views', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-brainstorm-privacy') });
  const { socket } = await joinAs(created.body.slug, 'legacy-author');
  try {
    assert.equal((await emitWithAck(socket, 'addQuestion', created.body.slug, { text: 'Legacy ideas', type: 'Brainstorm' }, false, created.body.adminToken)).added, true);
    const question = (await pool.query('SELECT id, type, show_attribution FROM questions WHERE discussion_id = $1', [created.body.id])).rows[0];
    assert.equal(question.type, 'Open Ended');
    assert.equal(question.show_attribution, false);
    const update = waitForQuestions(socket, qs => qs.some(q => q.id === question.id && q.votes.length === 1), 'legacy anonymous response');
    await emitWithAck(socket, 'vote', created.body.slug, question.id, 'Legacy contribution', 'legacy-author', 'Legacy Secret Author', 'custom');
    assert.equal((await update).find(q => q.id === question.id).votes[0].pseudonym, null);
    const csv = await fetch(`${server.baseUrl}/api/discussions/${created.body.slug}/export.csv`);
    assert.equal((await csv.text()).includes('Legacy Secret Author'), false);
  } finally { socket.disconnect(); }
});

test('legacy scalar answers update single-response questions but keep unlimited response creation', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-scalar-update') });
  const questions = (await pool.query("INSERT INTO questions (discussion_id, text, type, max_responses) VALUES ($1, 'Legacy written', 'Open Ended', 1), ($1, 'Former ideas', 'Open Ended', NULL) RETURNING id", [created.body.id])).rows;
  const store = createVoteStore(pool);
  await store.addVote(questions[0].id, 'Original', 'author', 'Author');
  assert.deepEqual(await store.addVote(questions[0].id, 'Updated scalar', 'author', 'Author'), { added: false, updated: true });
  assert.deepEqual((await pool.query('SELECT value FROM votes WHERE question_id = $1', [questions[0].id])).rows, [{ value: 'Updated scalar' }]);
  assert.equal((await store.addVote(questions[0].id, { text: 'New object response', requestId: 'new-create' }, 'author', 'Author')).reason, 'limit');
  await store.addVote(questions[1].id, 'First idea', 'author', 'Author');
  await store.addVote(questions[1].id, 'Second idea', 'author', 'Author');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM votes WHERE question_id = $1', [questions[1].id])).rows[0].n, 2);
});

test('a legacy upvote waiting for a moderator lock changes neither feedback store', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-lock-race') });
  await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE WHERE id = $1', [created.body.id]);
  const q = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Locked feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
  const vote = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'Keep locked') RETURNING id", [q.id])).rows[0];
  const { socket } = await joinAs(created.body.slug, 'legacy-voter');
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [created.body.id]);
    const update = waitForQuestions(socket, qs => qs.find(question => question.id === q.id)?.votes[0]?.upvotes === 0, 'toggle after lock commits');
    socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
    await waitForQuestionLockWait();
    await blocker.query('COMMIT');
    await update;
    for (const table of ['response_votes', 'response_ratings']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE response_id = $1`, [vote.id])).rows[0].n, 0);
    }
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    socket.disconnect();
  }
});

test('legacy upvote toggles and new quality ratings stay synchronized after migration', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-feedback-sync') });
  await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE WHERE id = $1', [created.body.id]);
  const question = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
  const vote = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'Keep feedback') RETURNING id", [question.id])).rows[0];
  const { socket } = await joinAs(created.body.slug, 'legacy-voter');
  const rating = async () => (await pool.query('SELECT quality, agreement FROM response_ratings WHERE response_id = $1 AND user_id = $2', [vote.id, 'legacy-voter'])).rows[0];
  try {
    let update = waitForQuestions(socket, qs => qs[0]?.votes[0]?.upvotes === 1, 'legacy upvote added');
    socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
    await update;
    assert.equal((await rating())?.quality, 1);
    await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE WHERE id = $1', [created.body.id]);
    update = waitForQuestions(socket, qs => qs[0]?.votes[0]?.qualityDown === 1, 'new quality downvote');
    socket.emit('setResponseRating', created.body.slug, vote.id, 'quality', -1, 'legacy-voter');
    assert.equal((await update)[0].votes[0].upvotes, 0);
    await pool.query("UPDATE response_ratings SET agreement = 'Agree' WHERE response_id = $1", [vote.id]);
    update = waitForQuestions(socket, qs => qs[0]?.votes[0]?.qualityUp === 1, 'legacy upvote after new rating');
    socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
    await update;
    assert.deepEqual(await rating(), { quality: 1, agreement: 'Agree' });
    update = waitForQuestions(socket, qs => qs[0]?.votes[0]?.upvotes === 0 && qs[0]?.votes[0]?.qualityUp === 0, 'legacy upvote removed');
    socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
    await update;
    assert.deepEqual(await rating(), { quality: null, agreement: 'Agree' });
    await pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [created.body.id]);
    update = waitForQuestions(socket, qs => qs[0]?.votes[0]?.upvotes === 0, 'locked legacy upvote rejected');
    socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
    await update;
    assert.deepEqual(await rating(), { quality: null, agreement: 'Agree' });
  } finally { socket.disconnect(); }
});

test('unified response migration preserves attribution, limits and upvotes without resetting later changes', async () => {
  await stopServer();
  try {
    await pool.query('DROP TABLE schema_migrations; ALTER TABLE questions DROP COLUMN max_responses, DROP COLUMN show_attribution');
    const d = (await pool.query("INSERT INTO discussions (topic, slug) VALUES ('Migration', 'migration') RETURNING id")).rows[0].id;
    const qs = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Written', 'Open Ended'), ($1, 'Ideas', 'Brainstorm') RETURNING id", [d])).rows;
    const v = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'Keep me') RETURNING id", [qs[0].id])).rows[0].id;
    await pool.query("INSERT INTO response_votes (response_id, user_id) VALUES ($1, 'voter')", [v]);
    await pool.query("INSERT INTO response_votes (response_id, user_id) VALUES ($1, 'agreement-voter'), ($1, 'quality-voter')", [v]);
    await pool.query("INSERT INTO response_ratings (response_id, user_id, quality, agreement) VALUES ($1, 'agreement-voter', NULL, 'Agree'), ($1, 'quality-voter', -1, 'Disagree')", [v]);
    await initializeDatabase(pool);
    const migrated = (await pool.query('SELECT type, max_responses, show_attribution FROM questions WHERE discussion_id = $1 ORDER BY id', [d])).rows;
    assert.deepEqual(migrated, [{ type: 'Open Ended', max_responses: 1, show_attribution: true }, { type: 'Open Ended', max_responses: null, show_attribution: false }]);
    assert.equal((await pool.query("SELECT quality FROM response_ratings WHERE response_id = $1 AND user_id = 'voter'", [v])).rows[0].quality, 1);
    assert.deepEqual((await pool.query("SELECT user_id, quality, agreement FROM response_ratings WHERE response_id = $1 AND user_id <> 'voter' ORDER BY user_id", [v])).rows,
      [{ user_id: 'agreement-voter', quality: 1, agreement: 'Agree' }, { user_id: 'quality-voter', quality: -1, agreement: 'Disagree' }]);
    await pool.query('UPDATE questions SET max_responses = 4 WHERE id = $1', [qs[0].id]);
    await initializeDatabase(pool);
    assert.equal((await pool.query('SELECT max_responses FROM questions WHERE id = $1', [qs[0].id])).rows[0].max_responses, 4);
  } finally { await startServer(); }
});

test('hidden feedback redacts legacy aliases of positive quality ratings', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('hidden-quality-alias') });
  const question = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
  const vote = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'Answer') RETURNING id", [question.id])).rows[0];
  await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE WHERE id = $1', [created.body.id]);
  const { socket } = await joinAs(created.body.slug, 'critic');
  try {
    const rated = waitForQuestions(socket, qs => qs[0]?.votes[0]?.qualityUp === 1, 'quality rating recorded');
    socket.emit('setResponseRating', created.body.slug, vote.id, 'quality', 1, 'critic');
    const visible = (await rated)[0].votes[0];
    assert.equal(visible.upvotes, 1);
    assert.equal(visible.upvoterTokens.length, 1);
    for (const enabled of [true, false]) {
      await pool.query('UPDATE discussions SET reactions_visible = FALSE, reactions_enabled = $2 WHERE id = $1', [created.body.id, enabled]);
      const visitor = await joinAs(created.body.slug, 'observer');
      try {
        const hidden = visitor.questions[0].votes[0];
        assert.equal(hidden.upvotes, 0);
        assert.deepEqual(hidden.upvoterTokens, []);
        assert.equal(hidden.qualityUp, undefined);
        assert.equal(hidden.upvoters, undefined);
      } finally { visitor.socket.disconnect(); }
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM response_votes WHERE response_id = $1', [vote.id])).rows[0].n, 1);
  } finally { socket.disconnect(); }
});

for (const [enabled, visible] of [[false, true], [true, false], [false, false]]) {
  test(`legacy upvotes cannot add or remove feedback when enabled=${enabled}, visible=${visible}`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('legacy-feedback-flags') });
    const q = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
    const vote = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'Answer') RETURNING id", [q.id])).rows[0];
    await pool.query('UPDATE discussions SET reactions_enabled = $2, reactions_visible = $3 WHERE id = $1', [created.body.id, enabled, visible]);
    const { socket } = await joinAs(created.body.slug, 'legacy-voter');
    try {
      for (const existing of [false, true]) {
        if (existing) {
          await pool.query("INSERT INTO response_votes (response_id, user_id) VALUES ($1, 'legacy-voter')", [vote.id]);
          await pool.query("INSERT INTO response_ratings (response_id, user_id, quality, agreement) VALUES ($1, 'legacy-voter', 1, 'Agree')", [vote.id]);
        }
        // This handler always broadcasts after completing, including rejection.
        const update = waitForQuestions(socket, qs => qs[0]?.id === q.id, 'legacy toggle completed');
        socket.emit('toggleResponseVote', created.body.slug, vote.id, 'legacy-voter');
        await update;
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM response_votes WHERE response_id = $1', [vote.id])).rows[0].n, existing ? 1 : 0);
        assert.deepEqual((await pool.query('SELECT quality, agreement FROM response_ratings WHERE response_id = $1', [vote.id])).rows,
          existing ? [{ quality: 1, agreement: 'Agree' }] : []);
      }
    } finally { socket.disconnect(); }
  });
}
