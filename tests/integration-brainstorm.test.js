const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const {
  useIntegrationServer,
  claimModerator,
  addBrainstormQuestion,
  jsonRequest,
  connectSocket,
  waitForQuestions,
  emitWithAck,
  waitForEvent,
  uniqueTopic,
  joinAs,
} = require('./helpers/integration.cjs');

const { pool } = useIntegrationServer(__filename);

async function waitForFeedbackLockWait(fragment) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1", [`%${fragment}%`]);
    if (result.rows[0].n) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

test('Brainstorm ratings broadcast as aggregates without exposing who voted', async () => {
  const topic = uniqueTopic('brainstorm-rate');
  const mod = await connectSocket();
  const participant = await connectSocket();
  // A separate browser does the rating: identity is pinned per socket, so the
  // idea's author socket can't also stand in as the rater (that would be a
  // self-rating, which is rejected).
  const rater = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    rater.emit('joinDiscussion', topic);

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
    // Socket handlers run concurrently: finish the rejected rating before
    // enabling feedback, so this checks disabled feedback rather than a race.
    assert.deepEqual(await emitWithAck(mod, 'setResponseRating', topic, responseId, 'quality', 1, 'user-early'), { updated: false });
    mod.emit('setDiscussionFlags', topic, { reactions_enabled: true }, token);
    const afterEnable = (await enabledUpdate)[0].votes[0];
    assert.equal(afterEnable.qualityUp, 0, 'rating before enabling reactions must be rejected');

    // Now ratings are accepted and surface as aggregate tallies.
    const ratingUpdate = waitForQuestions(
      mod,
      (questions) => questions[0] && questions[0].votes[0] && questions[0].votes[0].qualityUp === 1,
      'quality rating broadcast'
    );
    rater.emit('setResponseRating', topic, responseId, 'quality', 1, 'user-rater');
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
    rater.disconnect();
  }
});

