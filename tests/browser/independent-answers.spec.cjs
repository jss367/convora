const { test, expect } = require('./lifecycle-fixtures.cjs');

test('only moderators can configure and reveal independent written answers', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Independent answers');
  const path = `/discussion/${room.slug}`;
  await page.goto(`${path}?admin=${room.adminToken}`);
  const composer = target => target.locator('form').filter({ has: target.getByPlaceholder('Enter a new question or statement') });
  const setting = target => target.getByRole('checkbox', { name: /Collect independent answers/ });
  const hostForm = composer(page);
  await hostForm.getByPlaceholder('Enter a new question or statement').fill('What would make next week easier?');
  await hostForm.getByRole('combobox').selectOption('Open Ended');
  await setting(hostForm).check();
  await hostForm.getByRole('button', { name: 'Add Question', exact: true }).click();
  const reveal = page.getByRole('button', { name: 'Reveal answers' });
  await expect(reveal).toBeVisible();
  const guest = await browser.newPage();
  try {
    await guest.goto(new URL(path, page.url()).href);
    await composer(guest).getByRole('combobox').selectOption('Open Ended');
    await expect(setting(composer(guest))).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Reveal answers' })).toHaveCount(0);
    const hostCard = page.locator('[data-question-id]').filter({ has: reveal });
    await hostCard.getByPlaceholder('Enter a response').fill('Private until reveal');
    await hostCard.getByRole('button', { name: 'Add Response' }).click();
    await expect(hostCard.getByText('Private until reveal', { exact: true })).toBeVisible();
    await guest.reload();
    await expect(guest.getByText(/Only you and the moderators/)).toBeVisible();
    await expect(guest.getByText('Private until reveal', { exact: true })).toHaveCount(0);
    await reveal.click();
    await expect(guest.getByText('Private until reveal', { exact: true })).toBeVisible();
  } finally { await guest.close(); }
});
