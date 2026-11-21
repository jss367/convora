const { test, expect } = require('./lifecycle-fixtures.cjs');

test('a moderator can clear a test run without replacing the room or its questions', async ({ page, browser, request, rooms }) => {
  const room = await rooms.create('Practice', 'Agreement');
  const other = await rooms.create('Other');
  const { pool } = rooms;
  const moderatorToken = `promoted-${room.id}`;
  await pool.query('INSERT INTO discussion_moderators (discussion_id,user_id,token) VALUES ($1,$2,$3)', [room.id, 'cohost', moderatorToken]);
  await pool.query("INSERT INTO questions (discussion_id,text,type,queued) VALUES ($1,'Later','Agreement',true), ($1,'Feedback','Open Ended',false)", [room.id]);
  await pool.query("INSERT INTO opinion_snapshots (discussion_id,name,data) VALUES ($1,'Baseline','{}')", [room.id]);
  const seedVote = async (roomId, text) => (await pool.query('INSERT INTO votes (question_id,value) SELECT id,$2 FROM questions WHERE discussion_id=$1 AND type=$3 RETURNING id', [roomId, text, 'Open Ended'])).rows[0].id;
  const responseId = await seedVote(room.id, 'Practice response');
  const otherId = await seedVote(other.id, 'Keep me');
  await pool.query("INSERT INTO response_comments (response_id,user_id,body) VALUES ($1,'guest','Reply')", [responseId]);
  await pool.query("INSERT INTO question_interest (question_id,user_id) SELECT id,'guest' FROM questions WHERE discussion_id=$1 AND NOT queued", [room.id]);
  const questions = async () => (await pool.query('SELECT * FROM questions WHERE discussion_id=$1 ORDER BY id', [room.id])).rows;
  const before = await questions();
  const path = `/discussion/${room.slug}`;
  const api = `/api/discussions/${room.slug}/responses`;
  const guest = await browser.newContext();
  try {
    const participant = await guest.newPage();
    await participant.goto(path);
    const more = viewer => viewer.getByRole('button', { name: 'More ▾', exact: true });
    const action = viewer => viewer.getByRole('menuitem', { name: 'Clear votes and responses', exact: true });
    const vote = participant.getByRole('button', { name: 'Vote Agree on "Practice question"', exact: true });
    await vote.click();
    await expect(vote).toHaveAttribute('aria-pressed', 'true');
    for (const data of [{}, { adminToken: other.adminToken }]) {
      expect((await request.delete(api, { data })).status()).toBe(403);
    }
    await page.goto(`${path}?admin=${moderatorToken}`);
    const open = async () => { await more(page).click(); await action(page).click(); };
    await open();
    const dialog = page.getByRole('dialog', { name: 'Clear votes and responses?' });
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeFocused();
    await cancel.click();
    await expect(more(page)).toBeFocused();
    await expect(participant.getByText('Practice response', { exact: true })).toBeVisible();
    await open();
    await dialog.getByRole('button', { name: 'Clear votes and responses', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(path);
    await expect(participant.getByText('Practice response', { exact: true })).toHaveCount(0);
    await expect(vote).toHaveAttribute('aria-pressed', 'false');
    expect(await questions()).toEqual(before);
    expect((await pool.query('SELECT id FROM votes WHERE id=ANY($1::int[])', [[otherId, responseId]])).rows).toEqual([{ id: otherId }]);
    expect((await pool.query('SELECT id FROM response_comments WHERE response_id=$1', [responseId])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM question_interest WHERE question_id=ANY($1::int[])', [before.map(question => question.id)])).rowCount).toBe(0);
    expect((await pool.query('SELECT name FROM opinion_snapshots WHERE discussion_id=$1', [room.id])).rows).toEqual([{ name: 'Baseline' }]);
    await vote.click();
    await expect(vote).toHaveAttribute('aria-pressed', 'true');
    await more(participant).click();
    await expect(participant.getByRole('menu')).toBeVisible();
    await expect(action(participant)).toHaveCount(0);
  } finally {
    await guest.close();
  }
});
