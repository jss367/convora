const definitions = require('./question-tools.json');
const { normalizeQuestionTools, choiceOptionsFor } = require('./question-data');
const { lockPollVote } = require('./votes');

const denied = reason => ({ ok: false, reason });
const validId = id => Number.isSafeInteger(id) && id > 0 && id <= 2147483647;

async function submitNote(client, slug, questionId, userId, input) {
  const tool = definitions.find(item => item.kind === input?.kind);
  const body = typeof input?.body === 'string' && input.body.trim();
  if (!validId(questionId) || typeof userId !== 'string' || !userId || !tool || !body || body.length > tool.limit || body.includes('\0')) return denied('invalid');
  const { rows: [room] } = await client.query('SELECT id, locked FROM discussions WHERE slug = $1 FOR SHARE', [slug]);
  if (!room) return denied('unavailable');
  const { rows: [question] } = await client.query('SELECT id, tools, type, options FROM questions WHERE id = $1 AND discussion_id = $2 AND NOT queued FOR SHARE', [questionId, room.id]);
  if (!question || !normalizeQuestionTools(question.tools, question.type)?.includes(tool.kind)) return denied('unavailable');
  if (room.locked) return denied('locked');
  let voteId = null;
  if (tool.kind === 'suggestion') {
    const comparable = text => text.trim().replace(/\s+/g, ' ').toLowerCase();
    if (choiceOptionsFor(question).some(option => comparable(option) === comparable(body))) return denied('existing_option');
  } else {
    await lockPollVote(client, questionId, userId);
    const { rows: [vote] } = await client.query('SELECT id, value FROM votes WHERE question_id = $1 AND user_id = $2 ORDER BY id LIMIT 1', [questionId, userId]);
    if (tool.kind === 'clarification' && vote) return denied('already_voted');
    if (tool.kind === 'explanation') {
      if (!vote || vote.id !== input.voteId || vote.value !== String(input.voteValue)) return denied('vote_changed');
      voteId = vote.id;
    }
  }
  await client.query(`INSERT INTO question_tool_notes (question_id, user_id, kind, body, vote_id) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (question_id, user_id, kind) DO UPDATE SET body = EXCLUDED.body, vote_id = EXCLUDED.vote_id`, [questionId, userId, tool.kind, body, voteId]);
  return { ok: true };
}

function registerQuestionTools(socket, { slugifyTopic, bindSocketUser, withTransaction, verifyAdmin, notifyModerators, logError }) {
  function listen(event, work) {
    socket.on(event, async (topic, questionId, input, ack) => {
      if (typeof ack !== 'function') return;
      const slug = slugifyTopic(topic);
      const inRoom = () => !socket.data.isDisplay && socket.data.topic === slug;
      if (!validId(questionId) || !inRoom()) return ack(denied('unavailable'));
      try {
        const result = await withTransaction(client => work(client, slug, questionId, input));
        ack(inRoom() ? result : denied('unavailable'));
        if (result.ok && event === 'submitQuestionNote') notifyModerators(slug, questionId).catch(error => logError('Error notifying moderators:', error));
      } catch (error) {
        logError(`Error handling ${event}:`, error);
        ack(denied('error'));
      }
    });
  }
  listen('submitQuestionNote', (client, slug, id, input) => submitNote(client, slug, id, bindSocketUser(socket), input));

  listen('getQuestionNotes', async (client, slug, id, input) => {
    const roomId = await verifyAdmin(slug, input?.token, client);
    if (!roomId) return denied('not_authorized');
    if (!(await client.query('SELECT id FROM questions WHERE id = $1 AND discussion_id = $2', [id, roomId])).rowCount) return denied('unavailable');
    const { rows: notes } = await client.query(`SELECT n.id, n.kind, n.body, v.value AS answer
      FROM question_tool_notes n LEFT JOIN votes v ON v.id = n.vote_id
      WHERE n.question_id = $1 ORDER BY n.id`, [id]);
    return { ok: true, notes };
  });
}

module.exports = { registerQuestionTools, submitNote };
