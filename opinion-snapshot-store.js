const { buildOpinionSnapshot, OPINION_TYPES } = require('./opinion-snapshots');
const { logError } = require('./logging');

const MAX_SNAPSHOT_NAME_LENGTH = 120;

function redactSnapshot(snapshot, hiddenIds) {
  const questions = snapshot.data?.questions || [];
  if (!questions.some(q => hiddenIds.has(q.id))) return snapshot;
  return {
    ...snapshot,
    data: {
      ...snapshot.data,
      // With one question hidden, the participant total would bound its count.
      participantCount: null,
      questions: questions.map(q => (
        hiddenIds.has(q.id)
          // A Multiple Choice question's options are part of the question, not
          // its results, so they survive redaction; the counts do not.
          ? { id: q.id, text: q.text, type: q.type, ...(Array.isArray(q.options) ? { options: q.options } : {}), resultsHidden: true }
          : q
      )),
    },
  };
}

// The name of the snapshot saved before a question's results are first shown.
function snapshotNameBeforeReveal(questionText) {
  const prefix = 'Before results shown: ';
  const text = String(questionText).replace(/\s+/g, ' ').trim();
  const room = MAX_SNAPSHOT_NAME_LENGTH - prefix.length;
  return prefix + (text.length > room ? `${text.slice(0, room - 1).trimEnd()}…` : text);
}

function createSnapshotStore(pool) {
  // Save a snapshot of a discussion's published tallied questions as they stand
  // now. Returns { snapshot }, or { empty: true } when there is nothing to save.
  // `autoQuestionId` marks a snapshot the server saves by itself before that
  // question's results are first shown: it is skipped ({ empty: true }) when the
  // question has no responses, or when it already has such a snapshot.
  async function saveOpinionSnapshot(discussionId, name, { autoQuestionId = null, transactionClient = null } = {}) {
    const client = transactionClient || await pool.connect();
    let releaseError;
    try {
      // One statement gives metadata and votes the same view. For an automatic
      // capture it starts after the reveal acquired its question lock; manual
      // saves retain their own repeatable-read transaction.
      if (!transactionClient) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const input = await client.query(
        `SELECT
           COALESCE((SELECT jsonb_agg(q ORDER BY q.id) FROM (
             SELECT id, text, type, min_value, max_value, options FROM questions
             WHERE discussion_id=$1 AND type=ANY($2::text[]) AND NOT queued
           ) q), '[]'::jsonb) AS questions,
           COALESCE((SELECT jsonb_agg(v ORDER BY v.id) FROM (
             SELECT v.id, v.question_id, v.value, v.user_id FROM votes v
             JOIN questions q ON q.id=v.question_id
             WHERE q.discussion_id=$1 AND q.type=ANY($2::text[]) AND NOT q.queued
           ) v), '[]'::jsonb) AS votes`,
        [discussionId, OPINION_TYPES]
      );
      const questions = { rows: input.rows[0].questions };
      const votes = { rows: input.rows[0].votes };
      if (!questions.rows.length) {
        if (!transactionClient) await client.query('ROLLBACK');
        return { empty: true };
      }
      const votesByQuestion = new Map();
      votes.rows.forEach(vote => {
        if (!votesByQuestion.has(vote.question_id)) votesByQuestion.set(vote.question_id, []);
        votesByQuestion.get(vote.question_id).push(vote);
      });
      if (autoQuestionId !== null && !votesByQuestion.has(autoQuestionId)) {
        if (!transactionClient) await client.query('ROLLBACK');
        return { empty: true };
      }
      const data = buildOpinionSnapshot(questions.rows.map(question => ({
        ...question, votes: votesByQuestion.get(question.id) || [],
      })));
      const saved = await client.query(
        `INSERT INTO opinion_snapshots (discussion_id, name, data, auto_question_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (auto_question_id) WHERE auto_question_id IS NOT NULL DO NOTHING
         RETURNING id, name, created_at AS "createdAt", data`,
        [discussionId, name, JSON.stringify(data), autoQuestionId]
      );
      if (!transactionClient) await client.query('COMMIT');
      return saved.rows.length ? { snapshot: saved.rows[0] } : { empty: true };
    } catch (err) {
      try {
        if (!transactionClient) await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logError('Error rolling back opinion snapshot transaction:', rollbackErr);
        releaseError = rollbackErr;
      }
      throw err;
    } finally {
      if (!transactionClient) client.release(releaseError);
    }
  }

  // Called just before a moderator shows one question's results to everyone.
  // Once the room has seen how it answered, people start changing their answers,
  // and what they thought beforehand can no longer be recovered. So the first
  // time a question is shown, a snapshot is saved by itself, for a moderator who
  // did not think to save one. It covers every published tallied question, like
  // any snapshot. Nothing is saved when results are always shown (there was no
  // "before" to keep), when the question has no responses yet, or when it was
  // shown before. A failed capture rolls back to its savepoint so the reveal may continue.
  // The caller commits capture and reveal together and announces only after commit.
  async function saveSnapshotBeforeReveal(discussionSlug, discussionId, questionId, client) {
    if (!Number.isInteger(questionId)) return false;
    await client.query('SAVEPOINT automatic_baseline');
    try {
      const found = await client.query(
        `SELECT q.text FROM questions q JOIN discussions d ON d.id = q.discussion_id
          WHERE q.id = $1 AND d.id = $2 AND NOT q.queued AND NOT q.results_revealed
            AND q.type = ANY($3::text[]) AND d.results_visibility IS DISTINCT FROM 'always'
            AND NOT EXISTS (SELECT 1 FROM opinion_snapshots s WHERE s.auto_question_id = q.id)`,
        [questionId, discussionId, OPINION_TYPES]
      );
      if (!found.rows.length) {
        await client.query('RELEASE SAVEPOINT automatic_baseline');
        return false;
      }
      const saved = await saveOpinionSnapshot(discussionId, snapshotNameBeforeReveal(found.rows[0].text), { autoQuestionId: questionId, transactionClient: client });
      await client.query('RELEASE SAVEPOINT automatic_baseline');
      return Boolean(saved.snapshot);
    } catch (error) {
      logError('Error saving a snapshot before showing results:', error);
      await client.query('ROLLBACK TO SAVEPOINT automatic_baseline');
      await client.query('RELEASE SAVEPOINT automatic_baseline');
      return false;
    }
  }

  return { saveOpinionSnapshot, saveSnapshotBeforeReveal };
}

module.exports = { MAX_SNAPSHOT_NAME_LENGTH, redactSnapshot, snapshotNameBeforeReveal, createSnapshotStore };
