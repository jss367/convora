// Vote persistence is separate from transport handlers so every caller uses the
// same transaction and concurrency rules. Pseudonyms are sanitized by callers.
function createVoteStore(pool) {
  async function inTransaction(work) {
    const client = await pool.connect();
    let releaseError;
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
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

  // A transaction alone does not protect the absent-row case. Serialize one
  // participant's writes to a poll across sockets/processes before reading the
  // current vote. Read Committed gives the waiter a fresh view after the lock.
  function lockPollVote(client, questionId, userId) {
    return client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `poll_vote:${questionId}:${userId}`,
    ]);
  }

  // "Set my answer to this value." Repeating a poll submission leaves that
  // answer stored. Removing an answer is the separate clearVote action and is
  // never inferred from a repeated value, so a retried or double-tapped vote
  // cannot delete itself.
  function addVote(questionId, vote, userId, pseudonym) {
    return inTransaction(async client => {
      const typeResult = await client.query('SELECT id, type FROM questions WHERE id = $1', [questionId]);
      const question = typeResult.rows[0];
      if (!question) throw new Error('Question not found');
      // PostgreSQL accepts equivalent integer spellings such as 1, '01', '+1'.
      // All must use the same lock key, not the caller's unnormalized value.
      questionId = question.id;
      const questionType = question.type;

      if (questionType === 'Brainstorm') {
        // Each idea is an independent response, including simultaneous ideas
        // submitted by the same participant.
        await client.query(
          'INSERT INTO votes (question_id, user_id, value, pseudonym) VALUES ($1, $2, $3, $4)',
          [questionId, userId, vote, pseudonym]
        );
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
          await client.query('UPDATE votes SET value = $1, pseudonym = $2 WHERE id = $3', [
            value, pseudonym, current.id,
          ]);
        }
      }
    });
  }

  // "Remove my answer to this poll." Clearing an absent vote is a no-op, and
  // duplicates left by older versions go too. Brainstorm ideas are independent
  // responses removed one at a time by id, never through this.
  function clearVote(questionId, userId) {
    return inTransaction(async client => {
      const typeResult = await client.query('SELECT id, type FROM questions WHERE id = $1', [questionId]);
      const question = typeResult.rows[0];
      if (!question) throw new Error('Question not found');
      if (question.type === 'Brainstorm') return;
      await lockPollVote(client, question.id, userId);
      await client.query('DELETE FROM votes WHERE question_id = $1 AND user_id = $2', [question.id, userId]);
    });
  }

  return { addVote, clearVote };
}

module.exports = { createVoteStore };
