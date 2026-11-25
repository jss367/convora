const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { test } = require('node:test');
const {
  useIntegrationServer,
  rootDir,
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
  joinAs,
  joinDisplay,
  joinAsModerator,
} = require('./helpers/integration.cjs');

const { pool } = useIntegrationServer(__filename);

test('opinion snapshots enforce moderator access and validate names and question types', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('snapshot-auth') });
  const other = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('snapshot-other') });
  const { slug, adminToken } = created.body;
  const url = `/api/discussions/${slug}/snapshots`;
  assert.deepEqual((await jsonRequest('GET', url)).body, { snapshots: [] });
  for (const token of [undefined, 'invalid', other.body.adminToken]) {
    assert.equal((await jsonRequest('POST', url, { name: 'Before', adminToken: token })).status, 403);
  }
  for (const name of ['', '  ', 'x'.repeat(121), 42, {}]) {
    assert.equal((await jsonRequest('POST', url, { name, adminToken })).status, 400);
  }
  assert.equal((await jsonRequest('POST', url, { name: 'Before', adminToken })).status, 400);
  await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Ideas', 'Open Ended')", [created.body.id]);
  assert.equal((await jsonRequest('POST', url, { name: 'Before', adminToken })).status, 400);
  assert.equal((await jsonRequest('GET', '/api/discussions/nonexistent-snapshot-discussion/snapshots')).status, 404);
  assert.deepEqual((await jsonRequest('GET', `/api/discussions/${other.body.slug}/snapshots`)).body, { snapshots: [] });
});

test('snapshots preserve probabilities and opinion distributions across updates, edits, deletion, and restart', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('snapshot-lifecycle') });
  const { id, slug, adminToken } = created.body;
  const url = `/api/discussions/${slug}/snapshots`;
  const questions = await pool.query(
    `INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES
      ($1, 'Probability of success (%)?', 'Numerical', 0, 100),
      ($1, 'We should proceed', 'Agreement', NULL, NULL),
      ($1, 'Proceed?', 'Yes/No', NULL, NULL),
      ($1, 'Why?', 'Open Ended', NULL, NULL)
     RETURNING id`, [id]
  );
  const [numerical, agreement, yesNo, written] = questions.rows.map(q => q.id);
  await pool.query(
    `INSERT INTO votes (question_id, value, user_id, pseudonym) VALUES
      ($1, '30', 'private-snapshot-user-a', 'Private Snapshot Name'),
      ($1, '50', 'private-snapshot-user-b', NULL),
      ($2, 'Agree', 'private-snapshot-user-a', NULL),
      ($2, 'Disagree', 'private-snapshot-user-b', NULL),
      ($3, 'Yes', 'private-snapshot-user-a', NULL),
      ($3, 'No', 'private-snapshot-user-b', NULL),
      ($4, 'private-written-answer', 'private-snapshot-user-a', NULL)`,
    [numerical, agreement, yesNo, written]
  );
  const firstResponse = await jsonRequest('POST', url, { name: ' Before discussion ', adminToken });
  assert.equal(firstResponse.status, 201);
  const first = firstResponse.body;
  assert.equal(first.name, 'Before discussion');
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
  assert.equal(first.data.participantCount, 2);
  assert.equal(first.data.questions.length, 3);
  const initialProbability = first.data.questions.find(q => q.id === numerical);
  assert.equal(initialProbability.average, 40);
  assert.equal(initialProbability.responseCount, 2);
  assert.deepEqual(initialProbability.distribution.map(bin => bin.count), [0, 0, 0, 1, 0, 1, 0, 0, 0, 0]);
  assert.deepEqual(first.data.questions.find(q => q.id === agreement).optionCounts,
    { 'Strongly Disagree': 0, Disagree: 1, Unsure: 0, Agree: 1, 'Strongly Agree': 0 });
  assert.deepEqual(first.data.questions.find(q => q.id === yesNo).optionCounts, { No: 1, Yes: 1 });
  assert.doesNotMatch(JSON.stringify(first), /private-snapshot|Private Snapshot Name|private-written-answer|user_id|userId|ownerToken|adminToken/);

  const voter = await connectSocket();
  try {
    const updated = waitForQuestions(voter, qs => qs.some(q => q.id === numerical && q.votes.some(v => v.value === '70')), 'updated probability');
    voter.emit('joinDiscussion', slug);
    voter.emit('vote', slug, numerical, 70, 'private-snapshot-user-a', '');
    await updated;
  } finally {
    voter.disconnect();
  }
  await pool.query("UPDATE votes SET value = 'Strongly Agree' WHERE question_id = $1 AND value = 'Disagree'", [agreement]);
  const second = (await jsonRequest('POST', url, { name: 'After discussion', adminToken })).body;
  assert.equal(second.data.questions.find(q => q.id === numerical).average, 60);
  assert.equal(second.data.questions.find(q => q.id === agreement).optionCounts['Strongly Agree'], 1);
  assert.ok(second.id > first.id);
  assert.deepEqual((await jsonRequest('GET', url, undefined, asModerator(adminToken))).body.snapshots, [first, second]);

  await pool.query("UPDATE questions SET text = 'Edited question', max_value = 200 WHERE id = $1", [numerical]);
  await pool.query('DELETE FROM votes WHERE question_id = $1', [yesNo]);
  await pool.query('DELETE FROM questions WHERE id = $1', [yesNo]);
  await stopServer();
  await startServer();
  assert.deepEqual((await jsonRequest('GET', url, undefined, asModerator(adminToken))).body.snapshots, [first, second]);
  assert.deepEqual((await jsonRequest('GET', `/api/discussions/${slug}/summary`)).body.questions.find(q => q.id === numerical).text, 'Edited question');
});

