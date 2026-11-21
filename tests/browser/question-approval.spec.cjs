const { test, expect } = require('./lifecycle-fixtures.cjs');

test('participants can suggest questions for moderator approval', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Question approval');
  await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
  const mode = page.getByRole('combobox', { name: 'Question posting' });
  await mode.selectOption('approval');
  const participant = await browser.newPage();
  try {
    await participant.goto(new URL(`/discussion/${room.slug}`, page.url()).href);
    const suggest = participant.getByRole('button', { name: 'Suggest Question', exact: true });
    await expect(suggest).toBeVisible();
    await page.reload();
    await expect(mode).toHaveValue('approval');
    const text = 'Where should we meet next week?';
    await participant.getByPlaceholder('Enter a new question or statement').fill(text);
    await suggest.click();
    await expect(participant.getByText('Suggestion sent to the moderators for review.')).toBeVisible();
    await expect(participant.getByText(text, { exact: true })).toHaveCount(0);
    const item = page.getByTestId('queued-question').filter({ hasText: text });
    await expect(item.getByText('Participant suggestion')).toBeVisible();
    await item.getByRole('button', { name: 'Approve and publish' }).click();
    await expect(item).toHaveCount(0);
    await expect(participant.getByText(text, { exact: true })).toBeVisible();
  } finally {
    await participant.close();
  }
});
