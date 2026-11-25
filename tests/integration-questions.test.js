const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { initializeDatabase } = require('../database');
const {
  useIntegrationServer,
  claimModerator,
  jsonRequest,
  connectSocket,
  startServer,
  stopServer,
  waitForQuestions,
  emitWithAck,
  waitForEvent,
  uniqueTopic,
  seedResultsDiscussion,
  asModerator,
  asUser,
  byId,
  nextQuestions,
  joinAs,
  joinDisplay,
  joinAsModerator,
} = require('./helpers/integration.cjs');

const server = useIntegrationServer(__filename);
const { pool } = server;

const interestCount = async questionId =>
  (await pool.query('SELECT count(*)::int AS n FROM question_interest WHERE question_id = $1', [questionId])).rows[0].n;

test('a moderator can edit a question to Multiple Choice, and options are saved with the edit', async () => {
  const topic = uniqueTopic('edit-mc');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    const added = waitForQuestions(mod, (qs) => qs.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Agree?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await added)[0];
    assert.deepEqual(question.options, []);

    // Missing or invalid options make the edit invalid.
    const invalid = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Which?', type: 'Multiple Choice', options: ['Only one'] }, token);
    assert.deepEqual(invalid, { updated: false, reason: 'invalid' });

    const toChoice = waitForQuestions(mod, (qs) => qs[0]?.type === 'Multiple Choice', 'edit to multiple choice');
    const ack = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Which?', type: 'Multiple Choice', options: ['Red', 'Blue'] }, token);
    assert.equal(ack.updated, true);
    assert.deepEqual((await toChoice)[0].options, ['Red', 'Blue']);

    // Switching away clears the options, so a stale list cannot linger.
    const back = waitForQuestions(mod, (qs) => qs[0]?.type === 'Yes/No', 'edit back to yes/no');
    await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Yes?', type: 'Yes/No', options: ['Red', 'Blue'] }, token);
    assert.deepEqual((await back)[0].options, []);
  } finally {
    mod.disconnect();
  }
});

