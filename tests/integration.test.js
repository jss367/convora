const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');
const { once } = require('node:events');
const { Pool } = require('pg');
const { io } = require('socket.io-client');

const rootDir = path.resolve(__dirname, '..');
const databaseUrl = process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test';

let serverProcess;
let serverOutput = '';
let baseUrl;
let serverPort;
let pool;

test.before(async () => {
  assertSafeTestDatabase(databaseUrl);

  serverPort = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${serverPort}`;
  pool = new Pool({ connectionString: databaseUrl });

  await startServer();
});

test.beforeEach(async () => {
  await pool.query('TRUNCATE TABLE votes, questions, discussions RESTART IDENTITY CASCADE');
});

test.after(async () => {
  if (pool) {
    await pool.end();
  }

  await stopServer();
});

test('server startup creates schema and applies the pseudonym migration', async () => {
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('discussions', 'questions', 'votes')
    ORDER BY table_name
  `);
  assert.deepEqual(tables.rows.map((row) => row.table_name), ['discussions', 'questions', 'votes']);

  const columns = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'votes'
      AND column_name = 'pseudonym'
  `);
  assert.equal(columns.rowCount, 1);
});

test('HTTP API creates and fetches discussions', async () => {
  const topic = uniqueTopic('http');
  const createResponse = await jsonRequest('POST', '/api/discussions', { topic });

  assert.equal(createResponse.status, 200);
  assert.equal(createResponse.body.success, true);
  assert.equal(createResponse.body.id, 1);
  assert.equal(createResponse.body.topic, topic);
  assert.match(createResponse.body.slug, /^http-/);
  assert.match(createResponse.body.adminToken, /^[a-f0-9]{32}$/);

  const fetchResponse = await jsonRequest('GET', `/api/discussions/${createResponse.body.id}`);
  assert.equal(fetchResponse.status, 200);
  assert.equal(fetchResponse.body.topic, topic);
});

test('HTTP API creates distinct discussions for colliding slugs', async () => {
  const firstResponse = await jsonRequest('POST', '/api/discussions', { topic: 'C++' });
  const secondResponse = await jsonRequest('POST', '/api/discussions', { topic: 'C#' });

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(firstResponse.body.topic, 'C++');
  assert.equal(secondResponse.body.topic, 'C#');
  assert.equal(firstResponse.body.slug, 'c');
  assert.equal(secondResponse.body.slug, 'c-2');
  assert.match(firstResponse.body.adminToken, /^[a-f0-9]{32}$/);
  assert.match(secondResponse.body.adminToken, /^[a-f0-9]{32}$/);
  assert.notEqual(firstResponse.body.id, secondResponse.body.id);
});

test('HTTP API resolves legacy title routes before falling back to canonical slugs', async () => {
  await jsonRequest('POST', '/api/discussions', { topic: 'C++' });
  await jsonRequest('POST', '/api/discussions', { topic: 'C#' });

  const resolveTitle = await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent('C#')}`);
  assert.equal(resolveTitle.status, 200);
  assert.equal(resolveTitle.body.topic, 'C#');
  assert.equal(resolveTitle.body.slug, 'c-2');

  const resolveSlug = await jsonRequest('GET', '/api/discussions/resolve/c');
  assert.equal(resolveSlug.status, 200);
  assert.equal(resolveSlug.body.topic, 'C++');
  assert.equal(resolveSlug.body.slug, 'c');
});

test('slug migration preserves literal slug-shaped legacy titles', async () => {
  await stopServer();
  await pool.query('TRUNCATE TABLE votes, questions, discussions RESTART IDENTITY CASCADE');
  await pool.query(`
    INSERT INTO discussions (topic, slug)
    VALUES
      ('C++', 'c'),
      ('c', 'c-2')
  `);

  await startServer();

  const migrated = await pool.query('SELECT topic, slug FROM discussions ORDER BY topic');
  assert.deepEqual(migrated.rows, [
    { topic: 'C++', slug: 'c-2' },
    { topic: 'c', slug: 'c' },
  ]);

  const resolveSlug = await jsonRequest('GET', '/api/discussions/resolve/c');
  assert.equal(resolveSlug.status, 200);
  assert.equal(resolveSlug.body.topic, 'c');
  assert.equal(resolveSlug.body.slug, 'c');
});

test('creating a discussion makes the creator its moderator', async () => {
  const topic = uniqueTopic('creator-mod');

  const createResponse = await jsonRequest('POST', '/api/discussions', { topic });
  assert.equal(createResponse.status, 200);
  // The creator gets a moderator token back on the request that establishes it.
  assert.match(createResponse.body.adminToken, /^[a-f0-9]{32}$/);
  assert.match(createResponse.body.slug, /^creator-mod-/);

  // The returned token is the discussion's stored admin token — i.e. it really
  // grants moderation (verifyAdmin matches on this exact value).
  const stored = await pool.query('SELECT admin_token FROM discussions WHERE topic = $1', [topic]);
  assert.equal(stored.rows[0].admin_token, createResponse.body.adminToken);
});

