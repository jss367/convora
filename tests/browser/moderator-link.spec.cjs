const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test';
const PANEL_NAME = 'Save your moderator link';

async function createFromHomePage(page, topic) {
  await page.goto('/');
  await page.getByPlaceholder('Enter discussion topic').fill(topic);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Discussion: ${topic}`, exact: true })).toBeVisible();
}

async function deleteDiscussion(topic) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query('DELETE FROM discussions WHERE topic = $1', [topic]);
  } finally {
    await pool.end();
  }
}

test('the creator is prompted once to save the moderator link, and copying clears the reminder', async ({ page, context, browser }) => {
  const topic = `Moderator link ${Date.now()} ${Math.random().toString(16).slice(2)}`;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const participantContext = await browser.newContext();
  const secondDeviceContext = await browser.newContext();
  try {
    await createFromHomePage(page, topic);
    const panel = page.getByRole('region', { name: PANEL_NAME });
    const toolbarCopy = page.getByRole('button', { name: /^(Copy moderator link|Link copied!)/ }).last();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Copy moderator link' })).toBeFocused();
    await expect(toolbarCopy).toContainText('not saved yet');

    // Copying from the panel puts the real moderator link on the clipboard
    // and clears the reminder on the toolbar button too.
    await page.keyboard.press('Enter');
    await expect(panel.getByRole('status')).toHaveText(/Moderator link copied/);
    const copiedLink = await page.evaluate(() => navigator.clipboard.readText());
    expect(copiedLink).toBe(`${page.url()}?admin=${await page.evaluate(
      slug => localStorage.getItem(`convora_admin_${slug}`), new URL(page.url()).pathname.split('/').pop()
    )}`);
    await expect(page.getByText('not saved yet')).toHaveCount(0);

    // A reload keeps moderator rights but does not show the panel again.
    await page.reload();
    await expect(page.getByText("You're the moderator")).toBeVisible();
    await expect(page.getByRole('region', { name: PANEL_NAME })).toHaveCount(0);
    await expect(page.getByText('not saved yet')).toHaveCount(0);

    // A participant never sees the panel or the reminder.
    const participant = await participantContext.newPage();
    await participant.goto(page.url());
    await expect(participant.getByRole('heading', { name: `Discussion: ${topic}`, exact: true })).toBeVisible();
    await expect(participant.getByRole('region', { name: PANEL_NAME })).toHaveCount(0);
    await expect(participant.getByText('not saved yet')).toHaveCount(0);

    // Someone arriving through the moderator link moderates without the
    // creation panel.
    const secondDevice = await secondDeviceContext.newPage();
    await secondDevice.goto(copiedLink);
    await expect(secondDevice.getByText("You're the moderator")).toBeVisible();
    await expect(secondDevice.getByRole('region', { name: PANEL_NAME })).toHaveCount(0);
  } finally {
    await participantContext.close();
    await secondDeviceContext.close();
    await deleteDiscussion(topic);
  }
});

test('when the clipboard refuses, the moderator link is shown selected for manual copying', async ({ page }) => {
  const topic = `Moderator link fallback ${Date.now()} ${Math.random().toString(16).slice(2)}`;
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) },
    });
  });
  try {
    await createFromHomePage(page, topic);
    const panel = page.getByRole('region', { name: PANEL_NAME });
    await panel.getByRole('button', { name: 'Copy moderator link' }).click();

    const field = panel.getByRole('textbox');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(/\/discussion\/[^?]+\?admin=.+/);
    expect(await field.evaluate(el => el.readOnly && el.selectionStart === 0 && el.selectionEnd === el.value.length)).toBe(true);
    await expect(page.getByText('not saved yet')).toBeVisible();

    // Escape dismisses the panel and returns focus to the toolbar button,
    // which still carries the reminder and can bring the link back.
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    const toolbarCopy = page.getByRole('button', { name: /^Copy moderator link/ });
    await expect(toolbarCopy).toBeFocused();
    await expect(toolbarCopy).toContainText('not saved yet');

    await page.reload();
    await expect(page.getByText("You're the moderator")).toBeVisible();
    await expect(panel).toHaveCount(0);
    await toolbarCopy.click();
    await expect(panel.getByRole('textbox')).toBeFocused();

    // Copying the selected link by hand counts as saving it.
    await panel.getByRole('textbox').dispatchEvent('copy');
    await expect(page.getByText('not saved yet')).toHaveCount(0);
  } finally {
    await deleteDiscussion(topic);
  }
});
