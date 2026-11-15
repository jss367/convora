const { test, expect } = require('./lifecycle-fixtures.cjs');

test('retrying an unchanged response after its acknowledgement is lost reuses the creation id', async ({ page, rooms }) => {
  const room = await rooms.create('Lost response acknowledgement');
  const connections = [];
  const requestIds = [];
  let upgraded = false;
  let dropReplies = false;
  await page.routeWebSocket(/\/socket\.io\//, route => {
    const upstream = route.connectToServer();
    const first = connections.length === 0;
    connections.push({ route, upstream });
    route.onMessage(message => {
      if (message === '5') upgraded = true;
      if (typeof message === 'string' && message.startsWith('42')) {
        const event = JSON.parse(message.slice(message.indexOf('[')));
        if (event[0] === 'vote') {
          requestIds.push(event[3].requestId);
          if (first) dropReplies = true;
        }
      }
      upstream.send(message);
    });
    upstream.onMessage(message => {
      // Store the first request but lose its ack and question broadcast. The
      // client must retry the same operation after reconnect, not create anew.
      if (!first || !dropReplies) route.send(message);
    });
  });
  await page.goto(`/discussion/${room.slug}`);
  await expect.poll(() => upgraded).toBe(true);
  const draft = page.getByPlaceholder('Enter a response');
  await draft.fill('An answer with a lost acknowledgement');
  await page.getByRole('button', { name: 'Add Response', exact: true }).click();
  const count = async () => (await rooms.pool.query('SELECT count(*)::int AS n FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.discussion_id = $1', [room.id])).rows[0].n;
  await expect.poll(count).toBe(1);
  await connections[0].upstream.close({ code: 1012, reason: 'Lost acknowledgement' });
  await connections[0].route.close({ code: 1012, reason: 'Lost acknowledgement' });
  await expect.poll(() => connections.length).toBeGreaterThan(1);
  await expect(page.getByRole('listitem').getByText('An answer with a lost acknowledgement', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('An answer with a lost acknowledgement');
  await page.getByRole('button', { name: 'Add Response', exact: true }).click();
  await expect(draft).toHaveValue('');
  expect(await count()).toBe(1);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[1]).toBe(requestIds[0]);
});

test('a successful identical contribution starts a fresh creation id', async ({ page, rooms }) => {
  const room = await rooms.create('Intentional identical response');
  await page.goto(`/discussion/${room.slug}`);
  const draft = page.getByPlaceholder('Enter a response');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await draft.fill('An intentional repeated answer');
    await page.getByRole('button', { name: 'Add Response', exact: true }).click();
    await expect(draft).toHaveValue('');
  }
  const rows = (await rooms.pool.query('SELECT request_id FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.discussion_id = $1 ORDER BY v.id', [room.id])).rows;
  expect(rows).toHaveLength(2);
  expect(rows[0].request_id).not.toBe(rows[1].request_id);
});
