const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
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
  waitForEvent,
  uniqueTopic,
  seedResultsDiscussion,
  asModerator,
  asUser,
  assertResultsHidden,
  assertResultsShown,
  byId,
  nextQuestions,
  joinAs,
  storedVotes,
  joinAsModerator,
} = require('./helpers/integration.cjs');

const server = useIntegrationServer(__filename);
const { pool } = server;

for (const mode of ['always', 'after_vote']) {
  test(`independent answers stay private across viewers until moderator reveal (${mode})`, async t => {
    const { id, slug, adminToken } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('independent') })).body;
    const base = `/api/discussions/${slug}`;
    await pool.query('UPDATE discussions SET results_visibility=$2, reactions_enabled=true, comments_enabled=true WHERE id=$1', [id, mode]);
    const user = crypto.randomUUID();
    const { socket: author } = await joinAs(slug, user);
    const moderator = await joinAsModerator(slug, adminToken);
    t.after(() => { author.disconnect(); moderator.disconnect(); });
    const prompt = { text: 'Write an idea', type: 'Brainstorm', independentAnswers: true };
    assert.equal((await emitWithAck(author, 'addQuestion', slug, prompt, true)).reason, 'not_authorized');
    assert.equal((await emitWithAck(moderator, 'addQuestion', slug, prompt, true, adminToken)).added, true);
    const { rows: [question] } = await pool.query('SELECT id, independent_answers FROM questions WHERE discussion_id=$1', [id]);
    assert.equal(question.independent_answers, true);
    for (const independentAnswers of [false, true]) {
      assert.equal((await emitWithAck(moderator, 'editQuestion', slug, question.id, { ...prompt, independentAnswers }, adminToken)).updated, true);
      assert.equal((await pool.query('SELECT independent_answers FROM questions WHERE id=$1', [question.id])).rows[0].independent_answers, independentAnswers);
    }
    const secret = 'private-written-response-fixture';
    const own = waitForQuestions(author, list => byId(list, question.id)?.votes.length === 1, 'own independent answer');
    assert.equal((await emitWithAck(author, 'vote', slug, question.id, secret, user, 'Author', 'custom')).ok, true);
    const vote = byId(await own, question.id).votes[0];
    assert.equal(vote.value, secret);
    const { socket: peer, questions } = await joinAs(slug, 'another-author');
    const display = await connectSocket();
    t.after(() => { peer.disconnect(); display.disconnect(); });
    assert.deepEqual(byId(questions, question.id).votes, []);
    const projected = nextQuestions(display, 'private display');
    display.emit('joinDisplay', slug);
    assert.deepEqual(byId(await projected, question.id).votes, []);
    const ownPeer = waitForQuestions(peer, list => byId(list, question.id)?.votes.some(row => row.value === 'peer-only'), 'second independent answer');
    const modView = waitForQuestions(moderator, list => byId(list, question.id)?.votes.length === 2, 'moderator view');
    await emitWithAck(peer, 'vote', slug, question.id, 'peer-only', 'another-author', 'Other', 'custom');
    assert.deepEqual(byId(await ownPeer, question.id).votes.map(row => row.value), ['peer-only']);
    await modView;
    const denied = waitForEvent(peer, 'error');
    peer.emit('setResultsRevealed', slug, question.id, true, 'wrong');
    await denied;
    assert.equal((await emitWithAck(peer, 'setResponseRating', slug, vote.id, 'quality', 1, 'another-author')).updated, false);
    assert.equal((await emitWithAck(peer, 'addResponseComment', slug, vote.id, 'early comment', 'another-author', 'Other')).added, false);
    const legacy = nextQuestions(peer, 'legacy feedback check');
    peer.emit('toggleResponseVote', slug, vote.id, 'another-author');
    await legacy;
    peer.emit('toggleResponseReaction', slug, vote.id, 'crux', 'another-author');
    await pool.query("INSERT INTO questions (discussion_id,text,type) VALUES ($1,'Public poll','Agreement')", [id]);
    const saved = await jsonRequest('POST', `${base}/snapshots`, { adminToken, name: 'During collection' });
    assert.equal(saved.status, 201);
    assert.deepEqual(saved.body.data.questions.map(row => row.text), ['Public poll']);
    for (const route of ['summary', 'export.json', 'export.csv', 'report.html', 'snapshots', 'clusters']) {
      const result = await fetch(`${server.baseUrl}${base}/${route}`, { headers: asUser(user) });
      assert.equal(result.status, 200, route);
      assert.doesNotMatch(await result.text(), /private-written-response-fixture|peer-only/, route);
    }
    assert.equal((await jsonRequest('GET', `${base}/summary`, undefined, asModerator(adminToken))).body.counts.responses, 2);
    const feedback = await pool.query(`SELECT (SELECT count(*) FROM response_votes WHERE response_id=$1) +
      (SELECT count(*) FROM response_ratings WHERE response_id=$1) + (SELECT count(*) FROM response_reactions WHERE response_id=$1) AS total`, [vote.id]);
    assert.equal(Number(feedback.rows[0].total), 0);
    const shared = [author, peer, display].map(socket => waitForQuestions(socket, list => byId(list, question.id)?.resultsRevealed, 'moderator reveal'));
    moderator.emit('setResultsRevealed', slug, question.id, true, adminToken);
    for (const list of await Promise.all(shared)) assert.deepEqual(byId(list, question.id).votes.map(row => row.value), [secret, 'peer-only']);
    assert.equal((await emitWithAck(peer, 'setResponseRating', slug, vote.id, 'quality', 1, 'another-author')).updated, true);
    assert.equal((await jsonRequest('GET', `${base}/summary`)).body.counts.responses, 2);
    const reset = await fetch(`${server.baseUrl}${base}/responses`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken }) });
    assert.equal(reset.status, 204);
    assert.deepEqual((await pool.query('SELECT independent_answers, results_revealed FROM questions WHERE id=$1', [question.id])).rows[0],
      { independent_answers: true, results_revealed: false });
  });
}

