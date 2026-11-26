const { test, expect } = require('@playwright/test');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { Pool } = require('pg');

test('creator access follows a linked account across browsers while guests retain link access', async ({ browser, baseURL }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test' });
  const subject = randomUUID();
  const topic = 'Account linking ' + subject;
  const owner = await browser.newContext({ baseURL });
  const laptop = await browser.newContext({ baseURL });
  const outsider = await browser.newContext({ baseURL });
  const apiHeaders = { 'X-Convora-Account': '1' };

  async function signIn(context, sub) {
    // Seed the session issued after Google verification. Each browser gets a
    // different cookie even when the same Google subject signs in on both.
    const value = randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO moderator_sessions (digest, google_sub, expires_at)
      VALUES ($1, $2, now() + interval '1 hour')`, [createHash('sha256').update(value).digest('hex'), sub]);
    await context.addCookies([{ name: 'convora_session', value, url: baseURL, httpOnly: true }]);
  }

  try {
    const guestRoom = await (await owner.request.post('/api/discussions', { data: { topic } })).json();
    const roomUrl = '/discussion/' + guestRoom.slug;
    const original = await owner.newPage();
    await original.goto(roomUrl + '?admin=' + guestRoom.adminToken);
    await expect(original.getByText("You're the moderator")).toBeVisible();

    await signIn(owner, subject);
    await signIn(laptop, subject);
    await signIn(outsider, subject + '-other');
    await original.goto('/account');
    await original.getByRole('button', { name: 'Link my discussions' }).click();
    await expect(original.getByRole('link', { name: topic, exact: true })).toBeVisible();

    const newTitle = topic + ' new';
    await original.goto('/');
    await original.getByPlaceholder('Enter discussion topic').fill(newTitle);
    await original.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(original.getByText("You're the moderator")).toBeVisible();
    expect(await original.evaluate(() => localStorage.getItem('convora_admin_' + location.pathname.split('/').pop()))).toBeNull();
    const second = await laptop.newPage();
    // This browser never opened either discussion; the account supplies them.
    await second.goto('/');
    await expect(second.getByRole('heading', { name: topic, exact: true })).toBeVisible();
    await expect(second.getByRole('heading', { name: newTitle, exact: true })).toBeVisible();
    await second.goto('/account');
    await expect(second.getByRole('link', { name: newTitle, exact: true })).toBeVisible();
    await second.getByRole('link', { name: topic, exact: true }).click();
    await expect(second.getByText("You're the moderator")).toBeVisible();
    expect(await second.evaluate(slug => localStorage.getItem('convora_admin_' + slug), guestRoom.slug)).toBeNull();

    const otherRooms = await outsider.request.get('/api/account/discussions', { headers: apiHeaders });
    expect(await otherRooms.json()).toEqual([]);
    const otherAccess = await outsider.request.get('/api/account/access/' + guestRoom.slug, { headers: apiHeaders });
    expect(await otherAccess.json()).toEqual({ token: null });

    await second.goto('/account');
    await second.getByRole('button', { name: 'Sign out' }).click();
    await expect(second.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    expect((await laptop.request.get('/api/account/discussions', { headers: apiHeaders })).status()).toBe(401);
    await second.goto(roomUrl);
    await expect(second.getByRole('heading', { name: 'Discussion: ' + topic, exact: true })).toBeVisible();
    await expect(second.getByText("You're the moderator")).toHaveCount(0);
  } finally {
    await Promise.all([owner.close(), laptop.close(), outsider.close()]);
    await pool.query('DELETE FROM discussions WHERE topic = ANY($1)', [[topic, topic + ' new']]);
    await pool.query('DELETE FROM moderator_sessions WHERE google_sub = ANY($1)', [[subject, subject + '-other']]);
    await pool.end();
  }
});
