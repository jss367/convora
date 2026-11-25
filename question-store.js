const { slugifyTopic } = require('./discussion-names');
const { normalizeQuestionPayload, parseOptions } = require('./question-data');
const { questionDisposition } = require('./question-posting');
const { logError } = require('./logging');

function createQuestionStore({ pool, withTransaction, verifyAdmin, getOrCreateDiscussionForSlug }) {
  async function addQuestion(topic, question, { queueRequested, token, similar }) {

    const normalizedQuestion = normalizeQuestionPayload(question);
    if (!normalizedQuestion) {
      throw new Error('Invalid question payload');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const discussion = await getOrCreateDiscussionForSlug(client, topic);
      const discussionId = discussion.id;
      const room = await client.query('SELECT locked, moderator_only_questions, question_approval_required FROM discussions WHERE id = $1 FOR SHARE', [discussionId]);
      const isModerator = !!await verifyAdmin(topic, token, client);
      if (!isModerator && (normalizedQuestion.independentAnswers || normalizedQuestion.tools?.length)) {
        await client.query('ROLLBACK');
        return { reason: 'not_authorized' };
      }
      const disposition = questionDisposition(room.rows[0], isModerator, queueRequested);
      if (disposition.reason || similar) {
        await client.query('ROLLBACK');
        return disposition.reason ? disposition : { reason: 'similar', queued: disposition.queued };
      }

      // Ensure options is a valid JSON array
      const optionsJson = JSON.stringify(normalizedQuestion.options);

      // Insert the question
      const questionResult = await client.query(
        `INSERT INTO questions (discussion_id, text, type, min_value, max_value, options, max_responses, show_attribution, queued, participant_suggested, tools,
                                independent_answers) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          discussionId,
          normalizedQuestion.text,
          normalizedQuestion.type,
          normalizedQuestion.minValue,
          normalizedQuestion.maxValue,
          optionsJson,
          normalizedQuestion.maxResponses,
          normalizedQuestion.showAttribution,
          disposition.queued,
          disposition.suggested,
          normalizedQuestion.tools ?? [],
          normalizedQuestion.independentAnswers,
        ]
      );

      await client.query('COMMIT');
      return {
        ...questionResult.rows[0],
        options: parseOptions(questionResult.rows[0].options)
      };
    } catch (e) {
      await client.query('ROLLBACK');
      logError('Error in addQuestion:', e);
      throw e;
    } finally {
      client.release();
    }
  }

  // Confirm a question belongs to the given topic and report whether that
  // discussion is locked. Returns null when the question does not belong to the
  // topic, so callers can reject mismatched/forged questionIds. The join on
  // topic means a question id from a different discussion never matches.
  async function getQuestionForTopic(topic, questionId) {
    const slug = slugifyTopic(topic);
    const result = await pool.query(
      `SELECT q.id, q.type, q.discussion_id, q.min_value, q.max_value, q.options, q.queued, d.locked
       FROM questions q
       JOIN discussions d ON q.discussion_id = d.id
       WHERE d.slug = $1 AND q.id = $2`,
      [slug, questionId]
    );
    if (result.rows.length === 0) return null;
    return {
      id: result.rows[0].id,
      type: result.rows[0].type,
      discussionId: result.rows[0].discussion_id,
      minValue: result.rows[0].min_value,
      maxValue: result.rows[0].max_value,
      options: parseOptions(result.rows[0].options),
      locked: result.rows[0].locked === true,
      queued: result.rows[0].queued === true,
    };
  }

  // Return the text of the most similar existing statement in the discussion if
  // it crosses the trigram-similarity threshold, otherwise null. Queued questions
  // are never offered: the prompt would show a participant their wording.
  const SIMILARITY_THRESHOLD = 0.5;
  async function findSimilarQuestion(topic, text) {
    if (!text) return null;
    const slug = slugifyTopic(topic);
    try {
      const result = await pool.query(
        `SELECT q.text, similarity(q.text, $2) AS sim
         FROM questions q
         JOIN discussions d ON q.discussion_id = d.id
         WHERE d.slug = $1 AND NOT q.queued AND similarity(q.text, $2) > $3
         ORDER BY sim DESC
         LIMIT 1`,
        [slug, text, SIMILARITY_THRESHOLD]
      );
      return result.rows.length > 0 ? result.rows[0].text : null;
    } catch (e) {
      // If pg_trgm isn't available, skip dedup rather than blocking submission.
      logError('Similarity check failed (skipping dedup):', e);
      return null;
    }
  }

  // Record or remove a participant's interest in a question. Returns false when
  // the question is not in this discussion or the discussion is locked. Locking
  // closes voting, and an interest mark is a vote on the question.
  async function setQuestionInterest(topic, questionId, userId, interested) {
    const slug = slugifyTopic(topic);
    return withTransaction(async client => {
      // Hold the discussion row so a moderator's lock waits for this write, and a
      // write that waited for a lock sees it.
      const found = await client.query(
        `SELECT q.id, d.question_downvotes_enabled
         FROM questions q
         JOIN discussions d ON q.discussion_id = d.id
         WHERE q.id = $1 AND d.slug = $2 AND NOT d.locked AND NOT q.queued FOR SHARE OF d`,
        [questionId, slug]
      );
      if (found.rows.length === 0) return false;
      if (interested === 'down' && !found.rows[0].question_downvotes_enabled) return false;
      if (interested) {
        await client.query(
          `INSERT INTO question_interest (question_id, user_id, downvote) VALUES ($1, $2, $3)
           ON CONFLICT (question_id, user_id) DO UPDATE SET downvote = EXCLUDED.downvote`,
          [questionId, userId, interested === 'down']
        );
      } else {
        await client.query('DELETE FROM question_interest WHERE question_id = $1 AND user_id = $2 AND (NOT downvote OR $3)',
          [questionId, userId, found.rows[0].question_downvotes_enabled]);
      }
      return true;
    });
  }

  return { addQuestion, getQuestionForTopic, findSimilarQuestion, setQuestionInterest };
}

module.exports = { createQuestionStore };
