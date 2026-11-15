const { test, expect } = require('./lifecycle-fixtures.cjs');

async function createFromHomePage(page, topic, { listPublicly }) {
  await page.goto('/');
  await page.getByPlaceholder('Enter discussion topic').fill(topic);
  const checkbox = page.getByRole('checkbox', { name: /List publicly/ });
  await expect(checkbox).not.toBeChecked();
  if (listPublicly) await checkbox.check();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Discussion: ${topic}`, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split('/').pop();
}

test('a creator can list a discussion publicly and take it off the list', async ({ page, browser, rooms }) => {
  const suffix = `${Date.now()} ${Math.random().toString(16).slice(2)}`;
  const listedTopic = `Listed lecture ${suffix}`;
  const unlistedTopic = `Unlisted meeting ${suffix}`;
  const visitorContext = await browser.newContext();
  try {
    const listedSlug = await createFromHomePage(page, listedTopic, { listPublicly: true });
    await rooms.trackSlug(listedSlug);
    const toggle = page.getByRole('button', { name: 'Listed publicly', exact: true });
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const unlistedSlug = await createFromHomePage(page, unlistedTopic, { listPublicly: false });
    await rooms.trackSlug(unlistedSlug);
    await expect(page.getByRole('button', { name: 'List publicly', exact: true })).toHaveAttribute('aria-pressed', 'false');

    // A visitor who has never opened either sees only the listed one.
    const visitor = await visitorContext.newPage();
    await visitor.goto('/');
    await expect(visitor.getByRole('heading', { name: 'Public Discussions' })).toBeVisible();
    await expect(visitor.getByRole('link', { name: listedTopic })).toHaveAttribute('href', `/discussion/${listedSlug}`);
    await expect(visitor.getByText(unlistedTopic)).toHaveCount(0);

    // The moderator lists the second one and unlists the first.
    await page.getByRole('button', { name: 'List publicly', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Listed publicly', exact: true })).toBeVisible();
    await page.goto(`/discussion/${listedSlug}`);
    await page.getByRole('button', { name: 'Listed publicly', exact: true }).click();
    await expect(page.getByRole('button', { name: 'List publicly', exact: true })).toBeVisible();

    await visitor.reload();
    await expect(visitor.getByRole('link', { name: unlistedTopic })).toBeVisible();
    await expect(visitor.getByText(listedTopic)).toHaveCount(0);
    // Participants don't get the toggle.
    await visitor.goto(`/discussion/${unlistedSlug}`);
    await expect(visitor.getByRole('heading', { name: `Discussion: ${unlistedTopic}`, exact: true })).toBeVisible();
    await expect(visitor.getByRole('button', { name: /List(ed)? publicly/ })).toHaveCount(0);
  } finally {
    await visitorContext.close();
  }
});