test('re-creating an already-moderated discussion does not hand over moderation', async () => {
  const topic = uniqueTopic('creator-mod-repeat');

  const first = await jsonRequest('POST', '/api/discussions', { topic });
  const firstToken = first.body.adminToken;
  assert.match(firstToken, /^[a-f0-9]{32}$/);

  // A second create for the same topic must NOT mint or disclose a token —
  // otherwise anyone could seize moderation by re-submitting an existing topic.
  const second = await jsonRequest('POST', '/api/discussions', { topic });
  assert.equal(second.status, 200);
  assert.equal(second.body.success, true);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.slug, first.body.slug);
  assert.equal(second.body.adminToken, null);

  // The original moderator's token is untouched.
  const stored = await pool.query('SELECT admin_token FROM discussions WHERE topic = $1', [topic]);
  assert.equal(stored.rows[0].admin_token, firstToken);
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

    const voteUpdate = waitForQuestions(
      author,
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

test('Yes/No questions record a single choice that toggles off when reselected', async () => {
  const topic = uniqueTopic('yesno');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    const authorInitialQuestions = waitForQuestions(author, (questions) => Array.isArray(questions), 'author join');
    author.emit('joinDiscussion', topic);
    await authorInitialQuestions;

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
      author,
      (qs) => qs[0] && qs[0].votes.length === 1 && qs[0].votes[0].value === 'Yes',
      'yes vote'
    );
    voter.emit('vote', topic, question.id, 'Yes', 'yn-user', 'Decider');
    await yesUpdate;

    // Switching to No replaces the single choice rather than adding a row.
    const noUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.length === 1 && qs[0].votes[0].value === 'No',
      'switch to no'
    );
    voter.emit('vote', topic, question.id, 'No', 'yn-user', 'Decider');
    await noUpdate;

    // Re-selecting the current choice toggles it off, like Agreement votes.
    const toggleOffUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.length === 0,
      'toggle off'
    );
    voter.emit('vote', topic, question.id, 'No', 'yn-user', 'Decider');
    await toggleOffUpdate;
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('Socket.IO sanitizes display names: anonymous stores null, long names are clamped', async () => {
  const topic = uniqueTopic('names');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(
      author,
      (questions) => questions.length === 1,
      'question broadcast'
    );
    author.emit('addQuestion', topic, {
      text: 'Pick a name mode',
      type: 'Brainstorm',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];

    // Anonymous mode sends a blank name; the server stores null so the display
    // layer falls back to "Anonymous".
    const anonUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'idea-anon'),
      'anonymous vote'
    );
    voter.emit('vote', topic, question.id, 'idea-anon', 'anon-user', '   ');
    const anonVote = (await anonUpdate)[0].votes.find((v) => v.value === 'idea-anon');
    assert.equal(anonVote.pseudonym, null);

    // A typed-in name longer than the cap is clamped to 40 characters.
    const longName = 'X'.repeat(100);
    const longUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'idea-long'),
      'long-name vote'
    );
    voter.emit('vote', topic, question.id, 'idea-long', 'long-user', longName);
    const longVote = (await longUpdate)[0].votes.find((v) => v.value === 'idea-long');
    assert.equal(longVote.pseudonym, 'X'.repeat(40));
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('client pure-JS SHA-256 fallback matches the server ownership-token hash', async () => {
  // The client uses crypto.subtle when available, but falls back to this pure-JS
  // SHA-256 in insecure contexts (e.g. served over a plain http:// LAN IP via the
  // join-QR flow). The fallback MUST produce the same hex digest the server uses
  // for ownership tokens, or participants there can't recognize their own votes.
  const { sha256Hex } = await import('../client/src/sha256.js');
  const inputs = ['123:abcDEF', '42:café 🦦', 'x:y', '', 'a'.repeat(200), '9f3a:Mellow Otter'];
  for (const s of inputs) {
    const fallback = sha256Hex(new TextEncoder().encode(s));
    const node = crypto.createHash('sha256').update(s).digest('hex');
    assert.equal(fallback, node, `SHA-256 mismatch for ${JSON.stringify(s)}`);
  }
});

