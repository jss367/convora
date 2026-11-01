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
    await page.getByRole('button', { name: 'Submit', exact: true }).click();
    await expect(page.getByText('50.0', { exact: true })).toBeVisible();

    await page.getByPlaceholder('Enter a new question or statement').fill('Ready to begin?');
    await typePicker.selectOption('Yes/No');
    await page.getByRole('button', { name: 'Add Question', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ready to begin?', exact: true })).toBeVisible();
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