test('persisted categorical snapshots render ordered labels, zero counts, and aligned before/after values', async () => {
  const componentPath = path.join(rootDir, 'client/src/OpinionSnapshots.jsx');
  const { outputFiles } = await require('esbuild').build({ entryPoints: [componentPath], bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false });
  const componentModule = { exports: {} };
  const loadComponent = vm.runInThisContext(`(function(require, module, exports) { ${outputFiles[0].text}\n})`, { filename: componentPath });
  loadComponent(require, componentModule, componentModule.exports);
  const { QuestionComparison } = componentModule.exports;

  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('snapshot-display') });
  const { id, slug, adminToken } = created.body;
  const url = `/api/discussions/${slug}/snapshots`;
  const cases = [
    { type: 'Agreement', labels: ['Strongly Disagree', 'Disagree', 'Unsure', 'Agree', 'Strongly Agree'], before: [1, 0, 1, 0, 2], after: [0, 2, 0, 1, 1] },
    { type: 'Yes/No', labels: ['No', 'Yes'], before: [1, 0], after: [0, 2] },
    // Author-written options keep the author's order, not alphabetical or key order.
    { type: 'Multiple Choice', labels: ['Lower', 'About the same', 'Higher'], before: [2, 0, 1], after: [0, 1, 2], choice: true },
  ];
  for (const item of cases) {
    const added = await pool.query(
      'INSERT INTO questions (discussion_id, text, type, options) VALUES ($1, $2, $3, $4) RETURNING id',
      [id, `Saved ${item.type} opinions`, item.type, item.choice ? JSON.stringify(item.labels) : null]
    );
    item.id = added.rows[0].id;
  }
  const setResponses = async phase => {
    for (const item of cases) {
      await pool.query('DELETE FROM votes WHERE question_id = $1', [item.id]);
      let user = 0;
      for (let option = 0; option < item.labels.length; option += 1) {
        for (let count = 0; count < item[phase][option]; count += 1) {
          await pool.query('INSERT INTO votes (question_id, value, user_id) VALUES ($1, $2, $3)', [item.id, item.labels[option], `display-user-${user++}`]);
        }
      }
    }
  };
  await setResponses('before');
  assert.equal((await jsonRequest('POST', url, { name: 'Before', adminToken })).status, 201);
  await setResponses('after');
  assert.equal((await jsonRequest('POST', url, { name: 'After', adminToken })).status, 201);
  const { snapshots: [before, after] } = (await jsonRequest('GET', url, undefined, asModerator(adminToken))).body;

  for (const item of cases) {
    const earlier = before.data.questions.find(q => q.id === item.id);
    const later = after.data.questions.find(q => q.id === item.id);
    if (item.type === 'Agreement') assert.notDeepEqual(Object.keys(earlier.optionCounts), item.labels, 'JSONB has reordered the stored keys');
    const html = renderToStaticMarkup(React.createElement(QuestionComparison, {
      before: earlier, after: later, comparing: true, beforeName: before.name, afterName: after.name,
    }));
    const rows = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)]
      .flatMap(body => [...body[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)])
      .map(row => ({
        label: row[1].match(/<th scope="row"[^>]*>([^<]*)<\/th>/)[1],
        counts: [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
          .map(cell => Number(cell[1].replace(/<[^>]+>/g, '').match(/^(\d+) /)[1])),
      }));
    assert.deepEqual(rows, item.labels.map((label, index) => ({ label, counts: [item.before[index], item.after[index]] })));
  }

  // Someone who has not answered gets each Multiple Choice snapshot without its
  // counts, but still sees the options it asked about.
  const choice = cases.find(item => item.choice);
  const { snapshots: [hiddenBefore, hiddenAfter] } = (await jsonRequest('GET', url, undefined, asUser('snapshot-stranger'))).body;
  const hiddenEarlier = hiddenBefore.data.questions.find(q => q.id === choice.id);
  assert.deepEqual(hiddenEarlier, {
    id: choice.id, text: 'Saved Multiple Choice opinions', type: 'Multiple Choice', options: choice.labels, resultsHidden: true,
  });
  const hiddenHtml = renderToStaticMarkup(React.createElement(QuestionComparison, {
    before: hiddenEarlier, after: hiddenAfter.data.questions.find(q => q.id === choice.id),
    comparing: true, beforeName: hiddenBefore.name, afterName: hiddenAfter.name,
  }));
  assert.deepEqual([...hiddenHtml.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map(match => match[1]), choice.labels);
  assert.doesNotMatch(hiddenHtml, /<table|\d+%/);
  // A long unbroken option wraps inside the card rather than overflowing it.
  for (const item of hiddenHtml.matchAll(/<li class="([^"]*)"/g)) {
    assert.match(item[1], /\bmax-w-full\b/);
    assert.match(item[1], /\bbreak-words\b/);
  }
});

