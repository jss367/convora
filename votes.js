const { isValidVote } = require('./question-data');

// Vote persistence is separate from transport handlers so every caller uses the
// same transaction and concurrency rules. Pseudonyms are sanitized by callers.

function lockPollVote(client, questionId, userId) {
  return client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`poll_vote:${questionId}:${userId}`]);
}

// Lock the question's discussion row FOR SHARE and report whether voting is
// closed. Locking the discussion makes a moderator's lock (an UPDATE of that
// row) wait for this write, and makes a write that arrives during the lock
// wait and then see it. It runs before the question row is locked, matching
// the discussion-then-question order the moderator handlers use.
async function discussionLockedForQuestion(client, questionId) {
  const { rows: [room] } = await client.query(
    `SELECT d.locked FROM discussions d JOIN questions q ON q.discussion_id = d.id
      WHERE q.id = $1 FOR SHARE OF d`,
    [questionId]
  );
  return room ? room.locked : null;
}

function createVoteStore(pool) {
  async function inTransaction(work) {
    const client = await pool.connect();
    let releaseError;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  // "Set my answer to this value." Repeating a poll submission leaves that
  // answer stored. Removing an answer is the separate clearVote action and is
  // never inferred from a repeated value, so a retried or double-tapped vote
  // cannot delete itself.
  function addVote(questionId, vote, userId, pseudonym) {
    return inTransaction(async client => {
      if (await discussionLockedForQuestion(client, questionId)) return { added: false, reason: 'locked' };
      // FOR SHARE holds off a moderator's edit (editQuestion locks the row FOR
      // UPDATE) until this vote is stored, and makes a vote that arrives during
      // an edit wait and then read the edited row. Either way the vote is
      // checked against the question as it will be when the vote is stored.
      const typeResult = await client.query(
        'SELECT id, type, options, min_value, max_value, max_responses FROM questions WHERE id = $1 FOR SHARE', [questionId]
      );
      const question = typeResult.rows[0];
      if (!question) throw new Error('Question not found');
      if (!isValidVote(question, vote)) return { added: false, reason: 'invalid' };
      // PostgreSQL accepts equivalent integer spellings such as 1, '01', '+1'.
      // All must use the same lock key, not the caller's unnormalized value.
      questionId = question.id;
      const questionType = question.type;

      if (['Open Ended', 'Brainstorm'].includes(questionType)) {
        const payload = typeof vote === 'object' && vote !== null ? vote : { text: vote };
        if (typeof payload.text !== 'string' || !payload.text.trim()) throw new Error('Response cannot be empty');
        if (payload.requestId != null && (typeof payload.requestId !== 'string' || payload.requestId.length > 100)) throw new Error('Invalid request id');
        await lockPollVote(client, questionId, userId);
        // Pre-upgrade Open Ended clients send scalar edits. Their migrated
        // one-response policy keeps that upsert contract; object payloads and
        // unlimited former Brainstorm prompts still create separate responses.
        if (typeof vote === 'string' && question.max_responses === 1) {
          const existing = await client.query('SELECT id FROM votes WHERE question_id = $1 AND user_id = $2 ORDER BY id LIMIT 1', [questionId, userId]);
          if (existing.rows.length) {
            await client.query('UPDATE votes SET value = $1, pseudonym = $2 WHERE id = $3', [payload.text.trim(), pseudonym, existing.rows[0].id]);
            return { added: false, updated: true };
          }
        }
        if (payload.responseId != null) {
          const updated = await client.query('UPDATE votes SET value = $1 WHERE id = $2 AND question_id = $3 AND user_id = $4', [payload.text.trim(), payload.responseId, questionId, userId]);
          return { added: false, updated: updated.rowCount > 0 };
        }
        if (payload.requestId) {
          const previous = await client.query('SELECT id FROM votes WHERE question_id = $1 AND user_id = $2 AND request_id = $3', [questionId, userId, payload.requestId]);
          if (previous.rows.length) return { added: false, repeated: true };
        }
        const count = await client.query('SELECT count(*)::int AS count FROM votes WHERE question_id = $1 AND user_id = $2', [questionId, userId]);
        if (question.max_responses && count.rows[0].count >= question.max_responses) return { added: false, reason: 'limit' };
        await client.query('INSERT INTO votes (question_id, user_id, value, pseudonym, request_id) VALUES ($1, $2, $3, $4, $5)', [questionId, userId, payload.text.trim(), pseudonym, payload.requestId || null]);
      } else {
        await lockPollVote(client, questionId, userId);
        const existing = await client.query(
          'SELECT id, value FROM votes WHERE question_id = $1 AND user_id = $2 ORDER BY id',
          [questionId, userId]
        );
        const current = existing.rows[0];
        // Repair duplicates left by older versions when this participant next
        // answers. Keep the first owned response, matching the client's current
        // answer in getQuestions' ascending-ID list, so an update edits that answer.
        // Brainstorm ideas are independent and never go through this repair.
        if (existing.rows.length > 1) {
          await client.query(
            'DELETE FROM votes WHERE question_id = $1 AND user_id = $2 AND id <> $3',
            [questionId, userId, current.id]
          );
        }

        const value = Array.isArray(vote) ? JSON.stringify(vote) : vote;
        if (!current) {
          await client.query(
            'INSERT INTO votes (question_id, user_id, value, pseudonym) VALUES ($1, $2, $3, $4)',
            [questionId, userId, value, pseudonym]
          );
        } else {
          if (current.value !== String(value)) await client.query('DELETE FROM question_tool_notes WHERE vote_id = $1', [current.id]);
          await client.query('UPDATE votes SET value = $1, pseudonym = $2 WHERE id = $3', [
            value, pseudonym, current.id,
          ]);
        }
      }
      return { added: true };
    });
  }

  // "Remove my answer to this poll." Clearing an absent vote is a no-op, and
  // duplicates left by older versions go too. Brainstorm ideas are independent
  // responses removed one at a time by id, never through this.
  function clearVote(questionId, userId) {
    return inTransaction(async client => {
      if (await discussionLockedForQuestion(client, questionId)) return { cleared: false, reason: 'locked' };
      const typeResult = await client.query('SELECT id, type, max_responses FROM questions WHERE id = $1', [questionId]);
      const question = typeResult.rows[0];
      if (!question) throw new Error('Question not found');
      if (['Open Ended', 'Brainstorm'].includes(question.type)) return { cleared: false };
      await lockPollVote(client, question.id, userId);
      await client.query('DELETE FROM votes WHERE question_id = $1 AND user_id = $2', [question.id, userId]);
      return { cleared: true };
    });
  }

  return { addVote, clearVote };
}

module.exports = { createVoteStore, lockPollVote };