test('new and existing discussions default to showing results after voting', async () => {
  await stopServer();
  try {
    await pool.query("INSERT INTO discussions (topic, slug) VALUES ('Before the setting', 'before-the-setting')");
    await pool.query('DROP TABLE schema_migrations; ALTER TABLE discussions DROP COLUMN results_visibility');
    await initializeDatabase(pool);
    const read = () => pool.query("SELECT results_visibility FROM discussions WHERE slug = 'before-the-setting'");
    assert.equal((await read()).rows[0].results_visibility, 'after_vote');
    await pool.query("UPDATE discussions SET results_visibility = 'always' WHERE slug = 'before-the-setting'");
    await initializeDatabase(pool);
    assert.equal((await read()).rows[0].results_visibility, 'always', 'a restart keeps the moderator choice');
  } finally {
    await startServer();
  }
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('results-default') });
  const { socket } = await joinAs(created.body.slug, null);
  try {
    const state = waitForEvent(socket, 'discussionState');
    socket.emit('joinDiscussion', created.body.slug);
    assert.equal((await state).resultsVisibility, 'after_vote');
  } finally {
    socket.disconnect();
  }
});

test('results are withheld from a participant until they vote, including in live broadcasts', async () => {
  const seed = await seedResultsDiscussion('results-hidden');
  const tallied = [seed.agreement, seed.yesNo, seed.numerical];
  const { socket: watcher, questions: initial } = await joinAs(seed.slug, 'watcher');
  const { socket: other } = await joinAs(seed.slug, 'seed-c');
  try {
    // Initial payload: every tallied question is stripped, Open Ended is not.
    assert.equal(initial.length, 4);
    for (const id of tallied) assertResultsHidden(byId(initial, id), `initial ${byId(initial, id).type}`);
    assert.deepEqual(byId(initial, seed.written).votes.map(vote => vote.value), ['Because reasons']);
    assert.equal(byId(initial, seed.written).resultsHidden, false);

    // Someone else votes: the watcher gets the broadcast, still with nothing in it.
    for (const [id, value] of [[seed.agreement, 'Strongly Agree'], [seed.yesNo, 'Yes'], [seed.numerical, 90]]) {
      const broadcast = nextQuestions(watcher, 'broadcast after another vote');
      assert.deepEqual(await emitWithAck(other, 'vote', seed.slug, id, value, 'seed-c', 'Seed C', undefined), { ok: true });
      const questions = await broadcast;
      for (const hiddenId of tallied) assertResultsHidden(byId(questions, hiddenId), `after another vote on ${id}`);
      assert.doesNotMatch(JSON.stringify(questions.filter(q => tallied.includes(q.id))), /Seed C|Strongly Agree/);
    }

    // Each question opens up only once the watcher answers that question.
    const expected = {
      [seed.agreement]: ['Agree', 'Disagree', 'Strongly Agree'],
      [seed.yesNo]: ['Yes', 'No', 'Yes'],
      [seed.numerical]: ['30', '50', '90'],
    };
    const answers = [[seed.agreement, 'Unsure'], [seed.yesNo, 'No'], [seed.numerical, 10]];
    for (let index = 0; index < answers.length; index += 1) {
      const [id, value] = answers[index];
      const broadcast = nextQuestions(watcher, 'broadcast after own vote');
      assert.deepEqual(await emitWithAck(watcher, 'vote', seed.slug, id, value, 'watcher', 'Watcher', undefined), { ok: true });
      const questions = await broadcast;
      expected[id].push(String(value));
      answers.forEach(([answeredId], position) => {
        if (position <= index) assertResultsShown(byId(questions, answeredId), expected[answeredId], 'answered question');
        else assertResultsHidden(byId(questions, answeredId), 'question not answered yet');
      });
    }

    // Having answered, the watcher now receives live updates as before.
    const live = nextQuestions(watcher, 'live update after voting');
    assert.deepEqual(await emitWithAck(other, 'vote', seed.slug, seed.agreement, 'Disagree', 'seed-c', 'Seed C', undefined), { ok: true });
    assertResultsShown(byId(await live, seed.agreement), ['Agree', 'Disagree', 'Disagree', 'Unsure'], 'live update');
  } finally {
    watcher.disconnect();
    other.disconnect();
  }
});