test('snapshots support empty responses, numerical bounds, locked rooms, and promoted moderators', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('snapshot-boundaries') });
  const { id, slug, adminToken } = created.body;
  const url = `/api/discussions/${slug}/snapshots`;
  const added = await pool.query(
    "INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES ($1, 'Probability?', 'Numerical', 0, 100) RETURNING id", [id]
  );
  const questionId = added.rows[0].id;
  const empty = (await jsonRequest('POST', url, { name: 'No responses yet', adminToken })).body;
  assert.equal(empty.data.participantCount, 0);
  assert.equal(empty.data.questions[0].average, null);
  assert.equal(empty.data.questions[0].responseCount, 0);
  assert.equal(empty.data.questions[0].distribution.reduce((sum, bin) => sum + bin.count, 0), 0);
  await pool.query(
    "INSERT INTO votes (question_id, value, user_id) VALUES ($1, '0', 'a'), ($1, '100', 'b'), ($1, 'invalid legacy value', 'c')", [questionId]
  );
  await pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [id]);
  const token = crypto.randomBytes(16).toString('hex');
  await pool.query('INSERT INTO discussion_moderators (discussion_id, user_id, token) VALUES ($1, $2, $3)', [id, 'promoted-user', token]);
  const saved = await jsonRequest('POST', url, { name: 'Final opinions', adminToken: token });
  assert.equal(saved.status, 201);
  const probability = saved.body.data.questions[0];
  assert.equal(probability.average, 50);
  assert.equal(probability.responseCount, 2);
  assert.equal(saved.body.data.participantCount, 2);
  assert.equal(probability.distribution[0].count, 1);
  assert.equal(probability.distribution[9].count, 1);
  await pool.query('DELETE FROM discussion_moderators WHERE token = $1', [token]);
  assert.equal((await jsonRequest('POST', url, { name: 'Revoked moderator', adminToken: token })).status, 403);
});

