const crypto = require('crypto');
const { slugifyTopic, titleFromSlug } = require('./discussion-names');
const { lockDiscussionSlug } = require('./discussions');

// An opaque, stable handle for a participant: a hash of their user_id, so it
// stays bound to the same user no matter how the list reorders or who drops
// out. This lets the moderator UI refer to users without ever receiving the
// raw user_id (which doubles as the vote-ownership secret), and means a stale
// UI promotes the user it displayed — never whoever now sits at that position.
function participantHandle(userId) {
  return `participant-${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16)}`;
}

function createModeratorRoles(pool) {
  // Verify that the supplied token grants moderation of this discussion. A token
  // is valid if it's the discussion's creator admin_token OR a per-user token
  // granted to a promoted moderator (discussion_moderators). Returns the
  // discussion id when valid, or null otherwise.
  async function verifyAdmin(topic, token, db = pool) {
    if (!token) return null;
    const slug = slugifyTopic(topic);
    const result = await db.query(
      `SELECT d.id
         FROM discussions d
        WHERE d.slug = $1
          AND (
            d.admin_token = $2
            OR EXISTS (
              SELECT 1 FROM discussion_moderators m
               WHERE m.discussion_id = d.id AND m.token = $2
            )
          )`,
      [slug, token]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  }

  // Verify that the supplied token is specifically the discussion's *creator*
  // token (admin_token), not a per-user grant. Returns the discussion id when it
  // is, else null. Used to gate creator-only actions like removing a moderator,
  // so promoted moderators can't revoke each other or the creator.
  async function verifyCreator(topic, token) {
    if (!token) return null;
    const slug = slugifyTopic(topic);
    const result = await pool.query(
      'SELECT id FROM discussions WHERE slug = $1 AND admin_token = $2',
      [slug, token]
    );
    return result.rows.length > 0 ? result.rows[0].id : null;
  }

  // First-come moderator claim: assigns a fresh admin token only if the
  // discussion has none yet. Returns the token, or null if already claimed.
  // The advisory lock serializes moderator claims for the same topic; the upsert
  // also keeps the claim race-safe against non-moderator topic creation paths.
  async function claimModerator(topic) {
    const slug = slugifyTopic(topic);
    const token = crypto.randomBytes(16).toString('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [slug]);
      if (await lockDiscussionSlug(client, slug)) {
        await client.query('COMMIT');
        return null;
      }

      const claim = await client.query(
        `INSERT INTO discussions (topic, slug, admin_token)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE
         SET admin_token = COALESCE(discussions.admin_token, EXCLUDED.admin_token)
         WHERE discussions.admin_token IS NULL
         RETURNING admin_token`,
        [titleFromSlug(slug), slug, token]
      );

      await client.query('COMMIT');
      return claim.rows.length > 0 ? claim.rows[0].admin_token : null;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // The discussion's participants: everyone who has cast a vote or written a
  // response (the only users the server can identify, since there are no
  // accounts and presence is anonymous). Ordered by first activity for a stable
  // display order. Returns rows of { id, userId, pseudonym, isModerator }.
  async function getParticipants(topic) {
    const slug = slugifyTopic(topic);
    const result = await pool.query(
      `SELECT v.user_id,
              MIN(v.created_at) AS first_seen,
              (ARRAY_AGG(v.pseudonym ORDER BY v.id DESC))[1] AS pseudonym,
              BOOL_OR(m.user_id IS NOT NULL) AS is_moderator
         FROM votes v
         JOIN questions q ON v.question_id = q.id
         JOIN discussions d ON q.discussion_id = d.id
         LEFT JOIN discussion_moderators m
                ON m.discussion_id = d.id AND m.user_id = v.user_id
        WHERE d.slug = $1 AND v.user_id IS NOT NULL
        GROUP BY v.user_id
        ORDER BY MIN(v.created_at), v.user_id`,
      [slug]
    );
    const participants = result.rows.map((row) => ({
      id: participantHandle(row.user_id),
      userId: row.user_id,
      pseudonym: row.pseudonym || 'Anonymous',
      isModerator: row.is_moderator === true,
    }));

    // Include moderators who no longer have any votes — e.g. they were promoted
    // after posting a Brainstorm idea, then deleted it. The list above is derived
    // from votes, so without this they'd vanish from it while keeping a valid
    // token, leaving the creator no row (and no way) to remove them. Append them
    // after the voters so they can still be demoted.
    const seen = new Set(participants.map((p) => p.userId));
    const mods = await pool.query(
      `SELECT m.user_id
         FROM discussion_moderators m
         JOIN discussions d ON m.discussion_id = d.id
        WHERE d.slug = $1
        ORDER BY m.id`,
      [slug]
    );
    for (const row of mods.rows) {
      if (!seen.has(row.user_id)) {
        seen.add(row.user_id);
        participants.push({
          id: participantHandle(row.user_id),
          userId: row.user_id,
          pseudonym: 'Anonymous',
          isModerator: true,
        });
      }
    }
    return participants;
  }

  // The moderator-facing view of getParticipants: opaque handle, display name,
  // and whether they already moderate — never the raw user_id.
  async function listParticipants(topic) {
    const participants = await getParticipants(topic);
    return participants.map(({ id, pseudonym, isModerator }) => ({ id, pseudonym, isModerator }));
  }

  // Resolve an opaque participant handle back to its user_id. Because the handle
  // is a hash of the user_id (not a position), this matches the exact user the
  // moderator selected even if the list has since reordered; it returns null when
  // that user is no longer a participant (e.g. they removed their only response).
  async function resolveParticipant(topic, participantId) {
    const participants = await getParticipants(topic);
    return participants.find(p => p.id === participantId) || null;
  }

  // Promote a user to moderator by minting them a personal token (idempotent: a
  // user already promoted keeps their existing token). Returns the token plus
  // whether this call newly created the grant (vs. the user already being a
  // moderator), so the caller can roll back a brand-new grant that couldn't be
  // delivered.
  async function promoteModerator(discussionId, userId) {
    const token = crypto.randomBytes(16).toString('hex');
    const result = await pool.query(
      `INSERT INTO discussion_moderators (discussion_id, user_id, token)
       VALUES ($1, $2, $3)
       ON CONFLICT (discussion_id, user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING token, (xmax = 0) AS inserted`,
      [discussionId, userId, token]
    );
    return { token: result.rows[0].token, inserted: result.rows[0].inserted === true };
  }

  // Remove a user's moderator grant for a discussion.
  async function revokeModerator(discussionId, userId) {
    await pool.query(
      'DELETE FROM discussion_moderators WHERE discussion_id = $1 AND user_id = $2',
      [discussionId, userId]
    );
  }

  return {
    verifyAdmin, verifyCreator, claimModerator, listParticipants, resolveParticipant,
    promoteModerator, revokeModerator,
  };
}

// The shared shape of a moderator-only socket event that reports problems with
// 'error' events instead of an acknowledgment: check the token, refuse with the
// message every moderator control uses, and on failure log `log` and emit
// `message`. `work(slug, discussionId)` does the rest.
function moderatorAction(socket, { verifyAdmin, logError }) {
  return async (topic, token, { log, message }, work) => {
    const slug = slugifyTopic(topic);
    try {
      const discussionId = await verifyAdmin(slug, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        return;
      }
      await work(slug, discussionId);
    } catch (error) {
      logError(log, error);
      socket.emit('error', { message });
    }
  };
}

function registerModeratorRoles(socket, {
  claimModerator, verifyAdmin, verifyCreator, listParticipants, resolveParticipant, promoteModerator,
  revokeModerator, deliverModeratorToken, revokeModeratorToken, emitDiscussion, emitDiscussionState,
  emitQuestions, resendQuestionsIfPersonalized, logError,
}) {
  // First-come moderator claim. Replies via ack callback with the admin token.
  socket.on('claimModerator', async (topic, cb) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const token = await claimModerator(discussionSlug);
      if (token) {
        if (typeof cb === 'function') cb({ success: true, token });
        await emitDiscussion(discussionSlug);
        await emitDiscussionState(discussionSlug);
        // This socket now holds the moderator token, so it gets the moderator's
        // view of the questions (see checkModerator).
        socket.data.moderator = { slug: discussionSlug, token };
        if (socket.data.topic === discussionSlug) await resendQuestionsIfPersonalized(socket);
      } else if (typeof cb === 'function') {
        cb({ success: false, error: 'already_claimed' });
      }
    } catch (error) {
      logError('Error claiming moderator:', error);
      if (typeof cb === 'function') cb({ success: false, error: 'server_error' });
    }
  });

  // Moderator-only: list the discussion's participants (opaque handle +
  // pseudonym + whether they already moderate) so a moderator can pick someone
  // to promote. Raw user_ids are never sent to the client.
  socket.on('listParticipants', async (topic, token, cb) => {
    if (typeof cb !== 'function') return;
    const discussionSlug = slugifyTopic(topic);
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) {
        cb({ success: false, error: 'not_authorized' });
        return;
      }
      // canDemote tells the UI whether to offer "Remove" — only the creator may.
      const canDemote = !!(await verifyCreator(discussionSlug, token));
      cb({ success: true, participants: await listParticipants(discussionSlug), canDemote });
    } catch (error) {
      logError('Error listing participants:', error);
      cb({ success: false, error: 'server_error' });
    }
  });

  // Moderator-only: promote a participant (named by their opaque handle) to
  // moderator. Mints them a personal token, delivers it live to their connected
  // sockets, and returns the refreshed participant list.
  socket.on('promoteModerator', async (topic, token, participantId, cb) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) {
        if (typeof cb === 'function') cb({ success: false, error: 'not_authorized' });
        return;
      }
      const target = await resolveParticipant(discussionSlug, participantId);
      if (!target) {
        // The handle no longer maps to a participant (e.g. the list shifted).
        if (typeof cb === 'function') cb({ success: false, error: 'unknown_participant' });
        return;
      }
      const { token: grantedToken, inserted } = await promoteModerator(discussionId, target.userId);
      const delivered = deliverModeratorToken(discussionSlug, target.userId, grantedToken);
      // A token can only reach a user via a live push (we never re-deliver from a
      // client-supplied id). If this call newly granted moderation but the user
      // isn't connected to receive it, roll the grant back rather than leaving
      // them marked as a moderator with a token they can never obtain.
      if (inserted && delivered === 0) {
        await revokeModerator(discussionId, target.userId);
        if (typeof cb === 'function') cb({ success: false, error: 'participant_offline' });
        return;
      }
      await emitDiscussionState(discussionSlug);
      if (typeof cb === 'function') {
        const canDemote = !!(await verifyCreator(discussionSlug, token));
        cb({ success: true, participants: await listParticipants(discussionSlug), canDemote });
      }
    } catch (error) {
      logError('Error promoting moderator:', error);
      if (typeof cb === 'function') cb({ success: false, error: 'server_error' });
    }
  });

  // Creator-only: remove a participant's moderator status (e.g. it was granted
  // by mistake). Gated by verifyCreator so promoted moderators can't revoke each
  // other or the creator. Takes effect immediately server-side — the grant is
  // deleted, so verifyAdmin rejects that token on the next action even if the
  // user is offline; the live moderatorRevoked push just updates their UI.
  socket.on('demoteModerator', async (topic, token, participantId, cb) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const discussionId = await verifyCreator(discussionSlug, token);
      if (!discussionId) {
        if (typeof cb === 'function') cb({ success: false, error: 'not_authorized' });
        return;
      }
      const target = await resolveParticipant(discussionSlug, participantId);
      if (!target) {
        if (typeof cb === 'function') cb({ success: false, error: 'unknown_participant' });
        return;
      }
      await revokeModerator(discussionId, target.userId);
      revokeModeratorToken(discussionSlug, target.userId);
      await emitDiscussionState(discussionSlug);
      // The revoked token no longer grants the full results view.
      await emitQuestions(discussionSlug);
      if (typeof cb === 'function') {
        cb({ success: true, participants: await listParticipants(discussionSlug), canDemote: true });
      }
    } catch (error) {
      logError('Error demoting moderator:', error);
      if (typeof cb === 'function') cb({ success: false, error: 'server_error' });
    }
  });

  // Let a client confirm a stored moderator token is still valid. Used on load
  // so a token revoked while the user was offline (they never got
  // moderatorRevoked) is cleared instead of rendering a dead moderator UI.
  // ok:false signals a server error so the client keeps the token rather than
  // dropping a possibly-valid one on a transient failure.
  socket.on('checkModerator', async (topic, token, cb) => {
    if (typeof cb !== 'function') return;
    try {
      const slug = slugifyTopic(topic);
      const discussionId = await verifyAdmin(slug, token);
      // isCreator distinguishes the discussion's admin_token from a per-user
      // moderator grant. The client uses it to initialize canDemote on load so a
      // creator who hasn't opened the participant panel still won't have their
      // creator token clobbered by a pushed moderatorGranted token.
      const isCreator = discussionId ? !!(await verifyCreator(slug, token)) : false;
      // Remember the proven token so this socket receives the moderator's view
      // of the questions (results are never hidden from moderators). The token
      // is checked again whenever questions are sent, so revoking it ends that.
      const wasModerator = socket.data.moderator?.slug === slug;
      if (discussionId) {
        socket.data.moderator = { slug, token };
      } else if (wasModerator) {
        socket.data.moderator = null;
      }
      cb({ ok: true, isModerator: !!discussionId, isCreator });
      if ((discussionId || wasModerator) && socket.data.topic === slug) {
        await resendQuestionsIfPersonalized(socket);
      }
    } catch (error) {
      logError('Error checking moderator status:', error);
      cb({ ok: false });
    }
  });
}

module.exports = { createModeratorRoles, moderatorAction, registerModeratorRoles };
