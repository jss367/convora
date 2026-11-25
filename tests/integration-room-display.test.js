const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  useIntegrationServer,
  jsonRequest,
  connectSocket,
  waitForQuestions,
  emitWithAck,
  waitForEvent,
  uniqueTopic,
  seedResultsDiscussion,
  assertResultsHidden,
  assertResultsShown,
  byId,
  nextQuestions,
  joinAs,
  joinDisplay,
  joinAsModerator,
} = require('./helpers/integration.cjs');

const { pool } = useIntegrationServer(__filename);

// A hidden question on the display carries its response count and nothing else
// a tally could be rebuilt from.
function assertDisplayHidden(question, responseCount, label) {
  const { responseCount: count, ...rest } = question;
  assert.equal(count, responseCount, `${label}: response count`);
  assertResultsHidden(rest, label);
}

test('a moderator sets how the room display shows the QR code and questions', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('display-settings') });
  const { slug, adminToken } = created.body;
  const display = await connectSocket();
  const mod = await connectSocket();
  try {
    const initial = waitForEvent(display, 'discussionState', () => true);
    display.emit('joinDisplay', slug);
    const state = await initial;
    assert.equal(state.displayQr, 'full');
    assert.equal(state.displayLayout, 'all');
    assert.equal(state.displaySort, 'oldest');
    assert.equal(state.displayQuestionType, 'all');
    assert.equal(state.displayPinnedFirst, true);

    const outsider = await connectSocket();
    try {
      const refused = waitForEvent(outsider, 'error', error => /not authorized/i.test(error.message));
      outsider.emit('setDisplaySettings', slug, { qr: 'hidden' }, 'not-the-token');
      await refused;
    } finally {
      outsider.disconnect();
    }
    // The display itself is read-only, even holding the moderator token: the
    // request is dropped, so the next change below starts from the default.
    display.emit('setDisplaySettings', slug, { layout: 'focus' }, adminToken);

    const rejected = waitForEvent(mod, 'error', error => /room display setting/i.test(error.message));
    mod.emit('setDisplaySettings', slug, { qr: 'huge' }, adminToken);
    await rejected;

    // Each field changes on its own and leaves the other alone.
    const corner = waitForEvent(display, 'discussionState', s => s.displayQr === 'corner');
    mod.emit('setDisplaySettings', slug, { qr: 'corner' }, adminToken);
    assert.equal((await corner).displayLayout, 'all');
    const focus = waitForEvent(display, 'discussionState', s => s.displayLayout === 'focus');
    mod.emit('setDisplaySettings', slug, { layout: 'focus' }, adminToken);
    assert.equal((await focus).displayQr, 'corner');
    for (const sort of ['oldest', 'newest', 'interesting', 'agreement', 'disagreement', 'controversial']) {
      const changed = waitForEvent(display, 'discussionState', s => s.displaySort === sort && s.displayPinnedFirst === false);
      mod.emit('setDisplaySettings', slug, { sort, pinnedFirst: false }, adminToken);
      assert.equal((await changed).displayLayout, 'focus');
    }
    const filtered = waitForEvent(display, 'discussionState', state => state.displayQuestionType === 'Open Ended');
    mod.emit('setDisplaySettings', slug, { questionType: 'Open Ended' }, adminToken);
    assert.equal((await filtered).displaySort, 'controversial');
    for (const settings of [{ questionType: 'invalid' }, { questionType: null }, { sort: 'invalid' }, { sort: null }, { pinnedFirst: 'false' }, { pinnedFirst: null }]) {
      const invalid = waitForEvent(mod, 'error', error => /room display setting/i.test(error.message));
      mod.emit('setDisplaySettings', slug, settings, adminToken);
      await invalid;
    }
    const stored = await pool.query('SELECT display_question_type, display_sort, display_pinned_first FROM discussions WHERE slug = $1', [slug]);
    assert.deepEqual(stored.rows[0], { display_question_type: 'Open Ended', display_sort: 'controversial', display_pinned_first: false });

  } finally {
    display.disconnect();
    mod.disconnect();
  }
});

