const { test, expect } = require('./lifecycle-fixtures.cjs');

test('a moderator can set a question aside on the display while participants keep voting', async ({ page: display, browser, rooms, request }) => {
  const room = await rooms.create('Set aside', 'Agreement');
  const path = `/discussion/${room.slug}`;
  const save = await request.post(`/api/discussions/${room.slug}/snapshots`, { data: { name: 'Before', adminToken: room.adminToken } });
  expect(save.ok()).toBeTruthy();
  const moderator = await browser.newPage();
  const participant = await browser.newPage();
  try {
    await moderator.goto(`${path}?admin=${room.adminToken}`);
    await participant.goto(path);
    await display.goto(`${path}/display`);
    const layout = moderator.getByRole('combobox', { name: 'Display shows', exact: true });
    const question = display.getByRole('heading', { name: 'Set aside question', exact: true });
    await expect(question).toBeVisible();
    await moderator.getByRole('button', { name: 'Show on display', exact: true }).click();
    await expect(moderator.getByRole('button', { name: 'Back to all questions', exact: true })).toBeVisible();
    await moderator.getByRole('button', { name: 'Hide from display' }).click();
    await expect(display.getByText('No questions on display')).toBeVisible();
    await expect(layout).toHaveValue('all');
    await display.reload();
    await expect(display.getByText('No questions on display')).toBeVisible();
    const vote = participant.getByRole('button', { name: 'Vote Agree on "Set aside question"', exact: true });
    await vote.click();
    await expect(vote).toHaveAttribute('aria-pressed', 'true');
    await expect(participant.getByRole('button', { name: 'Restore to display' })).toHaveCount(0);
    await layout.selectOption('focus');
    await expect(question).toHaveCount(0);
    await layout.selectOption('compare');
    await expect(display.getByTestId('display-comparison-view').getByText('No questions on display')).toBeVisible();
    await moderator.getByRole('button', { name: 'Restore to display' }).click();
    await expect(display.getByTestId('display-comparison')).toContainText('Set aside question');
    await layout.selectOption('all');
    await expect(question).toBeVisible();
    await expect(display.getByText('1 response', { exact: true })).toBeVisible();
  } finally {
    await moderator.close();
    await participant.close();
  }
});
