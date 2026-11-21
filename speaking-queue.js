function registerSpeakingQueue(socket, { pool, withTransaction, verifyAdmin, bindSocketUser, notify, logError }) {
  const inRoom = slug => typeof slug === 'string' && socket.data.topic === slug && !socket.data.isDisplay;

  socket.on('readSpeakingQueue', async (slug, userId, token, ack) => {
    if (typeof ack !== 'function') return;
    if (!inRoom(slug)) return ack({ ok: false });
    const owner = bindSocketUser(socket, userId);
    try {
      const moderator = !!await verifyAdmin(slug, token);
      const { rows } = await pool.query(`SELECT h.id, h.question_id AS "questionId", h.display_name AS name,
          h.user_id = $2 AS mine FROM speaking_queue h JOIN questions q ON q.id = h.question_id
          JOIN discussions d ON d.id = q.discussion_id
          WHERE d.slug = $1 AND d.hands_enabled AND NOT q.queued AND ($3 OR h.user_id = $2) ORDER BY h.id`,
      [slug, owner, moderator]);
      if (!inRoom(slug)) return ack({ ok: false });
      ack({ ok: true, entries: rows });
    } catch (error) {
      logError('Error reading speaking queue:', error);
      ack({ ok: false });
    }
  });

  socket.on('changeSpeakingQueue', async (slug, input, ack) => {
    if (typeof ack !== 'function') return;
    if (!inRoom(slug) || !Number.isSafeInteger(input?.questionId)) return ack({ ok: false });
    const { action, questionId, entryId, token, name } = input;
    const owner = bindSocketUser(socket, input.userId);
    try {
      const outcome = await withTransaction(async client => {
        const { rows: [room] } = await client.query('SELECT id, locked FROM discussions WHERE slug = $1 AND hands_enabled FOR SHARE', [slug]);
        if (!room || room.locked) return null;
        if (!(await client.query('SELECT id FROM questions WHERE id = $1 AND discussion_id = $2 AND NOT queued FOR SHARE', [questionId, room.id])).rowCount) return null;
        if (action === 'done' && Number.isSafeInteger(entryId) && await verifyAdmin(slug, token, client)) {
          const removed = await client.query('DELETE FROM speaking_queue WHERE question_id = $1 AND id = $2 RETURNING user_id', [questionId, entryId]);
          return { userId: removed.rows[0]?.user_id };
        }
        if (typeof owner !== 'string' || !owner) return null;
        if (action === 'raise' && typeof name === 'string') {
          await client.query(`INSERT INTO speaking_queue (question_id, user_id, display_name) VALUES ($1,$2,$3)
            ON CONFLICT (question_id, user_id) DO NOTHING`, [questionId, owner, name.trim().slice(0, 80) || 'Anonymous']);
        } else if (action === 'lower') {
          await client.query('DELETE FROM speaking_queue WHERE question_id = $1 AND user_id = $2', [questionId, owner]);
        } else return null;
        return { userId: owner };
      });
      if (!outcome) return ack({ ok: false });
      ack({ ok: true });
      notify(slug, outcome.userId);
    } catch (error) {
      logError('Error changing speaking queue:', error);
      ack({ ok: false });
    }
  });
}

module.exports = { registerSpeakingQueue };