test('Socket.IO ownership tokens hide stable ids and differ per response', async () => {
  const topic = uniqueTopic('tokens');
  const author = await connectSocket();
  const voter = await connectSocket();

  // Tokens are keyed by the response's own row id, not the question id.
  const tokenFor = (voteId, userId) =>
    crypto.createHash('sha256').update(`${voteId}:${userId}`).digest('hex');

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    // Two open-ended questions, both answered by the SAME browser (same userId).
    const q1Update = waitForQuestions(author, (qs) => qs.length === 1, 'q1 broadcast');
    author.emit('addQuestion', topic, {
      text: 'Prompt one?', type: 'Open Ended', minValue: null, maxValue: null, options: [],
    });
    const q1 = (await q1Update)[0];

    const q2Update = waitForQuestions(author, (qs) => qs.length === 2, 'q2 broadcast');
    author.emit('addQuestion', topic, {
      text: 'Prompt two?', type: 'Open Ended', minValue: null, maxValue: null, options: [],
    });
    const q2 = (await q2Update).find((q) => q.id !== q1.id);

    const v1Update = waitForQuestions(
      author,
      (qs) => qs.find((q) => q.id === q1.id)?.votes?.length === 1,
      'q1 vote'
    );
    voter.emit('vote', topic, q1.id, 'answer one', 'same-browser', 'Same Browser');
    const vote1 = (await v1Update).find((q) => q.id === q1.id).votes[0];

    const v2Update = waitForQuestions(
      author,
      (qs) => qs.find((q) => q.id === q2.id)?.votes?.length === 1,
      'q2 vote'
    );
    voter.emit('vote', topic, q2.id, 'answer two', 'same-browser', 'Same Browser');
    const vote2 = (await v2Update).find((q) => q.id === q2.id).votes[0];

    // No raw ids leak, and the same browser gets a DIFFERENT token per response
    // (here, across two prompts) — so a socket observer can't correlate them.
    // The token is self-matchable from the response's own id.
    assert.equal('userId' in vote1, false);
    assert.equal(vote1.ownerToken, tokenFor(vote1.id, 'same-browser'));
    assert.equal(vote2.ownerToken, tokenFor(vote2.id, 'same-browser'));
    assert.notEqual(vote1.ownerToken, vote2.ownerToken);

    // Upvoter ids are likewise tokenized per response (and self-matchable).
    const upUpdate = waitForQuestions(
      author,
      (qs) => qs.find((q) => q.id === q1.id)?.votes?.[0]?.upvotes === 1,
      'q1 upvote'
    );
    author.emit('toggleResponseVote', topic, vote1.id, 'upvoter-x');
    const upvoted = (await upUpdate).find((q) => q.id === q1.id).votes[0];
    assert.equal(upvoted.upvoters, undefined);
    assert.deepEqual(upvoted.upvoterTokens, [tokenFor(vote1.id, 'upvoter-x')]);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test("Socket.IO de-correlates one participant's multiple Brainstorm ideas", async () => {
  const topic = uniqueTopic('brainstorm-tokens');
  const author = await connectSocket();
  const voter = await connectSocket();

  const tokenFor = (voteId, userId) =>
    crypto.createHash('sha256').update(`${voteId}:${userId}`).digest('hex');

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const qUpdate = waitForQuestions(author, (qs) => qs.length === 1, 'brainstorm prompt');
    author.emit('addQuestion', topic, {
      text: 'Brainstorm anything', type: 'Brainstorm', minValue: null, maxValue: null, options: [],
    });
    const question = (await qUpdate)[0];

    // The SAME anonymous browser submits two separate ideas to the same prompt.
    const idea1Update = waitForQuestions(
      author,
      (qs) => qs[0]?.votes?.some((v) => v.value === 'idea one'),
      'first idea'
    );
    voter.emit('vote', topic, question.id, 'idea one', 'one-browser', '   ');
    await idea1Update;

    const idea2Update = waitForQuestions(
      author,
      (qs) => qs[0]?.votes?.length === 2,
      'second idea'
    );
    voter.emit('vote', topic, question.id, 'idea two', 'one-browser', '   ');
    const votes = (await idea2Update)[0].votes;

    const v1 = votes.find((v) => v.value === 'idea one');
    const v2 = votes.find((v) => v.value === 'idea two');

    // Both ideas are anonymous and come from the same browser, yet each carries
    // a DIFFERENT ownerToken (keyed by the response's own id) — so a socket
    // observer can't group them as one participant's. Under the old per-question
    // scheme these tokens would have been identical.
    assert.equal('userId' in v1, false);
    assert.equal('userId' in v2, false);
    assert.notEqual(v1.ownerToken, v2.ownerToken);

    // Each token is still self-matchable from the response's id, so the author's
    // own client can recognize both ideas as theirs.
    assert.equal(v1.ownerToken, tokenFor(v1.id, 'one-browser'));
    assert.equal(v2.ownerToken, tokenFor(v2.id, 'one-browser'));
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('Summary counts anonymous participants distinctly and never leaks raw user ids', async () => {
  const topic = uniqueTopic('summary-anon');
  const author = await connectSocket();
  const voterA = await connectSocket();
  const voterB = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voterA.emit('joinDiscussion', topic);
    voterB.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(author, (qs) => qs.length === 1, 'question broadcast');
    author.emit('addQuestion', topic, {
      text: 'What do you think?',
      type: 'Open Ended',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];

    // Two distinct browsers (different stable user ids) both submit anonymously,
    // so both broadcast pseudonyms collapse to "Anonymous". They must still be
    // counted as TWO participants in the summary (which reads the real user_id
    // internally), not merged into one.
    const firstVote = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'first anon answer'),
      'first anon vote'
    );
    voterA.emit('vote', topic, question.id, 'first anon answer', 'browser-aaaaaaaa1', '   ');
    await firstVote;

    const secondVote = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'second anon answer'),
      'second anon vote'
    );
    voterB.emit('vote', topic, question.id, 'second anon answer', 'browser-bbbbbbbb2', '   ');
    await secondVote;

    const summaryResponse = await jsonRequest('GET', `/api/discussions/${topic}/summary`);
    assert.equal(summaryResponse.status, 200);
    assert.equal(summaryResponse.body.counts.participants, 2);

    // The client-facing summary must not echo any raw 16-char user id. The real
    // ids used here are 'browser-aaaaaaaa1' / 'browser-bbbbbbbb2'; assert neither
    // appears, and that no participant entry carries a raw id field.
    const serialized = JSON.stringify(summaryResponse.body);
    assert.equal(serialized.includes('browser-aaaaaaaa1'), false);
    assert.equal(serialized.includes('browser-bbbbbbbb2'), false);
    for (const participant of summaryResponse.body.facilitatorDashboard.participantStats) {
      assert.match(participant.id, /^participant-\d+$/);
    }
  } finally {
    author.disconnect();
    voterA.disconnect();
    voterB.disconnect();
  }
});