test('showing a question\'s results for the first time saves a "before" snapshot by itself', async () => {
  const seed = await seedResultsDiscussion('auto-snapshot');
  const { slug, adminToken } = seed;
  const url = `/api/discussions/${slug}/snapshots`;
  const mod = await joinAsModerator(slug, adminToken);
  const { socket: voter } = await joinAs(slug, 'seed-c');
  const { socket: display } = await joinDisplay(slug);
  const snapshots = async (headers = asModerator(adminToken)) => (await jsonRequest('GET', url, undefined, headers)).body.snapshots;
  // Show or hide a question's results and wait until the room has been told.
  const setRevealed = async (questionId, revealed) => {
    const told = waitForQuestions(mod, qs => byId(qs, questionId)?.resultsRevealed === revealed, `results ${revealed ? 'shown' : 'hidden'}`);
    mod.emit('setResultsRevealed', slug, questionId, revealed, adminToken);
    await told;
  };
  try {
    assert.deepEqual(await snapshots(), []);

    // Everyone watching is told, so an open snapshot panel and the room display reload.
    const voterTold = waitForEvent(voter, 'snapshotsChanged');
    const displayTold = waitForEvent(display, 'snapshotsChanged');
    await setRevealed(seed.agreement, true);
    await Promise.all([voterTold, displayTold]);
    const [first, ...rest] = await snapshots();
    assert.deepEqual(rest, []);
    assert.equal(first.name, 'Before results shown: We should proceed');
    // Like any snapshot, it covers every tallied question, as the room stood.
    assert.deepEqual(first.data.questions.map(q => [q.id, q.responseCount]), [[seed.agreement, 2], [seed.yesNo, 2], [seed.numerical, 2]]);
    assert.doesNotMatch(JSON.stringify(first), /seed-a|seed-b|Seed A|Seed B|auto_question_id|autoQuestionId/);
    // The revealed question's saved results are open to everyone, like its live ones.
    const forDisplay = (await snapshots({}))[0].data.questions;
    assert.equal(byId(forDisplay, seed.agreement).responseCount, 2);
    assert.equal(byId(forDisplay, seed.yesNo).resultsHidden, true);

    // Answers change once people have seen the results. Hiding and showing the
    // same question again keeps the one snapshot from before.
    assert.deepEqual(await emitWithAck(voter, 'vote', slug, seed.agreement, 'Strongly Agree', 'seed-c', 'Seed C', undefined), { ok: true });
    await setRevealed(seed.agreement, false);
    await setRevealed(seed.agreement, true);
    assert.deepEqual(await snapshots(), [first]);

    // Nothing is saved for a question nobody has answered yet...
    const added = waitForQuestions(mod, qs => qs.some(q => q.text === 'Nobody answered this'), 'unanswered question added');
    mod.emit('addQuestion', slug, { text: 'Nobody answered this', type: 'Yes/No', options: [] }, true, adminToken);
    const unanswered = (await added).find(q => q.text === 'Nobody answered this').id;
    await setRevealed(unanswered, true);
    assert.deepEqual(await snapshots(), [first]);
    // ...but once it has answers, its first showing after that does save one.
    await setRevealed(unanswered, false);
    assert.deepEqual(await emitWithAck(voter, 'vote', slug, unanswered, 'Yes', 'seed-c', 'Seed C', undefined), { ok: true });
    await setRevealed(unanswered, true);
    const afterUnanswered = await snapshots();
    assert.deepEqual(afterUnanswered.map(snapshot => snapshot.name), [first.name, 'Before results shown: Nobody answered this']);
    // It records the earlier question as it is now, after people updated.
    assert.equal(byId(afterUnanswered[1].data.questions, seed.agreement).responseCount, 3);

    // Someone without a moderator token changes nothing.
    const refused = waitForEvent(voter, 'error', error => /not authorized/i.test(error.message));
    voter.emit('setResultsRevealed', slug, seed.yesNo, true, 'not-the-token');
    await refused;
    assert.equal((await snapshots()).length, 2);

    // While results are always shown there is no "before" to keep.
    const always = waitForEvent(mod, 'discussionState', state => state.resultsVisibility === 'always');
    mod.emit('setResultsVisibility', slug, 'always', adminToken);
    await always;
    await setRevealed(seed.yesNo, true);
    assert.equal((await snapshots()).length, 2);
    await setRevealed(seed.yesNo, false);
    const afterVote = waitForEvent(mod, 'discussionState', state => state.resultsVisibility === 'after_vote');
    mod.emit('setResultsVisibility', slug, 'after_vote', adminToken);
    await afterVote;
    await setRevealed(seed.yesNo, true);
    assert.equal((await snapshots()).length, 3);

    // Written questions have no tally, so showing "results" for one saves nothing.
    mod.emit('setResultsRevealed', slug, seed.written, true, adminToken);
    // A long question is cut to fit the 120-character snapshot name.
    const longText = `How likely is it that ${'the room changes its mind '.repeat(8)}after talking?`;
    const longAdded = waitForQuestions(mod, qs => qs.some(q => q.text === longText.trim()), 'long question added');
    mod.emit('addQuestion', slug, { text: longText, type: 'Numerical', minValue: 0, maxValue: 100, options: [] }, true, adminToken);
    const longId = (await longAdded).find(q => q.text === longText.trim()).id;
    assert.deepEqual(await emitWithAck(voter, 'vote', slug, longId, 12.5, 'seed-c', 'Seed C', undefined), { ok: true });
    await setRevealed(longId, true);
    const all = await snapshots();
    assert.equal(all.length, 4);
    assert.equal(all[3].name.length, 120);
    assert.match(all[3].name, /^Before results shown: How likely is it that the room changes its mind .*…$/);
    assert.equal(byId(all[3].data.questions, longId).average, 12.5);

    // A snapshot a moderator saves by hand is announced the same way and is
    // unaffected by the one-per-question rule.
    const told = waitForEvent(voter, 'snapshotsChanged');
    const manual = await jsonRequest('POST', url, { name: 'After discussion', adminToken });
    assert.equal(manual.status, 201);
    await told;
    assert.deepEqual((await snapshots()).map(snapshot => snapshot.id), [...all.map(snapshot => snapshot.id), manual.body.id]);
  } finally {
    mod.disconnect();
    voter.disconnect();
    display.disconnect();
  }
});

