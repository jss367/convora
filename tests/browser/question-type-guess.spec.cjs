const { test, expect } = require('./lifecycle-fixtures.cjs');

for (const guessed of [false, true]) {
  test(`confirming the ${guessed ? 'guessed' : 'default'} type without changing its value locks the choice`, async ({ page, rooms }) => {
    const room = await rooms.create('Confirmed type');
    await page.goto(`/discussion/${room.slug}`);
    const input = page.getByPlaceholder('Enter a new question or statement');
    const picker = page.getByRole('combobox').filter({ has: page.locator('option[value="Numerical"]') });
    if (guessed) await input.fill('How many seats do we need?');
    const chosen = guessed ? 'Numerical' : 'Agreement';
    await expect(picker).toHaveValue(chosen);
    await picker.focus();
    await picker.press('Space');
    await picker.press('Enter');
    await input.fill('Why did the plan change?');
    await expect(picker).toHaveValue(chosen);
    await expect(page.getByRole('status').filter({ hasText: 'based on your wording' })).toHaveCount(0);
  });
}

test('the type picker follows the wording until the author chooses a type', async ({ page, rooms }) => {
  const room = await rooms.create('Type guess');
  await page.goto(`/discussion/${room.slug}`);
  const input = page.getByPlaceholder('Enter a new question or statement');
  const typePicker = page.getByRole('combobox').filter({ has: page.locator('option[value="Numerical"]') });
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
