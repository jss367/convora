const { slugifyTopic } = require('./discussion-names');
const { AGREEMENT_OPTIONS } = require('./question-data');
const { bindSocketUser } = require('./participant-identity');
const { moderatorAction } = require('./moderator-roles');
const { logInfo } = require('./logging');

// Curated catalog of epistemic reactions the system knows how to render. The
// keys are stable and the client owns their display labels; the server keeps
// this list purely as the validation allowlist (a key outside it is never
// accepted). A discussion's creator may narrow which of these are active for
// their session — see reaction_keys / resolveReactionKeys.
const REACTION_CATALOG = [
  'changed-mind',
  'crux',
  'follows',
  'citation-needed',
  'key-insight',
];

// Reactions a discussion starts with before its creator customizes the set
// (reaction_keys IS NULL) — currently the whole catalog.
const DEFAULT_REACTION_KEYS = REACTION_CATALOG;

// Resolve a discussion's stored reaction_keys (raw JSONB, possibly null) into an
// ordered, validated list of active reaction keys. Null/empty/all-invalid falls
// back to the defaults; otherwise the stored selection is filtered to the
// catalog and re-ordered to match it, so every client renders the same order.
function resolveReactionKeys(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_REACTION_KEYS];
  const selected = new Set(raw);
  const resolved = REACTION_CATALOG.filter(k => selected.has(k));
  return resolved.length > 0 ? resolved : [...DEFAULT_REACTION_KEYS];
}

