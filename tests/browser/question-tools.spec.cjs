const { io } = require('socket.io-client');
const { test, expect } = require('./lifecycle-fixtures.cjs');

test('private notes follow the ballot and update the moderator inbox live', async ({ page, browser, rooms, request }) => {
  const room = await rooms.create('Private feedback', 'Agreement');
  const path = `/discussion/${room.slug}`;
  await page.goto(`${path}?admin=${room.adminToken}`);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('button', { name: 'Save', exact: true }).locator('../..');
  await editor.getByRole('combobox').selectOption('Multiple Choice');
  await editor.getByPlaceholder('Option 1').fill('Blue');
  await editor.getByPlaceholder('Option 2').fill('Red');
  for (const name of ['Ask for clarification', 'Explain my vote', 'Suggest a missing answer']) await editor.getByRole('checkbox', { name }).check();
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: /Moderator notes/ })).toBeVisible();
  const context = await browser.newContext();
  try {
    const guest = await context.newPage();
    await guest.goto(path);
    const summary = name => guest.locator('summary').filter({ hasText: name });
    async function send(name, text) {
      const form = guest.locator('details').filter({ has: summary(name) });
      await summary(name).click();
      await form.getByRole('textbox').fill(text);
      await form.getByRole('button', { name: 'Send privately' }).click();
      await expect(form.getByRole('status')).toHaveText('Sent privately to moderators.');
    }
    await expect(summary('Explain my vote')).toHaveCount(0);
    await send('Ask for clarification', 'Which palette?');
    await expect(page.getByText('New private note', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Moderator notes/ }).click();
    await expect(page.getByText('Which palette?', { exact: true })).toBeVisible();
    await send('Suggest a missing answer', 'Violet');
    await expect(page.getByText('Violet', { exact: true })).toBeVisible();
    const vote = color => guest.getByRole('button', { name: `Vote ${color} on "Private feedback question"` });
    await expect(vote('Violet')).toHaveCount(0);
    await vote('Blue').click();
    await expect(summary('Ask for clarification')).toHaveCount(0);
    await send('Explain my vote', 'Matches the sky');
    await expect(page.getByText('Matches the sky', { exact: true })).toBeVisible();
    await vote('Red').click();
    await expect(page.getByText('Matches the sky', { exact: true })).toHaveCount(0);
    await send('Explain my vote', 'Matches the sign');
    await expect(page.getByText('Matches the sign', { exact: true })).toBeVisible();
    await vote('Red').click();
    await expect(page.getByText('Matches the sign', { exact: true })).toHaveCount(0);
    await expect(summary('Explain my vote')).toHaveCount(0);
    await expect(summary('Ask for clarification')).toBeVisible();
    await expect(guest.getByRole('button', { name: /Moderator notes/ })).toHaveCount(0);
    const response = await request.get(`/api/discussions/${room.slug}/export.json`);
    expect(response.ok()).toBeTruthy();
    expect(await response.text()).not.toMatch(/Which palette|Matches the sky|Violet/);
  } finally { await context.close(); }
});