test('updateDisplayName retroactively renames a participant\'s prior responses', async () => {
  const topic = uniqueTopic('rename');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(author, (qs) => qs.length === 1, 'question broadcast');
    author.emit('addQuestion', topic, {
      text: 'Share a thought',
      type: 'Open Ended',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];

    const voteUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.length === 1,
      'initial vote'
    );
    voter.emit('vote', topic, question.id, 'my response', 'rename-user', 'Original Name');
    const initial = (await voteUpdate)[0].votes[0];
    assert.equal(initial.pseudonym, 'Original Name');

    // Switching to a new display name must rewrite the existing response.
    const renamed = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes[0] && qs[0].votes[0].pseudonym === 'Renamed Person',
      'renamed broadcast'
    );
    voter.emit('updateDisplayName', topic, 'rename-user', 'Renamed Person');
    const after = (await renamed)[0].votes[0];
    assert.equal(after.pseudonym, 'Renamed Person');

    // Switching to anonymous (blank name) clears the stored pseudonym to null.
    const anonymized = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes[0] && qs[0].votes[0].pseudonym === null,
      'anonymized broadcast'
    );
    voter.emit('updateDisplayName', topic, 'rename-user', '   ');
    const anon = (await anonymized)[0].votes[0];
    assert.equal(anon.pseudonym, null);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('a moderator can promote a participant, granting them working controls', async () => {
  const topic = uniqueTopic('promote');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'guest-user-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    // The guest identifies so the server can route a moderator grant to them.
    guest.emit('identify', topic, guestUserId);

    // Add a question and have the guest vote, so they become a known participant.
    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, {
      text: 'Promote me?',
      type: 'Agreement',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Guest Otter');
    await voteRecorded;

    // The moderator sees the guest via an opaque, stable handle — never a raw
    // user id, and not a positional index.
    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(list.success, true);
    assert.equal(list.participants.length, 1);
    assert.match(list.participants[0].id, /^participant-[a-f0-9]{16}$/);
    assert.equal(list.participants[0].pseudonym, 'Guest Otter');
    assert.equal(list.participants[0].isModerator, false);
    assert.equal(list.participants[0].userId, undefined);
    const guestHandle = list.participants[0].id;

    // Promotion delivers a token to the guest live and flips their flag.
    const granted = waitForEvent(guest, 'moderatorGranted');
    const promote = await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    assert.equal(promote.success, true);
    assert.equal(promote.participants[0].isModerator, true);

    const grant = await granted;
    assert.match(grant.token, /^[a-f0-9]{32}$/);

    // The granted token really moderates: the guest can now lock the discussion.
    guest.emit('setLocked', topic, true, grant.token);
    const locked = await waitForEvent(mod, 'discussionState', (state) => state.locked === true);
    assert.equal(locked.locked, true);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a moderator sets the discussion color theme and it broadcasts to everyone', async () => {
  const topic = uniqueTopic('theme');
  const mod = await connectSocket();
  const guest = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    // A fresh discussion defaults to the original 'indigo' look.
    const claimed = await waitForEvent(guest, 'discussionState', (s) => s.hasModerator === true);
    assert.equal(claimed.theme, 'indigo');

    // The moderator switches theme; every participant receives the new value.
    const themed = waitForEvent(guest, 'discussionState', (s) => s.theme === 'orange');
    mod.emit('setTheme', topic, 'orange', token);
    assert.equal((await themed).theme, 'orange');

    // An unknown theme is rejected (error to the sender) and never broadcast.
    const rejected = waitForEvent(mod, 'error', (e) => /theme/i.test(e.message));
    mod.emit('setTheme', topic, 'chartreuse', token);
    await rejected;

    // The stored theme is unchanged: a fresh join still reports 'orange'.
    const rejoin = await connectSocket();
    try {
      rejoin.emit('joinDiscussion', topic);
      const state = await waitForEvent(rejoin, 'discussionState');
      assert.equal(state.theme, 'orange');
    } finally {
      rejoin.disconnect();
    }
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a non-moderator cannot set the discussion theme', async () => {
  const topic = uniqueTopic('theme-deny');
  await jsonRequest('POST', '/api/discussions', { topic });

  const stranger = await connectSocket();
  try {
    stranger.emit('joinDiscussion', topic);
    const rejected = waitForEvent(stranger, 'error', (e) => /authoriz/i.test(e.message));
    stranger.emit('setTheme', topic, 'orange', 'bogus-token');
    await rejected;

    // The theme stays at the default for everyone who joins afterward.
    const observer = await connectSocket();
    try {
      observer.emit('joinDiscussion', topic);
      const state = await waitForEvent(observer, 'discussionState');
      assert.equal(state.theme, 'indigo');
    } finally {
      observer.disconnect();
    }
  } finally {
    stranger.disconnect();
  }
});

test('a non-moderator cannot list or promote participants', async () => {
  const topic = uniqueTopic('promote-deny');
  await jsonRequest('POST', '/api/discussions', { topic });

  const stranger = await connectSocket();
  try {
    stranger.emit('joinDiscussion', topic);

    const list = await emitWithAck(stranger, 'listParticipants', topic, 'bogus-token');
    assert.equal(list.success, false);
    assert.equal(list.error, 'not_authorized');

    const promote = await emitWithAck(stranger, 'promoteModerator', topic, 'bogus-token', 'participant-1');
    assert.equal(promote.success, false);
    assert.equal(promote.error, 'not_authorized');
  } finally {
    stranger.disconnect();
  }
});

test('promoting an offline participant fails and does not leave a dangling grant', async () => {
  const topic = uniqueTopic('promote-offline');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'offline-guest-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Offline?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Absent Owl');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;

    // Guest leaves before being promoted. Wait until the server has processed
    // the disconnect (presence drops to just the moderator) so the promote can't
    // find a socket to deliver to.
    const presenceDropped = waitForEvent(mod, 'presence', (count) => count === 1);
    guest.disconnect();
    await presenceDropped;

    const promote = await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    assert.equal(promote.success, false);
    assert.equal(promote.error, 'participant_offline');

    // The grant was rolled back — the participant is not left marked a moderator.
    const after = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(after.participants[0].isModerator, false);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('Brainstorm ratings broadcast as aggregates without exposing who voted', async () => {
  const topic = uniqueTopic('brainstorm-rate');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);

    const token = await claimModerator(mod, topic);

    const question = await addBrainstormQuestion(mod, topic, 'How should we cut costs?');

    const ideaUpdate = waitForQuestions(
      mod,
      (questions) => questions[0] && questions[0].votes.length === 1,
      'brainstorm idea added'
    );
    participant.emit('vote', topic, question.id, 'Switch to solar', 'user-idea', 'Sunny');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // Reactions are off by default, so a rating should be ignored until enabled.
    const enabledUpdate = waitForQuestions(
      mod,
      (questions) => questions[0] && questions[0].reactionsEnabled === true,
      'reactions enabled'
    );
    mod.emit('setResponseRating', topic, responseId, 'quality', 1, 'user-early');
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true }, token);
    const afterEnable = (await enabledUpdate)[0].votes[0];
    assert.equal(afterEnable.qualityUp, 0, 'rating before enabling reactions must be rejected');

    // Now ratings are accepted and surface as aggregate tallies.
    const ratingUpdate = waitForQuestions(
      mod,
      (questions) => questions[0] && questions[0].votes[0] && questions[0].votes[0].qualityUp === 1,
      'quality rating broadcast'
    );
    participant.emit('setResponseRating', topic, responseId, 'quality', 1, 'user-rater');
    const rated = (await ratingUpdate)[0].votes[0];

    assert.equal(rated.qualityUp, 1);
    assert.equal(rated.qualityDown, 0);
    // The payload exposes counts only — never a list of who rated or reacted.
    assert.equal(rated.raters, undefined);
    assert.equal(rated.reactors, undefined);
    assert.deepEqual(rated.reactionCounts, {});
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('Brainstorm agreement votes accumulate into a distribution', async () => {
  const topic = uniqueTopic('brainstorm-agree');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Pick a direction');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'Build the thing', 'user-idea', 'Maker');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].reactionsEnabled === true, 'reactions enabled');
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true }, token);
    await enabledUpdate;

    const agreeUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].agreementCounts || {})['Strongly Agree'] === 1,
      'agreement counted'
    );
    mod.emit('setResponseRating', topic, responseId, 'agreement', 'Strongly Agree', 'user-a');
    mod.emit('setResponseRating', topic, responseId, 'agreement', 'Disagree', 'user-b');
    const counts = (await agreeUpdate)[0].votes[0].agreementCounts;

    assert.equal(counts['Strongly Agree'], 1);
    assert.equal(counts['Disagree'], 1);
  } finally {
    mod.disconnect();
  }
});

