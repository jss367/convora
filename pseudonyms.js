const { slugifyTopic } = require('./discussion-names');
const { bindSocketUser } = require('./participant-identity');

// Clients pick their own display name (a pseudonym, "Anonymous", or a typed-in
// name), so clamp it defensively: a name is at most 40 chars and we never store
// an empty string (let it fall back to the display layer's 'Anonymous').
const MAX_PSEUDONYM_LENGTH = 40;
function sanitizePseudonym(pseudonym) {
  if (typeof pseudonym !== 'string') return null;
  const trimmed = pseudonym.trim().slice(0, MAX_PSEUDONYM_LENGTH);
  return trimmed || null;
}

// The one name mode the server arbitrates. MUST match NameModes.PSEUDONYM in
// client/src/identity.js. The other modes ('custom', 'anonymous') are deliberate
// user choices the server stores verbatim, so only this one needs a constant.
const NAME_MODE_PSEUDONYM = 'pseudonym';

// Pool of friendly handles. MUST stay in sync with the ADJECTIVES/ANIMALS lists
// in client/src/identity.js — the client generates a candidate from these and
// the server hands out alternates from the same pool on collision, so a name a
// participant sees locally is one the server also knows how to deconflict.
// (Duplicated rather than shared because the server is CommonJS and the client
// is an ESM/Vite bundle, same as ownerToken() in participant-identity.js.)
const PSEUDONYM_ADJECTIVES = [
  'Happy', 'Brave', 'Clever', 'Gentle', 'Swift', 'Mighty', 'Curious', 'Calm',
  'Bold', 'Bright', 'Cheerful', 'Daring', 'Eager', 'Fierce', 'Friendly', 'Jolly',
  'Kind', 'Lively', 'Loyal', 'Lucky', 'Merry', 'Nimble', 'Noble', 'Plucky',
  'Proud', 'Quick', 'Quiet', 'Sleepy', 'Sly', 'Snappy', 'Sunny', 'Witty',
  'Zesty', 'Breezy', 'Cozy', 'Dapper', 'Fuzzy', 'Glad', 'Hardy', 'Humble',
  'Jazzy', 'Keen', 'Mellow', 'Peppy', 'Rosy', 'Spry', 'Tidy', 'Wise',
];
const PSEUDONYM_ANIMALS = [
  'Badger', 'Otter', 'Fox', 'Falcon', 'Panda', 'Heron', 'Lynx', 'Moose',
  'Beaver', 'Bison', 'Cobra', 'Crane', 'Dingo', 'Eagle', 'Ferret', 'Gecko',
  'Hawk', 'Ibis', 'Jaguar', 'Koala', 'Lemur', 'Marmot', 'Newt', 'Ocelot',
  'Puffin', 'Quokka', 'Raccoon', 'Salmon', 'Tapir', 'Urchin', 'Viper', 'Walrus',
  'Yak', 'Zebra', 'Wombat', 'Stoat', 'Robin', 'Possum', 'Mink', 'Lark',
  'Kestrel', 'Hare', 'Gull', 'Finch', 'Egret', 'Civet', 'Bat', 'Antelope',
];

function randomPseudonym() {
  const adjective = PSEUDONYM_ADJECTIVES[Math.floor(Math.random() * PSEUDONYM_ADJECTIVES.length)];
  const animal = PSEUDONYM_ANIMALS[Math.floor(Math.random() * PSEUDONYM_ANIMALS.length)];
  return `${adjective} ${animal}`;
}

// Every adjective-animal combination, in order — used as a guaranteed-coverage
// fallback when random probing keeps hitting names already taken in a crowded
// discussion, so we always find a free one if any remain.
function* allPseudonyms() {
  for (const adjective of PSEUDONYM_ADJECTIVES) {
    for (const animal of PSEUDONYM_ANIMALS) {
      yield `${adjective} ${animal}`;
    }
  }
}

