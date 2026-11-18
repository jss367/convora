const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const vm = require('node:vm');
const { normalizeQuestionPayload } = require('../question-data');
const { buildOpinionSnapshot, OPINION_TYPES } = require('../opinion-snapshots');
const source = process.env.HOST_CONTROL_BASE
  ? execFileSync('git', ['show', process.env.HOST_CONTROL_BASE + ':server.js'], { encoding: 'utf8' })
  : fs.readFileSync(require.resolve('../server.js'), 'utf8');
const declaration = name => { const start = source.indexOf('async function ' + name + '('); return source.slice(start, source.indexOf('\n}', start) + 2); };
const listener = name => { const start = source.indexOf("  socket.on('" + name + "'"); return source.slice(start, source.indexOf('\n  });', start) + 7); };
function load(names, events, additions) {
  const handlers = {}, emitted = [], trace = [];
  const context = vm.createContext({ normalizeQuestionPayload, buildOpinionSnapshot, OPINION_TYPES,
    MAX_SNAPSHOT_NAME_LENGTH: 120, DISPLAY_QR_MODES: ['full', 'corner', 'hidden'], DISPLAY_LAYOUTS: ['all', 'focus', 'compare'],
    slugifyTopic: value => value, verifyAdmin: async () => 1, isDiscussionLocked: async () => false,
    parseOptions: value => value, logError() {}, emitQuestions: async () => {}, emitDiscussionState: async () => {},
    audience: () => ({ emit: name => { trace.push(name); } }),
    socket: { data: {}, on: (name, fn) => { handlers[name] = fn; }, emit: (...args) => emitted.push(args) },
    ...additions,
  });
  vm.runInContext(names.map(declaration).join('\n') + '\n' + events.map(listener).join('\n'), context);
  return { handlers, emitted, trace, context };
}

test('a lock that wins before the insert transaction keeps a question uninserted', async () => {
  const statements = [];
  const client = { release() {}, async query(sql) {
    statements.push(sql);
    if (/SELECT locked/.test(sql)) return { rows: [{ locked: true }] };
    if (/INSERT INTO questions/.test(sql)) return { rows: [{ id: 7, options: [] }] };
    return { rows: [] };
  } };
  const { context } = load(['addQuestion'], [], { pool: { connect: async () => client }, getOrCreateDiscussionForSlug: async () => ({ id: 1 }) });
  const result = await context.addQuestion('synthetic-room', { text: 'Fictional question', type: 'Agreement' });
  assert.equal(result.locked, true);
  assert.equal(statements.some(sql => /INSERT INTO questions/.test(sql)), false);
  assert.ok(statements.some(sql => /SELECT locked.*FOR SHARE/.test(sql)));
  assert.ok(statements.includes('ROLLBACK'));
});

function publisher({ locked = false, failDelivery = false } = {}) {
  let queued = true, updates = 0, deliveries = 0;
  const trace = [];
  const query = async sql => {
    trace.push(sql);
    if (/SELECT locked/.test(sql)) return { rows: [{ locked }] };
    if (/SELECT queued/.test(sql)) return { rows: [{ queued }] };
    if (/UPDATE questions/.test(sql)) { const changed = queued; queued = false; updates += Number(changed); return { rowCount: Number(changed) }; }
    return { rows: [] };
  };
  const client = { query, release() {} };
  const loaded = load(['withTransaction'], ['publishQuestion'], {
    pool: { connect: async () => client, query },
    emitQuestions: async () => { deliveries++; trace.push('delivery'); if (failDelivery && deliveries === 1) throw new Error('synthetic broadcast failure'); },
  });
  return { ...loaded, trace, state: () => ({ queued, updates, deliveries }) };
}

test('publication rechecks and holds the discussion lock in its transaction', async () => {
  const hook = publisher({ locked: true }); let ack;
  await hook.handlers.publishQuestion('synthetic-room', 7, 'token', value => { ack = value; });
  assert.equal(ack.reason, 'locked');
  assert.equal(hook.state().queued, true);
  assert.equal(hook.state().updates, 0);
  assert.ok(hook.trace.some(sql => /SELECT locked.*FOR SHARE/.test(sql)));
});