test('a room display shows response counts but no results while results are shown after voting', async () => {
  const seed = await seedResultsDiscussion('display-hidden');
  const { socket: display, questions: initial } = await joinDisplay(seed.slug);
  const { socket: voter } = await joinAs(seed.slug, 'seed-c');
  const mod = await connectSocket();
  try {
    for (const id of [seed.agreement, seed.yesNo, seed.numerical]) assertDisplayHidden(byId(initial, id), 2, 'initial display view');
    // Open Ended responses are the discussion itself and stay visible.
    assert.deepEqual(byId(initial, seed.written).votes.map(vote => vote.value), ['Because reasons']);
    assert.equal(byId(initial, seed.written).resultsHidden, false);

    // Live votes update the counts and still reveal nothing.
    const broadcast = nextQuestions(display, 'display broadcast after a vote');
    assert.deepEqual(await emitWithAck(voter, 'vote', seed.slug, seed.agreement, 'Strongly Agree', 'seed-c', 'Seed C', undefined), { ok: true });
    const updated = await broadcast;
    assertDisplayHidden(byId(updated, seed.agreement), 3, 'after a vote');
    assertDisplayHidden(byId(updated, seed.yesNo), 2, 'question nobody new answered');
    assert.doesNotMatch(JSON.stringify(updated.filter(q => q.id !== seed.written)), /Seed C|Strongly Agree/);

    // A moderator acting elsewhere does not turn the display into a moderator view.
    assert.equal((await emitWithAck(mod, 'checkModerator', seed.slug, seed.adminToken)).isModerator, true);
    const afterPin = nextQuestions(display, 'display broadcast after a moderator action');
    mod.emit('setPinned', seed.slug, seed.numerical, true, seed.adminToken);
    assertDisplayHidden(byId(await afterPin, seed.numerical), 2, 'after a moderator action');
  } finally {
    display.disconnect();
    voter.disconnect();
    mod.disconnect();
  }
});

test('a room display shows live results when the moderator always shows them', async () => {
  const seed = await seedResultsDiscussion('display-always');
  const { socket: display } = await joinDisplay(seed.slug);
  const { socket: voter } = await joinAs(seed.slug, 'seed-c');
  const mod = await connectSocket();
  try {
    const opened = waitForQuestions(display, qs => byId(qs, seed.agreement)?.resultsHidden === false, 'display after switching to always');
    const state = waitForEvent(display, 'discussionState', s => s.resultsVisibility === 'always');
    mod.emit('setResultsVisibility', seed.slug, 'always', seed.adminToken);
    await state;
    const all = await opened;
    assertResultsShown(byId(all, seed.agreement), ['Agree', 'Disagree'], 'display: agreement');
    assertResultsShown(byId(all, seed.yesNo), ['Yes', 'No'], 'display: yes/no');
    assertResultsShown(byId(all, seed.numerical), ['30', '50'], 'display: numerical');

    const live = nextQuestions(display, 'display live broadcast');
    await emitWithAck(voter, 'vote', seed.slug, seed.agreement, 'Unsure', 'seed-c', 'Seed C', undefined);
    assertResultsShown(byId(await live, seed.agreement), ['Agree', 'Disagree', 'Unsure'], 'display: live');

    // A display opened while results are always shown gets them at once, and
    // loses them as soon as the moderator switches back.
    const { socket: late, questions: lateView } = await joinDisplay(seed.slug);
    try {
      assertResultsShown(byId(lateView, seed.numerical), ['30', '50'], 'late display');
      const closed = waitForQuestions(late, qs => byId(qs, seed.agreement)?.resultsHidden === true, 'display after switching back');
      mod.emit('setResultsVisibility', seed.slug, 'after_vote', seed.adminToken);
      assertDisplayHidden(byId(await closed, seed.agreement), 3, 'back to after_vote');
    } finally {
      late.disconnect();
    }
  } finally {
    display.disconnect();
    voter.disconnect();
    mod.disconnect();
  }
});

test('a room display that switches discussions ends up showing only the last one', async () => {
  const first = await seedResultsDiscussion('display-switch-a');
  const second = await seedResultsDiscussion('display-switch-b');
  const display = await connectSocket();
  try {
    const received = [];
    display.on('discussion', payload => received.push(['discussion', payload?.slug]));
    display.on('questions', payload => received.push(['questions', payload[0]?.id === first.agreement ? first.slug : second.slug]));
    // A -> B -> A, sent back to back so the joins overlap.
    const settled = waitForEvent(display, 'discussionState');
    display.emit('joinDisplay', first.slug);
    display.emit('joinDisplay', second.slug);
    display.emit('joinDisplay', first.slug);
    await settled;
    // Give any superseded join time to finish; it must send nothing after this.
    await new Promise(resolve => setTimeout(resolve, 300));
    const last = kind => received.filter(([event]) => event === kind).at(-1)?.[1];
    assert.equal(last('discussion'), first.slug);
    assert.equal(last('questions'), first.slug);
  } finally {
    display.disconnect();
  }
});