test('crafted invalid questions are rejected, not stored', async () => {
  const topic = uniqueTopic('question-validation');
  const author = await connectSocket();

  async function expectInvalidQuestion(payload) {
    const error = waitForEvent(author, 'error', (e) => /invalid question/i.test(e.message));
    const ack = await new Promise((resolve) => {
      author.emit('addQuestion', topic, payload, false, null, resolve);
    });
    await error;
    assert.deepEqual(ack, { added: false, reason: 'invalid' });
  }

  try {
    const initialQuestions = waitForQuestions(author, (questions) => Array.isArray(questions), 'author join');
    author.emit('joinDiscussion', topic);
    await initialQuestions;

    await expectInvalidQuestion({ text: '', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    await expectInvalidQuestion({ text: 'Mystery?', type: 'NotAType', minValue: null, maxValue: null, options: [] });
    await expectInvalidQuestion({ text: 'Budget?', type: 'Numerical', minValue: 10, maxValue: 0, options: [] });

    const stored = await pool.query('SELECT COUNT(*)::int AS n FROM questions');
    assert.equal(stored.rows[0].n, 0);
  } finally {
    author.disconnect();
  }
});

test('a moderator can edit a question before anyone responds', async () => {
  const topic = uniqueTopic('edit-question');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    const added = waitForQuestions(mod, (qs) => qs.some((q) => q.text === 'Typoo?'), 'question added');
    mod.emit('addQuestion', topic, { text: 'Typoo?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await added).find((q) => q.text === 'Typoo?');

    // Edit both the wording and the type (to Numerical, so min/max are applied).
    const editedUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].text === 'Pick a budget', 'edit broadcast');
    const ack = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Pick a budget', type: 'Numerical', minValue: 0, maxValue: 10 }, token);
    assert.equal(ack.updated, true);

    const edited = (await editedUpdate)[0];
    assert.equal(edited.text, 'Pick a budget');
    assert.equal(edited.type, 'Numerical');
    assert.equal(edited.minValue, 0);
    assert.equal(edited.maxValue, 10);
  } finally {
    mod.disconnect();
  }
});

test('a moderator can edit a question to and from the Yes/No type', async () => {
  const topic = uniqueTopic('edit-yesno');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    const added = waitForQuestions(mod, (qs) => qs.some((q) => q.text === 'Agree?'), 'question added');
    mod.emit('addQuestion', topic, { text: 'Agree?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await added).find((q) => q.text === 'Agree?');

    // Switching an unanswered question to Yes/No must be accepted (Yes/No is a
    // valid type, so the server-side edit validation has to allow it).
    const toYesNo = waitForQuestions(mod, (qs) => qs[0] && qs[0].type === 'Yes/No', 'edit to Yes/No');
    const ack = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Yes or no?', type: 'Yes/No' }, token);
    assert.equal(ack.updated, true);

    const edited = (await toYesNo)[0];
    assert.equal(edited.text, 'Yes or no?');
    assert.equal(edited.type, 'Yes/No');

    // Editing an existing Yes/No question (its form always re-submits type:
    // 'Yes/No') must likewise succeed rather than be rejected as invalid.
    const reword = waitForQuestions(mod, (qs) => qs[0] && qs[0].text === 'Yes or no, really?', 'reword broadcast');
    const ack2 = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Yes or no, really?', type: 'Yes/No' }, token);
    assert.equal(ack2.updated, true);
    assert.equal((await reword)[0].type, 'Yes/No');
  } finally {
    mod.disconnect();
  }
});

test('editing a question is refused once it has responses', async () => {
  const topic = uniqueTopic('edit-locked');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    const added = waitForQuestions(mod, (qs) => qs.some((q) => q.text === 'Keep cars?'), 'question added');
    mod.emit('addQuestion', topic, { text: 'Keep cars?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await added).find((q) => q.text === 'Keep cars?');

    const voted = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'vote recorded');
    participant.emit('vote', topic, question.id, 'Agree', 'user-voter', 'Voter');
    await voted;

    const ack = await emitWithAck(mod, 'editQuestion', topic, question.id,
      { text: 'Restrict cars?', type: 'Agreement' }, token);
    assert.equal(ack.updated, false);
    assert.equal(ack.reason, 'has_responses');

    // The original wording must be untouched — the response was made against it.
    const row = await pool.query('SELECT text FROM questions WHERE id = $1', [question.id]);
    assert.equal(row.rows[0].text, 'Keep cars?');
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('a non-moderator cannot edit a question', async () => {
  const topic = uniqueTopic('edit-authz');
  const mod = await connectSocket();
  const stranger = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    await claimModerator(mod, topic);

    const added = waitForQuestions(mod, (qs) => qs.some((q) => q.text === 'Original?'), 'question added');
    mod.emit('addQuestion', topic, { text: 'Original?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await added).find((q) => q.text === 'Original?');

    const ack = await emitWithAck(stranger, 'editQuestion', topic, question.id,
      { text: 'Hijacked?', type: 'Agreement' }, 'bogus-token');
    assert.equal(ack.updated, false);
    assert.equal(ack.reason, 'not_authorized');

    const row = await pool.query('SELECT text FROM questions WHERE id = $1', [question.id]);
    assert.equal(row.rows[0].text, 'Original?');
  } finally {
    mod.disconnect();
    stranger.disconnect();
  }
});

test('question downvotes require moderator opt-in and share one vote with upvotes', async () => {
  const seed = await seedResultsDiscussion('optional-downvotes');
  const { socket } = await joinAs(seed.slug, 'downvoter');
  const vote = direction => emitWithAck(socket, 'setQuestionInterest', seed.slug, seed.agreement, direction, 'downvoter');
  const recover = () => emitWithAck(socket, 'getQuestionInterestState', seed.slug, seed.agreement, 'downvoter');
  const enable = async enabled => {
    const changed = waitForEvent(socket, 'discussionState', state => state.questionDownvotesEnabled === enabled);
    socket.emit('setDiscussionFlags', seed.slug, { question_downvotes_enabled: enabled }, seed.adminToken);
    await changed;
  };
  try {
    const refused = waitForEvent(socket, 'error');
    socket.emit('setDiscussionFlags', seed.slug, { question_downvotes_enabled: true }, 'not-the-moderator');
    await refused;
    assert.deepEqual(await vote('down'), { updated: false });
    await enable(true);
    const broadcast = waitForQuestions(socket, qs => byId(qs, seed.agreement).downvoteCount === 1, 'downvote');
    assert.deepEqual(await vote('down'), { updated: true });
    const question = byId(await broadcast, seed.agreement);
    assert.deepEqual(question.downvoterTokens, [crypto.createHash('sha256').update(`question:${seed.agreement}:downvoter`).digest('hex')]);
    assert.equal(question.interestCount, 0);
    assert.deepEqual(await recover(), { interested: false, downvoted: true });
    await enable(false);
    assert.deepEqual(await recover(), { interested: false, downvoted: false });
    assert.deepEqual(await vote('down'), { updated: false });
    assert.deepEqual(await vote(true), { updated: true });
    await enable(true);
    assert.deepEqual(await recover(), { interested: true, downvoted: false });
    assert.equal(await interestCount(seed.agreement), 1);
    await pool.query('UPDATE discussions SET locked = TRUE WHERE id=$1', [seed.id]);
    assert.deepEqual(await vote('down'), { updated: false });
  } finally { socket.disconnect(); }
});

test('participants mark questions as interesting; counts broadcast with tokens instead of user ids', async () => {
  const seed = await seedResultsDiscussion('interest');
  const tokenFor = (questionId, userId) =>
    crypto.createHash('sha256').update(`question:${questionId}:${userId}`).digest('hex');
  const { socket: first, questions: initial } = await joinAs(seed.slug, 'interest-a');
  const { socket: second } = await joinAs(seed.slug, 'interest-b');
  try {
    for (const question of initial) {
      assert.equal(question.interestCount, 0);
      assert.deepEqual(question.interestVoterTokens, []);
    }

    // The count reaches a participant who has not answered the question, whose
    // results are still hidden from them.
    let broadcast = waitForQuestions(second, qs => byId(qs, seed.agreement).interestCount === 1, 'first interest');
    assert.deepEqual(await emitWithAck(first, 'setQuestionInterest', seed.slug, seed.agreement, true, 'interest-a'), { updated: true });
    let question = byId(await broadcast, seed.agreement);
    assert.equal(question.resultsHidden, true);
    assert.deepEqual(question.interestVoterTokens, [tokenFor(seed.agreement, 'interest-a')]);

    // Repeating the same request changes nothing.
    assert.deepEqual(await emitWithAck(first, 'setQuestionInterest', seed.slug, seed.agreement, true, 'interest-a'), { updated: true });
    assert.equal(await interestCount(seed.agreement), 1);

    broadcast = waitForQuestions(first, qs => byId(qs, seed.agreement).interestCount === 2, 'second interest');
    // The socket's pinned identity is used, not the id named in the message.
    assert.deepEqual(await emitWithAck(second, 'setQuestionInterest', seed.slug, seed.agreement, true, 'interest-a'), { updated: true });
    const questions = await broadcast;
    question = byId(questions, seed.agreement);
    assert.deepEqual(question.interestVoterTokens, [tokenFor(seed.agreement, 'interest-a'), tokenFor(seed.agreement, 'interest-b')]);
    assert.equal(byId(questions, seed.written).interestCount, 0);
    assert.equal('interest_voters' in question, false);
    assert.doesNotMatch(JSON.stringify(questions), /interest-a|interest-b/);

    broadcast = waitForQuestions(second, qs => byId(qs, seed.agreement).interestCount === 1, 'interest removed');
    assert.deepEqual(await emitWithAck(first, 'setQuestionInterest', seed.slug, seed.agreement, false, 'interest-a'), { updated: true });
    assert.deepEqual(byId(await broadcast, seed.agreement).interestVoterTokens, [tokenFor(seed.agreement, 'interest-b')]);
  } finally {
    first.disconnect();
    second.disconnect();
  }
});

test('interest marks are refused for other discussions, bad payloads, room displays and locked discussions', async () => {
  const seed = await seedResultsDiscussion('interest-guards');
  const other = await seedResultsDiscussion('interest-other');
  const { socket } = await joinAs(seed.slug, 'interest-guard');
  const display = await connectSocket();
  try {
    const refused = { updated: false };
    // A question id from another discussion does not match this room.
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, other.agreement, true, 'interest-guard'), refused);
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, String(seed.agreement), true, 'interest-guard'), refused);
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, seed.agreement, 'yes', 'interest-guard'), refused);
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, 2147483648, true, 'interest-guard'), refused);

    const joined = nextQuestions(display, 'display join');
    display.emit('joinDisplay', seed.slug);
    await joined;
    assert.equal((await emitWithAck(display, 'setQuestionInterest', seed.slug, seed.agreement, true, 'interest-display')).error, 'display_read_only');

    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, seed.written, true, 'interest-guard'), { updated: true });
    const locked = waitForEvent(socket, 'discussionState', state => state.locked === true);
    socket.emit('setLocked', seed.slug, true, seed.adminToken);
    await locked;
    // Locking closes voting: marks can be neither added nor removed.
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, seed.agreement, true, 'interest-guard'), refused);
    assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, seed.written, false, 'interest-guard'), refused);

    assert.equal(await interestCount(seed.agreement), 0);
    assert.equal(await interestCount(seed.written), 1);
    assert.equal(await interestCount(other.agreement), 0);
  } finally {
    socket.disconnect();
    display.disconnect();
  }
});