test('clearing a vote hides that question\'s results again', async () => {
  const seed = await seedResultsDiscussion('results-clear');
  const { socket: watcher } = await joinAs(seed.slug, 'watcher');
  const { socket: other } = await joinAs(seed.slug, 'seed-c');
  try {
    for (const [id, value, cleared] of [[seed.agreement, 'Agree', 'Disagree'], [seed.yesNo, 'Yes', 'No']]) {
      const shown = nextQuestions(watcher, 'results after voting');
      await emitWithAck(watcher, 'vote', seed.slug, id, value, 'watcher', 'Watcher', undefined);
      assert.equal(byId(await shown, id).votes.length, 3);

      const hidden = nextQuestions(watcher, 'results after clearing');
      assert.deepEqual(await emitWithAck(watcher, 'clearVote', seed.slug, id, 'watcher'), { ok: true });
      assertResultsHidden(byId(await hidden, id), 'after clearVote');

      // Later votes by others stay hidden too, and nobody else's vote was removed.
      const later = nextQuestions(watcher, 'broadcast after clearing');
      await emitWithAck(other, 'vote', seed.slug, id, cleared, 'seed-c', 'Seed C', undefined);
      assertResultsHidden(byId(await later, id), 'vote by another participant after clearVote');
      assert.equal((await storedVotes(id)).length, 3);
    }
  } finally {
    watcher.disconnect();
    other.disconnect();
  }
});