test('Brainstorm comments can be added, listed with pseudonyms, and deleted', async () => {
  const topic = uniqueTopic('brainstorm-comment');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'What should we try?');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'Run a pilot', 'user-idea', 'Planner');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // Comments are rejected until enabled.
    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    const rejected = await new Promise((resolve) =>
      participant.emit('addResponseComment', topic, responseId, 'too early', 'user-c', 'Critic', resolve));
    assert.equal(rejected.added, false, 'comment before enabling must be rejected');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabledUpdate;

    const commentUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1,
      'comment added'
    );
    const ack = await new Promise((resolve) =>
      participant.emit('addResponseComment', topic, responseId, 'Scope it to one team', 'user-c', 'Critic', resolve));
    assert.equal(ack.added, true);
    const comment = (await commentUpdate)[0].votes[0].comments[0];
    assert.equal(comment.body, 'Scope it to one team');
    assert.equal(comment.pseudonym, 'Critic');

    const deleteUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 0,
      'comment deleted'
    );
    participant.emit('deleteResponseComment', topic, comment.id, 'user-c');
    const afterDelete = (await deleteUpdate)[0].votes[0].comments;
    assert.deepEqual(afterDelete, []);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test("a moderator can delete any participant's response (spam control)", async () => {
  const topic = uniqueTopic('mod-delete-idea');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Ideas?');

    // A participant (not the moderator) posts the response.
    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'spam spam spam', 'spammer-1', 'Spammer');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // The moderator removes it even though they did not author it.
    const deleteUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 0, 'idea removed by moderator');
    mod.emit('moderatorDeleteVote', topic, responseId, token);
    assert.deepEqual((await deleteUpdate)[0].votes, []);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test("a non-moderator cannot delete another participant's response", async () => {
  const topic = uniqueTopic('mod-delete-deny');
  const mod = await connectSocket();
  const stranger = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    stranger.emit('joinDiscussion', topic);
    await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Ideas?');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'keep me', 'author-1', 'Author');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // A stranger with a bogus token is rejected, not silently obeyed.
    const denied = waitForEvent(stranger, 'error');
    stranger.emit('moderatorDeleteVote', topic, responseId, 'bogus-token');
    await denied;

    // Re-joining re-sends the current state; the response is still there.
    const refreshed = waitForQuestions(stranger, (qs) => qs[0] && qs[0].id === question.id, 'state refreshed');
    stranger.emit('joinDiscussion', topic);
    const votes = (await refreshed)[0].votes;
    assert.equal(votes.length, 1);
    assert.equal(votes[0].id, responseId);
  } finally {
    mod.disconnect();
    stranger.disconnect();
  }
});

