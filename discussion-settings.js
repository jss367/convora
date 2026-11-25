const { slugifyTopic, formatTopicTitle, MAX_TOPIC_LENGTH } = require('./discussion-names');
const { VALID_QUESTION_TYPES } = require('./question-data');
const { POSTING_MODES } = require('./question-posting');
const { RESULTS_VISIBILITY_MODES } = require('./question-views');
const { REACTION_CATALOG } = require('./response-interactions');
const { ALLOWED_THEMES, DISPLAY_QR_MODES, DISPLAY_LAYOUTS, DISPLAY_SORTS, comparisonIncludesQuestion } = require('./discussion-state');
const { lockDiscussionSlug } = require('./discussions');
const { moderatorAction } = require('./moderator-roles');

function registerDiscussionSettings(socket, {
  pool, withTransaction, verifyAdmin, emitDiscussion, emitDiscussionState, emitQuestions, logError,
}) {
  const asModerator = moderatorAction(socket, { verifyAdmin, logError });

  // Moderator-only: change how the room display presents itself. Any field may
  // be left out to keep its current value. `questionId` is the question to show
  // on its own, or null to resume the layout. Internally 'spotlight' is an
  // all-questions layout temporarily showing one question, not a layout option.
  // `beforeSnapshotId` and `afterSnapshotId` are the opinion snapshots the
  // before-and-after view compares, or null to let the display pick the first
  // and the latest. The settings ride discussionState, which the display's room
  // receives too.
  socket.on('setDisplaySettings', async (topic, settings, token, ack) => {
    const discussionSlug = slugifyTopic(topic);
    const refuse = message => {
      if (typeof ack === 'function') ack({ ok: false, message });
      else socket.emit('error', { message });
    };
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) return refuse('Not authorized to moderate this discussion.');
      const { qr, layout, sort, questionType, pinnedFirst, questionId, beforeSnapshotId, afterSnapshotId } = settings && typeof settings === 'object' ? settings : {};
      // An id is left out to keep the stored one, null to clear it, or a
      // Postgres integer.
      const validId = id => id === undefined || id === null
        || (Number.isInteger(id) && id > 0 && id <= 2147483647);
      const given = [qr, layout, sort, questionType, pinnedFirst, questionId, beforeSnapshotId, afterSnapshotId].some(value => value !== undefined);
      if ((qr !== undefined && !DISPLAY_QR_MODES.includes(qr))
          || (layout !== undefined && !DISPLAY_LAYOUTS.includes(layout))
          || (sort !== undefined && !DISPLAY_SORTS.includes(sort))
          || (questionType !== undefined && questionType !== 'all' && !VALID_QUESTION_TYPES.has(questionType))
          || (pinnedFirst !== undefined && typeof pinnedFirst !== 'boolean')
          || ![questionId, beforeSnapshotId, afterSnapshotId].every(validId)
          || (beforeSnapshotId != null && afterSnapshotId != null && afterSnapshotId <= beforeSnapshotId)
          || !given) {
        return refuse('Unknown room display setting.');
      }
      const changed = await withTransaction(async client => {
        const current = await client.query(`SELECT display_before_snapshot_id, display_after_snapshot_id, display_hidden_question_ids,
                                                  display_layout, display_question_id FROM discussions WHERE id = $1 FOR UPDATE`, [discussionId]);
        if (!current.rows.length) return false;
        const effectiveBefore = beforeSnapshotId === undefined ? current.rows[0].display_before_snapshot_id : beforeSnapshotId;
        const effectiveAfter = afterSnapshotId === undefined ? current.rows[0].display_after_snapshot_id : afterSnapshotId;
        if ((beforeSnapshotId !== undefined || afterSnapshotId !== undefined)
            && effectiveBefore != null && effectiveAfter != null && effectiveAfter <= effectiveBefore) {
          refuse('Unknown room display setting.');
          return false;
        }
        if (questionId != null) {
          // Only a published question of this discussion can go on the display.
          const question = await client.query(
            'SELECT 1 FROM questions WHERE id = $1 AND discussion_id = $2 AND NOT queued',
            [questionId, discussionId]
          );
          if (!question.rows.length || current.rows[0].display_hidden_question_ids.includes(questionId)) {
            refuse('That question cannot be shown on the room display.');
            return;
          }
        }
        const snapshotIds = [beforeSnapshotId, afterSnapshotId].filter(id => id != null);
        if (snapshotIds.length) {
          const found = await client.query(
            'SELECT id FROM opinion_snapshots WHERE discussion_id = $1 AND id = ANY($2::int[])',
            [discussionId, snapshotIds]
          );
          if (found.rows.length !== snapshotIds.length) {
            refuse('That snapshot cannot be shown on the room display.');
            return;
          }
        }
        let requestedQuestion = questionId;
        const candidate = questionId === undefined ? current.rows[0].display_question_id : questionId;
        if ((layout ?? current.rows[0].display_layout) === 'compare' && candidate != null
            && !await comparisonIncludesQuestion(client, discussionId, effectiveBefore, effectiveAfter, candidate)) {
          if (questionId != null) {
            refuse('This question is not in the selected snapshots. Choose another question or switch to the One question layout to show it live.');
            return false;
          }
          requestedQuestion = null;
        }
        await client.query(
          `UPDATE discussions
              SET display_qr = COALESCE($1, display_qr),
                  display_layout = COALESCE($2, CASE
                    WHEN $4::int IS NOT NULL AND display_layout = 'all' THEN 'spotlight'
                    WHEN $5 AND $4::int IS NULL AND display_layout = 'spotlight' THEN 'all'
                    ELSE display_layout END),
                  display_question_id = CASE WHEN $5 THEN $4::int ELSE display_question_id END,
                  display_before_snapshot_id = CASE WHEN $7 THEN $6::int ELSE display_before_snapshot_id END,
                  display_after_snapshot_id = CASE WHEN $9 THEN $8::int ELSE display_after_snapshot_id END,
                  display_sort = COALESCE($10, display_sort),
                  display_pinned_first = COALESCE($11, display_pinned_first),
                  display_question_type = COALESCE($12, display_question_type)
            WHERE id = $3`,
          [
            qr ?? null, layout ?? null, discussionId,
            requestedQuestion ?? null, requestedQuestion !== undefined,
            beforeSnapshotId ?? null, beforeSnapshotId !== undefined,
            afterSnapshotId ?? null, afterSnapshotId !== undefined,
            sort ?? null, pinnedFirst ?? null, questionType ?? null,
          ]
        );
        return true;
      });
      if (changed) {
        await emitDiscussionState(discussionSlug);
        if (typeof ack === 'function') ack({ ok: true });
      }
    } catch (error) {
      logError('Error setting room display settings:', error);
      refuse('Failed to update discussion');
    }
  });

  socket.on('setQuestionHiddenOnDisplay', (topic, questionId, hidden, token) => asModerator(topic, token, {
    log: 'Error changing question visibility on the room display:', message: 'Failed to update discussion',
  }, async (slug, discussionId) => {
    if (!Number.isInteger(questionId) || questionId < 1 || questionId > 2147483647 || typeof hidden !== 'boolean') {
      return socket.emit('error', { message: 'Unknown room display setting.' });
    }
    const changed = await pool.query(
      `UPDATE discussions SET display_hidden_question_ids = CASE
          WHEN NOT $3 THEN array_remove(display_hidden_question_ids, $2)
          WHEN $2 = ANY(display_hidden_question_ids) THEN display_hidden_question_ids
          ELSE array_append(display_hidden_question_ids, $2) END,
        display_layout = CASE WHEN $3 AND display_question_id = $2 AND display_layout = 'spotlight' THEN 'all' ELSE display_layout END,
        display_question_id = CASE WHEN $3 AND display_question_id = $2 THEN NULL ELSE display_question_id END
       WHERE id = $1 AND EXISTS (SELECT 1 FROM questions WHERE discussion_id = $1 AND id = $2 AND NOT queued)`,
      [discussionId, questionId, hidden]
    );
    if (!changed.rowCount) return socket.emit('error', { message: 'That question is not available on the room display.' });
    await emitDiscussionState(slug);
  }));

  // Moderator-only: list the discussion publicly on the home page, or take it
  // off the list. Unlisted is the default; the link works either way.
  socket.on('setListed', (topic, listed, token) => asModerator(topic, token, {
    log: 'Error setting listed state:', message: 'Failed to update discussion',
  }, async (discussionSlug, discussionId) => {
    await pool.query('UPDATE discussions SET listed = $1 WHERE id = $2', [listed === true, discussionId]);
    await emitDiscussionState(discussionSlug);
  }));

  socket.on('setLocked', (topic, locked, token) => asModerator(topic, token, {
    log: 'Error setting lock state:', message: 'Failed to update discussion',
  }, async (discussionSlug, discussionId) => {
    await pool.query('UPDATE discussions SET locked = $1 WHERE id = $2', [!!locked, discussionId]);
    await emitDiscussionState(discussionSlug);
  }));

  const setPostingMode = (topic, mode, token) => asModerator(topic, token, {
    log: 'Error setting question posting mode:', message: 'Failed to update discussion',
  }, async (discussionSlug, discussionId) => {
    if (!POSTING_MODES.includes(mode)) {
      socket.emit('error', { message: 'Invalid question posting mode.' });
      return;
    }
    await pool.query('UPDATE discussions SET moderator_only_questions = $1, question_approval_required = $2 WHERE id = $3',
      [mode === 'moderator_only', mode === 'approval', discussionId]);
    await emitDiscussionState(discussionSlug);
  });
  socket.on('setPostingMode', setPostingMode);
  socket.on('setModeratorOnly', (topic, on, token) => setPostingMode(topic, on ? 'moderator_only' : 'open', token));

  // Moderator-only: set the discussion's color theme. The new theme rides the
  // discussionState broadcast, so every connected participant recolors at once.
  socket.on('setTheme', (topic, theme, token) => asModerator(topic, token, {
    log: 'Error setting theme:', message: 'Failed to update discussion',
  }, async (discussionSlug, discussionId) => {
    if (!ALLOWED_THEMES.includes(theme)) {
      socket.emit('error', { message: 'Unknown theme.' });
      return;
    }
    await pool.query('UPDATE discussions SET theme = $1 WHERE id = $2', [theme, discussionId]);
    await emitDiscussionState(discussionSlug);
  }));

  // Moderator-only: choose when participants see the results of tallied
  // questions (see RESULTS_VISIBILITY_MODES). The mode rides discussionState, and
  // the questions are sent again because what each participant may see changed.
  socket.on('setResultsVisibility', (topic, mode, token) => asModerator(topic, token, {
    log: 'Error setting results visibility:', message: 'Failed to update discussion',
  }, async (discussionSlug, discussionId) => {
    if (!RESULTS_VISIBILITY_MODES.includes(mode)) {
      socket.emit('error', { message: 'Unknown results setting.' });
      return;
    }
    await pool.query('UPDATE discussions SET results_visibility = $1 WHERE id = $2', [mode, discussionId]);
    await emitDiscussionState(discussionSlug);
    await emitQuestions(discussionSlug);
  }));

  // Moderator-only: rename the discussion (change its display title). Only the
  // `topic` column is touched — the slug is the stable identifier every
  // participant's URL and socket room is keyed on, so we deliberately leave it
  // unchanged. A rename therefore never invalidates existing links or evicts
  // anyone from the room. The new title is broadcast on the same `discussion`
  // channel that carries it on join, so every open tab updates live.
  socket.on('setTopic', async (topic, newTopic, token, ack) => {
    const discussionSlug = slugifyTopic(topic);
    const reply = (result) => { if (typeof ack === 'function') ack(result); };
    try {
      const outcome = await withTransaction(async client => {
        // Take the shared route lock and canonical slug lock before any row
        // access. Deletion either waits for this committed title, or wins and
        // the rename must report failure rather than updating a vanished row.
        if (await lockDiscussionSlug(client, discussionSlug)) return 'not_found';
        const discussionId = await verifyAdmin(discussionSlug, token, client);
        if (!discussionId) return 'not_authorized';
        // formatTopicTitle substitutes a placeholder for blank input.
        const title = formatTopicTitle(newTopic);
        if (!String(newTopic || '').trim() || title.length > MAX_TOPIC_LENGTH) return 'invalid';
        const updated = await client.query('UPDATE discussions SET topic = $1 WHERE id = $2', [title, discussionId]);
        return updated.rowCount === 1 ? 'updated' : 'not_found';
      });
      if (outcome !== 'updated') {
        if (outcome === 'not_authorized') socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        reply({ updated: false, reason: outcome });
        return;
      }
      await emitDiscussion(discussionSlug);
      reply({ updated: true });
    } catch (error) {
      // discussions.topic is unique (discussions_topic_unique); renaming to an
      // existing title raises a Postgres unique-violation. Surface it as a
      // distinct, actionable reason so the moderator can pick another name
      // instead of seeing a generic failure.
      if (error?.code === '23505') {
        reply({ updated: false, reason: 'duplicate' });
        return;
      }
      logError('Error setting topic:', error);
      socket.emit('error', { message: 'Failed to rename discussion' });
      reply({ updated: false, reason: 'error' });
    }
  });

  // Moderator-only: flip the discussion-wide interaction flags (allow/disallow
  // reactions, reveal/hide reactions, allow/disallow comments). These apply to
  // every brainstorm prompt at once so a moderator can phase the whole room —
  // read silently first, then open reactions, then open comments — rather than
  // toggling each question. Only known boolean flags are applied.
  socket.on('setDiscussionFlags', (topic, flags, token) => asModerator(topic, token, {
    log: 'Error setting discussion flags:', message: 'Failed to update discussion',
  }, async (discussionSlug, discussionId) => {
    const allowed = ['reactions_enabled', 'reactions_visible', 'comments_enabled', 'question_downvotes_enabled', 'hands_enabled'];
    const sets = [];
    const values = [];
    for (const key of allowed) {
      if (flags && Object.prototype.hasOwnProperty.call(flags, key)) {
        values.push(!!flags[key]);
        sets.push(`${key} = $${values.length}`);
      }
    }
    if (sets.length === 0) return;
    values.push(discussionId);
    await withTransaction(async client => {
      await client.query(
        `UPDATE discussions SET ${sets.join(', ')} WHERE id = $${values.length}`,
        values
      );
      if (flags.hands_enabled === false) {
        await client.query('DELETE FROM speaking_queue WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [discussionId]);
      }
    });
    // Re-broadcast both channels: discussionState drives the moderator's
    // toggle buttons, while the questions payload changes too (revealing or
    // hiding reactions/comments changes what attachBrainstormInteractions
    // includes for everyone).
    await emitDiscussionState(discussionSlug);
    await emitQuestions(discussionSlug);
  }));

  // Moderator-only: choose which epistemic reactions are active for the whole
  // discussion. The selection is stored as a subset of REACTION_CATALOG (keys
  // outside it are dropped); an all-empty selection is ignored so a session is
  // never left with reactions enabled but nothing to place. Broadcast via
  // discussionState so every connected client re-renders the set live.
  socket.on('setReactionKeys', (topic, keys, token) => asModerator(topic, token, {
    log: 'Error setting reaction keys:', message: 'Failed to update reactions',
  }, async (discussionSlug, discussionId) => {
    const filtered = Array.isArray(keys) ? REACTION_CATALOG.filter(k => keys.includes(k)) : [];
    if (filtered.length === 0) return;
    await pool.query(
      'UPDATE discussions SET reaction_keys = $1 WHERE id = $2',
      [JSON.stringify(filtered), discussionId]
    );
    await emitDiscussionState(discussionSlug);
  }));
}

module.exports = { registerDiscussionSettings };
