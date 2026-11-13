const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');

test('question editing, numerical and binary voting, and brainstorm comments still work together', async ({ page, request }) => {
  const response = await request.post('/api/discussions', { data: { topic: `Question types ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  const discussion = await response.json();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test',
  });
  try {
    await pool.query("UPDATE discussions SET comments_enabled = TRUE, reactions_enabled = TRUE WHERE id = $1", [discussion.id]);
    await pool.query(
      "INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Ideas to try', 'Brainstorm')", [discussion.id]
    );
    await page.goto(`/discussion/${discussion.slug}?admin=${discussion.adminToken}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByPlaceholder('Enter a new question or statement').last().fill('Ideas worth trying');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ideas worth trying', exact: true })).toBeVisible();

    await page.getByPlaceholder('Add an idea (you can add as many as you like)').fill('A helpful idea');
    await page.getByRole('button', { name: 'Add Idea', exact: true }).click();
    await expect(page.getByRole('listitem').getByText('A helpful idea (You)', { exact: true })).toBeVisible();
    await expect(page.getByText('No agreement votes yet.', { exact: true })).toBeVisible();
    await page.getByPlaceholder('Add a comment').fill('A useful follow-up');
    await page.getByRole('button', { name: 'Post', exact: true }).click();
    await expect(page.getByText('A useful follow-up', { exact: true })).toBeVisible();

    const typePicker = page.getByRole('combobox').filter({ has: page.locator('option[value="Numerical"]') });
    await page.getByPlaceholder('Enter a new question or statement').fill('Estimate effort');
    await typePicker.selectOption('Numerical');
    await page.getByRole('button', { name: 'Add Question', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Estimate effort', exact: true })).toBeVisible();
    // An untouched numerical question has no selected value: nothing to submit
    // by accident, and no midpoint to anchor on.
    const submit = page.getByRole('button', { name: 'Submit', exact: true });
    const slider = page.getByRole('slider');
    const numberBox = page.getByRole('spinbutton', { name: 'Type your answer to: Estimate effort' });
    await expect(submit).toBeDisabled();
    await expect(numberBox).toHaveValue('');
    await expect(slider).toHaveClass(/slider-unset/);
    await expect(page.getByText('Move the slider or type a number', { exact: true })).toBeVisible();
    await numberBox.fill('1e2');
    await expect(numberBox).toHaveValue('1e2');
    await expect(slider).toHaveValue('100');
    // Typing drives the slider, and out-of-range input is clamped to the max.
    await numberBox.fill('250');
    await expect(slider).toHaveValue('100');
    await numberBox.blur();
    await expect(numberBox).toHaveValue('100');
    // Clearing the box goes back to "nothing selected".
    await numberBox.fill('');
    await expect(submit).toBeDisabled();
    // Moving the slider drives the number box.
    await slider.focus();
    await slider.press('ArrowRight');
    await expect(numberBox).toHaveValue('1');
    await expect(slider).not.toHaveClass(/slider-unset/);
    await numberBox.fill('50');
    await expect(slider).toHaveValue('50');

    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText('50.0', { exact: true })).toBeVisible();
    // A participant who has answered keeps seeing their own value.
    await expect(page.getByRole('button', { name: 'Update Vote', exact: true })).toBeDisabled();
    await expect(numberBox).toHaveValue('50');
    await expect(slider).toHaveValue('50');
    await numberBox.fill('51');
    await expect(page.getByRole('button', { name: 'Update Vote', exact: true })).toBeEnabled();
    await numberBox.fill('50');
    await expect(page.getByRole('button', { name: 'Update Vote', exact: true })).toBeDisabled();

    // Enter submits the new-question form, exactly once, and an empty question
    // is still rejected.
    const questionInput = page.getByPlaceholder('Enter a new question or statement');
    await questionInput.press('Enter');
    await expect(page.getByText('Question text cannot be empty.', { exact: true })).toBeVisible();
    await questionInput.fill('Ready to begin?');
    await typePicker.selectOption('Yes/No');
    await questionInput.press('Enter');
    await expect(page.getByRole('heading', { name: 'Ready to begin?', exact: true })).toHaveCount(1);
    await expect(questionInput).toHaveValue('');
    const added = await pool.query("SELECT count(*)::int AS n FROM questions WHERE discussion_id = $1 AND text = 'Ready to begin?'", [discussion.id]);
    expect(added.rows[0].n).toBe(1);
    await page.getByRole('button', { name: 'Vote', exact: true }).first().click();
    await expect(page.getByTitle('Yes: 1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Undo Vote', exact: true }).click();
    await expect(page.getByText('No votes yet — be the first to weigh in.', { exact: true })).toBeVisible();
  } finally {
    await pool.query('DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [discussion.id]);
    await pool.query('DELETE FROM questions WHERE discussion_id = $1', [discussion.id]);
    await pool.query('DELETE FROM discussions WHERE id = $1', [discussion.id]);
    await pool.end();
  }
});

test('pressing Enter in the topic box creates a discussion once, and ignores an empty topic', async ({ page }) => {
  const topic = `Enter creates ${Date.now()}`;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test',
  });
  try {
    await page.goto('/');
    const topicInput = page.getByPlaceholder('Enter discussion topic');
    await topicInput.fill('   ');
    await topicInput.press('Enter');
    await expect(page).toHaveURL(/\/$/);
    await topicInput.fill(topic);
    await topicInput.press('Enter');
    await expect(page).toHaveURL(/\/discussion\//);
    await expect(page.getByRole('heading', { name: `Discussion: ${topic}`, exact: true })).toBeVisible();
    const created = await pool.query('SELECT count(*)::int AS n FROM discussions WHERE topic = $1', [topic]);
    expect(created.rows[0].n).toBe(1);
  } finally {
    await pool.query('DELETE FROM discussions WHERE topic = $1', [topic]);
    await pool.end();
  }
});

test('"Most Recent" shows the newest question first for someone who joins later', async ({ page, request }) => {
  const response = await request.post('/api/discussions', { data: { topic: `Recent order ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  const discussion = await response.json();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test',
  });
  try {
    await pool.query(
      `INSERT INTO questions (discussion_id, text, type, created_at) VALUES
       ($1, 'Sort question A', 'Agreement', now() - interval '3 minutes'),
       ($1, 'Sort question B', 'Agreement', now() - interval '2 minutes'),
       ($1, 'Sort question C', 'Agreement', now() - interval '1 minute')`,
      [discussion.id]
    );
    await page.goto(`/discussion/${discussion.slug}`);
    await expect(page.getByRole('heading', { name: /^Sort question [ABC]$/ })).toHaveText(
      ['Sort question C', 'Sort question B', 'Sort question A']
    );
  } finally {
    await pool.query('DELETE FROM questions WHERE discussion_id = $1', [discussion.id]);
    await pool.query('DELETE FROM discussions WHERE id = $1', [discussion.id]);
    await pool.end();
  }
});