test('a moderator puts a comparison of two opinion snapshots on the room display', async () => {
  const seed = await seedResultsDiscussion('display-compare');
  const other = await seedResultsDiscussion('display-compare-other');
  const { slug, adminToken } = seed;
  const mod = await joinAsModerator(slug, adminToken);
  const display = await connectSocket();
  const save = async (room, name) => (await jsonRequest('POST', `/api/discussions/${room.slug}/snapshots`, { name, adminToken: room.adminToken })).body.id;
  const stateWhere = predicate => waitForEvent(display, 'discussionState', predicate);
  const stored = async () => (await pool.query(
    'SELECT display_layout, display_question_id, display_before_snapshot_id, display_after_snapshot_id FROM discussions WHERE slug = $1', [slug]
  )).rows[0];
  try {
    const before = await save(seed, 'Before');
    const middle = await save(seed, 'Middle');
    const after = await save(seed, 'After');
    const foreign = await save(other, 'Another room');

    const initial = stateWhere(() => true);
    display.emit('joinDisplay', slug);
    const state = await initial;
    assert.equal(state.displayBeforeSnapshotId, null);
    assert.equal(state.displayAfterSnapshotId, null);

    // The layout alone: the display picks the first and the latest snapshot.
    let changed = stateWhere(s => s.displayLayout === 'compare');
    mod.emit('setDisplaySettings', slug, { layout: 'compare' }, adminToken);
    assert.equal((await changed).displayBeforeSnapshotId, null);

    // A chosen pair.
    changed = stateWhere(s => s.displayAfterSnapshotId === after);
    mod.emit('setDisplaySettings', slug, { beforeSnapshotId: middle, afterSnapshotId: after }, adminToken);
    assert.equal((await changed).displayBeforeSnapshotId, middle);
    // Each id changes on its own, and null goes back to the display's own pick.
    changed = stateWhere(s => s.displayBeforeSnapshotId === before);
    mod.emit('setDisplaySettings', slug, { beforeSnapshotId: before }, adminToken);
    assert.equal((await changed).displayAfterSnapshotId, after);
    changed = stateWhere(s => s.displayAfterSnapshotId === null);
    mod.emit('setDisplaySettings', slug, { afterSnapshotId: null }, adminToken);
    assert.equal((await changed).displayBeforeSnapshotId, before);

    // Choosing a question narrows the comparison to it and keeps the layout.
    changed = stateWhere(s => s.displayQuestionId === seed.numerical);
    mod.emit('setDisplaySettings', slug, { questionId: seed.numerical }, adminToken);
    assert.equal((await changed).displayLayout, 'compare');

    // Only this discussion's snapshots, in order, can be chosen.
    for (const [settings, pattern] of [
      [{ beforeSnapshotId: foreign }, /snapshot cannot be shown/i],
      [{ afterSnapshotId: 999999999 }, /snapshot cannot be shown/i],
      [{ beforeSnapshotId: after, afterSnapshotId: before }, /room display setting/i],
      [{ beforeSnapshotId: before, afterSnapshotId: before }, /room display setting/i],
      [{ beforeSnapshotId: String(before) }, /room display setting/i],
      [{ layout: 'sideways' }, /room display setting/i],
    ]) {
      const refused = waitForEvent(mod, 'error', error => pattern.test(error.message));
      mod.emit('setDisplaySettings', slug, settings, adminToken);
      await refused;
    }
    assert.deepEqual(await stored(), {
      display_layout: 'compare', display_question_id: seed.numerical,
      display_before_snapshot_id: before, display_after_snapshot_id: null,
    });

    // The display reads the snapshots as someone who has answered nothing, so
    // it gets results only for questions the moderator has shown to everyone.
    const hidden = (await jsonRequest('GET', `/api/discussions/${slug}/snapshots`)).body.snapshots;
    assert.deepEqual(hidden.map(snapshot => snapshot.id), [before, middle, after]);
    assert.ok(hidden[0].data.questions.every(question => question.resultsHidden === true));
    const revealed = waitForQuestions(mod, qs => byId(qs, seed.numerical)?.resultsRevealed === true, 'numerical results shown');
    mod.emit('setResultsRevealed', slug, seed.numerical, true, adminToken);
    await revealed;
    const shown = (await jsonRequest('GET', `/api/discussions/${slug}/snapshots`)).body.snapshots;
    assert.equal(byId(shown[0].data.questions, seed.numerical).average, 40);
    assert.equal(byId(shown[0].data.questions, seed.agreement).resultsHidden, true);
  } finally {
    mod.disconnect();
    display.disconnect();
  }
});