test('deleting a question or its discussion removes the interest marks', async () => {
  const seed = await seedResultsDiscussion('interest-delete');
  const { socket } = await joinAs(seed.slug, 'interest-deleter');
  try {
    for (const id of [seed.agreement, seed.written]) {
      assert.deepEqual(await emitWithAck(socket, 'setQuestionInterest', seed.slug, id, true, 'interest-deleter'), { updated: true });
    }
    const removed = waitForQuestions(socket, qs => !byId(qs, seed.agreement), 'question deleted');
    socket.emit('deleteQuestion', seed.slug, seed.agreement, seed.adminToken);
    await removed;
    assert.equal(await interestCount(seed.agreement), 0);
    assert.equal(await interestCount(seed.written), 1);

    assert.equal((await jsonRequest('DELETE', `/api/discussions/${seed.slug}`, { adminToken: seed.adminToken })).status, 200);
    assert.equal(await interestCount(seed.written), 0);
  } finally {
    socket.disconnect();
  }
});

test('duplicating a room leaves pending suggestions behind but keeps published suggestions and authorized moderator drafts', async () => {
  const { id, slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('suggestion-source') })).body;
  await pool.query(`INSERT INTO questions (discussion_id, text, type, queued, participant_suggested) VALUES
    ($1, 'Moderator draft', 'Agreement', true, false),
    ($1, 'Pending suggestion', 'Agreement', true, true),
    ($1, 'Published suggestion', 'Agreement', false, true)`, [id]);
  const questions = async roomSlug => (await pool.query(`SELECT text, queued FROM questions
    JOIN discussions ON discussions.id = questions.discussion_id WHERE slug = $1 ORDER BY text`, [roomSlug])).rows;
  const published = { text: 'Published suggestion', queued: false };
  const draft = { text: 'Moderator draft', queued: true };
  for (const [credentials, expected] of [[{ adminToken }, [draft, published]], [{}, [published]]]) {
    const copy = await jsonRequest('POST', '/api/duplicate-discussion', {
      originalTopic: slug, newTopic: uniqueTopic('suggestion-copy'), ...credentials,
    });
    assert.equal(copy.status, 200);
    assert.deepEqual(await questions(copy.body.newSlug), expected);
  }
  assert.deepEqual(await questions(slug), [draft, { text: 'Pending suggestion', queued: true }, published]);
});