test('a socket is shown results only for the participant it identifies as', async () => {
  const seed = await seedResultsDiscussion('results-identity');
  // No identity at all: nothing is shown.
  const { socket: anonymous, questions: anonymousView } = await joinAs(seed.slug, null);
  try {
    for (const id of [seed.agreement, seed.yesNo, seed.numerical]) assertResultsHidden(byId(anonymousView, id), 'anonymous join');
    // The page joins first and identifies afterwards; the view follows.
    const resent = nextQuestions(anonymous, 'questions resent after identify');
    anonymous.emit('identify', seed.slug, 'seed-a');
    const identified = await resent;
    assertResultsShown(byId(identified, seed.agreement), ['Agree', 'Disagree'], 'own answered question');
    assertResultsShown(byId(identified, seed.numerical), ['30', '50'], 'own answered question');
    // A socket cannot switch to another participant's identity to see more.
    await pool.query('DELETE FROM votes WHERE question_id = $1 AND user_id = $2', [seed.yesNo, 'seed-a']);
    const afterSwitch = nextQuestions(anonymous, 'broadcast after identity switch attempt');
    anonymous.emit('identify', seed.slug, 'seed-b');
    anonymous.emit('updateDisplayName', seed.slug, 'seed-b', 'Seed A');
    assertResultsHidden(byId(await afterSwitch, seed.yesNo), 'question answered only by the other identity');
  } finally {
    anonymous.disconnect();
  }
});

test('moderators always see results, and lose them when their access is revoked', async () => {
  const seed = await seedResultsDiscussion('results-moderator');
  const { socket: creator, questions: beforeCheck } = await joinAs(seed.slug, 'creator-user');
  const { socket: helper } = await joinAs(seed.slug, 'helper-user');
  try {
    assertResultsHidden(byId(beforeCheck, seed.agreement), 'before proving the token');

    // A wrong token proves nothing.
    assert.equal((await emitWithAck(creator, 'checkModerator', seed.slug, 'not-the-token')).isModerator, false);

    const full = nextQuestions(creator, 'moderator view');
    assert.equal((await emitWithAck(creator, 'checkModerator', seed.slug, seed.adminToken)).isModerator, true);
    const moderatorView = await full;
    assertResultsShown(byId(moderatorView, seed.agreement), ['Agree', 'Disagree'], 'moderator');
    assertResultsShown(byId(moderatorView, seed.yesNo), ['Yes', 'No'], 'moderator');
    assertResultsShown(byId(moderatorView, seed.numerical), ['30', '50'], 'moderator');

    // The moderator's token works only for its own discussion.
    const elsewhere = await seedResultsDiscussion('results-moderator-other');
    const { socket: visitor, questions: visitorView } = await joinAs(elsewhere.slug, 'creator-user');
    try {
      assert.equal((await emitWithAck(visitor, 'checkModerator', elsewhere.slug, seed.adminToken)).isModerator, false);
      assertResultsHidden(byId(visitorView, elsewhere.agreement), 'another discussion');
    } finally {
      visitor.disconnect();
    }

    // Promote a participant: they see everything without having answered it.
    const helperVoted = nextQuestions(helper, 'helper vote');
    await emitWithAck(helper, 'vote', seed.slug, seed.yesNo, 'Yes', 'helper-user', 'Helper', undefined);
    assertResultsHidden(byId(await helperVoted, seed.agreement), 'helper before promotion');
    const helperId = `participant-${crypto.createHash('sha256').update('helper-user').digest('hex').slice(0, 16)}`;
    const granted = waitForEvent(helper, 'moderatorGranted');
    assert.equal((await emitWithAck(creator, 'promoteModerator', seed.slug, seed.adminToken, helperId)).success, true);
    const helperToken = (await granted).token;
    const promotedView = nextQuestions(helper, 'promoted moderator view');
    assert.equal((await emitWithAck(helper, 'checkModerator', seed.slug, helperToken)).isModerator, true);
    assertResultsShown(byId(await promotedView, seed.agreement), ['Agree', 'Disagree'], 'promoted moderator');

    // Demote them: the very next payload hides what they have not answered.
    const demotedView = waitForQuestions(helper, qs => byId(qs, seed.agreement)?.resultsHidden === true, 'demoted view');
    assert.equal((await emitWithAck(creator, 'demoteModerator', seed.slug, seed.adminToken, helperId)).success, true);
    const demoted = await demotedView;
    assertResultsHidden(byId(demoted, seed.numerical), 'demoted moderator');
    assertResultsShown(byId(demoted, seed.yesNo), ['Yes', 'No', 'Yes'], 'question the demoted moderator answered');
    const afterDemotion = nextQuestions(helper, 'broadcast after demotion');
    await emitWithAck(creator, 'vote', seed.slug, seed.agreement, 'Agree', 'creator-user', 'Creator', undefined);
    assertResultsHidden(byId(await afterDemotion, seed.agreement), 'demoted moderator, later broadcast');
  } finally {
    creator.disconnect();
    helper.disconnect();
  }
});

