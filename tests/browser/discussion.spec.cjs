const { test, expect } = require('./lifecycle-fixtures.cjs');

test('participants can add responses when secure-context randomUUID is unavailable', async ({ page, rooms }) => {
  const room = await rooms.create('Insecure-context response');
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
  await page.goto(`/discussion/${room.slug}`);
  const draft = page.getByPlaceholder('Enter a response');
  await draft.fill('A response without randomUUID');
  await page.getByRole('button', { name: 'Add Response', exact: true }).click();
  const response = page.getByRole('listitem').getByText('A response without randomUUID', { exact: true });
  await expect(response).toBeVisible();
  await expect(draft).toHaveValue('');
  await page.reload();
  await expect(response).toBeVisible();
});

test('a moderator can remove their own response while voting is locked', async ({ page, rooms }) => {
  const room = await rooms.create('Locked moderator response');
  await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
  await page.getByPlaceholder('Enter a response').fill('Moderator response');
  await page.getByRole('button', { name: 'Add Response', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Delete', exact: true }).last()).toBeVisible();
  await rooms.pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [room.id]);
  await page.reload();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(page.getByText('Moderator response', { exact: true })).toHaveCount(0);
});

test('legacy upvotes remain visible without enabling hidden response feedback', async ({ page, rooms }) => {
  const room = await rooms.create('Legacy response feedback');
  const vote = (await rooms.pool.query("INSERT INTO votes (question_id, user_id, value) SELECT id, 'legacy-author', 'Legacy answer' FROM questions WHERE discussion_id = $1 RETURNING id", [room.id])).rows[0];
  await rooms.pool.query("INSERT INTO response_votes (response_id, user_id) VALUES ($1, 'legacy-voter')", [vote.id]);
  await rooms.pool.query("INSERT INTO response_ratings (response_id, user_id, quality) VALUES ($1, 'legacy-voter', 1)", [vote.id]);
  await rooms.pool.query('UPDATE discussions SET reactions_enabled = FALSE, reactions_visible = FALSE WHERE id = $1', [room.id]);
  for (const suffix of ['', '/display']) {
    await page.goto(`/discussion/${room.slug}${suffix}`);
    await expect(page.getByText('Legacy answer', { exact: true })).toBeVisible();
    await expect(page.getByLabel('1 legacy upvote', { exact: true })).toBeVisible();
  }
  // Existing hidden ratings must stay hidden; preserving old upvotes must not
  // enable all feedback in a discussion containing other free-text questions.
  await rooms.pool.query('UPDATE discussions SET reactions_enabled = TRUE WHERE id = $1', [room.id]);
  await page.reload();
  await expect(page.getByLabel('1 legacy upvote', { exact: true })).toHaveCount(0);
});

test('an open-ended edit survives another participant responding', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Draft preservation');
  const context = await browser.newContext();
  try {
    await page.goto(`/discussion/${room.slug}`);
    await page.getByPlaceholder('Enter a response').fill('Original answer');
    await page.getByRole('button', { name: 'Add Response', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('textbox', { name: 'Edit response', exact: true });
    await edit.fill('An unfinished edit worth keeping');
    const other = await context.newPage();
    await other.goto(page.url());
    await other.getByPlaceholder('Enter a response').fill('Another perspective');
    await other.getByRole('button', { name: 'Add Response', exact: true }).click();
    await expect(page.getByText('Another perspective', { exact: true })).toBeVisible();
    await expect(edit).toHaveValue('An unfinished edit worth keeping');
    await page.getByRole('button', { name: 'Save response', exact: true }).click();
    await expect(edit).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('An unfinished edit worth keeping', { exact: true })).toBeVisible();
    await expect(page.getByText('Original answer', { exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

for (const editing of [false, true]) {
  test(`a draft typed during a delayed ${editing ? 'edit' : 'submission'} is preserved`, async ({ page, rooms }) => {
    const room = await rooms.create('Delayed response');
    await page.goto(`/discussion/${room.slug}`);
    let input = page.getByPlaceholder('Enter a response');
    if (editing) {
      await input.fill('Original answer');
      await page.getByRole('button', { name: 'Add Response', exact: true }).click();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      input = page.getByRole('textbox', { name: 'Edit response', exact: true });
    }
    await input.fill('Submitted answer');
    const blocker = await rooms.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE votes IN SHARE MODE');
      await page.getByRole('button', { name: editing ? 'Save response' : 'Add Response', exact: true }).click();
      await input.fill('Newer draft');
      await blocker.query('COMMIT');
      await expect(page.getByRole('button', { name: editing ? 'Save response' : 'Add Response', exact: true })).toBeEnabled();
      await expect(input).toHaveValue('Newer draft');
      await expect(input).toBeFocused();
      await page.getByRole('button', { name: editing ? 'Save response' : 'Add Response', exact: true }).click();
      await expect(page.getByText('Newer draft', { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText('Newer draft', { exact: true })).toBeVisible();
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  });
}

test('a saved response reflects edits from another tab', async ({ page, context, rooms }) => {
  const room = await rooms.create('Shared response');
  await page.goto(`/discussion/${room.slug}`);
  await page.getByPlaceholder('Enter a response').fill('Original answer');
  await page.getByRole('button', { name: 'Add Response', exact: true }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Edit response', exact: true })).toHaveCount(0);
  const other = await context.newPage();
  await other.goto(page.url());
  await other.getByRole('button', { name: 'Edit', exact: true }).click();
  await other.getByRole('textbox', { name: 'Edit response', exact: true }).fill('Updated elsewhere');
  await other.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect(page.getByText('Updated elsewhere', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Edit response', exact: true })).toHaveValue('Updated elsewhere');
});

test('a response limit blocks additions but still permits editing and deleting', async ({ page, rooms }) => {
  const room = await rooms.create('Limited responses');
  await rooms.pool.query('UPDATE questions SET max_responses = 1, show_attribution = FALSE WHERE discussion_id = $1', [room.id]);
  await page.goto(`/discussion/${room.slug}`);
  await page.getByPlaceholder('Enter a response').fill('One response');
  await page.getByRole('button', { name: 'Add Response', exact: true }).click();
  await expect(page.getByText('You have reached the limit', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Response', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit response', exact: true }).fill('Changed response');
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect(page.getByText('Changed response', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add Response', exact: true })).toBeVisible();
});

test('creators configure response limits and attribution on the unified question type', async ({ page, rooms }) => {
  const room = await rooms.create('Creation settings', 'Yes/No');
  await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
  const picker = page.getByRole('combobox').filter({ has: page.locator('option[value="Open Ended"]') });
  await expect(picker.locator('option[value="Brainstorm"]')).toHaveCount(0);
  await picker.selectOption('Open Ended');
  const limit = page.getByLabel('Maximum responses per person (blank for unlimited)');
  const attribution = page.getByLabel('Show author pseudonyms');
  await expect(limit).toHaveValue('');
  await expect(attribution).toBeChecked();
  await page.getByPlaceholder('Enter a new question or statement').fill('Suggestions for next year');
  await limit.fill('2');
  await attribution.uncheck();
  await page.getByRole('button', { name: 'Add Question', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Suggestions for next year', exact: true })).toBeVisible();
  const stored = await rooms.pool.query('SELECT max_responses, show_attribution FROM questions WHERE discussion_id = $1 AND type = $2', [room.id, 'Open Ended']);
  expect(stored.rows).toEqual([{ max_responses: 2, show_attribution: false }]);
  await page.reload();
  // Newly created questions appear first.
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
  await expect(page.getByLabel('Maximum responses per person (blank for unlimited)').last()).toHaveValue('2');
  await page.getByLabel('Maximum responses per person (blank for unlimited)').last().fill('3');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await rooms.pool.query("SELECT max_responses FROM questions WHERE discussion_id = $1 AND type = 'Open Ended'", [room.id])).rows[0].max_responses).toBe(3);
});
