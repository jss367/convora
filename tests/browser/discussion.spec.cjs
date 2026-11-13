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
    // The first browser never votes; it watches the tally to know the live update arrived.
    await pool.query("UPDATE discussions SET results_visibility = 'always' WHERE id = $1", [discussion.id]);
    const route = `/discussion/${discussion.slug}`;
    await page.goto(route);
    const answer = page.getByPlaceholder('Enter your response here');
    await answer.fill('Original answer');
    await page.getByRole('button', { name: 'Submit Response', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Update Response', exact: true })).toBeVisible();
    await answer.fill('An unfinished edit worth keeping');

    const participant = await other.newPage();
    await participant.goto(page.url());
    await participant.getByRole('button', { name: 'Vote Strongly Agree on "Should we proceed?"', exact: true }).click();
    // Wait for the live update before checking the draft; this cannot pass just
    // because the second participant's vote has not reached the first browser.
    await expect(page.getByText('Strongly Agree: 1', { exact: true }).first()).toBeVisible();
    await expect(answer).toHaveValue('An unfinished edit worth keeping');

    await page.getByRole('button', { name: 'Update Response', exact: true }).click();
    await expect(page.getByRole('listitem').getByText('An unfinished edit worth keeping', { exact: true })).toBeVisible();
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

for (const { initial, submitted, draft } of [
  { initial: '', submitted: 'Submitted answer', draft: 'A newer draft typed before acknowledgment' },
  { initial: 'Earlier answer', submitted: 'Updated answer', draft: 'Earlier answer' },
]) {
  test(`an edit made during a delayed save stays focused${initial ? ' when reverting to the earlier answer' : ''}`, async ({ page, request }) => {
    const response = await request.post('/api/discussions', {
      data: { topic: `Delayed answer ${Date.now()}` },
    });
    expect(response.ok()).toBeTruthy();
    const discussion = await response.json();
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test',
    });
    const blocker = await pool.connect();
    try {
      await pool.query(
        "INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Explain your answer', 'Open Ended')",
        [discussion.id]
      );
      await page.goto(`/discussion/${discussion.slug}`);
      const answer = page.getByPlaceholder('Enter your response here');
      if (initial) {
        await answer.fill(initial);
        await page.getByRole('button', { name: 'Submit Response', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Update Response', exact: true })).toBeVisible();
      }
      await answer.fill(submitted);
      // Delay the real save, rather than replacing the API or socket with mocks.
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE votes IN SHARE MODE');
      await page.getByRole('button', { name: initial ? 'Update Response' : 'Submit Response', exact: true }).click();
      await answer.fill(draft);
      await expect(answer).toBeFocused();
      await blocker.query('COMMIT');

      await expect(page.getByRole('listitem').getByText(submitted, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Update Response', exact: true })).toBeVisible();
      await expect(answer).toHaveValue(draft);
      await expect(answer).toBeFocused();
      await page.getByRole('button', { name: 'Update Response', exact: true }).click();
      await expect(page.getByRole('listitem').getByText(draft, { exact: true })).toBeVisible();
      await page.reload();
      await expect(answer).toHaveValue(draft);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pool.query('DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [discussion.id]);
      await pool.query('DELETE FROM questions WHERE discussion_id = $1', [discussion.id]);
      await pool.query('DELETE FROM discussions WHERE id = $1', [discussion.id]);
      await pool.end();
    }
  });
}

for (const whitespaceOnly of [false, true]) {
  test(`an unchanged save${whitespaceOnly ? ' with surrounding whitespace' : ''} does not block updates from another tab`, async ({ page, context, request }) => {
    const response = await request.post('/api/discussions', {
      data: { topic: `Unchanged answer ${Date.now()}` },
    });
    expect(response.ok()).toBeTruthy();
    const discussion = await response.json();
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test',
    });
    let upgraded = false;
    let broadcasts = 0;
    page.on('websocket', socket => {
      socket.on('framesent', event => { if (event.payload === '5') upgraded = true; });
      socket.on('framereceived', event => {
        if (typeof event.payload === 'string' && event.payload.startsWith('42["questions",')) broadcasts += 1;
      });
    });
    const other = await context.newPage();
    try {
      await pool.query(
        "INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Explain your answer', 'Open Ended')",
        [discussion.id]
      );
      await page.goto(`/discussion/${discussion.slug}`);
      const answer = page.getByPlaceholder('Enter your response here');
      await answer.fill('Original answer');
      await page.getByRole('button', { name: 'Submit Response', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Update Response', exact: true })).toBeVisible();
      await expect.poll(() => upgraded).toBe(true);

      if (whitespaceOnly) await answer.fill('  Original answer  ');
      const beforeSave = broadcasts;
      await page.getByRole('button', { name: 'Update Response', exact: true }).click();
      // Wait for the same-value acknowledgment itself, not unchanged DOM text.
      await expect.poll(() => broadcasts).toBeGreaterThan(beforeSave);
      await expect(answer).toHaveValue('Original answer');

      await other.goto(page.url());
      const otherAnswer = other.getByPlaceholder('Enter your response here');
      await expect(otherAnswer).toHaveValue('Original answer');
      await otherAnswer.fill('Updated in another tab');
      await other.getByRole('button', { name: 'Update Response', exact: true }).click();
      await expect(page.getByRole('listitem').getByText('Updated in another tab', { exact: true })).toBeVisible();
      await expect(answer).toHaveValue('Updated in another tab');
      await page.reload();
      await expect(answer).toHaveValue('Updated in another tab');
    } finally {
      await other.close();
      await pool.query('DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [discussion.id]);
      await pool.query('DELETE FROM questions WHERE discussion_id = $1', [discussion.id]);
      await pool.query('DELETE FROM discussions WHERE id = $1', [discussion.id]);
      await pool.end();
    }
  });
}