test('automatic baseline includes an in-flight vote committed while reveal waits for the question lock', async () => {
  const { id, slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('synthetic-reveal-mvcc') })).body;
  const questionId = (await pool.query(
    "INSERT INTO questions(discussion_id,text,type,min_value,max_value) VALUES ($1,'Fictional scale','Numerical',0,5) RETURNING id", [id]
  )).rows[0].id;
  await pool.query("INSERT INTO votes(question_id,value,user_id) VALUES ($1,'0','fictional-first')", [questionId]);
  const moderator = await connectSocket();
  const voter = await pool.connect();
  let committed = false;
  try {
    const joined = waitForQuestions(moderator, questions => questions.some(q => q.id === questionId), 'synthetic question joined');
    moderator.emit('joinDiscussion', slug); await joined;
    await voter.query('BEGIN');
    await voter.query('SELECT id FROM questions WHERE id=$1 FOR SHARE', [questionId]);
    await voter.query("INSERT INTO votes(question_id,value,user_id) VALUES ($1,'5','fictional-in-flight')", [questionId]);
    const announced = waitForEvent(moderator, 'snapshotsChanged');
    const shown = waitForQuestions(moderator, questions => questions.some(q => q.id === questionId && q.votes.length === 2), 'both committed votes shown');
    moderator.emit('setResultsRevealed', slug, questionId, true, adminToken);
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (Date.now() < deadline) {
      const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM questions%FOR UPDATE'");
      if (result.rows.length) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'reveal is observably blocked by the in-flight vote');
    await voter.query('COMMIT'); committed = true;
    await Promise.all([announced, shown]);
    const snapshots = (await jsonRequest('GET', `/api/discussions/${slug}/snapshots`, undefined, asModerator(adminToken))).body.snapshots;
    const baseline = snapshots[0].data.questions.find(q => q.id === questionId);
    assert.equal(baseline.responseCount, 2);
    assert.equal(baseline.average, 2.5);
  } finally {
    if (!committed) await voter.query('ROLLBACK');
    voter.release(); moderator.disconnect();
  }
});

