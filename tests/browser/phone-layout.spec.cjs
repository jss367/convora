const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');

// The viewport measured in issue #82: an iPhone 13 with the browser chrome showing.
const PHONE = { width: 390, height: 664 };
const LONG_TITLE = 'Should our neighborhood association fund a new community garden and tool library next year';

const connectionString = process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test';

async function createDiscussion(request, pool, questions) {
  const response = await request.post('/api/discussions', { data: { topic: `${LONG_TITLE} ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  const discussion = await response.json();
  for (const [index, text] of questions.entries()) {
    await pool.query(
      "INSERT INTO questions (discussion_id, text, type, created_at) VALUES ($1, $2, 'Agreement', now() - ($3 * interval '1 minute'))",
      [discussion.id, text, index + 1]
    );
  }
  return discussion;
}

async function removeDiscussion(pool, discussion) {
  await pool.query('DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [discussion.id]);
  await pool.query('DELETE FROM questions WHERE discussion_id = $1', [discussion.id]);
  await pool.query('DELETE FROM discussions WHERE id = $1', [discussion.id]);
}

test.describe('on a phone', () => {
  test.use({ viewport: PHONE });

  test('a participant sees the first question without scrolling, and can still add a statement and set a name', async ({ page, request }) => {
    const pool = new Pool({ connectionString });
    const discussion = await createDiscussion(request, pool, ['The garden should come first', 'The tool library should come first']);
    try {
      await page.goto(`/discussion/${discussion.slug}`);
      const firstQuestion = page.getByRole('heading', { name: 'The garden should come first', exact: true });
      await expect(firstQuestion).toBeVisible();
      // The heading keeps its full accessible name even though the prefix is
      // visually hidden at this width.
      await expect(page.getByRole('heading', { name: `Discussion: ${discussion.topic}`, exact: true })).toBeVisible();

      const card = firstQuestion.locator('xpath=ancestor::div[contains(@class, "shadow-lg")][1]');
      const cardBox = await card.boundingBox();
      const headingBox = await firstQuestion.boundingBox();
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      expect(cardBox.y).toBeLessThan(PHONE.height);
      // Not just the card's top edge: the question text itself is on screen.
      expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(PHONE.height);

      // The composer is collapsed behind one button; expanding it focuses the
      // text box, and Enter still submits the form.
      const questionInput = page.getByPlaceholder('Enter a new question or statement');
      await expect(questionInput).toBeHidden();
      await page.getByRole('button', { name: '+ Add a statement', exact: true }).click();
      await expect(questionInput).toBeFocused();
      await expect(page.getByRole('button', { name: '+ Add a statement', exact: true })).toBeHidden();
      await questionInput.fill('Both should be funded');
      await questionInput.press('Enter');
      await expect(page.getByRole('heading', { name: 'Both should be funded', exact: true })).toHaveCount(1);
      await expect(questionInput).toHaveValue('');
      // It stays open for a second statement rather than collapsing mid-task.
      await expect(questionInput).toBeVisible();

      // Enter in the name box closes the name picker and keeps the name.
      await page.getByRole('button', { name: '(change)', exact: true }).click();
      const pickerPrompt = page.getByText('How would you like to appear?', { exact: true });
      await expect(pickerPrompt).toBeVisible();
      const nameLabel = await page.getByText('Enter your own name:', { exact: true }).boundingBox();
      expect(nameLabel.height).toBeLessThan(30); // one line
      const nameBox = page.getByPlaceholder('Your name');
      await nameBox.fill('Phone Tester');
      await nameBox.press('Enter');
      await expect(pickerPrompt).toBeHidden();
      await expect(page.getByText('You are Phone Tester')).toBeVisible();
    } finally {
      await removeDiscussion(pool, discussion);
      await pool.end();
    }
  });

  test('an empty discussion shows the composer expanded', async ({ page, request }) => {
    const pool = new Pool({ connectionString });
    const discussion = await createDiscussion(request, pool, []);
    try {
      await page.goto(`/discussion/${discussion.slug}`);
      await expect(page.getByPlaceholder('Enter a new question or statement')).toBeVisible();
      await expect(page.getByRole('button', { name: '+ Add a statement', exact: true })).toBeHidden();
    } finally {
      await removeDiscussion(pool, discussion);
      await pool.end();
    }
  });

  test('the composer starts collapsed again after duplication and history navigation', async ({ page, request }) => {
    const pool = new Pool({ connectionString });
    const original = await createDiscussion(request, pool, ['A statement to copy']);
    let copied;
    try {
      await page.goto(`/discussion/${original.slug}?admin=${original.adminToken}`);
      const input = page.getByPlaceholder('Enter a new question or statement');
      const expand = page.getByRole('button', { name: '+ Add a statement', exact: true });
      await expect(page.getByRole('heading', { name: 'A statement to copy', exact: true })).toBeVisible();
      await expand.click();
      await expect(input).toBeFocused();

      await page.getByRole('button', { name: 'More ▾', exact: true }).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      const menuBox = await menu.boundingBox();
      expect(menuBox.x).toBeGreaterThanOrEqual(0);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(PHONE.width);
      await page.getByRole('menuitem', { name: 'Duplicate Discussion', exact: true }).click();
      await page.getByPlaceholder('Enter new topic name').fill(`Copied phone room ${Date.now()}`);
      const response = page.waitForResponse(result => result.url().endsWith('/api/duplicate-discussion') && result.request().method() === 'POST');
      await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
      const result = await (await response).json();
      const stored = await pool.query('SELECT id, slug FROM discussions WHERE slug = $1', [result.newSlug]);
      copied = stored.rows[0];
      await expect(page).toHaveURL(new RegExp(`/discussion/${result.newSlug}$`));
      await expect(page.getByRole('heading', { name: 'A statement to copy', exact: true })).toBeVisible();
      await expect(input).toBeHidden();
      await expand.click();
      await expect(input).toBeFocused();

      await page.goBack();
      await expect(page).toHaveURL(url => url.pathname === `/discussion/${original.slug}`);
      await expect(page.getByRole('heading', { name: 'A statement to copy', exact: true })).toBeVisible();
      await expect(input).toBeHidden();
      await expand.click();
      await expect(input).toBeFocused();

      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`/discussion/${result.newSlug}$`));
      await expect(page.getByRole('heading', { name: 'A statement to copy', exact: true })).toBeVisible();
      await expect(input).toBeHidden();
      await expect(expand).toBeVisible();
    } finally {
      if (copied) await removeDiscussion(pool, copied);
      await removeDiscussion(pool, original);
      await pool.end();
    }
  });
});

test('on desktop the composer is always shown', async ({ page, request }) => {
  const pool = new Pool({ connectionString });
  const discussion = await createDiscussion(request, pool, ['The garden should come first']);
  try {
    await page.goto(`/discussion/${discussion.slug}`);
    await expect(page.getByRole('heading', { name: 'The garden should come first', exact: true })).toBeVisible();
    await expect(page.getByPlaceholder('Enter a new question or statement')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Add a statement', exact: true })).toBeHidden();
    await expect(page.getByText('Discussion:', { exact: true })).toBeVisible();
  } finally {
    await removeDiscussion(pool, discussion);
    await pool.end();
  }
});