test('Brainstorm agreement votes accumulate into a distribution', async () => {
  const topic = uniqueTopic('brainstorm-agree');
  const mod = await connectSocket();
  // Two separate browsers cast the agreement ratings; the author socket can't
  // double as a rater (per-socket identity, and self-rating is rejected anyway).
  const raterA = await connectSocket();
  const raterB = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    raterA.emit('joinDiscussion', topic);
    raterB.emit('joinDiscussion', topic);
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
      (qs) => {
        const counts = qs[0]?.votes[0]?.agreementCounts || {};
        return counts['Strongly Agree'] === 1 && counts.Disagree === 1;
      },
      'both agreement votes counted'
    );
    raterA.emit('setResponseRating', topic, responseId, 'agreement', 'Strongly Agree', 'user-a');
    raterB.emit('setResponseRating', topic, responseId, 'agreement', 'Disagree', 'user-b');
    const counts = (await agreeUpdate)[0].votes[0].agreementCounts;

    assert.equal(counts['Strongly Agree'], 1);
    assert.equal(counts['Disagree'], 1);
  } finally {
    mod.disconnect();
    raterA.disconnect();
    raterB.disconnect();
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

test('a participant cannot act as another by supplying their userId (issue #38)', async () => {
  const topic = uniqueTopic('identity-spoof');
  const mod = await connectSocket();
  const victim = await connectSocket();
  const attacker = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    victim.emit('joinDiscussion', topic);
    attacker.emit('joinDiscussion', topic);
    // Each socket pins to its own identity up front, exactly as a real client
    // does on connect. From here on the server attributes every action to the
    // connection's pinned identity, never to a userId named in the message.
    victim.emit('identify', topic, 'victim-user');
    attacker.emit('identify', topic, 'attacker-user');

    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Ideas?');

    // The victim posts an idea and a comment on it.
    const victimIdea = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'victim idea');
    victim.emit('vote', topic, question.id, "victim's idea", 'victim-user', 'Victim');
    const victimResponseId = (await victimIdea)[0].votes[0].id;

    const commentsOn = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await commentsOn;

    const victimComment = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1, 'victim comment');
    victim.emit('addResponseComment', topic, victimResponseId, "victim's comment", 'victim-user', 'Victim');
    const victimCommentId = (await victimComment)[0].votes[0].comments[0].id;

    // The attacker also posts their own idea, so we can show what their socket can
    // actually delete (its own content) versus what it cannot (the victim's).
    const attackerIdea = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 2, 'attacker idea');
    attacker.emit('vote', topic, question.id, "attacker's idea", 'attacker-user', 'Attacker');
    const attackerResponseId = (await attackerIdea)[0].votes.find((v) => v.id !== victimResponseId).id;

    // ATTACK 1: delete the victim's idea by naming the victim's userId. The handler
    // ignores the supplied id and acts as the attacker's pinned identity, so the
    // delete matches nothing and the victim's idea survives. deleteVote always
    // re-broadcasts, so the next 'questions' event confirms the query ran.
    const afterDelete = waitForQuestions(mod, (qs) => qs[0], 'state after spoofed delete');
    attacker.emit('deleteVote', topic, victimResponseId, 'victim-user');
    const afterDeleteVotes = (await afterDelete)[0].votes;
    assert.ok(afterDeleteVotes.find((v) => v.id === victimResponseId), "victim's idea must survive a spoofed delete");

    // ATTACK 2: delete the victim's comment by naming their userId — must survive.
    const afterCommentDelete = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes.find((v) => v.id === victimResponseId), 'state after spoofed comment delete');
    attacker.emit('deleteResponseComment', topic, victimCommentId, 'victim-user');
    const survivingComments = (await afterCommentDelete)[0].votes.find((v) => v.id === victimResponseId).comments || [];
    assert.ok(survivingComments.find((c) => c.id === victimCommentId), "victim's comment must survive a spoofed delete");

    // ATTACK 3: rename the victim's responses by naming their userId — must not take.
    const afterRename = waitForQuestions(
      mod, (qs) => qs[0] && qs[0].votes.find((v) => v.id === victimResponseId), 'state after spoofed rename');
    attacker.emit('updateDisplayName', topic, 'victim-user', 'PWNED');
    const victimVoteAfter = (await afterRename)[0].votes.find((v) => v.id === victimResponseId);
    assert.equal(victimVoteAfter.pseudonym, 'Victim', "victim's display name must be unchanged by a spoofer");

    // The supplied id is IGNORED, not honored: the attacker passing 'victim-user'
    // to deleteVote deletes the ATTACKER'S OWN idea (their connection's pinned
    // identity), proving ownership is the socket's, not the message's.
    const ownDeleted = waitForQuestions(
      mod, (qs) => qs[0] && !qs[0].votes.find((v) => v.id === attackerResponseId), 'attacker own idea removed');
    attacker.emit('deleteVote', topic, attackerResponseId, 'victim-user');
    const remaining = (await ownDeleted)[0].votes;
    assert.ok(remaining.find((v) => v.id === victimResponseId), "victim's idea is still present");
    assert.ok(!remaining.find((v) => v.id === attackerResponseId), "the attacker's own idea is what got deleted");
  } finally {
    mod.disconnect();
    victim.disconnect();
    attacker.disconnect();
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

for (const action of ['quality', 'agreement', 'reaction', 'comment']) {
  test(`a ${action} waiting for a moderator lock cannot write feedback`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic(`feedback-lock-${action}`) });
    await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE, comments_enabled = TRUE WHERE id = $1', [created.body.id]);
    const q = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
    const response = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'A response') RETURNING id", [q.id])).rows[0];
    const { socket } = await joinAs(created.body.slug, 'critic');
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [created.body.id]);
      let comment;
      if (action === 'comment') comment = emitWithAck(socket, 'addResponseComment', created.body.slug, response.id, 'A comment', 'critic', 'Critic', 'custom');
      else if (action === 'reaction') socket.emit('toggleResponseReaction', created.body.slug, response.id, 'crux', 'critic');
      else socket.emit('setResponseRating', created.body.slug, response.id, action, action === 'quality' ? 1 : 'Agree', 'critic');
      const waited = await waitForFeedbackLockWait('FOR SHARE OF d');
      await blocker.query('COMMIT');
      if (comment) assert.equal((await comment).added, false);
      await emitWithAck(socket, 'getBrainstormState', created.body.slug, 'critic');
      for (const table of ['response_votes', 'response_ratings', 'response_reactions', 'response_comments']) {
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE response_id = $1`, [response.id])).rows[0].n, 0, `${table} stays unchanged`);
      }
      assert.equal(waited, true, 'feedback validation waits for the moderator transaction');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      socket.disconnect();
    }
  });
}

for (const [action, table] of [['quality', 'response_ratings'], ['reaction', 'response_reactions'], ['comment', 'response_comments']]) {
  test(`a moderator lock waits for an in-progress ${action} write`, async () => {
    const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic(`feedback-write-${action}`) });
    await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE, comments_enabled = TRUE WHERE id = $1', [created.body.id]);
    const q = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Feedback', 'Open Ended') RETURNING id", [created.body.id])).rows[0];
    const response = (await pool.query("INSERT INTO votes (question_id, user_id, value) VALUES ($1, 'author', 'A response') RETURNING id", [q.id])).rows[0];
    const { socket } = await joinAs(created.body.slug, 'critic');
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`LOCK TABLE ${table} IN SHARE MODE`);
      let comment;
      if (action === 'comment') comment = emitWithAck(socket, 'addResponseComment', created.body.slug, response.id, 'A comment', 'critic', 'Critic', 'custom');
      else if (action === 'reaction') socket.emit('toggleResponseReaction', created.body.slug, response.id, 'crux', 'critic');
      else socket.emit('setResponseRating', created.body.slug, response.id, 'quality', 1, 'critic');
      assert.equal(await waitForFeedbackLockWait(table), true, 'feedback write reached its transaction gate');
      let locked = false;
      const locking = pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [created.body.id]).then(() => { locked = true; });
      const waited = await waitForFeedbackLockWait('UPDATE discussions SET locked');
      const committedEarly = locked;
      await blocker.query('COMMIT');
      await locking;
      if (comment) assert.equal((await comment).added, true);
      assert.equal(waited, true, 'moderator lock waits until the feedback write commits');
      assert.equal(committedEarly, false);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE response_id = $1`, [response.id])).rows[0].n, 1);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      socket.disconnect();
    }
  });
}

