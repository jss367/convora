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
let pool;

test.before(async () => {
  assertSafeTestDatabase(databaseUrl);

  const port = await getAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  pool = new Pool({ connectionString: databaseUrl });

  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      CLIENT_URL: baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', collectServerOutput);
  serverProcess.stderr.on('data', collectServerOutput);

  await waitForServer(baseUrl, serverProcess);
});

test.beforeEach(async () => {
  await pool.query('TRUNCATE TABLE votes, questions, discussions RESTART IDENTITY CASCADE');
});

test.after(async () => {
  if (pool) {
    await pool.end();
  }

  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await waitForExit(serverProcess);
  }
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

  const fetchResponse = await jsonRequest('GET', `/api/discussions/${createResponse.body.id}`);
  assert.equal(fetchResponse.status, 200);
  assert.equal(fetchResponse.body.topic, topic);
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
