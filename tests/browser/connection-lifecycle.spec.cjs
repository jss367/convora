const { test, expect } = require('./lifecycle-fixtures.cjs');

test('a dropped connection rejoins the room without losing identity or a draft', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Reconnect');
  const connections = [];
  await page.routeWebSocket(/\/socket\.io\//, route => {
    const upstream = route.connectToServer();
    connections.push({ route, upstream });
  });
  const observerContext = await browser.newContext();
  try {
    const observer = await observerContext.newPage();
    await observer.goto(`http://127.0.0.1:4173/discussion/${room.slug}`);
    await page.goto(`/discussion/${room.slug}`);
    await expect(page.getByText('2 people here now', { exact: true })).toBeVisible();
    const answer = page.getByPlaceholder('Enter your response here');
    await answer.fill('My saved answer');
    await page.getByRole('button', { name: 'Submit Response', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Update Response', exact: true })).toBeVisible();
    await answer.fill('My unfinished draft');
    const identity = await page.evaluate(() => {
      window.lifecycleMarker = 'same-page';
      return localStorage.getItem('convora_identity');
    });
    await expect.poll(() => connections.length).toBe(1);
    await connections[0].upstream.close({ code: 1012, reason: 'Connection interruption test' });
    await connections[0].route.close({ code: 1012, reason: 'Connection interruption test' });
    await expect.poll(() => connections.length).toBeGreaterThan(1);
    await expect(page.getByText('2 people here now', { exact: true })).toBeVisible();
    await expect(observer.getByText('2 people here now', { exact: true })).toBeVisible();
    await observer.getByPlaceholder('Enter your response here').fill('Answer received after reconnect');
    await observer.getByRole('button', { name: 'Submit Response', exact: true }).click();
    await expect(page.getByRole('listitem').getByText('Answer received after reconnect', { exact: true })).toBeVisible();
    await expect(answer).toHaveValue('My unfinished draft');
    await expect(page.getByRole('button', { name: 'Update Response', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('convora_identity'))).toBe(identity);
    expect(await page.evaluate(() => window.lifecycleMarker)).toBe('same-page');
  } finally {
    await observerContext.close();
  }
});

test('switching discussions leaves the previous room and keeps responses isolated', async ({ page, browser, rooms }) => {
  const original = await rooms.create('Original room');
  const observerContext = await browser.newContext();
  try {
    const observer = await observerContext.newPage();
    await observer.goto(`http://127.0.0.1:4173/discussion/${original.slug}`);
    await page.goto(`/discussion/${original.slug}?admin=${original.adminToken}`);
    await expect(page.getByText('2 people here now', { exact: true })).toBeVisible();
    await page.getByPlaceholder('Enter your response here').fill('Original room answer');
    await page.getByRole('button', { name: 'Submit Response', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Update Response', exact: true })).toBeVisible();
    const identity = await page.evaluate(() => localStorage.getItem('convora_identity'));
    await page.getByRole('button', { name: 'More ▾', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Duplicate Discussion', exact: true }).click();
    const title = `New room ${Date.now()}`;
    await page.getByPlaceholder('Enter new topic name').fill(title);
    const duplicated = page.waitForResponse(response => response.url().endsWith('/api/duplicate-discussion') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
    const result = await (await duplicated).json();
    const copiedId = await rooms.trackSlug(result.newSlug);
    await expect(page).toHaveURL(new RegExp(`/discussion/${result.newSlug}$`));
    await expect(page.getByRole('heading', { name: `Discussion: ${title}`, exact: true })).toBeVisible();
    await expect(page.getByText('1 person here now', { exact: true })).toBeVisible();
    await expect(observer.getByText('1 person here now', { exact: true })).toBeVisible();
    await expect(page.getByRole('listitem').getByText('Original room answer', { exact: true })).toHaveCount(0);
    await page.getByPlaceholder('Enter your response here').fill('New room answer');
    await page.getByRole('button', { name: 'Submit Response', exact: true }).click();
    await expect(page.getByRole('listitem').getByText('New room answer', { exact: true })).toBeVisible();
    await observer.getByPlaceholder('Enter your response here').fill('Later original-room answer');
    await observer.getByRole('button', { name: 'Submit Response', exact: true }).click();
    await expect(observer.getByRole('listitem').getByText('Later original-room answer', { exact: true })).toBeVisible();
    await expect(page.getByRole('listitem').getByText('Later original-room answer', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('listitem').getByText('New room answer', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('convora_identity'))).toBe(identity);
    const stored = await rooms.pool.query(
      `SELECT q.discussion_id, v.value FROM votes v JOIN questions q ON v.question_id = q.id
       WHERE q.discussion_id = ANY($1::int[]) ORDER BY v.value`, [[original.id, copiedId]]
    );
    expect(stored.rows).toEqual([
      { discussion_id: original.id, value: 'Later original-room answer' },
      { discussion_id: copiedId, value: 'New room answer' },
      { discussion_id: original.id, value: 'Original room answer' },
    ]);
    // Back/forward reuse the discussion route too; old subscriptions and
    // ownership state must not survive the room transition.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/discussion/${original.slug}$`));
    await expect(page.getByPlaceholder('Enter your response here')).toHaveValue('Original room answer');
    await expect(observer.getByText('2 people here now', { exact: true })).toBeVisible();
    await expect(page.getByRole('listitem').getByText('New room answer', { exact: true })).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/discussion/${result.newSlug}$`));
    await expect(page.getByPlaceholder('Enter your response here')).toHaveValue('New room answer');
    await expect(page.getByText('1 person here now', { exact: true })).toBeVisible();
    await expect(observer.getByText('1 person here now', { exact: true })).toBeVisible();
  } finally {
    await observerContext.close();
  }
});

test('a moderator grant and revocation update controls and stored access live', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Moderator access');
  const participantContext = await browser.newContext();
  try {
    const participant = await participantContext.newPage();
    await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
    await participant.goto(`http://127.0.0.1:4173/discussion/${room.slug}`);
    await expect(page.getByText('2 people here now', { exact: true })).toBeVisible();
    await participant.getByPlaceholder('Enter your response here').fill('Participant present');
    await participant.getByRole('button', { name: 'Submit Response', exact: true }).click();
    await expect(page.getByRole('listitem').getByText('Participant present', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Only I can add questions', exact: true }).click();
    await expect(participant.getByRole('button', { name: 'Add Question', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Manage participants', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Make moderator', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Make moderator', exact: true }).click();
    await expect(participant.getByRole('button', { name: 'Lock discussion', exact: true })).toBeVisible();
    await expect(participant.getByRole('button', { name: 'Add Question', exact: true })).toBeVisible();
    await participant.getByRole('button', { name: 'Manage participants', exact: true }).click();
    await expect(participant.getByRole('button', { name: 'Hide participants', exact: true })).toBeVisible();
    await page.getByRole('listitem').filter({ hasText: 'Moderator' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(participant.getByRole('button', { name: 'Lock discussion', exact: true })).toHaveCount(0);
    await expect(participant.getByRole('button', { name: 'Hide participants', exact: true })).toHaveCount(0);
    await expect(participant.getByRole('button', { name: 'Add Question', exact: true })).toHaveCount(0);
    await expect.poll(() => participant.evaluate(slug => localStorage.getItem(`convora_admin_${slug}`), room.slug)).toBeNull();
    await expect(page.getByRole('button', { name: 'Lock discussion', exact: true })).toBeVisible();
    await participant.reload();
    await expect(participant.getByText('2 people here now', { exact: true })).toBeVisible();
    await expect(participant.getByRole('button', { name: 'Lock discussion', exact: true })).toHaveCount(0);
    await participant.getByPlaceholder('Enter your response here').fill('Still allowed to answer');
    await participant.getByRole('button', { name: 'Update Response', exact: true }).click();
    await expect(page.getByRole('listitem').getByText('Still allowed to answer', { exact: true })).toBeVisible();
  } finally {
    await participantContext.close();
  }
});