test('Renaming updates stored comment pseudonyms, and comment tokens are namespaced', async () => {
  const topic = uniqueTopic('brainstorm-rename');
  const mod = await connectSocket();
  const participant = await connectSocket();
  // The commenter is a different participant from the idea's author, on its own
  // socket — identity is pinned per connection, so one socket can't post the idea
  // as 'user-idea' and the comment as 'user-c'.
  const commenter = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    commenter.emit('joinDiscussion', topic);
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
    await emitWithAck(commenter, 'addResponseComment', topic, responseId, 'My take', 'user-c', 'Critic');
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
    commenter.emit('updateDisplayName', topic, 'user-c', 'Reformed Critic');
    await renamed;
  } finally {
    mod.disconnect();
    participant.disconnect();
    commenter.disconnect();
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
  // A separate browser reacts; the author socket can't also be the reactor
  // (per-socket identity, and reacting to your own idea is rejected).
  const reactor = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    reactor.emit('joinDiscussion', topic);
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
    reactor.emit('toggleResponseReaction', topic, responseId, 'key-insight', 'user-react');
    reactor.emit('toggleResponseReaction', topic, responseId, 'crux', 'user-react');
    const counts = (await reactUpdate)[0].votes[0].reactionCounts;
    assert.equal(counts.crux, 1);
    assert.equal(counts['key-insight'], undefined, 'reaction outside the active set must be rejected');
  } finally {
    mod.disconnect();
    reactor.disconnect();
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
    await addBrainstormQuestion(mod, topic, 'Carry flags');

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
        copy, (qs) => qs.length === 1 && qs[0].type === 'Open Ended', 'copy questions');
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
