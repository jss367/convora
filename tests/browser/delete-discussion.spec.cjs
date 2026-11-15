const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');
const { assertSafeTestDatabase } = require('../../scripts/test-database');

const databaseUrl = process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test';
assertSafeTestDatabase(databaseUrl);

test('creator confirms deletion, cancellation and errors preserve the room, and viewers leave', async ({ page, browser, request }) => {
  const topic = `Delete discussion ${Date.now()}`;
  const response = await request.post('/api/discussions', { data: { topic } });
  const { id, slug, adminToken } = await response.json();
  const pool = new Pool({ connectionString: databaseUrl });
  const participantContext = await browser.newContext();
  const moderatorContext = await browser.newContext();
  try {
    await pool.query("INSERT INTO discussion_moderators (discussion_id, user_id, token) VALUES ($1, 'promoted', 'delete-test-moderator')", [id]);
    await page.goto(`/discussion/${slug}?admin=${adminToken}`);
    await page.getByRole('button', { name: 'More ▾', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete discussion', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete discussion?' });
    await expect(dialog).toContainText(topic);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'More ▾', exact: true })).toBeFocused();

    const participant = await participantContext.newPage();
    const moderator = await moderatorContext.newPage();
    await participant.goto(`/discussion/${slug}`);
    await moderator.goto(`/discussion/${slug}?admin=delete-test-moderator`);
    await expect(moderator.getByText("You're the moderator")).toBeVisible();
    for (const viewer of [participant, moderator]) {
      await viewer.getByRole('button', { name: 'More ▾', exact: true }).click();
      await expect(viewer.getByRole('menuitem', { name: 'Duplicate Discussion' })).toBeVisible();
      await expect(viewer.getByRole('menuitem', { name: 'Delete discussion', exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'More ▾', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete discussion', exact: true }).click();
    await page.route(`**/api/discussions/${slug}`, async route => {
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 500, json: { error: 'Please try again.' } });
      } else await route.continue();
    });
    await dialog.getByRole('button', { name: 'Delete discussion', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Please try again.');
    await page.unroute(`**/api/discussions/${slug}`);
    await dialog.getByRole('button', { name: 'Delete discussion', exact: true }).click();
    for (const viewer of [page, participant, moderator]) {
      await expect(viewer).toHaveURL('/');
      await expect(viewer.getByRole('status')).toHaveText('The discussion was deleted.');
      await expect(viewer.getByRole('link', { name: topic, exact: true })).toHaveCount(0);
    }
    expect(await page.evaluate(slug => localStorage.getItem(`convora_admin_${slug}`), slug)).toBeNull();
  } finally {
    await participantContext.close();
    await moderatorContext.close();
    await pool.query('DELETE FROM discussions WHERE id = $1', [id]);
    await pool.end();
  }
});