test('a private note prevents edits before the first vote and retains its original question', async () => {
  const { id, slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('edit-after-note') })).body;
  const moderator = await joinAsModerator(slug, adminToken);
  const { socket: participant } = await joinAs(slug, 'note-author');
  try {
    for (const [kind, body] of [['clarification', 'Which day?'], ['suggestion', 'Thursday']]) {
      const { rows: [question] } = await pool.query(`INSERT INTO questions (discussion_id, text, type, options, tools)
        VALUES ($1, 'When?', 'Multiple Choice', $2, $3) RETURNING id`, [id, JSON.stringify(['Monday', 'Tuesday']), [kind]]);
      assert.deepEqual(await emitWithAck(participant, 'submitQuestionNote', slug, question.id, { kind, body }), { ok: true });
      assert.deepEqual(await emitWithAck(moderator, 'editQuestion', slug, question.id, { text: 'How many?', type: 'Numerical', minValue: 0, maxValue: 10, tools: [] }, adminToken),
        { updated: false, reason: 'has_notes' });
      const saved = (await pool.query('SELECT text, type, tools FROM questions WHERE id = $1', [question.id])).rows[0];
      assert.deepEqual(saved, { text: 'When?', type: 'Multiple Choice', tools: [kind] });
      const { notes } = await emitWithAck(moderator, 'getQuestionNotes', slug, question.id, { token: adminToken });
      assert.deepEqual(notes.map(note => [note.kind, note.body]), [[kind, body]]);
    }
  } finally {
    moderator.disconnect();
    participant.disconnect();
  }
});

