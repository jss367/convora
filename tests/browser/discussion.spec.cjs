const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');

test('an open-ended edit survives another participant voting and can be saved', async ({ page, browser, request }) => {
  const response = await request.post('/api/discussions', {
    data: { topic: `Draft preservation ${Date.now()}` },
  });
  expect(response.ok()).toBeTruthy();
  const discussion = await response.json();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test',
  });
  const other = await browser.newContext();
  try {
    await pool.query(
      `INSERT INTO questions (discussion_id, text, type) VALUES
       ($1, 'Explain your answer', 'Open Ended'), ($1, 'Should we proceed?', 'Agreement')`,
      [discussion.id]
    );
    const route = `/discussion/${discussion.slug}`;
    await page.goto(route);
    const answer = page.getByPlaceholder('Enter your response here');
    await answer.fill('Original answer');
    await page.getByRole('button', { name: 'Submit Response', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Update Response', exact: true })).toBeVisible();
    await answer.fill('An unfinished edit worth keeping');

    const participant = await other.newPage();
    await participant.goto(page.url());
    await participant.getByRole('button', { name: 'Vote', exact: true }).first().click();
    // Wait for the live update before checking the draft; this cannot pass just
    // because the second participant's vote has not reached the first browser.
    await expect(page.getByText('Strongly Agree: 1', { exact: true }).first()).toBeVisible();
    await expect(answer).toHaveValue('An unfinished edit worth keeping');

    await page.getByRole('button', { name: 'Update Response', exact: true }).click();
    await expect(page.getByText('An unfinished edit worth keeping', { exact: true })).toBeVisible();
    await page.reload();
    await expect(answer).toHaveValue('An unfinished edit worth keeping');
  } finally {
    await other.close();
    await pool.query('DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [discussion.id]);
    await pool.query('DELETE FROM questions WHERE discussion_id = $1', [discussion.id]);
    await pool.query('DELETE FROM discussions WHERE id = $1', [discussion.id]);
    await pool.end();
  }
});