test('a real failed reveal rolls back its baseline before a successful retry captures changed answers', async () => {
  const { id, slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('synthetic-reveal-rollback') })).body;
  const questionId = (await pool.query(
    "INSERT INTO questions(discussion_id,text,type,min_value,max_value) VALUES ($1,'Fictional rollback scale','Numerical',0,5) RETURNING id", [id]
  )).rows[0].id;
  await pool.query("INSERT INTO votes(question_id,value,user_id) VALUES ($1,'1','fictional-voter')", [questionId]);
  await pool.query(`CREATE FUNCTION synthetic_reveal_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic reveal failure'; END $$`);
  await pool.query('CREATE TRIGGER synthetic_reveal_failure BEFORE UPDATE OF results_revealed ON questions FOR EACH ROW EXECUTE FUNCTION synthetic_reveal_failure()');
  const moderator = await connectSocket();
  try {
    const joined = waitForQuestions(moderator, questions => questions.some(q => q.id === questionId), 'rollback question joined');
    moderator.emit('joinDiscussion', slug); await joined;
    const failed = waitForEvent(moderator, 'error', error => /Failed to update question/.test(error.message));
    moderator.emit('setResultsRevealed', slug, questionId, true, adminToken); await failed;
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM opinion_snapshots WHERE discussion_id=$1', [id])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT results_revealed FROM questions WHERE id=$1', [questionId])).rows[0].results_revealed, false);
    await pool.query('DROP TRIGGER synthetic_reveal_failure ON questions');
    await pool.query("UPDATE votes SET value='4' WHERE question_id=$1", [questionId]);
    const saved = waitForEvent(moderator, 'snapshotsChanged');
    moderator.emit('setResultsRevealed', slug, questionId, true, adminToken); await saved;
    const snapshots = (await jsonRequest('GET', `/api/discussions/${slug}/snapshots`, undefined, asModerator(adminToken))).body.snapshots;
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].data.questions.find(q => q.id === questionId).average, 4);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS synthetic_reveal_failure ON questions');
    await pool.query('DROP FUNCTION IF EXISTS synthetic_reveal_failure()');
    moderator.disconnect();
  }
});