test('posting approval migration preserves old rooms and moderator drafts', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE discussions (moderator_only_questions boolean); CREATE TEMP TABLE questions (queued boolean)');
    await client.query('INSERT INTO discussions VALUES (true), (false); INSERT INTO questions VALUES (true), (false)');
    const migrate = require('../migrations').find(([, migration]) => migration.name === 'migrateQuestionApproval')[1];
    await migrate(client);
    const rooms = (await client.query('SELECT * FROM discussions ORDER BY moderator_only_questions')).rows;
    assert.deepEqual(rooms.map(require('../question-posting').postingMode), ['open', 'moderator_only']);
    assert.deepEqual((await client.query('SELECT queued, participant_suggested FROM questions ORDER BY queued')).rows,
      [{ queued: false, participant_suggested: false }, { queued: true, participant_suggested: false }]);
    await client.query('UPDATE discussions SET question_approval_required = TRUE WHERE NOT moderator_only_questions');
    await migrate(client);
    assert.equal((await client.query('SELECT question_approval_required FROM discussions WHERE NOT moderator_only_questions')).rows[0].question_approval_required, true);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('posting approval routes legacy and forced submissions to the private queue until published', async () => {
  const { slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('posting-approval') })).body;
  const mod = await joinAsModerator(slug, adminToken);
  const { socket: participant } = await joinAs(slug, 'suggester');
  const { socket: display } = await joinDisplay(slug);
  try {
    const forbidden = waitForEvent(participant, 'error');
    participant.emit('setPostingMode', slug, 'approval', 'invalid');
    assert.match((await forbidden).message, /not authorized/i);
    const invalid = waitForEvent(mod, 'error');
    mod.emit('setPostingMode', slug, 'unknown', adminToken);
    assert.match((await invalid).message, /invalid/i);

    const switched = waitForEvent(participant, 'discussionState', state => state.postingMode === 'approval');
    mod.emit('setPostingMode', slug, 'approval', adminToken);
    assert.equal((await switched).moderatorOnly, false);
    const modList = waitForQuestions(mod, list => list.some(question => question.suggested), 'suggestion in moderator queue');
    const participantList = nextQuestions(participant, 'participant view');
    const displayList = nextQuestions(display, 'display view');
    const payload = { text: 'Where should we meet?', type: 'Agreement', queued: false };
    assert.deepEqual(await emitWithAck(participant, 'addQuestion', slug, payload, true), { added: true, queued: true, suggested: true });
    const [suggestion] = await modList;
    assert.equal(suggestion.queued, true);
    assert.deepEqual(await participantList, []);
    assert.deepEqual(await displayList, []);
    assert.equal((await emitWithAck(participant, 'publishQuestion', slug, suggestion.id, 'invalid')).published, false);

    const publicPayload = { text: 'Transport costs will rise', type: 'Agreement' };
    assert.deepEqual(await emitWithAck(mod, 'addQuestion', slug, publicPayload, true, adminToken), { added: true });
    const duplicate = waitForEvent(participant, 'similarQuestion');
    assert.equal((await emitWithAck(participant, 'addQuestion', slug, publicPayload, false)).reason, 'similar');
    const retry = (await duplicate).question;
    assert.equal(retry.queued, true);
    const opened = waitForEvent(participant, 'discussionState', state => state.postingMode === 'open');
    mod.emit('setModeratorOnly', slug, false, adminToken);
    await opened;
    assert.equal((await emitWithAck(participant, 'addQuestion', slug, retry, true)).reason, 'not_authorized');
    const published = waitForQuestions(participant, list => list.some(question => question.id === suggestion.id), 'approved suggestion');
    assert.equal((await emitWithAck(mod, 'publishQuestion', slug, suggestion.id, adminToken)).published, true);
    assert.equal((await published).find(question => question.id === suggestion.id).queued, false);
  } finally {
    mod.disconnect(); participant.disconnect(); display.disconnect();
  }
});

