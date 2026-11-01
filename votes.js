// Vote persistence is separate from transport handlers so every caller uses the
// same transaction and concurrency rules. Pseudonyms are sanitized by callers.
function createVoteStore(pool) {
  async function addVote(questionId, vote, userId, pseudonym) {
    const client = await pool.connect();
    let releaseError;
    try {
      await client.query('BEGIN');
      const typeResult = await client.query('SELECT type FROM questions WHERE id = $1', [questionId]);
      const questionType = typeResult.rows[0]?.type;
      if (!questionType) throw new Error('Question not found');

      if (questionType === 'Brainstorm') {
        // Each idea is an independent response, including simultaneous ideas
        // submitted by the same participant.
        await client.query(
          'INSERT INTO votes (question_id, user_id, value, pseudonym) VALUES ($1, $2, $3, $4)',
          [questionId, userId, vote, pseudonym]
        );
      } else {
        // A transaction alone does not protect the absent-row case. Serialize
        // submissions across sockets/processes before reading the current vote.
        // Read Committed gives the waiter a fresh view after acquiring the lock.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `poll_vote:${questionId}:${userId}`,
        ]);
        const existing = await client.query(
          'SELECT id, value FROM votes WHERE question_id = $1 AND user_id = $2 ORDER BY id DESC',
          [questionId, userId]
        );
        const current = existing.rows[0];
        // Repair duplicates left by older versions when this participant next
        // answers. Keep the latest response and leave Brainstorm ideas alone.
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
        } else if (current.value === vote && ['Agreement', 'Yes/No'].includes(questionType)) {
          await client.query('DELETE FROM votes WHERE id = $1', [current.id]);
        } else {
          await client.query('UPDATE votes SET value = $1, pseudonym = $2 WHERE id = $3', [
            value, pseudonym, current.id,
          ]);
        }
      }
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

  return { addVote };
}

module.exports = { createVoteStore };