test("a moderator can delete any participant's comment (spam control)", async () => {
  const topic = uniqueTopic('mod-delete-comment');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'What should we try?');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'A real idea', 'user-idea', 'Planner');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabledUpdate;

    const commentUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1,
      'comment added'
    );
    const ack = await emitWithAck(
      participant, 'addResponseComment', topic, responseId, 'buy now at spam.example', 'spammer-2', 'Spammer');
    assert.equal(ack.added, true);
    const comment = (await commentUpdate)[0].votes[0].comments[0];

    // The moderator removes a comment they did not author.
    const deleteUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 0,
      'comment removed by moderator'
    );
    mod.emit('moderatorDeleteResponseComment', topic, comment.id, token);
    assert.deepEqual((await deleteUpdate)[0].votes[0].comments, []);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('a moderator cannot delete a poll vote via moderatorDeleteVote (aggregate data)', async () => {
  const topic = uniqueTopic('mod-delete-poll-deny');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    // Agreement polls are aggregate data, not spammable free text. The
    // moderator-delete feature is scoped to written responses, so the backend
    // must refuse to remove a poll vote even with a valid token.
    const questionAdded = waitForQuestions(mod, (qs) => qs.length === 1, 'poll added');
    mod.emit('addQuestion', topic, { text: 'Agree?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await questionAdded)[0];

    const voteUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'poll vote recorded');
    participant.emit('vote', topic, question.id, 'Agree', 'poll-voter', 'Voter');
    const voteId = (await voteUpdate)[0].votes[0].id;

    // The moderator targets the poll vote id directly, as if from the console.
    // The handler always re-broadcasts questions after running, so waiting for
    // that broadcast guarantees the (no-op) delete query has completed before
    // we assert. The poll vote must still be there.
    const afterDelete = waitForQuestions(mod, (qs) => qs[0] && qs[0].id === question.id, 'state after delete');
    mod.emit('moderatorDeleteVote', topic, voteId, token);
    const votes = (await afterDelete)[0].votes;
    assert.equal(votes.length, 1);
    assert.equal(votes[0].id, voteId);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('Brainstorm ratings, reactions, and comments are rejected once the discussion is locked', async () => {
  const topic = uniqueTopic('brainstorm-locked');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Locked-phase ideas');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'An idea', 'user-idea', 'Thinker');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // Reactions and comments are enabled...
    const enabledUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].reactionsEnabled === true && qs[0].commentsEnabled === true,
      'reactions + comments enabled'
    );
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true, comments_enabled: true }, token);
    await enabledUpdate;

    // ...then the discussion is locked, which should close all of them.
    const lockedState = waitForEvent(mod, 'discussionState', (s) => s.locked === true);
    mod.emit('setLocked', topic, true, token);
    await lockedState;

    const commentAck = await emitWithAck(
      participant, 'addResponseComment', topic, responseId, 'sneaking in', 'user-c', 'Critic');
    assert.equal(commentAck.added, false, 'comment must be rejected while locked');

    participant.emit('setResponseRating', topic, responseId, 'quality', 1, 'user-r');
    participant.emit('toggleResponseReaction', topic, responseId, 'crux', 'user-r');

    // Neither the rating nor the reaction should have been recorded for the user.
    const mine = await emitWithAck(participant, 'getBrainstormState', topic, 'user-r');
    assert.deepEqual(mine.ratings, {}, 'rating must be rejected while locked');
    assert.deepEqual(mine.reactions, {}, 'reaction must be rejected while locked');
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('moderator-only mode lets only moderators add questions while voting stays open', async () => {
  const topic = uniqueTopic('mod-only-questions');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    // Turn on moderator-only questions and wait for the state to broadcast.
    const restricted = waitForEvent(participant, 'discussionState', (s) => s.moderatorOnly === true);
    mod.emit('setModeratorOnly', topic, true, token);
    await restricted;

    // A participant with no moderator token is bounced...
    const rejected = await emitWithAck(
      participant,
      'addQuestion',
      topic,
      { text: 'Can I ask this?', type: 'Agreement', minValue: null, maxValue: null, options: [] },
      false,
      null
    );
    assert.equal(rejected.added, false, 'participant submission must be rejected');
    assert.equal(rejected.reason, 'moderator_only');

    // ...but the moderator can add a question with their token. Register the
    // listener before emitting: the server broadcasts 'questions' before it acks.
    const questionAdded = waitForQuestions(mod, (qs) => qs.length === 1, 'moderator question added');
    const modAdded = await emitWithAck(
      mod,
      'addQuestion',
      topic,
      { text: 'Moderator agenda item', type: 'Agreement', minValue: null, maxValue: null, options: [] },
      false,
      token
    );
    assert.equal(modAdded.added, true, 'moderator submission must be accepted');

    const questions = await questionAdded;
    const questionId = questions[0].id;
    assert.equal(questions[0].text, 'Moderator agenda item');

    // Voting stays open for everyone even while questions are restricted.
    const voted = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'participant vote recorded');
    participant.emit('vote', topic, questionId, 'Agree', 'user-voter', 'Voter');
    await voted;

    // Reopening lets participants add questions again.
    const opened = waitForEvent(participant, 'discussionState', (s) => s.moderatorOnly === false);
    mod.emit('setModeratorOnly', topic, false, token);
    await opened;

    const accepted = await emitWithAck(
      participant,
      'addQuestion',
      topic,
      { text: 'Now I can ask', type: 'Agreement', minValue: null, maxValue: null, options: [] },
      false,
      null
    );
    assert.equal(accepted.added, true, 'participant submission must be accepted once reopened');
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('setModeratorOnly rejects callers without a valid moderator token', async () => {
  const topic = uniqueTopic('mod-only-auth');
  const mod = await connectSocket();
  const intruder = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    intruder.emit('joinDiscussion', topic);
    await claimModerator(mod, topic);

    // An attempt with a bogus token must not change the discussion's state.
    const errored = waitForEvent(intruder, 'error');
    intruder.emit('setModeratorOnly', topic, true, 'not-a-real-token');
    await errored;

    // beforeEach truncates, and only the moderator's claim created a discussion,
    // so the single row reflects whether the bogus token managed to flip the flag.
    const state = await pool.query('SELECT moderator_only_questions FROM discussions');
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].moderator_only_questions, false);
  } finally {
    mod.disconnect();
    intruder.disconnect();
  }
});