test('a queued question reaches moderators only, and nobody can answer it, until it is published', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('queue') });
  const { slug, adminToken } = created.body;
  const mod = await joinAsModerator(slug, adminToken);
  const { socket: participant } = await joinAs(slug, 'queue-participant');
  const { socket: display } = await joinDisplay(slug);
  try {
    const queuedPayload = { text: 'Takeover within a year is likely', type: 'Agreement', options: [], queued: true };

    // Only a moderator can queue. A refused request adds nothing, because
    // adding it unqueued would show the question to the whole room.
    assert.deepEqual(
      await emitWithAck(participant, 'addQuestion', slug, queuedPayload, false, undefined),
      { added: false, reason: 'not_authorized' }
    );
    assert.deepEqual(
      await emitWithAck(participant, 'addQuestion', slug, queuedPayload, false, 'not-the-token'),
      { added: false, reason: 'not_authorized' }
    );
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM questions')).rows[0].n, 0);

    const modSees = waitForQuestions(mod, qs => qs.length === 1, 'moderator receives the queued question');
    const participantSees = nextQuestions(participant, 'participant broadcast after queueing');
    const displaySees = nextQuestions(display, 'display broadcast after queueing');
    assert.deepEqual(await emitWithAck(mod, 'addQuestion', slug, queuedPayload, false, adminToken), { added: true });
    const [queued] = await modSees;
    assert.equal(queued.queued, true);
    assert.deepEqual(await participantSees, []);
    assert.deepEqual(await displaySees, []);

    // Its id is easy to guess, so every way to answer it is refused as if the
    // question did not exist.
    const refusedVote = waitForEvent(participant, 'error', e => /invalid question/i.test(e.message));
    assert.deepEqual(await emitWithAck(participant, 'vote', slug, queued.id, 'Agree', 'queue-participant', 'P', undefined), { ok: false });
    await refusedVote;
    assert.deepEqual(await emitWithAck(participant, 'clearVote', slug, queued.id, 'queue-participant'), { ok: false });
    assert.deepEqual(await emitWithAck(participant, 'setQuestionInterest', slug, queued.id, true, 'queue-participant'), { updated: false });
    assert.deepEqual(await emitWithAck(participant, 'getQuestionInterestState', slug, queued.id, 'queue-participant'), { error: 'not_found' });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM votes')).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM question_interest')).rows[0].n, 0);

    // A participant who writes the same statement is not shown the queued
    // wording as "a similar statement"; theirs is simply added.
    const publicAdded = waitForQuestions(participant, qs => qs.length === 1, 'participant question added');
    assert.deepEqual(
      await emitWithAck(participant, 'addQuestion', slug, { ...queuedPayload, queued: undefined }, false, undefined),
      { added: true }
    );
    const [publicQuestion] = await publicAdded;
    assert.equal(publicQuestion.queued, false);
    assert.notEqual(publicQuestion.id, queued.id);

    // A moderator queueing a near-duplicate is asked first, and "Post anyway"
    // (which sends the echoed question back) still queues it.
    const similar = waitForEvent(mod, 'similarQuestion');
    assert.deepEqual(
      await emitWithAck(mod, 'addQuestion', slug, { ...queuedPayload, text: 'Takeover within a year is likely!' }, false, adminToken),
      { added: false, reason: 'similar' }
    );
    const echoed = (await similar).question;
    assert.equal(echoed.queued, true);
    assert.deepEqual(await emitWithAck(mod, 'addQuestion', slug, echoed, true, adminToken), { added: true });
    const flags = async () => (await pool.query('SELECT text, queued FROM questions ORDER BY id')).rows.map(row => row.queued);
    assert.deepEqual(await flags(), [true, false, true]);

    // Summaries, exports and snapshots leave queued questions out for everyone.
    const base = `/api/discussions/${slug}`;
    for (const headers of [{}, asUser('queue-participant'), asModerator(adminToken)]) {
      const summary = (await jsonRequest('GET', `${base}/summary`, undefined, headers)).body;
      assert.deepEqual(summary.questions.map(q => q.id), [publicQuestion.id]);
      assert.equal(summary.counts.questions, 1);
      const csv = await fetch(`${server.baseUrl}${base}/export.csv`, { headers });
      assert.equal((await csv.text()).split('\n').length, 2, 'header and the one published question');
    }
    const snapshot = await jsonRequest('POST', `${base}/snapshots`, { name: 'Queue', adminToken });
    assert.deepEqual(snapshot.body.data.questions.map(q => q.id), [publicQuestion.id]);

    // Showing results to everyone does not show queued questions to everyone.
    const alwaysForParticipant = waitForEvent(participant, 'discussionState', state => state.resultsVisibility === 'always');
    const alwaysQuestions = nextQuestions(participant, 'participant broadcast in always mode');
    const alwaysForMod = nextQuestions(mod, 'moderator broadcast in always mode');
    const alwaysForDisplay = nextQuestions(display, 'display broadcast in always mode');
    mod.emit('setResultsVisibility', slug, 'always', adminToken);
    await alwaysForParticipant;
    assert.deepEqual((await alwaysQuestions).map(q => q.id), [publicQuestion.id]);
    assert.deepEqual((await alwaysForDisplay).map(q => q.id), [publicQuestion.id]);
    assert.equal((await alwaysForMod).length, 3);
    // Someone who joins or proves a moderator token in that mode gets the right list.
    const late = await joinAs(slug, 'queue-latecomer');
    try {
      assert.deepEqual(late.questions.map(q => q.id), [publicQuestion.id]);
      const promoted = waitForQuestions(late.socket, qs => qs.length === 3, 'queued questions after proving a token');
      assert.equal((await emitWithAck(late.socket, 'checkModerator', slug, adminToken)).isModerator, true);
      await promoted;
    } finally {
      late.socket.disconnect();
    }

    // Only a moderator can publish.
    const refusedPublish = waitForEvent(participant, 'error', e => /not authorized/i.test(e.message));
    assert.deepEqual(await emitWithAck(participant, 'publishQuestion', slug, queued.id, 'not-the-token'), { published: false, reason: 'not_authorized' });
    await refusedPublish;
    assert.deepEqual(await flags(), [true, false, true]);

    // Publishing shows the question to everyone as the newest one.
    const published = waitForQuestions(participant, qs => qs.length === 2, 'participant receives the published question');
    const publishedOnDisplay = waitForQuestions(display, qs => qs.length === 2, 'display receives the published question');
    assert.deepEqual(await emitWithAck(mod, 'publishQuestion', slug, queued.id, adminToken), { published: true });
    assert.deepEqual((await published).map(q => q.id), [publicQuestion.id, queued.id]);
    const onDisplay = await publishedOnDisplay;
    assert.deepEqual(onDisplay.map(q => q.id), [publicQuestion.id, queued.id]);
    assert.equal(onDisplay[1].queued, false);
    assert.ok(Date.parse(onDisplay[1].created_at) > Date.parse(onDisplay[0].created_at), 'published now, so it sorts as the most recent');
    // Publishing twice changes nothing, and neither does an id from elsewhere.
    assert.deepEqual(await emitWithAck(mod, 'publishQuestion', slug, queued.id, adminToken), { published: false });
    assert.deepEqual(await emitWithAck(mod, 'publishQuestion', slug, 'not-an-id', adminToken), { published: false });

    // Now it can be answered.
    assert.deepEqual(await emitWithAck(participant, 'vote', slug, queued.id, 'Agree', 'queue-participant', 'P', undefined), { ok: true });

    // A moderator's duplicate keeps the rest of the agenda queued.
    const copiedQuestions = async newSlug => (await pool.query(
      'SELECT q.text, q.queued FROM questions q JOIN discussions d ON d.id = q.discussion_id WHERE d.slug = $1 ORDER BY q.id',
      [newSlug]
    )).rows;
    const copy = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: slug, newTopic: uniqueTopic('queue-copy'), adminToken });
    const copied = await copiedQuestions(copy.body.newSlug);
    assert.deepEqual(copied.map(row => row.queued), [false, false, true]);
    assert.equal(copied[2].text, 'Takeover within a year is likely!');
    // Anyone can duplicate a discussion and moderates the copy, so a duplicate
    // made without the original's moderator token leaves the queue behind.
    for (const body of [{}, { adminToken: 'not-the-token' }, { adminToken: copy.body.adminToken }]) {
      const stranger = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: slug, newTopic: uniqueTopic('queue-stranger-copy'), ...body });
      assert.equal(stranger.status, 200);
      assert.deepEqual((await copiedQuestions(stranger.body.newSlug)).map(row => row.queued), [false, false]);
    }

    // Locking closes new questions, and publishing would add one for the room.
    const lockedState = waitForEvent(mod, 'discussionState', state => state.locked === true);
    mod.emit('setLocked', slug, true, adminToken);
    await lockedState;
    const remaining = (await pool.query('SELECT id FROM questions WHERE queued AND discussion_id = $1', [created.body.id])).rows[0].id;
    assert.deepEqual(await emitWithAck(mod, 'publishQuestion', slug, remaining, adminToken), { published: false, reason: 'locked' });
    assert.equal((await pool.query('SELECT queued FROM questions WHERE id = $1', [remaining])).rows[0].queued, true);
  } finally {
    mod.disconnect();
    participant.disconnect();
    display.disconnect();
  }
});

