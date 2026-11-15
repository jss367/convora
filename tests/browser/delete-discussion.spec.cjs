const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');
const { assertSafeTestDatabase } = require('../../scripts/test-database');

const databaseUrl = process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test';
assertSafeTestDatabase(databaseUrl);

for (const route of ['canonical', 'legacy']) {
  test(`opening a deleted ${route} route shows the deletion state`, async ({ page, request }) => {
    const topic = `Deleted late visit ${Date.now()} ${route}`;
    const created = await (await request.post('/api/discussions', { data: { topic } })).json();
    expect((await request.delete(`/api/discussions/${created.slug}`, { data: { adminToken: created.adminToken } })).ok()).toBeTruthy();
    await page.goto(`/discussion/${route === 'canonical' ? created.slug : encodeURIComponent(topic)}`);
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('status')).toHaveText('The discussion was deleted.');
    await expect(page.getByPlaceholder('Enter a new question or statement')).toHaveCount(0);
  });
}

test('a participant who missed deletion while offline leaves the room on reconnect', async ({ page, request }) => {
  const topic = `Missed deletion ${Date.now()}`;
  const created = await (await request.post('/api/discussions', { data: { topic } })).json();
  await page.goto(`/discussion/${created.slug}`);
  await expect(page.getByRole('heading', { name: `Discussion: ${topic}`, exact: true })).toBeVisible();
  await page.context().setOffline(true);
  try {
    expect((await request.delete(`/api/discussions/${created.slug}`, { data: { adminToken: created.adminToken } })).ok()).toBeTruthy();
  } finally { await page.context().setOffline(false); }
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('status')).toHaveText('The discussion was deleted.');
});

test('deleted renamed title URLs stay gone while a colliding live canonical route stays usable', async ({ page, request }) => {
  const pool = new Pool({ connectionString: databaseUrl });
  const created = await (await request.post('/api/discussions', { data: { topic: `Old title ${Date.now()}` } })).json();
  const title = `Current title ${Date.now()}`;
  const live = await (await request.post('/api/discussions', { data: { topic: `Live collision ${Date.now()}` } })).json();
  const renamed = await (await request.post('/api/discussions', { data: { topic: `Collision original ${Date.now()}` } })).json();
  try {
    await pool.query('UPDATE discussions SET topic = $1 WHERE id = $2', [title, created.id]);
    expect((await request.delete(`/api/discussions/${created.slug}`, { data: { adminToken: created.adminToken } })).ok()).toBeTruthy();
    for (const route of [title, title.toLowerCase().replace(/\s+/g, '-')]) {
      await page.goto(`/discussion/${encodeURIComponent(route)}`);
      await expect(page).toHaveURL('/');
      await expect(page.getByRole('status')).toHaveText('The discussion was deleted.');
    }
    const alias = live.topic + '!';
    await pool.query('UPDATE discussions SET topic = $1 WHERE id = $2', [alias, renamed.id]);
    expect((await request.delete(`/api/discussions/${renamed.slug}`, { data: { adminToken: renamed.adminToken } })).ok()).toBeTruthy();
    await page.goto(`/discussion/${live.slug}`);
    await expect(page.getByRole('heading', { name: `Discussion: ${live.topic}`, exact: true })).toBeVisible();
    await page.goto(`/discussion/${encodeURIComponent(alias)}`);
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('status')).toHaveText('The discussion was deleted.');
    await expect(page.getByRole('link').filter({ has: page.getByRole('heading', { name: live.topic, exact: true }) })).toBeVisible();
    await page.goto(`/discussion/${live.slug}`);
    await expect(page.getByRole('heading', { name: `Discussion: ${live.topic}`, exact: true })).toBeVisible();
  } finally {
    await pool.query('DELETE FROM discussions WHERE id = ANY($1::int[])', [[created.id, live.id, renamed.id]]);
    await pool.end();
  }
});

test('a never-created route still supports lazy question creation', async ({ page }) => {
  const slug = `never-deleted-${Date.now()}`;
  await page.goto(`/discussion/${slug}`);
  await page.getByPlaceholder('Enter a new question or statement').fill('A new statement');
  await page.getByPlaceholder('Enter a new question or statement').press('Enter');
  await expect(page.getByRole('heading', { name: 'A new statement', exact: true })).toBeVisible();
});

test('creator confirms deletion, cancellation and errors preserve the room, and viewers leave', async ({ page, browser, request }) => {
  const topic = `Delete discussion ${Date.now()}`;
  const response = await request.post('/api/discussions', { data: { topic } });
  const { id, slug, adminToken } = await response.json();
  const pool = new Pool({ connectionString: databaseUrl });
  const participantContext = await browser.newContext();
  const moderatorContext = await browser.newContext();
  const displayContext = await browser.newContext();
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
    const display = await displayContext.newPage();
    await participant.goto(`/discussion/${slug}`);
    await moderator.goto(`/discussion/${slug}?admin=delete-test-moderator`);
    await display.goto(`/discussion/${slug}/display`);
    await expect(display.getByRole('heading', { name: topic, exact: true })).toBeVisible();
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
    await expect(display.getByText('Discussion not found', { exact: true })).toBeVisible();
    await expect(display.getByRole('heading', { name: topic, exact: true })).toHaveCount(0);
  } finally {
    await participantContext.close();
    await moderatorContext.close();
    await displayContext.close();
    await pool.query('DELETE FROM discussions WHERE id = $1', [id]);
    await pool.end();
  }
});
