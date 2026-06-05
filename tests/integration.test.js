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

test('participant handle formula matches between client and server', async () => {
  // The moderator panel hides promote/remove on the viewer's own row by matching
  // the server's opaque handle: "participant-" + first 16 hex of sha256(userId).
  // The client computes it from the same sha256Hex this asserts against the
  // server hash, so they must agree — otherwise the self row fails open to
  // showing its own controls again. (identity.js can't be imported directly here
  // because of its extensionless ./sha256 import, so we re-derive the formula.)
  const { sha256Hex } = await import('../client/src/sha256.js');
  const ids = ['user-1', 'guest-user-1', 'Z9f3a2b1c0d4e5f6', 'a'.repeat(80)];
  for (const id of ids) {
    const client = `participant-${sha256Hex(new TextEncoder().encode(String(id))).slice(0, 16)}`;
    const server = `participant-${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16)}`;
    assert.equal(client, server, `participant handle mismatch for ${JSON.stringify(id)}`);
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

test('the creator can remove a moderator, revoking their access live', async () => {
  const topic = uniqueTopic('demote');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'demote-guest-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Demote me?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Doomed Crab');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(list.canDemote, true); // the creator may remove moderators
    const guestHandle = list.participants[0].id;

    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    const grant = await granted;

    // The granted token works before demotion (a promoted mod is not the creator).
    const asMod = await emitWithAck(guest, 'listParticipants', topic, grant.token);
    assert.equal(asMod.success, true);
    assert.equal(asMod.canDemote, false);

    // The creator removes them: the guest is told live and the flag clears.
    const revoked = waitForEvent(guest, 'moderatorRevoked');
    const demote = await emitWithAck(mod, 'demoteModerator', topic, adminToken, guestHandle);
    assert.equal(demote.success, true);
    assert.equal(demote.participants[0].isModerator, false);
    await revoked;

    // Their token no longer grants moderation.
    const afterRevoke = await emitWithAck(guest, 'listParticipants', topic, grant.token);
    assert.equal(afterRevoke.success, false);
    assert.equal(afterRevoke.error, 'not_authorized');
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a promoted moderator cannot remove moderators (creator-only)', async () => {
  const topic = uniqueTopic('demote-deny');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'demote-deny-guest';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Q?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Power Hungry Yak');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;

    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    const grant = await granted;

    // A promoted moderator is not the creator: their own token can't demote.
    const demote = await emitWithAck(guest, 'demoteModerator', topic, grant.token, guestHandle);
    assert.equal(demote.success, false);
    assert.equal(demote.error, 'not_authorized');

    // Still a moderator — the rejected attempt revoked nothing.
    const after = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(after.participants[0].isModerator, true);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a moderator who deleted their only response can still be removed', async () => {
  const topic = uniqueTopic('demote-novotes');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'novotes-guest';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    // The guest becomes a participant by posting a Brainstorm idea.
    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Ideas?', type: 'Brainstorm', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const ideaPosted = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'idea posted');
    guest.emit('vote', topic, questionId, 'My only idea', guestUserId, 'Fleeting Crab');
    const voteId = (await ideaPosted)[0].votes[0].id;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;
    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    await granted;

    // The guest deletes their only idea — they now have no votes, so the
    // vote-derived list would normally drop them.
    const ideaRemoved = waitForQuestions(mod, (questions) => questions[0] && questions[0].votes.length === 0, 'idea removed');
    guest.emit('deleteVote', topic, voteId, guestUserId);
    await ideaRemoved;

    // They must still appear as a moderator so the creator can remove them.
    const afterDelete = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const stillListed = afterDelete.participants.find((p) => p.id === guestHandle);
    assert.ok(stillListed, 'a vote-less moderator should still be listed');
    assert.equal(stillListed.isModerator, true);

    // ...and the creator can demote them; afterwards they have neither votes nor
    // a grant, so they drop out of the list entirely.
    const demote = await emitWithAck(mod, 'demoteModerator', topic, adminToken, guestHandle);
    assert.equal(demote.success, true);
    assert.equal(demote.participants.find((p) => p.id === guestHandle), undefined);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('checkModerator rejects a revoked token so offline demotions clear stale UI', async () => {
  const topic = uniqueTopic('check-mod');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'check-guest-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Q?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Soon Gone Fox');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;
    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    const grant = await granted;

    // While granted, the token checks out.
    assert.deepEqual(await emitWithAck(guest, 'checkModerator', topic, grant.token), { ok: true, isModerator: true });

    // After removal the same token no longer checks out — this is what lets an
    // offline-demoted user's client drop its stale token on next load.
    await emitWithAck(mod, 'demoteModerator', topic, adminToken, guestHandle);
    assert.deepEqual(await emitWithAck(guest, 'checkModerator', topic, grant.token), { ok: true, isModerator: false });

    // The creator's own token still checks out.
    assert.deepEqual(await emitWithAck(mod, 'checkModerator', topic, adminToken), { ok: true, isModerator: true });
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
    mod.emit('setQuestionFlags', topic, question.id, { reactions_enabled: true }, token);
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
    mod.emit('setQuestionFlags', topic, question.id, { reactions_enabled: true }, token);
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
    mod.emit('setQuestionFlags', topic, question.id, { comments_enabled: true }, token);
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
    mod.emit('setQuestionFlags', topic, question.id, { reactions_enabled: true, comments_enabled: true }, token);
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
    mod.emit('setQuestionFlags', topic, question.id, { comments_enabled: true }, token);
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
    mod.emit('setQuestionFlags', topic, question.id, { reactions_enabled: true }, token);
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
    mod.emit('setQuestionFlags', topic, question.id, { comments_enabled: true }, token);
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
    mod.emit('setQuestionFlags', topic, question.id,
      { reactions_enabled: true, reactions_visible: false, comments_enabled: true }, token);
    await flaggedUpdate;

    const newTopic = uniqueTopic('brainstorm-dup-copy');
    const dup = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: topic, newTopic });
    assert.equal(dup.status, 200);

    // The duplicate must keep the same flags, not reset to defaults.
    const copy = await connectSocket();
    try {
      const copyQuestions = waitForQuestions(
        copy, (qs) => qs.length === 1 && qs[0].type === 'Brainstorm', 'copy questions');
      copy.emit('joinDiscussion', dup.body.newTopic);
      const q = (await copyQuestions)[0];
      assert.equal(q.reactionsEnabled, true);
      assert.equal(q.reactionsVisible, false);
      assert.equal(q.commentsEnabled, true);
    } finally {
      copy.disconnect();
    }
  } finally {
    mod.disconnect();
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