test('a committed publish is reported despite failed delivery and an authorized repeat repairs the list', async () => {
  const hook = publisher({ failDelivery: true }); let ack;
  await hook.handlers.publishQuestion('synthetic-room', 7, 'token', value => { ack = value; });
  assert.equal(ack.published, true);
  assert.equal(hook.state().queued, false);
  assert.ok(hook.trace.indexOf('COMMIT') < hook.trace.indexOf('delivery'));
  await hook.handlers.publishQuestion('synthetic-room', 7, 'token', value => { ack = value; });
  assert.equal(ack.published, false, 'repeat preserves the existing no-op reply');
  assert.equal(hook.state().updates, 1, 'created_at is only changed by the first publish');
  assert.equal(hook.state().deliveries, 2);
});

for (const settings of [{ beforeSnapshotId: 3 }, { afterSnapshotId: 2 }]) {
  test(`partial display pair ${JSON.stringify(settings)} is checked against the locked stored pair`, async () => {
    let writes = 0;
    const query = async sql => {
      if (/SELECT display_before/.test(sql)) return { rows: [{ display_before_snapshot_id: 2, display_after_snapshot_id: 3 }] };
      if (/SELECT id FROM opinion_snapshots/.test(sql)) return { rows: [{ id: 3 }] };
      if (/UPDATE discussions/.test(sql)) writes++;
      return { rows: [] };
    };
    const hook = load(['withTransaction'], ['setDisplaySettings'], { pool: { query, connect: async () => ({ query, release() {} }) } });
    await hook.handlers.setDisplaySettings('synthetic-room', settings, 'token');
    assert.equal(writes, 0);
    assert.ok(hook.emitted.some(([event]) => event === 'error'));
  });
}

test('valid partial display pairs and explicit null values remain accepted', async () => {
  for (const settings of [{ beforeSnapshotId: 1 }, { afterSnapshotId: null }]) {
    let writes = 0;
    const query = async sql => {
      if (/SELECT display_before/.test(sql)) return { rows: [{ display_before_snapshot_id: 2, display_after_snapshot_id: 3 }] };
      if (/SELECT id FROM opinion_snapshots/.test(sql)) return { rows: [{ id: 1 }] };
      if (/UPDATE discussions/.test(sql)) writes++;
      return { rows: [] };
    };
    const hook = load(['withTransaction'], ['setDisplaySettings'], { pool: { query, connect: async () => ({ query, release() {} }) } });
    await hook.handlers.setDisplaySettings('synthetic-room', settings, 'token');
    assert.equal(writes, 1);
  }
});

function revelation({ failReveal = false, failCapture = false } = {}) {
  const shared = { snapshots: [], revealed: false }, events = [], trace = [];
  let value = '.5';
  const clone = state => JSON.parse(JSON.stringify(state));
  const client = () => {
    let local = null, savepoint = null, failed = false;
    return { release() {}, async query(sql, args) {
      trace.push(sql);
      if (sql.startsWith('BEGIN')) { local = clone(shared); return { rows: [] }; }
      if (sql === 'ROLLBACK') { local = null; failed = false; return { rows: [] }; }
      if (sql.startsWith('ROLLBACK TO')) { local = clone(savepoint); failed = false; return { rows: [] }; }
      if (failed) throw new Error('synthetic aborted transaction');
      if (sql === 'COMMIT') { Object.assign(shared, local); local = null; return { rows: [] }; }
      if (sql.startsWith('SAVEPOINT')) { savepoint = clone(local); return { rows: [] }; }
      if (sql.startsWith('RELEASE')) return { rows: [] };
      const state = local || shared;
      if (/SELECT q.text/.test(sql)) return { rows: state.snapshots.length || state.revealed ? [] : [{ text: 'Fictional scale' }] };
      if (/SELECT id FROM questions/.test(sql)) return { rows: [{ id: 7 }] };
      if (/SELECT id, text, type/.test(sql)) return { rows: [{ id: 7, text: 'Fictional scale', type: 'Numerical', min_value: 0, max_value: 5 }] };
      if (/SELECT v.id/.test(sql)) return { rows: [{ id: 1, question_id: 7, value, user_id: 'fictional-person' }] };
      if (/INSERT INTO opinion_snapshots/.test(sql)) {
        if (failCapture) { failed = true; throw new Error('synthetic capture failure'); }
        const snapshot = { id: 1, data: JSON.parse(args[2]) }; state.snapshots.push(snapshot);
        return { rows: [snapshot] };
      }
      if (/UPDATE questions SET results_revealed/.test(sql)) {
        if (failReveal) { failed = true; throw new Error('synthetic reveal failure'); }
        state.revealed = args[0]; return { rowCount: 1 };
      }
      return { rows: [] };
    } };
  };
  const pool = { connect: async () => client(), query: (...args) => client().query(...args) };
  const hook = load(['withTransaction', 'saveOpinionSnapshot', 'saveSnapshotBeforeReveal'], ['setResultsRevealed'], {
    pool, snapshotNameBeforeReveal: () => 'Synthetic before',
    audience: () => ({ emit: name => { events.push(name); trace.push(name); } }),
  });
  return { ...hook, shared, events, trace,
    retry() { failReveal = false; value = '4.5'; },
  };
}

