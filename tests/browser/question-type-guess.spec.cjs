const { test, expect } = require('./lifecycle-fixtures.cjs');

test('switching away from Open Ended ignores its invalid retained limit', async ({ page, rooms }) => {
  const room = await rooms.create('Retained response setting');
  await page.goto(`/discussion/${room.slug}`);
  const picker = page.getByLabel('New question type', { exact: true });
  await picker.selectOption('Open Ended');
  await page.getByLabel('Maximum responses per person (blank for unlimited)').fill('0');
  await picker.selectOption('Agreement');
  const text = 'This prompt keeps its chosen poll type';
  await page.getByPlaceholder('Enter a new question or statement').fill(text);
  await page.getByPlaceholder('Enter a new question or statement').press('Enter');
  await expect(page.getByRole('heading', { name: text, exact: true })).toBeVisible();
  expect((await rooms.pool.query('SELECT type, max_responses FROM questions WHERE discussion_id = $1 AND text = $2', [room.id, text])).rows)
    .toEqual([{ type: 'Agreement', max_responses: null }]);
});

test('idea guesses use unified Open Ended and preserve explicitly chosen response settings', async ({ page, rooms }) => {
  const room = await rooms.create('Unified guess');
  await page.goto(`/discussion/${room.slug}`);
  const input = page.getByPlaceholder('Enter a new question or statement');
  const picker = page.getByLabel('New question type', { exact: true });
  await expect(picker.locator('option[value="Brainstorm"]')).toHaveCount(0);
  await input.fill('What are some ways to improve this?');
  await expect(picker).toHaveValue('Open Ended');
  await page.getByLabel('Maximum responses per person (blank for unlimited)').fill('3');
  await page.getByLabel('Show author pseudonyms').uncheck();
  await input.fill('How likely is this to help?');
  await expect(picker).toHaveValue('Open Ended');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect((await rooms.pool.query('SELECT type, max_responses, show_attribution FROM questions WHERE discussion_id = $1 AND text = $2', [room.id, 'How likely is this to help?'])).rows)
    .toEqual([{ type: 'Open Ended', max_responses: 3, show_attribution: false }]);
  await input.fill('How might we improve this?');
  await expect(picker).toHaveValue('Open Ended');
  await expect(page.getByLabel('Maximum responses per person (blank for unlimited)')).toHaveValue('');
  await expect(page.getByLabel('Show author pseudonyms')).toBeChecked();
});

for (const guessed of [false, true]) {
  test(`confirming the ${guessed ? 'guessed' : 'default'} type without changing its value locks the choice`, async ({ page, rooms }) => {
    const room = await rooms.create('Confirmed type');
    await page.goto(`/discussion/${room.slug}`);
    const input = page.getByPlaceholder('Enter a new question or statement');
    const picker = page.getByLabel('New question type', { exact: true });
    if (guessed) await input.fill('How many seats do we need?');
    const chosen = guessed ? 'Numerical' : 'Agreement';
    await expect(picker).toHaveValue(chosen);
    await page.evaluate(() => {
      window.typeConfirmationSubmits = 0;
      document.addEventListener('submit', () => { window.typeConfirmationSubmits += 1; });
    });
    await picker.focus();
    await picker.press('Space');
    await picker.press('Enter');
    expect(await page.evaluate(() => window.typeConfirmationSubmits)).toBe(0);
    await expect(input).toHaveValue(guessed ? 'How many seats do we need?' : '');
    await input.fill('Why did the plan change?');
    await expect(picker).toHaveValue(chosen);
    await expect(page.getByRole('status').filter({ hasText: 'based on your wording' })).toHaveCount(0);
  });
}

test('the type picker follows the wording until the author chooses a type', async ({ page, rooms }) => {
  const room = await rooms.create('Type guess');
  await page.goto(`/discussion/${room.slug}`);
  const input = page.getByPlaceholder('Enter a new question or statement');
  const typePicker = page.getByLabel('New question type', { exact: true });
  const hint = page.getByRole('status').filter({ hasText: 'based on your wording' });
  const range = page.getByRole('spinbutton');
  const storedType = async text => {
    const result = await rooms.pool.query(
      'SELECT type, min_value, max_value FROM questions WHERE discussion_id = $1 AND text = $2', [room.id, text]
    );
    expect(result.rows).toHaveLength(1);
    return result.rows[0];
  };

  await expect(typePicker).toHaveValue('Agreement');
  await expect(hint).toHaveCount(0);

  // The wording picks the type, and says so.
  await input.fill('How likely is it that we ship in June?');
  await expect(typePicker).toHaveValue('Numerical');
  await expect(hint).toHaveText(/Set to Numerical based on your wording/);
  await expect(range).toHaveCount(2);
  await expect(range.first()).toHaveValue('0');
  await expect(range.last()).toHaveValue('100');

  // Rewording keeps following: a plain statement goes back to the default.
  await input.fill('We will ship in June');
  await expect(typePicker).toHaveValue('Agreement');
  await expect(hint).toHaveCount(0);
  await input.fill('Will we ship in June?');
  await expect(typePicker).toHaveValue('Yes/No');
  await expect(hint).toHaveText(/Set to Yes\/No/);

  // Once the author picks a type, the wording no longer changes it.
  await typePicker.selectOption('Open Ended');
  await expect(hint).toHaveCount(0);
  await input.fill('How many people will come?');
  await expect(typePicker).toHaveValue('Open Ended');
  await expect(hint).toHaveCount(0);
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'How many people will come?', exact: true })).toBeVisible();
  expect((await storedType('How many people will come?')).type).toBe('Open Ended');

  // A new question starts fresh, and a guessed type is what gets posted.
  await expect(input).toHaveValue('');
  await expect(typePicker).toHaveValue('Agreement');
  await input.fill('How many seats do we need?');
  await expect(typePicker).toHaveValue('Numerical');
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'How many seats do we need?', exact: true })).toBeVisible();
  const stored = await storedType('How many seats do we need?');
  expect(stored.type).toBe('Numerical');
  expect([Number(stored.min_value), Number(stored.max_value)]).toEqual([0, 100]);

  // Editing the range is also a choice: the type stays put afterwards.
  await input.fill('How many chairs do we need?');
  await range.last().fill('500');
  await input.fill('Chairs are more important than tables');
  await expect(typePicker).toHaveValue('Numerical');
  await expect(range.last()).toHaveValue('500');
});
