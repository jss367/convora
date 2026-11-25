// Shared setup for the integration test files. Each file runs in its own
// process (node:test runs files concurrently), so each one gets its own
// server on a free port and its own database. The per-file database keeps one
// file's cleanup, row counts, and lock waits from reaching another file's tests.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { test } = require('node:test');
const { once } = require('node:events');
const { Client, Pool } = require('pg');
const { io } = require('socket.io-client');
const { assertSafeTestDatabase } = require('../../scripts/test-database');
const { cleanupDiscussions } = require('./cleanup-discussions.cjs');

const rootDir = path.resolve(__dirname, '../..');
const sharedDatabaseUrl = process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test';

let serverProcess;
let serverOutput = '';
let baseUrl;
let serverPort;
let databaseUrl;
let pool;

// Every file holds this advisory lock in shared mode while it sets up, runs a
// test, or drops its database. A test that measures elapsed time takes it in exclusive
// mode instead, so it runs while no other file loads the CPU or Postgres.
// Advisory locks are per database, so every file takes it in the shared one.
const EXCLUSIVE_LOCK = "hashtext('convora:integration-tests')";

// Register the hooks that give one test file its own database and server.
// Returns the file's pool and connection string right away (the pool connects
// lazily), plus getters for the server's URL and recent output, which exist
// only once the before hook has run. `exclusive` names the file's tests that
// must not overlap with tests from other files.
function useIntegrationServer(testFile, { exclusive = [] } = {}) {
  const databaseName = fileDatabaseName(sharedDatabaseUrl, testFile);
  const exclusiveTests = new Set(exclusive);
  // A renamed test would otherwise silently lose its exclusive run.
  const source = fs.readFileSync(testFile, 'utf8');
  for (const name of exclusiveTests) assert.ok(source.includes(`test('${name}',`), `No test named ${JSON.stringify(name)} in ${testFile}`);
  databaseUrl = withDatabase(sharedDatabaseUrl, databaseName);
  pool = new Pool({ connectionString: databaseUrl });
  let gate;
  let heldMode = null;

  const lock = async mode => {
    await gate.query(`SELECT pg_advisory_lock${mode}(${EXCLUSIVE_LOCK})`);
    heldMode = mode;
  };
  const unlock = async () => {
    if (heldMode === null) return;
    await gate.query(`SELECT pg_advisory_unlock${heldMode}(${EXCLUSIVE_LOCK})`);
    heldMode = null;
  };

  test.before(async () => {
    assertSafeTestDatabase(sharedDatabaseUrl);
    assertSafeTestDatabase(databaseUrl);
    gate = new Client({ connectionString: sharedDatabaseUrl });
    await gate.connect();
    await lock('_shared');
    try {
      await recreateDatabase(gate, databaseName);

      serverPort = await getAvailablePort();
      baseUrl = `http://127.0.0.1:${serverPort}`;

      await startServer();
    } finally {
      await unlock();
    }
  });

  test.beforeEach(async t => {
    await lock(exclusiveTests.has(t.name) ? '' : '_shared');
    try {
      await cleanupDiscussions(pool);
    } catch (error) {
      await unlock();
      throw error;
    }
  });

  test.afterEach(async () => {
    await unlock();
  });

  test.after(async () => {
    await pool.end();
    await stopServer();
    if (!gate) return;
    try {
      await lock('_shared');
      await dropDatabase(gate, databaseName);
    } finally {
      // Closing the session also releases its advisory lock.
      await gate.end();
    }
  });

  return {
    pool,
    databaseUrl,
    get baseUrl() { return baseUrl; },
    get output() { return serverOutput; },
  };
}

// Derive a name such as convora_integration_voting_test from the shared
// convora_test database and the test file's name. The name keeps the _test
// suffix that the destructive-test guard requires.
function fileDatabaseName(connectionString, testFile) {
  const { database } = new Client({ connectionString }).connectionParameters;
  const stem = String(database).replace(/_test$/, '');
  const file = path.basename(testFile).replace(/\.test\.js$/, '').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  return `${stem}_${file}_test`;
}

function withDatabase(connectionString, databaseName) {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  const result = url.toString();
  // A database named in the query string would override the path and send
  // every file to the same database, so refuse it instead.
  if (new Client({ connectionString: result }).connectionParameters.database !== databaseName) {
    throw new Error(`Cannot derive a per-file test database from ${connectionString}`);
  }
  return result;
}

// A database left by an interrupted run is replaced rather than reused.
async function recreateDatabase(client, databaseName) {
  await dropDatabase(client, databaseName);
  await client.query(`CREATE DATABASE "${databaseName}"`);
}

function dropDatabase(client, databaseName) {
  return client.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
}

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
    (questions) => questions.some((q) => q.text === text && q.type === 'Open Ended'),
    'brainstorm question added'
  );
  socket.emit('addQuestion', topic, { text, type: 'Open Ended', minValue: null, maxValue: null, options: [] });
  const questions = await update;
  return questions.find((q) => q.text === text);
}

async function jsonRequest(method, urlPath, body, headers = {}) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
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