test('only a moderator can change the results setting, and "always show" sends everyone the results', async () => {
  const seed = await seedResultsDiscussion('results-always');
  const { socket: watcher } = await joinAs(seed.slug, 'watcher');
  const { socket: other } = await joinAs(seed.slug, 'seed-c');
  const mod = await connectSocket();
  try {
    // Without a valid token, or with an unknown mode, nothing changes.
    const refused = waitForEvent(watcher, 'error', error => /not authorized/i.test(error.message));
    watcher.emit('setResultsVisibility', seed.slug, 'always', 'not-the-token');
    await refused;
    const unknown = waitForEvent(mod, 'error', error => /unknown results setting/i.test(error.message));
    mod.emit('setResultsVisibility', seed.slug, 'moderator_reveals', seed.adminToken);
    await unknown;
    const stored = () => pool.query('SELECT results_visibility FROM discussions WHERE id = $1', [seed.id]);
    assert.equal((await stored()).rows[0].results_visibility, 'after_vote');

    // Always show: a participant who has not voted gets everything, as before.
    const state = waitForEvent(watcher, 'discussionState', s => s.resultsVisibility === 'always');
    const opened = nextQuestions(watcher, 'questions after switching to always');
    mod.emit('setResultsVisibility', seed.slug, 'always', seed.adminToken);
    await state;
    const all = await opened;
    assertResultsShown(byId(all, seed.agreement), ['Agree', 'Disagree'], 'always: agreement');
    assertResultsShown(byId(all, seed.yesNo), ['Yes', 'No'], 'always: yes/no');
    assertResultsShown(byId(all, seed.numerical), ['30', '50'], 'always: numerical');
    assert.equal((await stored()).rows[0].results_visibility, 'always');

    // Live broadcasts and a fresh anonymous join carry the results too.
    const live = nextQuestions(watcher, 'always: live broadcast');
    await emitWithAck(other, 'vote', seed.slug, seed.agreement, 'Unsure', 'seed-c', 'Seed C', undefined);
    assertResultsShown(byId(await live, seed.agreement), ['Agree', 'Disagree', 'Unsure'], 'always: live');
    const { socket: anonymous, questions: anonymousView } = await joinAs(seed.slug, null);
    anonymous.disconnect();
    assertResultsShown(byId(anonymousView, seed.agreement), ['Agree', 'Disagree', 'Unsure'], 'always: anonymous join');

    // So do the REST endpoints, with no identity at all.
    const summary = (await jsonRequest('GET', `/api/discussions/${seed.slug}/summary`)).body;
    assert.equal(summary.counts.hiddenResults, 0);
    assert.equal(summary.questions.find(q => q.id === seed.agreement).responseCount, 3);
    const csv = await (await fetch(`${server.baseUrl}/api/discussions/${seed.slug}/export.csv`)).text();
    assert.match(csv, /"Strongly Agree"|"Unsure"/);
    assert.doesNotMatch(csv, /results hidden/);

    // A duplicate keeps the setting.
    const copy = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: seed.slug, newTopic: uniqueTopic('results-copy') });
    const copied = await pool.query('SELECT results_visibility FROM discussions WHERE slug = $1', [copy.body.newSlug]);
    assert.equal(copied.rows[0].results_visibility, 'always');

    // Switching back hides them again at once.
    const closed = waitForQuestions(watcher, qs => byId(qs, seed.agreement)?.resultsHidden === true, 'questions after switching back');
    mod.emit('setResultsVisibility', seed.slug, 'after_vote', seed.adminToken);
    for (const id of [seed.agreement, seed.yesNo, seed.numerical]) assertResultsHidden(byId(await closed, id), 'back to after_vote');
  } finally {
    watcher.disconnect();
    other.disconnect();
    mod.disconnect();
  }
});