function createPseudonyms(pool) {
  // Resolve the display name to actually persist on a vote/comment. For pseudonym
  // mode we trust the RESERVED handle in discussion_pseudonyms over the name the
  // client sent, closing the submit-before-reservation race (#57): on joining an
  // existing discussion there's a brief window where the client falls back to its
  // unreserved local pick, and if that pick collides with a handle already taken in
  // the discussion the row would otherwise persist a visible duplicate.
  //
  // The common case is a cheap lookup: the join-time reservation already exists, so
  // we store it. The hard case is the actual race — the vote/comment beat the
  // requestPseudonym round-trip, so no row exists yet. We must NOT fall back to the
  // client value here: that value may be the colliding pick, and the client's later
  // updateDisplayName reconciliation can interleave BEFORE this insert lands (socket
  // handlers aren't awaited in order), leaving exactly the duplicate this is meant to
  // prevent. Instead we create-and-await the reservation now via assignPseudonym,
  // which serializes with the in-flight requestPseudonym through the
  // discussion_pseudonyms unique constraint — whichever path inserts first wins and
  // the other returns the same row — so a unique handle is stored deterministically.
  //
  // Custom names and "Anonymous" are stored as-is (only sanitized). `mode` is
  // undefined for pre-#57 clients; those keep the old store-as-sent behavior.
  async function canonicalPseudonym(slug, discussionId, userId, mode, clientPseudonym) {
    const sanitized = sanitizePseudonym(clientPseudonym);
    if (mode !== NAME_MODE_PSEUDONYM || !discussionId || !userId) return sanitized;
    const existing = await pool.query(
      'SELECT pseudonym FROM discussion_pseudonyms WHERE discussion_id = $1 AND user_id = $2',
      [discussionId, userId]
    );
    if (existing.rows[0]) return existing.rows[0].pseudonym;
    // No reservation yet — create one now rather than trusting the client's pick.
    const { pseudonym } = await assignPseudonym(slug, userId, clientPseudonym);
    return pseudonym || sanitized;
  }

  // Claim `name` for (discussionId, userId). Returns the reserved name on success,
  // or null when `name` is already held by a DIFFERENT user in this discussion
  // (UNIQUE(discussion_id, pseudonym) violation), so the caller can try the next
  // candidate. The database, not a read-then-write in JS, is the arbiter of
  // uniqueness — that's what makes concurrent joins safe.
  //
  // Two conflict semantics on the (discussion_id, user_id) key:
  //   - overwrite:false (default, initial allocation) — FIRST-WINS. If this user
  //     already has a reservation (e.g. a racing vote and its own requestPseudonym
  //     both allocated), we keep the existing one and return it rather than
  //     replacing it. Replacing would let the loser clobber a handle the winner
  //     already acked to the client (and that the client may have used to rename
  //     its prior responses), splitting the user's name across responses (#58).
  //   - overwrite:true (the regenerate/shuffle button) — the user deliberately
  //     wants a NEW handle, so we update their existing row.
  async function reservePseudonym(discussionId, userId, name, { overwrite = false } = {}) {
    try {
      if (overwrite) {
        const result = await pool.query(
          `INSERT INTO discussion_pseudonyms (discussion_id, user_id, pseudonym)
           VALUES ($1, $2, $3)
           ON CONFLICT (discussion_id, user_id)
           DO UPDATE SET pseudonym = EXCLUDED.pseudonym
           RETURNING pseudonym`,
          [discussionId, userId, name]
        );
        return result.rows[0] ? result.rows[0].pseudonym : null;
      }
      const result = await pool.query(
        `INSERT INTO discussion_pseudonyms (discussion_id, user_id, pseudonym)
         VALUES ($1, $2, $3)
         ON CONFLICT (discussion_id, user_id) DO NOTHING
         RETURNING pseudonym`,
        [discussionId, userId, name]
      );
      if (result.rows[0]) return result.rows[0].pseudonym; // we inserted — we won
      // No row returned ⇒ this user already had a reservation (the other racer won).
      // A name-already-taken-by-someone-else conflict is on the (discussion_id,
      // pseudonym) constraint instead, which DO NOTHING doesn't catch — it raises
      // 23505 and is handled below. So re-read and return the winning handle.
      const existing = await pool.query(
        'SELECT pseudonym FROM discussion_pseudonyms WHERE discussion_id = $1 AND user_id = $2',
        [discussionId, userId]
      );
      return existing.rows[0] ? existing.rows[0].pseudonym : null;
    } catch (e) {
      if (e.code === '23505') return null; // name taken by someone else; try the next
      throw e;
    }
  }

  // Reserve a per-discussion-unique display handle for this user, or return the one
  // they already have. `preferred` is the client's locally-generated candidate; we
  // keep it when it's free so most people get the name they already see locally.
  // On collision we hand out a different combination — never a numbered suffix —
  // so a discussion never shows the same handle twice. `regenerate: true` forces a
  // brand-new handle distinct from the user's current one (the shuffle button).
  //
  // Returns { pseudonym, reserved }. `reserved` is false ONLY when the discussion
  // doesn't exist yet and we could merely hand back a preview — the client must
  // keep asking in that case rather than treating the preview as final, otherwise
  // the user's handle would never get inserted and could later collide.
  async function assignPseudonym(slug, userId, preferred, { regenerate = false } = {}) {
    const canonicalSlug = slugifyTopic(slug);
    const discussionResult = await pool.query(
      'SELECT id FROM discussions WHERE slug = $1',
      [canonicalSlug]
    );
    if (discussionResult.rows.length === 0) {
      // The discussion doesn't exist yet (nobody has added a question, so there's
      // no row to reserve against). Hand back a preview name, flagged unreserved so
      // the client re-asks once the discussion exists and the name gets reserved.
      return { pseudonym: sanitizePseudonym(preferred) || randomPseudonym(), reserved: false };
    }
    const discussionId = discussionResult.rows[0].id;

    const existingResult = await pool.query(
      'SELECT pseudonym FROM discussion_pseudonyms WHERE discussion_id = $1 AND user_id = $2',
      [discussionId, userId]
    );
    const current = existingResult.rows[0] ? existingResult.rows[0].pseudonym : null;
    if (current && !regenerate) return { pseudonym: current, reserved: true };

    // Names already in use in this discussion, so we can skip them up front (the
    // DB still has the final say via reservePseudonym's unique constraint). We
    // union two sources: the reservation table, AND handles already shown on
    // existing votes/comments by OTHER users. The latter matters for discussions
    // that predate this migration (whose reservation table starts empty while old
    // responses already display handles) — without it a newcomer could be handed a
    // name already visible on someone else's old response. We exclude the
    // requesting user's own responses so a returning participant can reclaim the
    // handle their existing responses already show.
    const takenResult = await pool.query(
      `SELECT pseudonym FROM discussion_pseudonyms WHERE discussion_id = $1
       UNION
       SELECT v.pseudonym
         FROM votes v
         JOIN questions q ON v.question_id = q.id
        WHERE q.discussion_id = $1 AND v.user_id <> $2 AND v.pseudonym IS NOT NULL
       UNION
       SELECT c.pseudonym
         FROM response_comments c
         JOIN votes v ON c.response_id = v.id
         JOIN questions q ON v.question_id = q.id
        WHERE q.discussion_id = $1 AND c.user_id <> $2 AND c.pseudonym IS NOT NULL`,
      [discussionId, userId]
    );
    const taken = new Set(takenResult.rows.map((row) => row.pseudonym));

    // Candidates to try, in priority order: the user's preferred name (unless
    // regenerating), then a few cheap random probes, then every remaining free
    // combination so we never give up while a name is still available.
    const candidates = [];
    const sanitizedPreferred = sanitizePseudonym(preferred);
    if (!regenerate && sanitizedPreferred && !taken.has(sanitizedPreferred)) {
      candidates.push(sanitizedPreferred);
    }
    for (let i = 0; i < 16; i++) {
      const probe = randomPseudonym();
      if (probe !== current && !taken.has(probe)) candidates.push(probe);
    }
    for (const name of allPseudonyms()) {
      if (name !== current && !taken.has(name)) candidates.push(name);
    }

    for (const name of candidates) {
      const reserved = await reservePseudonym(discussionId, userId, name, { overwrite: regenerate });
      if (reserved) return { pseudonym: reserved, reserved: true };
    }

    // Every one of the ~2300 combinations is taken (>2300 participants in a single
    // discussion). Only here do we resort to a numbered handle so the user still
    // gets a name; log it because it means the pool should grow.
    console.warn(`Pseudonym pool exhausted for discussion ${discussionId}; falling back to a numbered handle`);
    const base = sanitizedPreferred || randomPseudonym();
    for (let n = 2; ; n++) {
      // Trim the base so the suffix survives the length cap — otherwise a base
      // already at MAX_PSEUDONYM_LENGTH would slice the " <n>" back off, producing
      // the same taken string every iteration and looping forever without acking.
      const suffix = ` ${n}`;
      const name = `${base.slice(0, MAX_PSEUDONYM_LENGTH - suffix.length)}${suffix}`;
      const reserved = await reservePseudonym(discussionId, userId, name, { overwrite: regenerate });
      if (reserved) return { pseudonym: reserved, reserved: true };
    }
  }

  return { canonicalPseudonym, assignPseudonym };
}