// Fixtures used by more than one integration test file.

// Give a racing statement on the questions table up to two seconds to block on
// the row lock the test holds, so the test releases the lock only once the race
// is set up. Without serialization nothing blocks, and the test goes on to
// assert the outcome anyway, which is what catches the bug. Only this file's
// database counts, since other test files wait on their own locks concurrently.
async function waitForQuestionLockWait() {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const waiting = await pool.query(
      `SELECT count(*)::int AS count FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%questions%'`
    );
    if (waiting.rows[0].count > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// A discussion with one question of each tallied type plus an Open Ended one,
// each already answered by two other participants.
async function seedResultsDiscussion(prefix) {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic(prefix) });
  const { id, slug, adminToken } = created.body;
  const inserted = await pool.query(
    `INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES
      ($1, 'We should proceed', 'Agreement', NULL, NULL),
      ($1, 'Proceed now?', 'Yes/No', NULL, NULL),
      ($1, 'Chance of success?', 'Numerical', 0, 100),
      ($1, 'Why?', 'Open Ended', NULL, NULL)
     RETURNING id`, [id]
  );
  const [agreement, yesNo, numerical, written] = inserted.rows.map(row => row.id);
  await pool.query(
    `INSERT INTO votes (question_id, value, user_id, pseudonym) VALUES
      ($1, 'Agree', 'seed-a', 'Seed A'), ($1, 'Disagree', 'seed-b', 'Seed B'),
      ($2, 'Yes', 'seed-a', 'Seed A'), ($2, 'No', 'seed-b', 'Seed B'),
      ($3, '30', 'seed-a', 'Seed A'), ($3, '50', 'seed-b', 'Seed B'),
      ($4, 'Because reasons', 'seed-a', 'Seed A')`,
    [agreement, yesNo, numerical, written]
  );
  return { id, slug, adminToken, agreement, yesNo, numerical, written };
}

const asModerator = token => ({ 'X-Convora-Moderator': token });
const asUser = userId => ({ 'X-Convora-User': userId });

// Nothing a tally could be rebuilt from may be present on a hidden question.
// Interest marks say who wants to discuss a question, not how anyone answered
// it, so they stay visible.
function assertResultsHidden(question, label) {
  assert.equal(question.resultsHidden, true, `${label}: marked hidden`);
  assert.deepEqual(question.votes, [], `${label}: no votes on the wire`);
  assert.deepEqual(
    Object.keys(question).filter(key => !['maxResponses', 'max_responses', 'interestCount', 'interestVoterTokens', 'downvoteCount', 'downvoterTokens'].includes(key) && /vote|count|tally|result|average|response|distribution/i.test(key)).sort(),
    ['resultsHidden', 'resultsRevealed', 'votes'], `${label}: no other result fields`
  );
  assert.equal(question.resultsRevealed, false, `${label}: not revealed`);
  assert.doesNotMatch(JSON.stringify(question), /Seed A|Seed B|ownerToken|"value"/, `${label}: no vote data`);
}

function assertResultsShown(question, expectedValues, label) {
  assert.equal(question.resultsHidden, false, `${label}: not marked hidden`);
  assert.deepEqual(question.votes.map(vote => vote.value).sort(), [...expectedValues].sort(), `${label}: all votes present`);
}

const byId = (questions, id) => questions.find(question => question.id === id);
const nextQuestions = (socket, description) => waitForQuestions(socket, () => true, description);

async function joinAs(slug, userId) {
  const socket = await connectSocket();
  const joined = nextQuestions(socket, `join as ${userId || 'anonymous'}`);
  if (userId) socket.emit('identify', slug, userId);
  socket.emit('joinDiscussion', slug);
  return { socket, questions: await joined };
}

// A room display joins as a display, never as a participant.
async function joinDisplay(slug) {
  const socket = await connectSocket();
  const joined = nextQuestions(socket, 'room display join');
  socket.emit('joinDisplay', slug);
  return { socket, questions: await joined };
}

function storedVotes(questionId) {
  return pool.query('SELECT user_id, value FROM votes WHERE question_id = $1 ORDER BY id', [questionId])
    .then(result => result.rows);
}

// A moderator socket: joined, identified by nothing but its proven token.
async function joinAsModerator(slug, adminToken) {
  const { socket } = await joinAs(slug, null);
  assert.equal((await emitWithAck(socket, 'checkModerator', slug, adminToken)).isModerator, true);
  return socket;
}

module.exports = {
  useIntegrationServer,
  rootDir,
  claimModerator,
  addBrainstormQuestion,
  jsonRequest,
  connectSocket,
  startServer,
  stopServer,
  waitForQuestions,
  emitWithAck,
  waitForEvent,
  withTimeout,
  uniqueTopic,
  waitForQuestionLockWait,
  seedResultsDiscussion,
  asModerator,
  asUser,
  assertResultsHidden,
  assertResultsShown,
  byId,
  nextQuestions,
  joinAs,
  joinDisplay,
  storedVotes,
  joinAsModerator,
};