test('Renaming updates stored comment pseudonyms, and comment tokens are namespaced', async () => {
  const topic = uniqueTopic('brainstorm-rename');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Rename test');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'An idea', 'user-idea', 'Ideator');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabledUpdate;

    const commentUpdate = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1, 'comment added');
    await emitWithAck(participant, 'addResponseComment', topic, responseId, 'My take', 'user-c', 'Critic');
    const comment = (await commentUpdate)[0].votes[0].comments[0];
    assert.equal(comment.pseudonym, 'Critic');

    // The comment token is namespaced (`comment:<id>`) so it can never equal a
    // vote token of the same numeric id and de-anonymize the author.
    const namespaced = crypto.createHash('sha256').update(`comment:${comment.id}:user-c`).digest('hex');
    const collidingVoteToken = crypto.createHash('sha256').update(`${comment.id}:user-c`).digest('hex');
    assert.equal(comment.ownerToken, namespaced);
    assert.notEqual(comment.ownerToken, collidingVoteToken);

    // Renaming the author updates the persisted comment pseudonym too.
    const renamed = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || [])[0] &&
        qs[0].votes[0].comments[0].pseudonym === 'Reformed Critic',
      'comment renamed'
    );
    participant.emit('updateDisplayName', topic, 'user-c', 'Reformed Critic');
    await renamed;
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('Brainstorm authors cannot rate or react to their own idea', async () => {
  const topic = uniqueTopic('brainstorm-self');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'No self-rating');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'My own idea', 'user-self', 'Author');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].reactionsEnabled === true, 'reactions enabled');
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true }, token);
    await enabledUpdate;

    // The author tries to rate and react to their own idea.
    mod.emit('setResponseRating', topic, responseId, 'quality', 1, 'user-self');
    mod.emit('toggleResponseReaction', topic, responseId, 'key-insight', 'user-self');

    const mine = await emitWithAck(mod, 'getBrainstormState', topic, 'user-self');
    assert.deepEqual(mine.ratings, {}, 'self-rating must be rejected');
    assert.deepEqual(mine.reactions, {}, 'self-reaction must be rejected');
  } finally {
    mod.disconnect();
  }
});

test('Brainstorm reactions can be narrowed to a creator-chosen set', async () => {
  const topic = uniqueTopic('brainstorm-reactset');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    // A fresh discussion broadcasts the full default reaction catalog.
    const initial = await waitForEvent(mod, 'discussionState', (s) => Array.isArray(s.reactionKeys));
    assert.deepEqual(initial.reactionKeys, ['changed-mind', 'crux', 'follows', 'citation-needed', 'key-insight']);

    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Narrow the reactions');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'An idea', 'user-idea', 'Ideator');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // The creator narrows the active set (and passes a bogus key, which is dropped
    // and the rest re-ordered to catalog order).
    const narrowed = waitForEvent(
      mod, 'discussionState', (s) => Array.isArray(s.reactionKeys) && s.reactionKeys.length === 1);
    mod.emit('setReactionKeys', topic, ['bogus', 'crux'], token);
    assert.deepEqual((await narrowed).reactionKeys, ['crux']);

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].reactionsEnabled === true, 'reactions enabled');
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true }, token);
    await enabledUpdate;

    // A reaction outside the active set is rejected; one inside is accepted.
    const reactUpdate = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].reactionCounts || {}).crux === 1, 'crux counted');
    mod.emit('toggleResponseReaction', topic, responseId, 'key-insight', 'user-react');
    mod.emit('toggleResponseReaction', topic, responseId, 'crux', 'user-react');
    const counts = (await reactUpdate)[0].votes[0].reactionCounts;
    assert.equal(counts.crux, 1);
    assert.equal(counts['key-insight'], undefined, 'reaction outside the active set must be rejected');
  } finally {
    mod.disconnect();
  }
});

test('Only a moderator can change the brainstorm reaction set', async () => {
  const topic = uniqueTopic('brainstorm-reactset-auth');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    await claimModerator(mod, topic);

    // A non-moderator attempt is rejected and leaves the set at its defaults.
    const errored = waitForEvent(mod, 'error', (e) => /Not authorized/.test(e.message));
    mod.emit('setReactionKeys', topic, ['crux'], 'bogus-token');
    await errored;

    // Re-joining re-broadcasts discussionState, confirming the set is untouched.
    const state = waitForEvent(mod, 'discussionState', (s) => Array.isArray(s.reactionKeys));
    mod.emit('joinDiscussion', topic);
    assert.deepEqual((await state).reactionKeys, ['changed-mind', 'crux', 'follows', 'citation-needed', 'key-insight']);
  } finally {
    mod.disconnect();
  }
});