test('composer saves selected tools and drops choices ineligible for the final type', async ({ page, rooms }) => {
  const room = await rooms.create('Composer');
  await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
  const composer = page.locator('form').filter({ has: page.getByPlaceholder('Enter a new question or statement') });
  await composer.getByPlaceholder('Enter a new question or statement').fill('Which color fits?');
  await composer.getByRole('combobox').selectOption('Multiple Choice');
  const suggestion = composer.getByRole('checkbox', { name: 'Suggest a missing answer' });
  await expect(suggestion).not.toBeChecked();
  await suggestion.check();
  await composer.getByRole('checkbox', { name: 'Explain my vote' }).check();
  await composer.getByRole('combobox').selectOption('Numerical');
  await expect(suggestion).toHaveCount(0);
  await composer.getByRole('button', { name: 'Add Question', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Which color fits?' })).toBeVisible();
  expect((await rooms.pool.query('SELECT tools FROM questions WHERE discussion_id=$1 AND type=$2', [room.id, 'Numerical'])).rows)
    .toEqual([{ tools: ['explanation'] }]);
});

test('socket enforces note settings, identity, timing, locks, scope, and moderator-only reads', async ({ baseURL, rooms }) => {
  const room = await rooms.create('Policy', 'Yes/No');
  const { rows: [{ id }] } = await rooms.pool.query("UPDATE questions SET tools='{clarification,explanation}' WHERE discussion_id=$1 RETURNING id", [room.id]);
  const guest = io(baseURL, { autoConnect: false });
  const owner = io(baseURL, { autoConnect: false });
  const privateEvents = [];
  guest.on('questionNotesChanged', data => privateEvents.push(data));
  const call = (socket, event, ...args) => socket.timeout(5000).emitWithAck(event, room.slug, ...args);
  const send = (kind, body, extra) => call(guest, 'submitQuestionNote', id, { kind, body, ...extra });
  try {
    for (const [socket, user] of [[guest, 'guest'], [owner, 'owner']]) {
      const ready = new Promise(resolve => socket.once('discussionState', resolve));
      socket.connect().emit('joinDiscussion', room.slug);
      socket.emit('identify', room.slug, user);
      await ready;
    }
    expect(await call(guest, 'addQuestion', { type: 'Yes/No', text: 'Unauthorized tool', tools: ['explanation'] }, true, null)).toMatchObject({ added: false, reason: 'not_authorized' });
    expect(await send('explanation', 'Too soon')).toMatchObject({ ok: false });
    expect(await send('suggestion', 'Maybe')).toMatchObject({ ok: false });
    expect(await send('clarification', '  ')).toMatchObject({ ok: false });
    expect(await send('clarification', 'One')).toMatchObject({ ok: true });
    expect(await send('clarification', 'Two')).toMatchObject({ ok: true });
    expect(await call(guest, 'getQuestionNotes', id, {})).toMatchObject({ ok: false });
    const read = () => call(owner, 'getQuestionNotes', id, { token: room.adminToken });
    expect((await read()).notes.map(note => note.body)).toEqual(['Two']);
    expect(await call(guest, 'vote', id, 'Yes', 'guest', 'Guest')).toMatchObject({ ok: true });
    const { rows: [vote] } = await rooms.pool.query('SELECT id FROM votes WHERE question_id=$1', [id]);
    expect(await send('clarification', 'Too late')).toMatchObject({ ok: false });
    expect(await send('explanation', 'Stale', { voteId: vote.id, voteValue: 'No' })).toMatchObject({ ok: false });
    expect(await call(owner, 'submitQuestionNote', id, { kind: 'explanation', body: 'Not mine', voteId: vote.id, voteValue: 'Yes', userId: 'guest' })).toMatchObject({ ok: false });
    expect(await send('explanation', 'Current', { voteId: vote.id, voteValue: 'Yes' })).toMatchObject({ ok: true });
    expect(await call(guest, 'vote', id, 'Yes', 'guest', 'Guest')).toMatchObject({ ok: true });
    expect((await read()).notes.map(note => note.body)).toEqual(['Two', 'Current']);
    await rooms.pool.query('UPDATE discussions SET locked=true WHERE id=$1', [room.id]);
    expect(await send('explanation', 'Locked', { voteId: vote.id, voteValue: 'Yes' })).toMatchObject({ ok: false, reason: 'locked' });
    await rooms.pool.query('UPDATE questions SET queued=true WHERE id=$1', [id]);
    expect(await send('clarification', 'Queued')).toMatchObject({ ok: false, reason: 'unavailable' });
    const other = await rooms.create('Other room');
    expect(await call(guest, 'getQuestionNotes', id, { token: other.adminToken })).toMatchObject({ ok: false });
    expect(privateEvents).toEqual([]);
  } finally { guest.disconnect(); owner.disconnect(); }
});
