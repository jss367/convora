const { test, expect } = require('@playwright/test');
const { Pool } = require('pg');

test('negative numerical answers preserve a lone minus through controlled rerenders', async ({ page, request }) => {
  const response = await request.post('/api/discussions', { data: { topic: `Negative entry ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  const discussion = await response.json();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test',
  });
  try {
    await pool.query(
      "INSERT INTO questions (discussion_id, text, type, min_value, max_value) VALUES ($1, 'Temperature', 'Numerical', -100, 0)",
      [discussion.id]
    );
    await page.goto(`/discussion/${discussion.slug}`);
    const input = page.getByRole('textbox', { name: 'Type your answer to: Temperature' });
    const slider = page.getByRole('slider');
    const submit = page.getByRole('button', { name: 'Submit', exact: true });
    await expect(slider).toHaveAttribute('max', '0');
    await input.pressSequentially('-');
    await expect(input).toHaveValue('-');
    await expect(submit).toBeDisabled();
    await input.pressSequentially('1');
    await expect(input).toHaveValue('-1');
    await expect(slider).toHaveValue('-1');
    await input.pressSequentially('5');
    await expect(input).toHaveValue('-15');
    await expect(slider).toHaveValue('-15');
    await submit.click();
    await expect(input).toHaveValue('-15');
    await expect(page.getByRole('button', { name: 'Update Vote', exact: true })).toBeDisabled();
  } finally {
    await pool.query('DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [discussion.id]);
    await pool.query('DELETE FROM questions WHERE discussion_id = $1', [discussion.id]);
    await pool.query('DELETE FROM discussions WHERE id = $1', [discussion.id]);
    await pool.end();
  }
});

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
      "INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Ideas to try', 'Open Ended')", [discussion.id]
    );
    await page.goto(`/discussion/${discussion.slug}?admin=${discussion.adminToken}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByPlaceholder('Enter a new question or statement').last().fill('Ideas worth trying');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ideas worth trying', exact: true })).toBeVisible();

    await page.getByPlaceholder('Enter a response').fill('A helpful idea');
    await page.getByRole('button', { name: 'Add Response', exact: true }).click();
    await expect(page.getByRole('listitem').getByText('A helpful idea', { exact: true })).toBeVisible();
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
    const numberBox = page.getByRole('textbox', { name: 'Type your answer to: Estimate effort' });
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
    const voteYes = page.getByRole('button', { name: 'Vote Yes on "Ready to begin?"', exact: true });
    await voteYes.click();
    await expect(page.getByTitle('Yes: 1', { exact: true })).toBeVisible();
    await expect(voteYes).toHaveText('Undo Vote');
    await voteYes.click();
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

test('a Multiple Choice question is written with its own options, validated, voted on, and undone', async ({ page, request }) => {
  const response = await request.post('/api/discussions', { data: { topic: `Multiple choice ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  const discussion = await response.json();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test',
  });
  try {
    await page.goto(`/discussion/${discussion.slug}`);
    const question = 'In the last year, did your p(doom) get higher or lower?';
    await page.getByPlaceholder('Enter a new question or statement').fill(question);
    await page.getByRole('combobox').filter({ has: page.locator('option[value="Multiple Choice"]') })
      .selectOption('Multiple Choice');

    // Two empty options to start; too few and repeats are caught before sending.
    const addQuestion = page.getByRole('button', { name: 'Add Question', exact: true });
    await addQuestion.click();
    await expect(page.getByText('Fill in at least 2 answer options.', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Answer option 1' }).fill('Higher');
    await page.getByRole('textbox', { name: 'Answer option 2' }).fill(' higher ');
    await addQuestion.click();
    await expect(page.getByText('Each answer option must be different.', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Answer option 2' }).fill('Lower');
    // Enter in the last filled option adds the next one and moves into it.
    const option3 = page.getByRole('textbox', { name: 'Answer option 3' });
    // Holding the key does not carry on into the new option and submit it.
    const hold = async (key) => {
      await page.keyboard.down(key);
      await page.keyboard.down(key);
      await page.keyboard.down(key);
      await page.keyboard.up(key);
    };
    await page.getByRole('textbox', { name: 'Answer option 2' }).focus();
    await hold('Enter');
    await expect(option3).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Answer option 4' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: question, exact: true })).toHaveCount(0);
    // Backspace in the empty spare option removes it and steps back, and
    // holding it does not go on to delete the option before.
    await hold('Backspace');
    await expect(option3).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Answer option 2' })).toBeFocused();
    await expect(page.getByRole('textbox', { name: 'Answer option 2' })).toHaveValue('Lower');
    // The button also moves into the option it adds.
    await page.getByRole('button', { name: '+ Add option' }).click();
    await expect(option3).toBeFocused();
    await option3.fill('About the same');
    // A spare option left empty is dropped; Enter in it submits the question.
    await option3.press('Enter');
    await page.getByRole('textbox', { name: 'Answer option 4' }).press('Enter');
    await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible();
    // The composer resets to a blank form with two empty options.
    await expect(page.getByPlaceholder('Enter a new question or statement').first()).toHaveValue('');

    // Results stay hidden until this participant answers.
    await expect(page.getByTestId('results-hidden')).toBeVisible();
    const lower = page.getByRole('button', { name: `Vote Lower on "${question}"` });
    await lower.click();
    await expect(lower).toHaveAttribute('aria-pressed', 'true');
    const results = page.getByTestId('choice-results');
    await expect(results).toContainText('1 vote');
    await expect(results).toContainText('1 · 100%');
    await expect(results).toContainText('0 · 0%');

    // Undo clears the vote and hides the results again.
    await lower.click();
    await expect(lower).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('results-hidden')).toBeVisible();
  } finally {
    await pool.query('DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [discussion.id]);
    await pool.query('DELETE FROM questions WHERE discussion_id = $1', [discussion.id]);
    await pool.query('DELETE FROM discussions WHERE id = $1', [discussion.id]);
    await pool.end();
  }
});

test('the summary lists a Multiple Choice question\'s options at zero before anyone answers, and while results are hidden', async ({ page, request }) => {
  const response = await request.post('/api/discussions', { data: { topic: `Choice summary ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  const discussion = await response.json();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://convora:convora@127.0.0.1:54330/convora_test',
  });
  try {
    await pool.query(
      "INSERT INTO questions (discussion_id, text, type, options) VALUES ($1, 'p(doom) this year?', 'Multiple Choice', $2)",
      [discussion.id, JSON.stringify(['Higher', 'Lower', 'About the same'])]
    );
    // Results always shown, so the unanswered question's results are visible.
    await pool.query("UPDATE discussions SET results_visibility = 'always' WHERE id = $1", [discussion.id]);
    await page.goto(`/discussion/${discussion.slug}/summary`);
    const bars = page.getByTestId('summary-choice-bars');
    await expect(bars).toBeVisible();
    for (const option of ['Higher', 'Lower', 'About the same']) {
      await expect(bars.getByText(option, { exact: true })).toBeVisible();
    }
    await expect(bars.getByText('0 · 0%', { exact: true })).toHaveCount(3);

    // With results shown only after voting, someone who has not answered still
    // sees the options, with no counts or percentages.
    await pool.query("UPDATE discussions SET results_visibility = 'after_vote' WHERE id = $1", [discussion.id]);
    await page.reload();
    const labels = page.getByTestId('summary-choice-options');
    for (const option of ['Higher', 'Lower', 'About the same']) {
      await expect(labels.getByText(option, { exact: true })).toBeVisible();
    }
    await expect(labels.getByText(/%|·/)).toHaveCount(0);
    await expect(page.getByTestId('summary-choice-bars')).toHaveCount(0);
  } finally {
    await pool.query('DELETE FROM questions WHERE discussion_id = $1', [discussion.id]);
    await pool.query('DELETE FROM discussions WHERE id = $1', [discussion.id]);
    await pool.end();
  }
});