test('queue moves require moderator access and the same adjacent unpublished questions', async () => {
  const { body: room } = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('queue-order') });
  const mod = await joinAsModerator(room.slug, room.adminToken);
  const insert = async (text, queued) => (await pool.query(
    "INSERT INTO questions (discussion_id, text, type, queued) VALUES ($1, $2, 'Agreement', $3) RETURNING id",
    [room.id, text, queued])).rows[0].id;
  try {
    const first = await insert('First', true), second = await insert('Second', true), third = await insert('Third', true);
    const live = await insert('Live', false);
    const swap = (earlier, later, token = room.adminToken) => mod.emit('swapQueuedQuestions', room.slug, earlier, later, token);
    const refused = waitForEvent(mod, 'error', error => /not authorized/i.test(error.message));
    swap(first, second, 'wrong');
    await refused;
    const reordered = waitForQuestions(mod, questions => questions.filter(question => question.queued)[0]?.id === second, 'saved queue order');
    swap(first, second);
    await reordered;
    for (const pair of [[first, second], [second, third], [third, live]]) {
      const stale = waitForEvent(mod, 'error', error => /queue has changed/i.test(error.message));
      swap(...pair);
      await stale;
    }
    await insert('Last', true);
    const { body: copy } = await jsonRequest('POST', '/api/duplicate-discussion', {
      originalTopic: room.slug, newTopic: uniqueTopic('ordered-copy'), adminToken: room.adminToken,
    });
    const copied = await pool.query(`SELECT text FROM questions JOIN discussions ON discussions.id = discussion_id
      WHERE slug = $1 AND queued ORDER BY COALESCE(queue_position, questions.id)`, [copy.newSlug]);
    assert.deepEqual(copied.rows.map(question => question.text), ['Second', 'First', 'Third', 'Last']);
  } finally {
    mod.disconnect();
  }
});