test('a failed reveal rolls back its automatic baseline and a retry captures the new answers', async () => {
  const hook = revelation({ failReveal: true });
  await hook.handlers.setResultsRevealed('synthetic-room', 7, true, 'token');
  assert.equal(hook.shared.revealed, false);
  assert.equal(hook.shared.snapshots.length, 0);
  assert.equal(hook.events.length, 0);
  hook.retry();
  await hook.handlers.setResultsRevealed('synthetic-room', 7, true, 'token');
  assert.equal(hook.shared.revealed, true);
  assert.equal(hook.shared.snapshots[0].data.questions[0].average, 4.5);
  assert.ok(hook.trace.indexOf('COMMIT') < hook.trace.indexOf('snapshotsChanged'));
});

test('capture failure rolls back to its savepoint while preserving the reveal-only fallback', async () => {
  const hook = revelation({ failCapture: true });
  await hook.handlers.setResultsRevealed('synthetic-room', 7, true, 'token');
  assert.equal(hook.shared.revealed, true);
  assert.equal(hook.shared.snapshots.length, 0);
  assert.equal(hook.events.length, 0);
});

test('moderator resends are discarded after leaving or revisiting a room', async () => {
  let guard;
  const socket = { data: { topic: 'synthetic-A', discussionVisit: 1 } };
  const hook = load(['resendQuestionsIfPersonalized'], [], { emitQuestions: async (_slug, _socket, current) => { guard = current; }, getResultsAccess: async () => ({ alwaysShow: true }) });
  await hook.context.resendQuestionsIfPersonalized(socket, { moderatorChanged: true });
  assert.equal(typeof guard, 'function');
  assert.equal(guard(), true);
  socket.data.topic = 'synthetic-B'; socket.data.discussionVisit = 2;
  assert.equal(guard(), false);
  socket.data.topic = 'synthetic-A'; socket.data.discussionVisit = 3;
  assert.equal(guard(), false);
});

test('manual saves preserve historical snapshot payloads while new snapshots use the new bins', async () => {
  const hook = revelation();
  const historical = { id: 41, data: { questions: [{ type: 'Numerical', distribution: [{ min: 0, max: 1, count: 1 }] }] } };
  hook.shared.snapshots.push(historical);
  const before = JSON.stringify(historical);
  const saved = await hook.context.saveOpinionSnapshot(1, 'Synthetic manual');
  assert.equal(saved.snapshot.data.questions[0].distribution.length, 6);
  assert.equal(JSON.stringify(hook.shared.snapshots[0]), before);
  assert.ok(hook.trace.includes('BEGIN ISOLATION LEVEL REPEATABLE READ'));
  assert.ok(hook.trace.includes('COMMIT'));
});
