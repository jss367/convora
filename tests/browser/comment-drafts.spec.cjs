const { test, expect } = require('./lifecycle-fixtures.cjs');

for (const outcome of ['rejected', 'accepted', 'edited']) {
  test(`comment draft survives until acknowledgment: ${outcome}`, async ({ page, rooms }) => {
    const room = await rooms.create('Comment draft');
    await rooms.pool.query('UPDATE discussions SET comments_enabled = TRUE WHERE id = $1', [room.id]);
    await rooms.pool.query("INSERT INTO votes (question_id, user_id, value) SELECT id, 'author', 'Discuss this answer' FROM questions WHERE discussion_id = $1", [room.id]);
    let releaseAck;
    let upgraded = false;
    let commentAck;
    await page.routeWebSocket(/\/socket\.io\//, route => {
      const upstream = route.connectToServer();
      route.onMessage(message => {
        if (message === '5') upgraded = true;
        if (typeof message === 'string' && message.startsWith('42')
            && JSON.parse(message.slice(message.indexOf('[')))[0] === 'addResponseComment') {
          commentAck = `43${message.slice(2, message.indexOf('['))}[`;
        }
        upstream.send(message);
      });
      upstream.onMessage(message => {
        if (commentAck && typeof message === 'string' && message.startsWith(commentAck)) {
          releaseAck = () => route.send(message);
        } else route.send(message);
      });
    });
    await page.goto(`/discussion/${room.slug}`);
    await expect.poll(() => upgraded).toBe(true);
    const draft = page.getByPlaceholder('Add a comment');
    await draft.fill('Submitted comment');
    // Change server authorization without broadcasting it to the stale client.
    if (outcome === 'rejected') await rooms.pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [room.id]);
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect.poll(() => Boolean(releaseAck)).toBe(true);
    await expect(draft).toHaveValue('Submitted comment');
    if (outcome === 'edited') await draft.fill('Newer comment draft');
    releaseAck();
    await expect(draft).toHaveValue(outcome === 'accepted' ? '' : outcome === 'edited' ? 'Newer comment draft' : 'Submitted comment');
    const rows = (await rooms.pool.query('SELECT body FROM response_comments WHERE response_id IN (SELECT v.id FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.discussion_id = $1)', [room.id])).rows;
    expect(rows).toEqual(outcome === 'rejected' ? [] : [{ body: 'Submitted comment' }]);
  });
}