test('a moderator can reveal one question\'s results to everyone, including the room display', async () => {
  const seed = await seedResultsDiscussion('reveal-results');
  const other = await seedResultsDiscussion('reveal-results-other');
  const { socket: display } = await joinDisplay(seed.slug);
  const { socket: watcher } = await joinAs(seed.slug, 'watcher');
  const mod = await connectSocket();
  try {
    // Only this discussion's moderator can reveal, and only its own questions.
    const refused = waitForEvent(watcher, 'error', error => /not authorized/i.test(error.message));
    watcher.emit('setResultsRevealed', seed.slug, seed.agreement, true, 'not-the-token');
    await refused;
    const quiet = nextQuestions(display, 'questions after a cross-discussion attempt');
    mod.emit('setResultsRevealed', other.slug, seed.agreement, true, other.adminToken);
    mod.emit('setPinned', seed.slug, seed.numerical, true, seed.adminToken);
    assertDisplayHidden(byId(await quiet, seed.agreement), 2, 'after a cross-discussion attempt');
    assert.equal((await pool.query('SELECT results_revealed FROM questions WHERE id = $1', [seed.agreement])).rows[0].results_revealed, false);

    // Revealed: the display and a participant who has not voted both get it,
    // while the other questions stay hidden.
    const shownOnDisplay = waitForQuestions(display, qs => byId(qs, seed.agreement)?.resultsRevealed === true, 'display after reveal');
    const shownToWatcher = waitForQuestions(watcher, qs => byId(qs, seed.agreement)?.resultsRevealed === true, 'watcher after reveal');
    mod.emit('setResultsRevealed', seed.slug, seed.agreement, true, seed.adminToken);
    for (const [view, label] of [[await shownOnDisplay, 'display'], [await shownToWatcher, 'participant']]) {
      assertResultsShown(byId(view, seed.agreement), ['Agree', 'Disagree'], `${label}: revealed question`);
      assert.equal(byId(view, seed.yesNo).resultsHidden, true, `${label}: other question still hidden`);
      assert.equal(byId(view, seed.yesNo).resultsRevealed, false);
    }

    // Live votes on a revealed question reach everyone.
    const live = nextQuestions(display, 'display after a vote on a revealed question');
    await emitWithAck(watcher, 'vote', seed.slug, seed.yesNo, 'Yes', 'watcher', 'Watcher', undefined);
    const { socket: voter } = await joinAs(seed.slug, 'seed-c');
    try {
      const next = waitForQuestions(display, qs => byId(qs, seed.agreement)?.votes.length === 3, 'display after another vote');
      await live;
      await emitWithAck(voter, 'vote', seed.slug, seed.agreement, 'Unsure', 'seed-c', 'Seed C', undefined);
      assertResultsShown(byId(await next, seed.agreement), ['Agree', 'Disagree', 'Unsure'], 'display: live on revealed');
    } finally {
      voter.disconnect();
    }

    // The REST views follow the same switch, for a caller with no identity.
    const summary = (await jsonRequest('GET', `/api/discussions/${seed.slug}/summary`)).body;
    assert.equal(summary.counts.hiddenResults, 2);
    assert.equal(summary.questions.find(q => q.id === seed.agreement).responseCount, 3);

    // Hiding it again goes back to showing results only after voting.
    const hiddenAgain = waitForQuestions(display, qs => byId(qs, seed.agreement)?.resultsRevealed === false, 'display after hiding');
    const watcherHidden = waitForQuestions(watcher, qs => byId(qs, seed.agreement)?.resultsRevealed === false, 'watcher after hiding');
    mod.emit('setResultsRevealed', seed.slug, seed.agreement, false, seed.adminToken);
    assertDisplayHidden(byId(await hiddenAgain, seed.agreement), 3, 'display after hiding');
    assertResultsHidden(byId(await watcherHidden, seed.agreement), 'participant after hiding');
  } finally {
    display.disconnect();
    watcher.disconnect();
    mod.disconnect();
  }
});