test('REST endpoints withhold results the caller has not voted on', async () => {
  const seed = await seedResultsDiscussion('results-rest');
  // Enough agreement votes for opinion groups: four participants, two statements.
  const second = (await pool.query(
    "INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'We should wait', 'Agreement') RETURNING id", [seed.id]
  )).rows[0].id;
  await pool.query(
    `INSERT INTO votes (question_id, value, user_id) VALUES
      ($1, 'Strongly Agree', 'seed-c'), ($1, 'Strongly Disagree', 'seed-d'),
      ($2, 'Disagree', 'seed-a'), ($2, 'Agree', 'seed-b'), ($2, 'Strongly Disagree', 'seed-c'), ($2, 'Strongly Agree', 'seed-d')`,
    [seed.agreement, second]
  );
  const base = `/api/discussions/${seed.slug}`;
  const tallied = [seed.agreement, seed.yesNo, seed.numerical, second];
  const text = async (path, headers) => (await fetch(`${server.baseUrl}${base}${path}`, { headers })).text();
  const saved = await jsonRequest('POST', `${base}/snapshots`, { name: 'Before', adminToken: seed.adminToken });
  assert.equal(saved.status, 201);

  // seed-e has answered only the yes/no question.
  await pool.query("INSERT INTO votes (question_id, value, user_id) VALUES ($1, 'Yes', 'seed-e')", [seed.yesNo]);
  const leak = /seed-[a-e]|Strongly Agree|Strongly Disagree|optionCounts|"average"|agreeCount|distribution/;

  for (const [label, headers, visible] of [
    ['no identity', {}, []],
    ['unknown participant', asUser('nobody'), []],
    ['wrong moderator token', asModerator('not-the-token'), []],
    ['participant who answered one question', asUser('seed-e'), [seed.yesNo]],
  ]) {
    const hidden = tallied.filter(id => !visible.includes(id));

    // Summary and its JSON export.
    for (const path of ['/summary', '/export.json']) {
      const summary = JSON.parse(await text(path, headers));
      assert.equal(summary.counts.hiddenResults, hidden.length, `${label} ${path}`);
      for (const id of hidden) {
        assert.deepEqual(Object.keys(summary.questions.find(q => q.id === id)).sort(),
          ['createdAt', 'id', 'resultsHidden', 'text', 'type'], `${label} ${path}: hidden question carries no results`);
      }
      // Only what the caller may see is counted: the written response, plus the yes/no votes if visible.
      assert.equal(summary.counts.responses, 1 + (visible.length ? 3 : 0), `${label} ${path}: responses`);
      assert.deepEqual(summary.topConsensus.concat(summary.topDivisive).filter(item => hidden.includes(item.id)), []);
      assert.deepEqual(summary.facilitatorDashboard.unansweredPrompts.filter(item => hidden.includes(item.id)), []);
      if (!visible.length) assert.doesNotMatch(JSON.stringify(summary), leak, `${label} ${path}`);
      else assert.equal(summary.questions.find(q => q.id === seed.yesNo).responseCount, 3);
    }

    // Printable report and CSV.
    const report = await text('/report.html', headers);
    assert.equal(report.match(/Hidden until you vote/g).length, hidden.length, `${label} report`);
    assert.doesNotMatch(report, /agree \/|Avg /, `${label} report: no agreement or numerical signal`);
    const csv = await text('/export.csv', headers);
    assert.equal(csv.match(/results hidden until you vote/g).length, hidden.length, `${label} csv`);
    assert.doesNotMatch(csv, /Strongly|"Agree"|"Disagree"/, `${label} csv`);
    assert.equal(/"Yes"|"No"/.test(csv), visible.length > 0, `${label} csv: yes/no rows`);
    assert.match(csv, /Because reasons/, 'Open Ended responses are unaffected');

    // Opinion groups are computed without the hidden statements.
    const clusters = (await jsonRequest('GET', `${base}/clusters`, undefined, headers)).body;
    assert.equal(clusters.eligible, false, `${label} clusters`);
    assert.equal(clusters.hiddenStatementCount, 2);
    assert.equal(clusters.participantCount, 0);
    assert.equal(clusters.statementCount, 0);
    assert.doesNotMatch(JSON.stringify(clusters), /clusters"|bridging|divisive/);

    // Saved snapshots hold the same tallies and are redacted the same way.
    const { snapshots } = (await jsonRequest('GET', `${base}/snapshots`, undefined, headers)).body;
    assert.equal(snapshots[0].data.participantCount, null, `${label} snapshot`);
    for (const question of snapshots[0].data.questions) {
      if (visible.includes(question.id)) assert.deepEqual(question.optionCounts, { No: 1, Yes: 1 });
      else assert.deepEqual(Object.keys(question).sort(), ['id', 'resultsHidden', 'text', 'type'], `${label} snapshot question`);
    }
  }

  // A participant who answered everything, and a moderator, get the lot.
  for (const [label, headers] of [['participant who answered everything', asUser('seed-a')], ['moderator', asModerator(seed.adminToken)]]) {
    const summary = (await jsonRequest('GET', `${base}/summary`, undefined, headers)).body;
    assert.equal(summary.counts.hiddenResults, 0, label);
    assert.equal(summary.questions.find(q => q.id === seed.agreement).responseCount, 4, label);
    assert.equal(summary.questions.find(q => q.id === seed.numerical).average, 40, label);
    assert.doesNotMatch(await text('/export.csv', headers), /results hidden/, label);
    assert.doesNotMatch(await text('/report.html', headers), /Hidden until you vote/, label);
    const clusters = (await jsonRequest('GET', `${base}/clusters`, undefined, headers)).body;
    assert.equal(clusters.hiddenStatementCount, 0, label);
    assert.equal(clusters.statementCount, 2, label);
    assert.equal(clusters.participantCount, 4, label);
    const { snapshots } = (await jsonRequest('GET', `${base}/snapshots`, undefined, headers)).body;
    assert.deepEqual(snapshots, [saved.body], label);
  }
});

test('Open Ended and Brainstorm responses are not affected by the results setting', async () => {
  const topic = uniqueTopic('results-written');
  const author = await connectSocket();
  const reader = await connectSocket();
  try {
    author.emit('joinDiscussion', topic);
    reader.emit('joinDiscussion', topic);
    const brainstorm = await addBrainstormQuestion(author, topic, 'Ideas?');
    const seen = waitForQuestions(reader, qs => qs[0]?.votes.length === 1, 'idea visible to a reader who has not answered');
    author.emit('vote', topic, brainstorm.id, 'An idea', 'author-user', 'Author');
    const [question] = await seen;
    assert.equal(question.resultsHidden, false);
    assert.equal(question.votes[0].value, 'An idea');
  } finally {
    author.disconnect();
    reader.disconnect();
  }
});
