const { test, expect } = require('./lifecycle-fixtures.cjs');

const interestButton = (page, text) => page.getByRole('button', { name: `Upvote "${text}"`, exact: true });
const questionOrder = page => page.getByRole('heading', { level: 2 }).allTextContents();

test('participants mark questions as interesting and sort the list by that count', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Newer', 'Agreement');
  await rooms.pool.query(
    "INSERT INTO questions (discussion_id, text, type, created_at) VALUES ($1, 'Older question', 'Open Ended', now() - interval '1 hour')",
    [room.id]
  );
  const context = await browser.newContext();
  try {
    await page.goto(`/discussion/${room.slug}`);
    await expect(interestButton(page, 'Older question')).toHaveAttribute('aria-pressed', 'false');
    await expect(interestButton(page, 'Older question')).toHaveAccessibleDescription('0 upvotes');
    expect(await questionOrder(page)).toEqual(['Newer question', 'Older question']);

    await interestButton(page, 'Older question').click();
    await expect(interestButton(page, 'Older question')).toHaveAttribute('aria-pressed', 'true');
    await expect(interestButton(page, 'Older question')).toHaveAccessibleDescription('1 upvote');
    // The default order does not change until the participant picks the sort.
    expect(await questionOrder(page)).toEqual(['Newer question', 'Older question']);
    await page.getByRole('combobox').filter({ has: page.locator('option[value="Most Interesting"]') }).selectOption('Most Interesting');
    await expect.poll(() => questionOrder(page)).toEqual(['Older question', 'Newer question']);

    // Another participant sees the count, but not as their own mark.
    const other = await context.newPage();
    await other.goto(page.url());
    await expect(interestButton(other, 'Older question')).toHaveAccessibleDescription('1 upvote');
    await expect(interestButton(other, 'Older question')).toHaveAttribute('aria-pressed', 'false');
    await interestButton(other, 'Newer question').click();
    await interestButton(other, 'Older question').click();
    await expect(interestButton(page, 'Older question')).toHaveAccessibleDescription('2 upvotes');
    await expect(interestButton(page, 'Newer question')).toHaveAccessibleDescription('1 upvote');
    await expect(interestButton(page, 'Newer question')).toHaveAttribute('aria-pressed', 'false');

    // Removing a mark reorders the list for everyone sorting by interest.
    await interestButton(page, 'Older question').click();
    await expect(interestButton(page, 'Older question')).toHaveAttribute('aria-pressed', 'false');
    await expect(interestButton(page, 'Older question')).toHaveAccessibleDescription('1 upvote');
    await interestButton(other, 'Older question').click();
    await expect.poll(() => questionOrder(page)).toEqual(['Newer question', 'Older question']);

    // A participant's own mark is still shown as theirs after a reload.
    await other.reload();
    await expect(interestButton(other, 'Newer question')).toHaveAttribute('aria-pressed', 'true');
    await expect(interestButton(other, 'Older question')).toHaveAttribute('aria-pressed', 'false');

    // Locking the discussion closes interest marks along with voting.
    await rooms.pool.query('UPDATE discussions SET locked = TRUE WHERE id = $1', [room.id]);
    await other.reload();
    await expect(interestButton(other, 'Newer question')).toBeDisabled();
    await expect(interestButton(other, 'Newer question')).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await context.close();
  }
});

test('a moderator can enable and hide question downvotes live', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Downvote');
  const participant = await browser.newPage();
  try {
    await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
    await participant.goto(`/discussion/${room.slug}`);
    const toggle = page.getByRole('switch', { name: 'Allow question downvotes' });
    const up = interestButton(participant, 'Downvote question');
    const down = participant.getByRole('button', { name: 'Downvote "Downvote question"' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await up.click();
    await expect(down).toHaveCount(0);
    await toggle.click();
    await down.click();
    await expect(up).toHaveAccessibleDescription('0 upvotes');
    await expect(down).toHaveAccessibleDescription('1 downvote');
    await participant.reload();
    await expect(down).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(down).toHaveCount(0);
    await toggle.click();
    await expect(down).toHaveAttribute('aria-pressed', 'true');
    await down.click();
    await expect(down).toHaveAccessibleDescription('0 downvotes');
  } finally { await participant.close(); }
});

for (const role of ['participant', 'moderator']) {
  test(`the interest button leaves a long question readable on a phone for a ${role}`, async ({ page, rooms }) => {
    await page.setViewportSize({ width: 390, height: 664 });
    const room = await rooms.create('Should our neighborhood association fund a new community garden and tool library next year', 'Agreement');
    await page.goto(`/discussion/${room.slug}${role === 'moderator' ? `?admin=${room.adminToken}` : ''}`);
    const heading = page.getByRole('heading', { level: 2 });
    await expect(heading).toBeVisible();
    const button = page.getByRole('button', { name: /^Upvote/ });
    await expect(button).toBeVisible();
    if (role === 'moderator') await expect(page.getByRole('button', { name: 'Pin', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const [buttonBox, headingBox] = [await button.boundingBox(), await heading.boundingBox()];
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(headingBox.x);
    // The moderator's buttons must not squeeze the title into a thin column.
    expect(headingBox.width).toBeGreaterThan(220);
  });
}