test('rapid show and hide leave every screen matching the stored reveal state', async () => {
  const seed = await seedResultsDiscussion('reveal-race');
  const { socket: display } = await joinDisplay(seed.slug);
  const { socket: watcher } = await joinAs(seed.slug, 'watcher');
  const mod = await connectSocket();
  try {
    const last = { display: null, watcher: null };
    display.on('questions', qs => { last.display = byId(qs, seed.agreement); });
    watcher.on('questions', qs => { last.watcher = byId(qs, seed.agreement); });
    // Overlapping refreshes must not deliver an older payload after a newer one.
    for (let i = 0; i < 10; i += 1) {
      mod.emit('setResultsRevealed', seed.slug, seed.agreement, i % 2 === 0, seed.adminToken);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    const stored = (await pool.query('SELECT results_revealed FROM questions WHERE id = $1', [seed.agreement])).rows[0].results_revealed;
    for (const [label, question] of Object.entries(last)) {
      assert.ok(question, `${label} received questions`);
      assert.equal(question.resultsRevealed, stored, `${label} matches the stored state`);
      assert.equal(question.resultsHidden, !stored, `${label} hides results exactly when not revealed`);
    }
  } finally {
    display.disconnect();
    watcher.disconnect();
    mod.disconnect();
  }
});

test('a room display is not a participant and cannot vote, write or moderate', async () => {
  const seed = await seedResultsDiscussion('display-read-only');
  const { socket: participant } = await joinAs(seed.slug, 'seed-c');
  try {
    // The display gets the presence count, which does not include itself.
    const display = await connectSocket();
    try {
      const presence = waitForEvent(display, 'presence');
      const questions = nextQuestions(display, 'display join');
      display.emit('joinDisplay', seed.slug);
      assert.equal(await presence, 1);
      await questions;

      // A participant joining is counted, and the display hears about it.
      const secondJoined = waitForEvent(display, 'presence', count => count === 2);
      const { socket: second } = await joinAs(seed.slug, 'seed-d');
      // Subscribe before disconnecting too: both broadcasts can arrive before
      // the asynchronous join/disconnect helpers return control to this test.
      const secondLeft = waitForEvent(participant, 'presence', count => count === 1);
      try {
        assert.equal(await secondJoined, 2);
      } finally {
        second.disconnect();
      }
      assert.equal(await secondLeft, 1);

      // Even if it claims an identity, it cannot vote, add anything or moderate.
      display.emit('identify', seed.slug, 'seed-display');
      assert.deepEqual(await emitWithAck(display, 'vote', seed.slug, seed.agreement, 'Agree', 'seed-display', 'Display', undefined),
        { ok: false, success: false, error: 'display_read_only' });
      assert.equal((await emitWithAck(display, 'addQuestion', seed.slug, { text: 'From the screen', type: 'Open Ended' }, true, null)).ok, false);
      assert.equal((await emitWithAck(display, 'checkModerator', seed.slug, seed.adminToken)).ok, false);
      assert.equal((await emitWithAck(display, 'claimModerator', seed.slug)).success, false);
      // Nor can it switch itself into the participant room.
      display.emit('joinDiscussion', seed.slug);
      const stillHidden = nextQuestions(display, 'display after attempted switch');
      await emitWithAck(participant, 'vote', seed.slug, seed.agreement, 'Agree', 'seed-c', 'Seed C', undefined);
      assertDisplayHidden(byId(await stillHidden, seed.agreement), 3, 'after identify and moderator attempts');

      const stored = await pool.query(
        `SELECT COUNT(*)::int AS count FROM votes WHERE user_id = 'seed-display'
          OR question_id IN (SELECT id FROM questions WHERE text = 'From the screen')`
      );
      assert.equal(stored.rows[0].count, 0);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM questions WHERE text = 'From the screen'")).rows[0].count, 0);
      const participants = await emitWithAck(participant, 'listParticipants', seed.slug, seed.adminToken);
      assert.equal(participants.participants.some(p => p.pseudonym === 'Display'), false);
    } finally {
      display.disconnect();
    }
    // Closing the display does not change the participant count either.
    const after = waitForEvent(participant, 'presence');
    const { socket: third } = await joinAs(seed.slug, 'seed-e');
    third.disconnect();
    assert.equal(await after, 2);
  } finally {
    participant.disconnect();
  }
});

test('a moderator chooses which question the room display shows on its own', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('display-question') });
  const other = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('display-question-other') });
  const { slug, adminToken } = created.body;
  const mod = await joinAsModerator(slug, adminToken);
  const display = await connectSocket();
  const add = async (socket, where, token, question) => {
    assert.deepEqual(await emitWithAck(socket, 'addQuestion', where, { type: 'Agreement', options: [], ...question }, true, token), { added: true });
    return (await pool.query('SELECT id FROM questions WHERE text = $1', [question.text])).rows[0].id;
  };
  const stateWhere = predicate => waitForEvent(display, 'discussionState', predicate);
  const refusal = pattern => waitForEvent(mod, 'error', error => pattern.test(error.message));
  try {
    const first = await add(mod, slug, adminToken, { text: 'First statement' });
    const second = await add(mod, slug, adminToken, { text: 'Second statement' });
    const queued = await add(mod, slug, adminToken, { text: 'Queued statement', queued: true });
    const foreign = await add(mod, other.body.slug, other.body.adminToken, { text: 'Another room' });

    const initial = stateWhere(() => true);
    display.emit('joinDisplay', slug);
    assert.equal((await initial).displayQuestionId, null);

    // Choosing a question also switches a display that lists every question to
    // the one-question view, so one click puts the question on the screen.
    let changed = stateWhere(state => state.displayQuestionId === first);
    mod.emit('setDisplaySettings', slug, { questionId: first }, adminToken);
    assert.equal((await changed).displayLayout, 'focus');

    // An explicit layout wins, and the choice is kept for when the moderator
    // goes back to one question.
    changed = stateWhere(state => state.displayQuestionId === second);
    mod.emit('setDisplaySettings', slug, { questionId: second, layout: 'all' }, adminToken);
    assert.equal((await changed).displayLayout, 'all');
    changed = stateWhere(state => state.displayLayout === 'focus');
    mod.emit('setDisplaySettings', slug, { layout: 'focus' }, adminToken);
    assert.equal((await changed).displayQuestionId, second);

    // Other settings leave the chosen question alone.
    changed = stateWhere(state => state.displayQr === 'hidden');
    mod.emit('setDisplaySettings', slug, { qr: 'hidden' }, adminToken);
    assert.equal((await changed).displayQuestionId, second);

    // Only a published question of this discussion can be chosen.
    for (const [questionId, pattern] of [
      [queued, /cannot be shown/i], [foreign, /cannot be shown/i], [999999999, /cannot be shown/i],
      ['7', /room display setting/i], [1.5, /room display setting/i], [0, /room display setting/i],
    ]) {
      const refused = refusal(pattern);
      mod.emit('setDisplaySettings', slug, { questionId }, adminToken);
      await refused;
    }
    const outsider = await connectSocket();
    try {
      const refused = waitForEvent(outsider, 'error', error => /not authorized/i.test(error.message));
      outsider.emit('setDisplaySettings', slug, { questionId: first }, 'not-the-token');
      await refused;
    } finally {
      outsider.disconnect();
    }
    assert.equal((await pool.query('SELECT display_question_id FROM discussions WHERE slug = $1', [slug])).rows[0].display_question_id, second);

    // A new question from the room does not take over the screen.
    await add(mod, slug, undefined, { text: 'A participant statement' });
    assert.equal((await pool.query('SELECT display_question_id FROM discussions WHERE slug = $1', [slug])).rows[0].display_question_id, second);

    // Clearing the choice keeps the layout.
    changed = stateWhere(state => state.displayQuestionId === null);
    mod.emit('setDisplaySettings', slug, { questionId: null }, adminToken);
    assert.equal((await changed).displayLayout, 'focus');

    // Deleting the chosen question clears the choice for everyone watching.
    changed = stateWhere(state => state.displayQuestionId === first);
    mod.emit('setDisplaySettings', slug, { questionId: first }, adminToken);
    await changed;
    changed = stateWhere(state => state.displayQuestionId === null);
    mod.emit('deleteQuestion', slug, first, adminToken);
    await changed;
    assert.equal((await pool.query('SELECT display_question_id FROM discussions WHERE slug = $1', [slug])).rows[0].display_question_id, null);
  } finally {
    mod.disconnect();
    display.disconnect();
  }
});
