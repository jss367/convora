const { test, expect } = require('./lifecycle-fixtures.cjs');

test('a moderator arranges submitted questions live without overriding personal sorts', async ({ page, browser, rooms }) => {
  const room = await rooms.create('First');
  await rooms.pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Second question', 'Agreement')", [room.id]);
  const url = `/discussion/${room.slug}`;
  const viewer = await browser.newContext();
  try {
    const participant = await viewer.newPage();
    await participant.goto(url);
    await page.goto(`${url}?admin=${room.adminToken}`);
    const headings = participant.getByRole('heading', { level: 2 });
    await expect(headings).toHaveText(['Second question', 'First question']);
    await expect(participant.getByRole('button', { name: 'Move up: First question' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Move up: First question' }).click();
    await expect(headings).toHaveText(['First question', 'Second question']);
    await participant.reload();
    await expect(headings).toHaveText(['First question', 'Second question']);
    await participant.getByLabel('Sort submitted questions').selectOption('Most Recent');
    await expect(headings).toHaveText(['Second question', 'First question']);
    await expect(page.getByRole('button', { name: 'Move up: First question' })).toBeDisabled();
  } finally {
    await viewer.close();
  }
});