test('published moves require a moderator and adjacent questions in the same room and pin group', async () => {
  const { body: room } = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('published-order') });
  const { body: other } = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('other-order') });
  const mod = await joinAsModerator(room.slug, room.adminToken);
  const insert = async (roomId, text, pinned = false, queued = false) => (await pool.query(
    "INSERT INTO questions (discussion_id, text, type, pinned, queued) VALUES ($1, $2, 'Agreement', $3, $4) RETURNING id",
    [roomId, text, pinned, queued])).rows[0].id;
  try {
    const oldest = await insert(room.id, 'Oldest'), middle = await insert(room.id, 'Middle'), newest = await insert(room.id, 'Newest');
    const pinned = await insert(room.id, 'Pinned', true), queued = await insert(room.id, 'Queued', false, true);
    const elsewhere = await insert(other.id, 'Elsewhere');
    const swap = (earlier, later, token = room.adminToken) => mod.emit('swapPublishedQuestions', room.slug, earlier, later, token);
    const refused = waitForEvent(mod, 'error', error => /not authorized/i.test(error.message));
    swap(newest, middle, 'wrong');
    await refused;
    for (const pair of [[newest, oldest], [pinned, newest], [newest, queued], [newest, elsewhere]]) {
      const rejected = waitForEvent(mod, 'error', error => /order has changed/i.test(error.message));
      swap(...pair);
      await rejected;
    }
    const moved = waitForQuestions(mod, questions => questions.find(question => question.id === middle)?.moderatorOrder === 2, 'stored moderator order');
    swap(newest, middle);
    await moved;
    const stale = waitForEvent(mod, 'error', error => /order has changed/i.test(error.message));
    swap(newest, middle);
    await stale;
    const added = await insert(room.id, 'New submission');
    const { rows } = await pool.query('SELECT id FROM questions WHERE discussion_id = $1 AND NOT queued ORDER BY pinned DESC, published_position NULLS LAST', [room.id]);
    assert.deepEqual(rows.map(row => row.id), [pinned, middle, newest, oldest, added]);
  } finally {
    mod.disconnect();
  }
});

test('existing questions are published when the queue column is added', async () => {
  await stopServer();
  try {
    const discussion = await pool.query("INSERT INTO discussions (topic, slug) VALUES ('Before the queue', 'before-the-queue') RETURNING id");
    await pool.query('DROP TABLE schema_migrations; ALTER TABLE questions DROP COLUMN queued');
    await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Older question', 'Agreement')", [discussion.rows[0].id]);
    await initializeDatabase(pool);
    assert.equal((await pool.query("SELECT queued FROM questions WHERE text = 'Older question'")).rows[0].queued, false);
  } finally {
    await startServer();
  }
});