// Set or clear one axis of a user's rating on a brainstorm response. Upserts so
// the two axes (quality, agreement) can be set independently; passing null
// clears that axis (e.g. un-clicking the up arrow).
async function setResponseRating(client, responseId, userId, axis, value) {
  if (axis === 'quality') {
    const quality = value === 1 || value === -1 ? value : null;
    // Share the legacy toggle lock so mixed old/new clients cannot leave
    // the two representations at different states.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`response_vote:${responseId}:${userId}`]);
    await client.query(
      `INSERT INTO response_ratings (response_id, user_id, quality) VALUES ($1, $2, $3)
       ON CONFLICT (response_id, user_id) DO UPDATE SET quality = EXCLUDED.quality`,
      [responseId, userId, quality]
    );
    if (quality === 1) {
      await client.query('INSERT INTO response_votes (response_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [responseId, userId]);
    } else {
      await client.query('DELETE FROM response_votes WHERE response_id = $1 AND user_id = $2', [responseId, userId]);
    }
  } else if (axis === 'agreement') {
    const agreement = AGREEMENT_OPTIONS.includes(value) ? value : null;
    await client.query(
      `INSERT INTO response_ratings (response_id, user_id, agreement) VALUES ($1, $2, $3)
       ON CONFLICT (response_id, user_id) DO UPDATE SET agreement = EXCLUDED.agreement`,
      [responseId, userId, agreement]
    );
  }
}

// Toggle a single epistemic reaction for a user on a response: remove it if
// present, add it otherwise.
async function toggleResponseReaction(client, responseId, userId, reaction) {
  // Serialize concurrent toggles of the same reaction (see toggleResponseVote);
  // the advisory lock is keyed on (response, user, reaction) so it also closes
  // the absent-row race a bare transaction leaves open.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`response_reaction:${responseId}:${userId}:${reaction}`]);
  const deleteResult = await client.query(
    'DELETE FROM response_reactions WHERE response_id = $1 AND user_id = $2 AND reaction = $3',
    [responseId, userId, reaction]
  );
  if (deleteResult.rowCount === 0) {
    await client.query(
      'INSERT INTO response_reactions (response_id, user_id, reaction) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [responseId, userId, reaction]
    );
  }
}

function createResponseInteractions({ pool, withTransaction }) {
  // Toggle a user's upvote on an open-ended response. Adds the upvote if absent,
  // removes it if already present.
  async function toggleResponseVote(topic, responseId, userId) {
    const slug = slugifyTopic(topic);
    return withTransaction(async client => {
      // Hold the discussion row while checking the lock and writing feedback,
      // so a waiting toggle sees committed lock and feedback-setting changes.
      const ownerResult = await client.query(
        `SELECT v.user_id
         FROM votes v
         JOIN questions q ON v.question_id = q.id
         JOIN discussions d ON q.discussion_id = d.id
         WHERE v.id = $1 AND d.slug = $2 AND NOT d.locked
           AND (NOT q.independent_answers OR q.results_revealed)
           AND d.reactions_enabled AND d.reactions_visible FOR SHARE OF d, q`,
        [responseId, slug]
      );
      if (ownerResult.rows.length === 0) {
        return;
      }
      // Reject self-upvotes: the UI disables the button for your own response, but
      // the event can still be emitted from the console, so enforce it server-side.
      if (ownerResult.rows[0].user_id === userId) {
        logInfo('Ignoring self-upvote on response', responseId);
        return;
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`response_vote:${responseId}:${userId}`]);
      const deleteResult = await client.query(
        'DELETE FROM response_votes WHERE response_id = $1 AND user_id = $2',
        [responseId, userId]
      );
      if (deleteResult.rowCount === 0) {
        await client.query(
          'INSERT INTO response_votes (response_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [responseId, userId]
        );
      }
      // Old browsers can still toggle upvotes after migration. Keep the quality
      // axis in sync in this transaction without touching the agreement axis.
      await client.query(
        `INSERT INTO response_ratings (response_id, user_id, quality) VALUES ($1, $2, $3)
         ON CONFLICT (response_id, user_id) DO UPDATE SET quality = EXCLUDED.quality`,
        [responseId, userId, deleteResult.rowCount === 0 ? 1 : null]
      );
    });
  }

  // Look up a brainstorm response within a topic and return its owner plus the
  // discussion's interaction flags. Returns null when the response doesn't
  // belong to the topic, so callers reject forged/cross-topic response ids.
  async function getResponseContext(topic, responseId, { client = pool, lockDiscussion = false } = {}) {
    const slug = slugifyTopic(topic);
    const result = await client.query(
      `SELECT v.user_id, q.discussion_id, q.type, d.reactions_enabled, d.reactions_visible, d.comments_enabled, d.locked, d.reaction_keys
       FROM votes v
       JOIN questions q ON v.question_id = q.id
       JOIN discussions d ON q.discussion_id = d.id
       WHERE v.id = $1 AND d.slug = $2 AND (NOT q.independent_answers OR q.results_revealed)
       ${lockDiscussion ? 'FOR SHARE OF d, q' : ''}`,
      [responseId, slug]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      ownerId: row.user_id,
      discussionId: row.discussion_id,
      type: row.type,
      reactionsEnabled: row.reactions_enabled === true,
      reactionsVisible: row.reactions_visible === true,
      commentsEnabled: row.comments_enabled === true,
      locked: row.locked === true,
      reactionKeys: resolveReactionKeys(row.reaction_keys),
    };
  }

  // A user's own ratings and reactions across a whole discussion, so the client
  // can restore which buttons it had selected after a reload. This is the only
  // path that returns per-user selections, and it's scoped to the requesting
  // user's own rows — never another participant's.
  async function getMyBrainstormState(topic, userId) {
    const ratings = {};
    const reactions = {};
    if (!userId) return { ratings, reactions };
    const slug = slugifyTopic(topic);

    const ratingResult = await pool.query(
      `SELECT rr.response_id, rr.quality, rr.agreement
       FROM response_ratings rr
       JOIN votes v ON rr.response_id = v.id
       JOIN questions q ON v.question_id = q.id
       JOIN discussions d ON q.discussion_id = d.id
       WHERE d.slug = $1 AND rr.user_id = $2 AND (NOT q.independent_answers OR q.results_revealed)`,
      [slug, userId]
    );
    for (const row of ratingResult.rows) {
      ratings[row.response_id] = { quality: row.quality, agreement: row.agreement };
    }

    const reactionResult = await pool.query(
      `SELECT react.response_id, react.reaction
       FROM response_reactions react
       JOIN votes v ON react.response_id = v.id
       JOIN questions q ON v.question_id = q.id
       JOIN discussions d ON q.discussion_id = d.id
       WHERE d.slug = $1 AND react.user_id = $2 AND (NOT q.independent_answers OR q.results_revealed)`,
      [slug, userId]
    );
    for (const row of reactionResult.rows) {
      (reactions[row.response_id] = reactions[row.response_id] || []).push(row.reaction);
    }

    return { ratings, reactions };
  }

  return { toggleResponseVote, getResponseContext, getMyBrainstormState };
}

