const assert = require('node:assert/strict');
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

test('creating a discussion makes the creator its moderator', async () => {
  const topic = uniqueTopic('creator-mod');

  const createResponse = await jsonRequest('POST', '/api/discussions', { topic });
  assert.equal(createResponse.status, 200);
  // The creator gets a moderator token back on the request that establishes it.
  assert.match(createResponse.body.adminToken, /^[a-f0-9]{32}$/);

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
    assert.equal(updatedQuestions[0].votes[0].value, 'Agree');
    assert.equal(updatedQuestions[0].votes[0].userId, 'user-1');
    assert.equal(updatedQuestions[0].votes[0].pseudonym, 'Careful Tester');
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