test('Brainstorm comment pseudonyms are sanitized before storage', async () => {
  const topic = uniqueTopic('brainstorm-sanitize');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Sanitize names');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'An idea', 'user-idea', 'Ideator');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabledUpdate;

    const oversized = 'x'.repeat(120);
    const commentUpdate = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1, 'comment added');
    await emitWithAck(participant, 'addResponseComment', topic, responseId, 'A point', 'user-c', `  ${oversized}  `);
    const comment = (await commentUpdate)[0].votes[0].comments[0];

    // Trimmed and capped to the same 40-char limit votes use.
    assert.equal(comment.pseudonym, oversized.slice(0, 40));
    assert.equal(comment.pseudonym.length, 40);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('Duplicating a discussion preserves brainstorm interaction flags', async () => {
  const topic = uniqueTopic('brainstorm-dup');
  const mod = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Carry flags');

    // Enable reactions but hide them, and enable comments — all non-default.
    const flaggedUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].reactionsEnabled === true && qs[0].reactionsVisible === false && qs[0].commentsEnabled === true,
      'flags set'
    );
    mod.emit('setDiscussionFlags', topic,
      { reactions_enabled: true, reactions_visible: false, comments_enabled: true }, token);
    await flaggedUpdate;

    // Also narrow the session-level reaction set to a non-default subset.
    const narrowed = waitForEvent(
      mod, 'discussionState', (s) => Array.isArray(s.reactionKeys) && s.reactionKeys.length === 2);
    mod.emit('setReactionKeys', topic, ['crux', 'follows'], token);
    await narrowed;

    // And pick a non-default color theme; the duplicate should keep it too.
    const themed = waitForEvent(mod, 'discussionState', (s) => s.theme === 'orange');
    mod.emit('setTheme', topic, 'orange', token);
    await themed;

    const newTopic = uniqueTopic('brainstorm-dup-copy');
    const dup = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: topic, newTopic });
    assert.equal(dup.status, 200);

    // The duplicate must keep the same flags, reaction set, and theme, not reset to defaults.
    const copy = await connectSocket();
    try {
      const copyQuestions = waitForQuestions(
        copy, (qs) => qs.length === 1 && qs[0].type === 'Brainstorm', 'copy questions');
      const copyState = waitForEvent(copy, 'discussionState', (s) => Array.isArray(s.reactionKeys));
      copy.emit('joinDiscussion', dup.body.newTopic);
      const q = (await copyQuestions)[0];
      assert.equal(q.reactionsEnabled, true);
      assert.equal(q.reactionsVisible, false);
      assert.equal(q.commentsEnabled, true);
      const state = await copyState;
      assert.deepEqual(state.reactionKeys, ['crux', 'follows']);
      assert.equal(state.theme, 'orange');
    } finally {
      copy.disconnect();
    }
  } finally {
    mod.disconnect();
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

function claimModerator(socket, topic) {
  return withTimeout(
    new Promise((resolve, reject) => {
      socket.emit('claimModerator', topic, (resp) => {
        if (resp && resp.success) resolve(resp.token);
        else reject(new Error('Failed to claim moderator'));
      });
    }),
    5000,
    'Timed out claiming moderator'
  );
}

async function addBrainstormQuestion(socket, topic, text) {
  const update = waitForQuestions(
    socket,
    (questions) => questions.some((q) => q.text === text && q.type === 'Brainstorm'),
    'brainstorm question added'
  );
  socket.emit('addQuestion', topic, { text, type: 'Brainstorm', minValue: null, maxValue: null, options: [] });
  const questions = await update;
  return questions.find((q) => q.text === text);
}

async function jsonRequest(method, urlPath, body) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

function connectSocket() {
  const socket = io(baseUrl, {
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });

  return withTimeout(
    new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    }),
    5000,
    'Timed out connecting Socket.IO client'
  );
}

async function startServer() {
  serverOutput = '';
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(serverPort),
      DATABASE_URL: databaseUrl,
      CLIENT_URL: baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', collectServerOutput);
  serverProcess.stderr.on('data', collectServerOutput);

  await waitForServer(baseUrl, serverProcess);
}

async function stopServer() {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await waitForExit(serverProcess);
  }
}

function waitForQuestions(socket, predicate, description) {
  return withTimeout(
    new Promise((resolve) => {
      const handler = (questions) => {
        if (predicate(questions)) {
          socket.off('questions', handler);
          resolve(questions);
        }
      };

      socket.on('questions', handler);
    }),
    5000,
    `Timed out waiting for ${description}`
  );
}

// Emit an event whose last argument is an ack callback, and resolve with the
// server's ack payload.
function emitWithAck(socket, event, ...args) {
  return withTimeout(
    new Promise((resolve) => {
      socket.emit(event, ...args, resolve);
    }),
    5000,
    `Timed out waiting for ack of ${event}`
  );
}

// Resolve with the first occurrence of an event (optionally matching predicate).
function waitForEvent(socket, event, predicate) {
  return withTimeout(
    new Promise((resolve) => {
      const handler = (payload) => {
        if (!predicate || predicate(payload)) {
          socket.off(event, handler);
          resolve(payload);
        }
      };

      socket.on(event, handler);
    }),
    5000,
    `Timed out waiting for ${event}`
  );
}

function waitForServer(url, childProcess) {
  let interval;
  const readiness = new Promise((resolve, reject) => {
    interval = setInterval(async () => {
      if (childProcess.exitCode !== null) {
        reject(new Error(`Server exited early with code ${childProcess.exitCode}\n${serverOutput}`));
        return;
      }

      try {
        const response = await fetch(`${url}/api/discussions`);
        if (response.ok) {
          resolve();
        }
      } catch {
        // Keep polling until the server accepts connections or the timeout wins.
      }
    }, 100);
  });

  return withTimeout(
    readiness,
    10000,
    `Timed out waiting for server to start\n${serverOutput}`
  ).finally(() => clearInterval(interval));
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForExit(childProcess) {
  try {
    await withTimeout(once(childProcess, 'exit'), 5000, 'Timed out waiting for server process to exit');
  } catch {
    childProcess.kill('SIGKILL');
    await once(childProcess, 'exit');
  }
}

function withTimeout(promise, milliseconds, message) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), milliseconds);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function collectServerOutput(chunk) {
  serverOutput += chunk.toString();
  if (serverOutput.length > 8000) {
    serverOutput = serverOutput.slice(-8000);
  }
}

function uniqueTopic(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function assertSafeTestDatabase(connectionString) {
  if (process.env.ALLOW_NON_TEST_DATABASE === '1') {
    return;
  }

  const url = new URL(connectionString);
  const databaseName = url.pathname.replace(/^\//, '');
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

  if (!localHosts.has(url.hostname) || !databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run destructive integration tests against ${url.hostname}/${databaseName}. ` +
      'Use a localhost database whose name ends with "_test", or set ALLOW_NON_TEST_DATABASE=1 for a disposable database.'
    );
  }
}