function registerResponseInteractions(socket, {
  pool, withTransaction, verifyAdmin, toggleResponseVote, getResponseContext, getMyBrainstormState,
  canonicalPseudonym, emitQuestions, logError,
}) {
  const asModerator = moderatorAction(socket, { verifyAdmin, logError });

  socket.on('toggleResponseVote', async (topic, responseId, claimedUserId) => {
    const discussionSlug = slugifyTopic(topic);
    const userId = bindSocketUser(socket, claimedUserId);
    if (!userId) return;
    try {
      await toggleResponseVote(discussionSlug, responseId, userId);
      await emitQuestions(discussionSlug);
    } catch (error) {
      logError('Error toggling response vote:', error);
      socket.emit('error', { message: 'Failed to upvote response' });
    }
  });

  // Set/clear one axis (quality or agreement) of a user's rating on a brainstorm
  // idea. Gated on the question being a Brainstorm with reactions currently
  // revealed, so a hidden/disabled phase can't be rated through a crafted event.
  socket.on('setResponseRating', async (topic, responseId, axis, value, claimedUserId, ack) => {
    const discussionSlug = slugifyTopic(topic);
    const reply = updated => { if (typeof ack === 'function') ack({ updated }); };
    const userId = bindSocketUser(socket, claimedUserId);
    if (!userId) { reply(false); return; }
    try {
      if (axis !== 'quality' && axis !== 'agreement') { reply(false); return; }
      const changed = await withTransaction(async client => {
        const ctx = await getResponseContext(topic, responseId, { client, lockDiscussion: true });
        if (!ctx || ctx.locked || !['Open Ended', 'Brainstorm'].includes(ctx.type) || !ctx.reactionsEnabled || !ctx.reactionsVisible) return false;
        if (ctx.ownerId === userId) return false;
        await setResponseRating(client, responseId, userId, axis, value);
        return true;
      });
      reply(changed);
      if (!changed) return;
      await emitQuestions(discussionSlug);
    } catch (error) {
      logError('Error setting response rating:', error);
      reply(false);
      socket.emit('error', { message: 'Failed to rate response' });
    }
  });

  socket.on('toggleResponseReaction', async (topic, responseId, reaction, claimedUserId) => {
    const discussionSlug = slugifyTopic(topic);
    const userId = bindSocketUser(socket, claimedUserId);
    if (!userId) return;
    try {
      const changed = await withTransaction(async client => {
        const ctx = await getResponseContext(topic, responseId, { client, lockDiscussion: true });
        if (!ctx || ctx.locked || !['Open Ended', 'Brainstorm'].includes(ctx.type) || !ctx.reactionsEnabled || !ctx.reactionsVisible) return false;
        if (!ctx.reactionKeys.includes(reaction) || ctx.ownerId === userId) return false;
        await toggleResponseReaction(client, responseId, userId, reaction);
        return true;
      });
      if (!changed) return;
      await emitQuestions(discussionSlug);
    } catch (error) {
      logError('Error toggling response reaction:', error);
      socket.emit('error', { message: 'Failed to react to response' });
    }
  });

  socket.on('addResponseComment', async (topic, responseId, body, claimedUserId, pseudonym, mode, ack) => {
    // Back-compat: pre-#57 clients used (topic, responseId, body, userId,
    // pseudonym, ack) with no mode, so their ack arrives bound to `mode`. Detect
    // that and shift it back, leaving mode undefined (store-as-sent behavior).
    if (typeof mode === 'function' && ack === undefined) {
      ack = mode;
      mode = undefined;
    }
    const discussionSlug = slugifyTopic(topic);
    const reply = (result) => { if (typeof ack === 'function') ack(result); };
    const userId = bindSocketUser(socket, claimedUserId);
    if (!userId) {
      reply({ added: false });
      return;
    }
    try {
      const ctx = await getResponseContext(topic, responseId);
      // A locked discussion has new statements closed; comments are statements.
      if (!ctx || ctx.locked || !['Open Ended', 'Brainstorm'].includes(ctx.type) || !ctx.commentsEnabled) {
        reply({ added: false });
        return;
      }
      const text = String(body || '').trim();
      if (!text) {
        reply({ added: false });
        return;
      }
      // Persist the reserved handle in pseudonym mode rather than the client's
      // (possibly pre-reservation, colliding) local pick — see canonicalPseudonym.
      // Custom/Anonymous stay as sent. canonicalPseudonym also sanitizes (trim +
      // length cap) so a crafted oversized/whitespace name can't break the UI.
      const handle = await canonicalPseudonym(discussionSlug, ctx.discussionId, userId, mode, pseudonym);
      const added = await withTransaction(async client => {
        // Resolve the pseudonym before taking this transaction's row lock, then
        // recheck current authorization/flags while holding the lock through write.
        const current = await getResponseContext(topic, responseId, { client, lockDiscussion: true });
        if (!current || current.locked || !['Open Ended', 'Brainstorm'].includes(current.type) || !current.commentsEnabled) return false;
        await client.query(
          'INSERT INTO response_comments (response_id, user_id, pseudonym, body) VALUES ($1, $2, $3, $4)',
          [responseId, userId, handle, text.slice(0, 2000)]
        );
        return true;
      });
      if (!added) {
        reply({ added: false });
        return;
      }
      await emitQuestions(discussionSlug);
      reply({ added: true });
    } catch (error) {
      logError('Error adding response comment:', error);
      socket.emit('error', { message: 'Failed to add comment' });
      reply({ added: false });
    }
  });

  // Delete a comment. Scoped through the discussion and to the comment's own
  // author, so a participant can only remove their own comments.
  socket.on('deleteResponseComment', async (topic, commentId, claimedUserId) => {
    const discussionSlug = slugifyTopic(topic);
    const userId = bindSocketUser(socket, claimedUserId);
    if (!userId) return;
    try {
      await pool.query(
        `DELETE FROM response_comments c
         USING votes v, questions q, discussions d
         WHERE c.id = $1 AND c.user_id = $2
           AND (NOT q.independent_answers OR q.results_revealed)
           AND c.response_id = v.id AND v.question_id = q.id AND q.discussion_id = d.id
           AND d.slug = $3`,
        [commentId, userId, discussionSlug]
      );
      await emitQuestions(discussionSlug);
    } catch (error) {
      logError('Error deleting response comment:', error);
      socket.emit('error', { message: 'Failed to delete comment' });
    }
  });

  // Moderator-only: remove any participant's comment (spam control). Scoped
  // through the discussion so a moderator of one discussion can't reach another
  // discussion's comments. Mirrors the author-only deleteResponseComment above.
  socket.on('moderatorDeleteResponseComment', (topic, commentId, token) => asModerator(topic, token, {
    log: 'Error deleting comment (moderator):', message: 'Failed to delete comment',
  }, async (discussionSlug, discussionId) => {
    await pool.query(
      `DELETE FROM response_comments c
       USING votes v, questions q
       WHERE c.id = $1
         AND c.response_id = v.id AND v.question_id = q.id
         AND q.discussion_id = $2`,
      [commentId, discussionId]
    );
    await emitQuestions(discussionSlug);
  }));

  // Return the requesting user's own ratings/reactions so the client can restore
  // its selected state after a reload or reconnect.
  socket.on('getBrainstormState', async (topic, claimedUserId, ack) => {
    const userId = bindSocketUser(socket, claimedUserId);
    try {
      const state = await getMyBrainstormState(topic, userId);
      if (typeof ack === 'function') ack(state);
    } catch (error) {
      logError('Error fetching brainstorm state:', error);
      if (typeof ack === 'function') ack({ ratings: {}, reactions: {} });
    }
  });

  socket.on('deleteVote', async (topic, voteId, claimedUserId) => {
    const discussionSlug = slugifyTopic(topic);
    const userId = bindSocketUser(socket, claimedUserId);
    if (!userId) return;
    try {
      await pool.query(`DELETE FROM votes v USING questions q, discussions d
        WHERE v.id = $1 AND v.user_id = $2 AND v.question_id = q.id AND q.discussion_id = d.id
          AND d.slug = $3 AND NOT d.locked AND q.type IN ('Open Ended', 'Brainstorm')`, [voteId, userId, discussionSlug]);
      await emitQuestions(discussionSlug);
    } catch (error) {
      logError('Error deleting vote:', error);
      socket.emit('error', { message: 'Failed to delete vote' });
    }
  });

  // Moderator-only: remove any participant's response/idea (a votes row),
  // regardless of who authored it (spam control). Scoped through the discussion
  // so a moderator can't reach another discussion's responses by passing a
  // foreign voteId. Dependent ratings/reactions/comments/upvotes cascade away
  // via their ON DELETE CASCADE foreign keys on votes(id).
  socket.on('moderatorDeleteVote', (topic, voteId, token) => asModerator(topic, token, {
    log: 'Error deleting response (moderator):', message: 'Failed to delete response',
  }, async (discussionSlug, discussionId) => {
    // Scope deletes to written-response question types only. The feature
    // exists to remove spammy free text (Open Ended responses, Brainstorm
    // ideas), and the UI only surfaces the "Remove" control for those. Poll
    // and scale votes (Agreement, Numerical) are aggregate data, not
    // spammable free text — deleting one would silently distort the results,
    // so we forbid it server-side even though every vote id is broadcast in
    // getQuestions and a moderator could otherwise target a poll vote id
    // directly from the console.
    await pool.query(
      `DELETE FROM votes
       WHERE id = $1
         AND question_id IN (
           SELECT id FROM questions
           WHERE discussion_id = $2
             AND type IN ('Open Ended', 'Brainstorm')
         )`,
      [voteId, discussionId]
    );
    await emitQuestions(discussionSlug);
  }));
}

module.exports = {
  REACTION_CATALOG, DEFAULT_REACTION_KEYS, resolveReactionKeys,
  createResponseInteractions, registerResponseInteractions,
};
