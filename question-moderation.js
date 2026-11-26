const { slugifyTopic } = require('./discussion-names');
const { normalizeQuestionPayload, normalizeQuestionTools } = require('./question-data');
const { MODERATOR_ORDER_SQL } = require('./question-views');
const { moderatorAction } = require('./moderator-roles');

function registerQuestionModeration(socket, {
  pool, withTransaction, verifyAdmin, isDiscussionLocked, saveSnapshotBeforeReveal, audience,
  emitQuestions, emitDiscussionState, logError,
}) {
  const asModerator = moderatorAction(socket, { verifyAdmin, logError });

  socket.on('deleteQuestion', (topic, questionId, token) => asModerator(topic, token, {
    log: 'Error deleting question:', message: 'Failed to delete question',
  }, async (discussionSlug, discussionId) => {
    // Scope the delete through the question's discussion so a moderator of
    // one discussion can never wipe another discussion's votes by passing a
    // foreign questionId. Votes go first to satisfy the FK constraint. The
    // question row is locked for the whole transaction: a vote locks it FOR
    // SHARE while it is stored (see addVote), so one that arrives during the
    // delete waits and then finds no question, instead of landing between
    // the two deletes and leaving the question behind with its votes gone.
    //
    // Removing the spotlighted question also restores the underlying layout.
    // That runs in the same transaction, so a failed broadcast cannot leave the
    // display pointing at a deleted question. It runs first, so the discussion
    // row is locked before the question row, the order votes lock them in.
    const spotlightCleared = await withTransaction(async client => {
      const cleared = await client.query(
        `UPDATE discussions SET display_question_id = NULL,
            display_layout = CASE WHEN display_layout = 'spotlight' THEN 'all' ELSE display_layout END
          WHERE id = $1 AND display_question_id = $2`,
        [discussionId, questionId]
      );
      const target = await client.query(
        'SELECT id FROM questions WHERE id = $1 AND discussion_id = $2 FOR UPDATE',
        [questionId, discussionId]
      );
      if (target.rows.length) {
        await client.query('DELETE FROM votes WHERE question_id = $1', [target.rows[0].id]);
        await client.query('DELETE FROM questions WHERE id = $1', [target.rows[0].id]);
      }
      return cleared.rowCount > 0;
    });
    await emitQuestions(discussionSlug);
    if (spotlightCleared) await emitDiscussionState(discussionSlug);
  }));

  // Moderator-only: show one question's results to everyone now, voted or not,
  // or go back to showing them only after voting. The first time a question is
  // shown, a "before" snapshot is saved by itself. Anyone with the link can open
  // the room display, so a result revealed on the room's screen cannot stay
  // hidden from anyone; this is the one switch for both. Has no visible effect
  // while the discussion always shows results.
  socket.on('setResultsRevealed', (topic, questionId, revealed, token) => asModerator(topic, token, {
    log: 'Error revealing results:', message: 'Failed to update question',
  }, async (discussionSlug, discussionId) => {
    // READ COMMITTED takes the capture statement's view after this lock
    // finishes waiting for in-flight votes; later votes wait until reveal commits.
    const snapshotSaved = await withTransaction(async client => {
      const target = await client.query('SELECT id FROM questions WHERE id = $1 AND discussion_id = $2 FOR UPDATE', [questionId, discussionId]);
      if (!target.rows.length) return false;
      const saved = revealed === true
        ? await saveSnapshotBeforeReveal(discussionSlug, discussionId, questionId, client) : false;
      await client.query('UPDATE questions SET results_revealed = $1 WHERE id = $2 AND discussion_id = $3',
        [revealed === true, questionId, discussionId]);
      return saved;
    });
    if (snapshotSaved) audience(discussionSlug).emit('snapshotsChanged');
    await emitQuestions(discussionSlug);
  }));

  socket.on('swapQueuedQuestions', (topic, earlierId, laterId, token) => asModerator(topic, token, {
    log: 'Error reordering queue:', message: 'Failed to update the queue order.',
  }, async (discussionSlug, discussionId) => {
    if (![earlierId, laterId].every(id => Number.isInteger(id) && id > 0 && id <= 2147483647)) return;
    const moved = await withTransaction(async client => {
      await client.query('SELECT id FROM discussions WHERE id = $1 FOR UPDATE', [discussionId]);
      const { rows } = await client.query(`SELECT id, COALESCE(queue_position, id) AS position
        FROM questions WHERE discussion_id = $1 AND queued ORDER BY position FOR UPDATE`, [discussionId]);
      const index = rows.findIndex(row => row.id === earlierId);
      if (index < 0 || rows[index + 1]?.id !== laterId) return false;
      await client.query(`UPDATE questions SET queue_position = CASE WHEN id = $2 THEN $4::integer ELSE $5::integer END
        WHERE discussion_id = $1 AND queued AND id IN ($2, $3)`,
      [discussionId, earlierId, laterId, rows[index + 1].position, rows[index].position]);
      return true;
    });
    if (!moved) socket.emit('error', { message: 'The queue has changed. Check the order before moving a question again.' });
    await emitQuestions(discussionSlug);
  }));

  socket.on('swapPublishedQuestions', (topic, earlierId, laterId, token) => asModerator(topic, token, {
    log: 'Error reordering published questions:', message: 'Failed to update the question order.',
  }, async (slug, discussionId) => {
    if (![earlierId, laterId].every(id => Number.isInteger(id) && id > 0 && id <= 2147483647)) return;
    const moved = await withTransaction(async client => {
      await client.query('SELECT id FROM discussions WHERE id = $1 FOR UPDATE', [discussionId]);
      const { rows } = await client.query(`SELECT q.id, q.pinned FROM questions q
        WHERE q.discussion_id = $1 AND NOT q.queued ORDER BY ${MODERATOR_ORDER_SQL} FOR UPDATE`, [discussionId]);
      const earlier = rows.findIndex(row => row.id === earlierId);
      if (earlier < 0) return false;
      const later = rows.findIndex((row, index) => index > earlier && row.pinned === rows[earlier].pinned);
      if (rows[later]?.id !== laterId) return false;
      [rows[earlier], rows[later]] = [rows[later], rows[earlier]];
      await client.query(`UPDATE questions q SET published_position = ordered.position::integer
        FROM unnest($1::integer[]) WITH ORDINALITY AS ordered(id, position)
        WHERE q.id = ordered.id AND q.published_position IS DISTINCT FROM ordered.position`, [rows.map(row => row.id)]);
      return true;
    });
    if (!moved) socket.emit('error', { message: 'The question order has changed. Check the order and try again.' });
    await emitQuestions(slug);
  }));

  // Moderator-only: publish a queued question, showing it to everyone and
  // opening it for answers. Its creation time becomes now, so it arrives as the
  // newest question for participants and for the room display. There is no way
  // back to the queue: once people can answer a question, hiding it would hide
  // their answers too. Publishing an already published question changes nothing.
  socket.on('publishQuestion', async (topic, questionId, token, ack) => {
    const discussionSlug = slugifyTopic(topic);
    const reply = (result) => { if (typeof ack === 'function') ack(result); };
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        reply({ published: false, reason: 'not_authorized' });
        return;
      }
      // Locking closes new questions, and a published question is a new one
      // for everybody else.
      if (await isDiscussionLocked(discussionSlug)) {
        socket.emit('error', { message: 'This discussion is locked.' });
        reply({ published: false, reason: 'locked' });
        return;
      }
      const validId = Number.isInteger(questionId) && questionId > 0 && questionId <= 2147483647;
      const outcome = validId ? await withTransaction(async client => {
        const discussion = await client.query('SELECT locked FROM discussions WHERE id = $1 FOR SHARE', [discussionId]);
        if (!discussion.rows.length || discussion.rows[0].locked) return { locked: true };
        const target = await client.query('SELECT queued FROM questions WHERE id = $1 AND discussion_id = $2 FOR UPDATE', [questionId, discussionId]);
        if (!target.rows.length) return { exists: false, changed: false };
        if (!target.rows[0].queued) return { exists: true, changed: false };
        await client.query('UPDATE questions SET queued = FALSE, created_at = now() WHERE id = $1 AND discussion_id = $2', [questionId, discussionId]);
        return { exists: true, changed: true };
      }) : { exists: false, changed: false };
      if (outcome.locked) {
        reply({ published: false, reason: 'locked' });
        return;
      }
      // An authorized repeat repairs failed delivery without republishing or
      // changing created_at. Delivery failure cannot undo a committed publish.
      if (outcome.exists) {
        try { await emitQuestions(discussionSlug); }
        catch (error) { logError('Error broadcasting published question:', error); }
      }
      reply({ published: outcome.changed });
    } catch (error) {
      logError('Error publishing question:', error);
      socket.emit('error', { message: 'Failed to publish question' });
      reply({ published: false, reason: 'error' });
    }
  });

  socket.on('setPinned', (topic, questionId, pinned, token) => asModerator(topic, token, {
    log: 'Error setting pin state:', message: 'Failed to update question',
  }, async (discussionSlug, discussionId) => {
    await pool.query('UPDATE questions SET pinned = $1 WHERE id = $2 AND discussion_id = $3', [!!pinned, questionId, discussionId]);
    await emitQuestions(discussionSlug);
  }));

  // Moderator-only: edit a question's wording/type, allowed ONLY while it has no
  // responses yet. Once anyone has answered, the wording is a contract their
  // responses were made against, so editing is refused (delete + re-ask instead).
  socket.on('editQuestion', async (topic, questionId, updates, token, ack) => {
    const discussionSlug = slugifyTopic(topic);
    const reply = (result) => { if (typeof ack === 'function') ack(result); };
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        reply({ updated: false, reason: 'not_authorized' });
        return;
      }

      // Validate the same way creation does: non-empty text, a known type, a
      // valid min < max range for Numerical and valid options for Multiple Choice.
      const normalizedUpdates = normalizeQuestionPayload(updates);

      // One transaction, with the question row locked FOR UPDATE before the
      // response check. A vote locks the same row FOR SHARE while it is
      // validated and stored (see addVote), so the two serialize: an edit that
      // waited for a vote then sees that response and is refused, and a vote
      // that waited for an edit is checked against the edited question.
      // Scoping through discussion_id stops a moderator of one discussion from
      // probing or editing another's questions by passing a foreign id.
      const outcome = await withTransaction(async (client) => {
        const existing = await client.query(
          'SELECT id, tools FROM questions WHERE id = $1 AND discussion_id = $2 FOR UPDATE',
          [questionId, discussionId]
        );
        if (existing.rows.length === 0) return 'not_found';
        const { rows: [participation] } = await client.query(`SELECT
          EXISTS (SELECT 1 FROM votes WHERE question_id = $1) AS answered,
          EXISTS (SELECT 1 FROM question_tool_notes WHERE question_id = $1) AS noted`, [questionId]);
        if (participation.answered) return 'has_responses';
        if (participation.noted) return 'has_notes';
        if (!normalizedUpdates) return 'invalid';
        await client.query(
          `UPDATE questions SET text = $1, type = $2, min_value = $3, max_value = $4, options = $5, max_responses = $7, show_attribution = $8
           , tools = $9,
           independent_answers = COALESCE($10, independent_answers),
           results_revealed = CASE WHEN type <> $2 OR independent_answers <> COALESCE($10, independent_answers) THEN FALSE ELSE results_revealed END
           WHERE id = $6`,
          [
            normalizedUpdates.text,
            normalizedUpdates.type,
            normalizedUpdates.minValue,
            normalizedUpdates.maxValue,
            JSON.stringify(normalizedUpdates.options),
            questionId,
            normalizedUpdates.maxResponses,
            normalizedUpdates.showAttribution,
            normalizedUpdates.tools ?? normalizeQuestionTools(existing.rows[0].tools, normalizedUpdates.type),
            updates.independentAnswers === undefined && normalizedUpdates.type === 'Open Ended' ? null : normalizedUpdates.independentAnswers,
          ]
        );
        return 'updated';
      });
      if (outcome === 'has_responses') {
        socket.emit('error', { message: 'This question already has responses and can no longer be edited.' });
      } else if (outcome === 'has_notes') {
        socket.emit('error', { message: 'This question has private participant notes and can no longer be edited.' });
      }
      if (outcome !== 'updated') {
        reply({ updated: false, reason: outcome });
        return;
      }
      await emitQuestions(discussionSlug);
      reply({ updated: true });
    } catch (error) {
      logError('Error editing question:', error);
      socket.emit('error', { message: 'Failed to edit question' });
      reply({ updated: false, reason: 'error' });
    }
  });
}

module.exports = { registerQuestionModeration };