function registerPseudonyms(socket, { withTransaction, assignPseudonym, emitPseudonymSync, emitQuestions, logError }) {
  // Hand the client a display handle that's guaranteed unique within this
  // discussion. The client proposes its locally-generated name; the server keeps
  // it if free and substitutes a different one if it's already taken, so two
  // people never end up as the same "Tidy Newt". Stable across reloads (a user
  // who already has a reservation gets it back).
  socket.on('requestPseudonym', async (topic, claimedUserId, preferred, cb) => {
    if (typeof cb !== 'function') return;
    const userId = bindSocketUser(socket, claimedUserId);
    try {
      if (!topic || !userId) {
        cb({ pseudonym: sanitizePseudonym(preferred), reserved: false });
        return;
      }
      cb(await assignPseudonym(slugifyTopic(topic), userId, preferred));
    } catch (error) {
      logError('Error assigning pseudonym:', error);
      // Fall back to the proposed name so the client still has something to show,
      // flagged unreserved so the client keeps trying to reserve it.
      cb({ pseudonym: sanitizePseudonym(preferred) || null, reserved: false });
    }
  });

  // Shuffle: give this user a brand-new handle, still unique within the
  // discussion and different from their current one.
  socket.on('regeneratePseudonym', async (topic, claimedUserId, cb) => {
    if (typeof cb !== 'function') return;
    const userId = bindSocketUser(socket, claimedUserId);
    try {
      if (!topic || !userId) {
        cb({ pseudonym: null, reserved: false });
        return;
      }
      const discussionSlug = slugifyTopic(topic);
      const result = await assignPseudonym(discussionSlug, userId, null, { regenerate: true });
      cb(result);
      // The shuffle freed the old handle for anyone else to claim, so this user's
      // OTHER tabs on this discussion must stop using it. Push the new handle to
      // them (their already-submitted responses were renamed via updateDisplayName
      // by the shuffling tab); the originating socket already has it via the ack.
      if (result.reserved) {
        emitPseudonymSync(discussionSlug, userId, result.pseudonym, socket.id);
      }
    } catch (error) {
      logError('Error regenerating pseudonym:', error);
      cb({ pseudonym: null, reserved: false });
    }
  });

  // Retroactively rename a participant's already-submitted responses when they
  // change name mode, edit their custom name, or shuffle their pseudonym. Without
  // this, switching to "Completely anonymous" would still show the old name on
  // prior responses, breaking the privacy promise. Allowed even when the
  // discussion is locked: this is a display-name edit, not a new vote.
  socket.on('updateDisplayName', async (topic, claimedUserId, displayName) => {
    const discussionSlug = slugifyTopic(topic);
    const userId = bindSocketUser(socket, claimedUserId);
    try {
      if (!topic || !userId) return;
      const pseudonym = sanitizePseudonym(displayName);
      // Both renames commit together, so a failure cannot leave the old name on
      // comments after the responses changed. Locking the discussion row FOR
      // UPDATE first waits for votes and comments being stored right now (they
      // hold it FOR SHARE), so their rows exist when the rename runs.
      await withTransaction(async client => {
        const { rows: [room] } = await client.query('SELECT id FROM discussions WHERE slug = $1 FOR UPDATE', [discussionSlug]);
        if (!room) return;
        await client.query(
          `UPDATE votes SET pseudonym = $1
           WHERE user_id = $2
             AND question_id IN (SELECT id FROM questions WHERE discussion_id = $3)`,
          [pseudonym, userId, room.id]
        );
        // Brainstorm comments persist their author's name separately, so rename /
        // anonymize must reach them too — otherwise old comments keep showing the
        // previous name after a privacy action.
        await client.query(
          `UPDATE response_comments SET pseudonym = $1
           WHERE user_id = $2
             AND response_id IN (
               SELECT v.id FROM votes v
               JOIN questions q ON v.question_id = q.id
               WHERE q.discussion_id = $3
             )`,
          [pseudonym, userId, room.id]
        );
      });
      await emitQuestions(discussionSlug);
    } catch (error) {
      logError('Error updating display name:', error);
      socket.emit('error', { message: 'Failed to update display name' });
    }
  });
}

module.exports = { sanitizePseudonym, createPseudonyms, registerPseudonyms };
