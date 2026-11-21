const { test, expect } = require('./lifecycle-fixtures.cjs');

test('personal question filters combine independently of the live room display filter', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Reflection');
  await rooms.pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Poll', 'Agreement')", [room.id]);
  const path = `/discussion/${room.slug}`;
  const participant = await browser.newPage();
  const display = await browser.newPage();
  try {
    await participant.goto(path);
    await page.goto(`${path}?admin=${room.adminToken}`);
    await display.goto(`${path}/display`);
    const personal = participant.getByRole('combobox', { name: 'Question type', exact: true });
    const projected = page.getByRole('combobox', { name: 'Display question type' });
    const cards = display.getByTestId('display-question');
    await personal.selectOption('Agreement');
    await expect(participant.getByRole('heading', { name: 'Reflection question' })).toHaveCount(0);
    await expect(cards).toHaveCount(2);
    await projected.selectOption('Open Ended');
    await expect(cards).toHaveCount(1);
    await expect(cards.getByRole('heading')).toHaveText('Reflection question');
    await display.reload();
    await expect(cards).toHaveCount(1);
    await expect(cards.getByRole('heading')).toHaveText('Reflection question');
    await participant.getByRole('button', { name: 'Vote Strongly Agree on "Poll"', exact: true }).click();
    await participant.getByLabel('Show questions I haven’t answered').check();
    await expect(participant.getByText('No questions match your filters.')).toBeVisible();
    await personal.selectOption('all');
    await expect(participant.getByRole('heading', { level: 2 })).toHaveText(['Reflection question']);
    await projected.selectOption('Numerical');
    await expect(display.getByText('No Numerical questions on display')).toBeVisible();
    await projected.selectOption('all');
    await expect(cards).toHaveCount(2);
  } finally {
    await participant.close();
    await display.close();
  }
});
