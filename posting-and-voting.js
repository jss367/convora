const { slugifyTopic } = require('./discussion-names');
const { normalizeQuestionPayload, normalizeNumericalVote, choiceOptionsFor, isValidVote } = require('./question-data');
const { bindSocketUser } = require('./participant-identity');

function registerPostingAndVoting(socket, {
  pool, interestUpdates, addQuestion, findSimilarQuestion, getQuestionForTopic, canonicalPseudonym,
  addVote, clearVote, setQuestionInterest, emitQuestions, emitDiscussion, logError,
}) {
  socket.on('addQuestion', async (topic, question, force, token, ack) => {
    // Back-compat: pre-deploy clients (and external Socket.IO callers) used the
    // old (topic, question, force, ack) signature, which binds their ack
    // callback to `token`. Detect that and move it back to `ack`, clearing
    // `token` so the submitter is simply treated as a non-moderator.
    if (typeof token === 'function' && ack === undefined) {
      ack = token;
      token = undefined;
    }
    const discussionSlug = slugifyTopic(topic);

    // Report the outcome back to the submitter so the client only clears its
    // draft once the question is actually added — not when it's bounced as a
    // near-duplicate or fails.
    const reply = (result) => {
      if (typeof ack === 'function') ack(result);
    };

    try {
      const normalizedQuestion = normalizeQuestionPayload(question);
      if (!normalizedQuestion) {
        socket.emit('error', { message: 'Invalid question.' });
        reply({ added: false, reason: 'invalid' });
        return;
      }

      const similar = !force && await findSimilarQuestion(discussionSlug, normalizedQuestion.text);
      const added = await addQuestion(discussionSlug, normalizedQuestion, { queueRequested: question.queued === true, token, similar });
      if (added.reason) {
        if (added.reason === 'similar') {
          socket.emit('similarQuestion', { candidate: similar, question: added.queued ? { ...normalizedQuestion, queued: true } : normalizedQuestion });
        } else {
          const messages = { locked: 'This discussion is locked.', moderator_only: 'Only the moderator can add questions right now.', not_authorized: normalizedQuestion.independentAnswers ? 'Only moderators can collect independent answers.' : 'Only a moderator can queue a question.' };
          socket.emit('error', { message: added.reason === 'not_authorized' && normalizedQuestion.tools?.length
            ? 'Moderator access is required to enable private participant tools.' : messages[added.reason] });
        }
        reply({ added: false, reason: added.reason });
        return;
      }
      // The question is saved. A failed broadcast must not report it as not
      // added, or the composer keeps the draft and a forced retry saves a copy.
      // Each broadcast is attempted on its own, so a failed discussion refresh
      // does not keep the new question from reaching viewers.
      for (const broadcast of [emitDiscussion, emitQuestions]) {
        try {
          await broadcast(discussionSlug);
        } catch (error) {
          logError('Error broadcasting added question:', error);
        }
      }
      reply(added.participant_suggested ? { added: true, suggested: true, queued: true } : { added: true });
    } catch (error) {
      logError('Error adding question:', error);
      socket.emit('error', { message: 'Failed to add question' });
      reply({ added: false, reason: 'error' });
    }
  });

  // "Set my vote to this value": repeating the same vote leaves it set. Undo is
  // the separate clearVote event below. The optional ack tells the sender when
  // the vote has been handled so its pending state can clear.
  socket.on('vote', async (topic, questionId, vote, claimedUserId, pseudonym, mode, ack) => {
    if (typeof mode === 'function' && ack === undefined) {
      ack = mode;
      mode = undefined;
    }
    const reply = (ok, details = {}) => { if (typeof ack === 'function') ack({ ok, ...details }); };
    const discussionSlug = slugifyTopic(topic);
    // Attribute the vote to the socket's pinned identity, not to whatever id the
    // message carries, so a client can't cast votes as another participant.
    const userId = bindSocketUser(socket, claimedUserId);
    if (!userId) {
      socket.emit('error', { message: 'Failed to handle vote' });
      reply(false);
      return;
    }
    try {
      // Verify the question actually belongs to this topic AND that the topic is
      // not locked. Without this, a client could bypass a locked discussion by
      // sending the locked question's id under some other (unlocked) topic.
      const target = await getQuestionForTopic(discussionSlug, questionId);
      // A queued question cannot be answered, and is reported exactly like one
      // that does not exist so its id reveals nothing.
      if (!target || target.queued) {
        socket.emit('error', { message: 'Invalid question for this discussion.' });
        reply(false);
        return;
      }
      if (target.locked) {
        socket.emit('error', { message: 'Voting is closed for this discussion.' });
        reply(false);
        return;
      }
      // Single-choice types accept only their options (Multiple Choice its own
      // stored ones) and Numerical a number within the question's range.
      // Without this, a crafted socket message could store an arbitrary value
      // that skews the results bars, the summary statistics and the cluster
      // analysis. addVote checks again against the locked question row, in
      // case a moderator edits the question before the vote is stored.
      const questionRow = {
        type: target.type, options: target.options, min_value: target.minValue, max_value: target.maxValue,
      };
      if (!isValidVote(questionRow, vote)) {
        socket.emit('error', { message: 'Invalid vote.' });
        reply(false);
        return;
      }
      // Decimals are allowed; store them at one precision (see normalizeNumericalVote).
      if (target.type === 'Numerical') vote = normalizeNumericalVote(vote);
      // Persist the reserved handle in pseudonym mode rather than the client's
      // (possibly pre-reservation, colliding) local pick — see canonicalPseudonym.
      const handle = await canonicalPseudonym(discussionSlug, target.discussionId, userId, mode, pseudonym);
      const result = await addVote(questionId, vote, userId, handle);
      if (result.reason === 'locked') {
        // A moderator locked the discussion after the check above.
        socket.emit('error', { message: 'Voting is closed for this discussion.' });
        reply(false);
        return;
      }
      if (result.reason === 'invalid') {
        // The question was edited between the check above and the write, and
        // this vote no longer fits it.
        socket.emit('error', { message: 'This question changed. Please vote again.' });
        reply(false);
        await emitQuestions(discussionSlug);
        return;
      }
      if (result.reason === 'limit') {
        reply(false, result);
        socket.emit('error', { message: 'You have reached the response limit for this question.' });
        return;
      }
      await emitQuestions(discussionSlug);
      reply(result.updated !== false, ['Open Ended', 'Brainstorm'].includes(target.type) ? result : {});
    } catch (error) {
      logError('Error handling vote:', error);
      socket.emit('error', { message: 'Failed to handle vote' });
      reply(false);
    }
  });

  // Explicit undo for single-choice polls. Clearing an already-absent vote is a
  // no-op, so a retried or duplicated emit is harmless.
  socket.on('clearVote', async (topic, questionId, claimedUserId, ack) => {
    const reply = (ok) => { if (typeof ack === 'function') ack({ ok }); };
    const discussionSlug = slugifyTopic(topic);
    const userId = bindSocketUser(socket, claimedUserId);
    if (!userId) {
      socket.emit('error', { message: 'Failed to handle vote' });
      reply(false);
      return;
    }
    try {
      const target = await getQuestionForTopic(discussionSlug, questionId);
      if (!target || target.queued || !choiceOptionsFor(target)) {
        socket.emit('error', { message: 'Invalid question for this discussion.' });
        reply(false);
        return;
      }
      if (target.locked) {
        socket.emit('error', { message: 'Voting is closed for this discussion.' });
        reply(false);
        return;
      }
      const cleared = await clearVote(questionId, userId);
      if (cleared?.reason === 'locked') {
        socket.emit('error', { message: 'Voting is closed for this discussion.' });
        reply(false);
        return;
      }
      await emitQuestions(discussionSlug);
      reply(true);
    } catch (error) {
      logError('Error clearing vote:', error);
      socket.emit('error', { message: 'Failed to handle vote' });
      reply(false);
    }
  });

  // Mark or unmark a question as interesting. The count ranks questions under
  // the "Most Interesting" sort. The event sets the state instead of toggling
  // it, so a repeated or retried emit leaves the same result.
  socket.on('setQuestionInterest', async (topic, questionId, interested, claimedUserId, ack) => {
    const discussionSlug = slugifyTopic(topic);
    const reply = updated => { if (typeof ack === 'function') ack({ updated }); };
    const userId = bindSocketUser(socket, claimedUserId);
    // Question ids are Postgres integers; anything else cannot match a question.
    const validId = Number.isInteger(questionId) && questionId > 0 && questionId <= 2147483647;
    if (!userId || !validId || ![true, false, 'down'].includes(interested)) { reply(false); return; }
    try {
      const changed = await interestUpdates.run(discussionSlug, questionId, userId,
        () => setQuestionInterest(discussionSlug, questionId, userId, interested));
      reply(changed);
      if (!changed) return;
      await emitQuestions(discussionSlug);
    } catch (error) {
      logError('Error setting question interest:', error);
      reply(false);
      socket.emit('error', { message: 'Failed to update question' });
    }
  });

  // A recovery read waits behind this participant's prior interest writes,
  // including a write whose acknowledgment was lost on another connection.
  socket.on('getQuestionInterestState', async (topic, questionId, claimedUserId, ack) => {
    if (typeof ack !== 'function') return;
    const discussionSlug = slugifyTopic(topic);
    const userId = bindSocketUser(socket, claimedUserId);
    if (!userId || !Number.isInteger(questionId) || questionId <= 0 || questionId > 2147483647) {
      ack({ error: 'invalid_request' });
      return;
    }
    try {
      const result = await interestUpdates.run(discussionSlug, questionId, userId, () => pool.query(
        `SELECT COALESCE(NOT qi.downvote, false) AS interested,
                COALESCE(qi.downvote AND d.question_downvotes_enabled, false) AS downvoted
         FROM questions q JOIN discussions d ON d.id=q.discussion_id
         LEFT JOIN question_interest qi ON qi.question_id=q.id AND qi.user_id=$3
         WHERE q.id=$1 AND d.slug=$2 AND NOT q.queued`, [questionId, discussionSlug, userId]
      ));
      ack(result.rows[0] || { error: 'not_found' });
    } catch (error) {
      logError('Error recovering question interest:', error);
      ack({ error: 'unavailable' });
    }
  });
}

module.exports = { registerPostingAndVoting };
