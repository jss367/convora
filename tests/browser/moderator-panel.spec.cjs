const { test, expect } = require('./lifecycle-fixtures.cjs');

const PHONE = { width: 390, height: 664 };

test('moderator switches show the current setting and keep it after a reload', async ({ page, rooms }) => {
  const room = await rooms.create('Moderator switches');
  await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
  const locked = page.getByRole('switch', { name: 'Locked', exact: true });
  const banner = page.getByText('This discussion is locked.', { exact: false });
  await expect(locked).toHaveAttribute('aria-checked', 'false');
  await expect(banner).toHaveCount(0);

  await locked.click();
  await expect(locked).toHaveAttribute('aria-checked', 'true');
  await expect(banner).toBeVisible();

  // The label next to a switch works it too.
  await page.getByText('Locked', { exact: true }).click();
  await expect(locked).toHaveAttribute('aria-checked', 'false');
  await expect(banner).toHaveCount(0);

  // "Reactions open" only applies while reactions are on.
  const reactions = page.getByRole('switch', { name: 'Reactions', exact: true });
  const reactionsOpen = page.getByRole('switch', { name: 'Reactions open', exact: true });
  await expect(reactionsOpen).toHaveCount(0);
  await reactions.click();
  await expect(reactions).toHaveAttribute('aria-checked', 'true');
  await expect(reactionsOpen).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('group', { name: 'Reaction set', exact: true })).toBeVisible();

  await page.reload();
  await expect(reactions).toHaveAttribute('aria-checked', 'true');
  await expect(locked).toHaveAttribute('aria-checked', 'false');
});

test('the moderator panel collapses to a summary and stays collapsed', async ({ page, rooms }) => {
  const room = await rooms.create('Moderator collapse');
  await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
  const locked = page.getByRole('switch', { name: 'Locked', exact: true });
  await expect(locked).toHaveAttribute('aria-checked', 'false');
  await locked.click();
  await expect(locked).toHaveAttribute('aria-checked', 'true');

  const hide = page.getByRole('button', { name: 'Hide controls', exact: true });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  await hide.click();
  const show = page.getByRole('button', { name: 'Show controls', exact: true });
  await expect(show).toHaveAttribute('aria-expanded', 'false');
  await expect(show).toBeFocused();
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByText('Locked · Unlisted · Results after voting', { exact: false })).toBeVisible();
  // The reminder to save the moderator link survives collapsing.
  await expect(page.getByText('not saved yet')).toBeVisible();

  await page.reload();
  await expect(page.getByText("You're the moderator")).toBeVisible();
  await expect(show).toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(0);

  await show.click();
  await expect(locked).toHaveAttribute('aria-checked', 'true');
});

test('a moderator renames the discussion from the button beside its title', async ({ page, rooms }) => {
  const room = await rooms.create('Moderator rename');
  const renamed = `Renamed room ${Date.now()}`;
  await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
  await expect(page.getByText("You're the moderator")).toBeVisible();
  const rename = page.getByRole('button', { name: 'Rename discussion', exact: true });
  await rename.click();
  const field = page.getByRole('textbox', { name: 'Discussion name', exact: true });
  await expect(field).toBeFocused();
  await field.fill(renamed);
  await field.press('Enter');
  await expect(page.getByRole('heading', { name: `Discussion: ${renamed}`, exact: true })).toBeVisible();
  await expect(rename).toBeFocused();

  // Participants get no rename button.
  await page.goto(`/discussion/${room.slug}`);
  await page.evaluate(slug => localStorage.removeItem(`convora_admin_${slug}`), room.slug);
  await page.reload();
  await expect(page.getByRole('heading', { name: `Discussion: ${renamed}`, exact: true })).toBeVisible();
  await expect(rename).toHaveCount(0);
});

test.describe('on a phone', () => {
  test.use({ viewport: PHONE });

  test('the moderator panel starts collapsed and fits the screen when opened', async ({ page, rooms }) => {
    const room = await rooms.create('Moderator phone');
    await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
    const show = page.getByRole('button', { name: 'Show controls', exact: true });
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('switch')).toHaveCount(0);

    await show.click();
    await expect(page.getByRole('switch', { name: 'Locked', exact: true })).toBeVisible();
    await expect(page.getByLabel('Display QR')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  });
});
