const { test, expect } = require('./lifecycle-fixtures.cjs');

// The controls a host reaches for while a discussion is running: decimal
// answers, a queue of questions to publish one at a time, choosing what the
// room display shows, and the before-and-after comparison.

const asModerator = room => `/discussion/${room.slug}?admin=${room.adminToken}`;

test('a participant can answer a numerical question with a decimal', async ({ page, rooms }) => {
  const room = await rooms.create('Decimal', 'Numerical');
  await page.goto(`/discussion/${room.slug}`);
  const numberBox = page.getByRole('textbox', { name: 'Type your answer to: Decimal question' });
  const submit = page.getByRole('button', { name: 'Submit', exact: true });

  // A decimal comma, as many phone keypads type it, is read as a decimal point.
  await numberBox.fill('0,5');
  await expect(submit).toBeEnabled();
  await numberBox.blur();
  await expect(numberBox).toHaveValue('0.5');
  await submit.click();

  // The saved answer comes back as typed, not rounded to a whole number.
  await expect(page.getByText(/1 response · average/)).toContainText('0.5');
  await expect(numberBox).toHaveValue('0.5');
  await expect.poll(async () => (await rooms.pool.query(
    'SELECT v.value FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.discussion_id = $1', [room.id]
  )).rows.map(row => row.value)).toEqual(['0.5']);

  // More than two decimal places are rounded when the box loses focus.
  await numberBox.fill('33.337');
  await numberBox.blur();
  await expect(numberBox).toHaveValue('33.34');
  await page.getByRole('button', { name: 'Update Vote', exact: true }).click();
  await expect(page.getByText(/1 response · average/)).toContainText('33.3');
});

test('a moderator queues a question, publishes it, and chooses what the room display shows', async ({ page, browser, rooms, request }) => {
  const room = await rooms.create('Agenda', 'Agreement');
  const moderatorContext = await browser.newContext();
  const displayContext = await browser.newContext();
  try {
    await page.goto(`/discussion/${room.slug}`);
    await expect(page.getByRole('heading', { name: 'Agenda question', exact: true })).toBeVisible();
    // Participants are not offered the queue.
    await expect(page.getByLabel(/Add to the queue/)).toHaveCount(0);

    const display = await displayContext.newPage();
    await display.goto(`/discussion/${room.slug}/display`);
    const shown = display.getByTestId('display-question');
    await expect(shown).toHaveCount(1);

    const moderator = await moderatorContext.newPage();
    await moderator.goto(asModerator(room));
    await moderator.getByPlaceholder('Enter a new question or statement').fill('Queued agenda item');
    await moderator.getByLabel(/Add to the queue/).check();
    await moderator.getByRole('button', { name: 'Add to Queue', exact: true }).click();

    // The moderator sees it in the queue; nobody else sees it at all.
    const queue = moderator.getByRole('region', { name: /Queued questions \(1\)/ });
    await expect(queue.getByRole('heading', { name: 'Queued agenda item', exact: true })).toBeVisible();
    await expect(queue.getByText('Type: Agreement', { exact: true })).toBeVisible();
    // The box stays ticked for the next question of the agenda.
    await expect(moderator.getByLabel(/Add to the queue/)).toBeChecked();
    await expect(moderator.getByPlaceholder('Enter a new question or statement')).toHaveValue('');
    await expect(page.getByText('Queued agenda item')).toHaveCount(0);
    await expect(shown).toHaveCount(1);
    await expect(display.getByText('Queued agenda item')).toHaveCount(0);
    // A queued question has nothing to vote with yet.
    await expect(moderator.getByRole('button', { name: /on "Queued agenda item"/ })).toHaveCount(0);

    // One click puts a question on the screen, on its own.
    await moderator.getByRole('button', { name: 'Show on display', exact: true }).click();
    const backToList = moderator.getByRole('button', { name: 'Back to all questions', exact: true });
    await expect(backToList).toBeVisible();
    await expect(moderator.getByLabel('Display shows', { exact: true })).toHaveValue('focus');
    await expect(shown).toHaveCount(1);
    await expect(shown.getByRole('heading', { name: 'Agenda question' })).toBeVisible();

    // Publishing shows the question to the room. It is the newest question, yet
    // the display keeps showing the one the moderator chose.
    await queue.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Queued agenda item', exact: true })).toBeVisible();
    await expect(moderator.getByRole('region', { name: /Queued questions/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Vote Agree on "Queued agenda item"', exact: true })).toBeVisible();
    await expect(shown.getByRole('heading', { name: 'Agenda question' })).toBeVisible();
    // Published now, so it is first under Most Recent.
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText('Queued agenda item');

    // Move the screen on to it.
    await moderator.getByRole('button', { name: 'Show on display', exact: true }).click();
    await expect(shown.getByRole('heading', { name: 'Queued agenda item' })).toBeVisible();
    await expect(backToList).toHaveCount(1);
    await expect(moderator.getByRole('button', { name: 'Show on display', exact: true })).toHaveCount(1);

    await moderator.reload();
    await backToList.click();
    await expect(moderator.getByRole('button', { name: 'Show on display', exact: true })).toHaveCount(2);
    await expect(shown).toHaveCount(2);

    const layout = moderator.getByLabel('Display shows', { exact: true });
    await expect(layout).toHaveValue('all');
    await layout.selectOption('focus');
    await expect(shown).toHaveCount(1);
    const spotlightOlder = moderator.getByRole('button', { name: 'Show on display', exact: true }).last();
    await spotlightOlder.click();
    await expect(shown.getByRole('heading', { name: 'Agenda question' })).toBeVisible();
    await moderator.getByRole('button', { name: 'Resume automatic selection' }).click();
    await expect(shown.getByRole('heading', { name: 'Queued agenda item' })).toBeVisible();

    expect((await request.post(`/api/discussions/${room.slug}/snapshots`, { data: { name: 'Baseline', adminToken: room.adminToken } })).ok()).toBeTruthy();
    await layout.selectOption('compare');
    const compared = display.getByTestId('display-comparison');
    await expect(compared).toHaveCount(2);
    await spotlightOlder.click();
    await expect(compared).toHaveCount(1);
    await moderator.getByRole('button', { name: 'Back to full comparison' }).click();
    await expect(compared).toHaveCount(2);
  } finally {
    await moderatorContext.close();
    await displayContext.close();
  }
});

test('showing results saves a "before" snapshot, and the comparison goes on the room display', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Shift', 'Agreement');
  await rooms.pool.query(
    `INSERT INTO votes (question_id, value, user_id)
     SELECT id, v.value, v.user_id FROM questions,
       (VALUES ('Agree', 'seed-a'), ('Disagree', 'seed-b')) AS v(value, user_id)
     WHERE discussion_id = $1`, [room.id]
  );
  const displayContext = await browser.newContext();
  try {
    const display = await displayContext.newPage();
    await display.goto(`/discussion/${room.slug}/display`);
    await expect(display.getByTestId('display-question').getByText('2 responses', { exact: true })).toBeVisible();

    // The moderator opens the snapshot list first: it is empty, and it fills
    // in by itself when the results are shown.
    await page.goto(asModerator(room));
    await page.getByRole('button', { name: 'Opinion Snapshots' }).click();
    const panel = page.getByRole('region', { name: 'Opinion snapshots' });
    await expect(panel.getByText(/No snapshots saved yet/)).toBeVisible();
    await page.getByRole('button', { name: 'Show results', exact: true }).click();
    const earlier = panel.getByLabel('Earlier snapshot');
    await expect(earlier.locator('option')).toHaveCount(1);
    await expect(earlier.locator('option')).toContainText('Before results shown: Shift question');

    // The room talks, someone answers, and the moderator saves the "after".
    await page.getByRole('button', { name: 'Vote Strongly Agree on "Shift question"', exact: true }).click();
    await expect(page.getByRole('button', { name: /Strongly Agree on "Shift question"/, pressed: true })).toBeVisible();
    await panel.getByLabel('Snapshot name').fill('After discussion');
    await panel.getByRole('button', { name: 'Save snapshot', exact: true }).click();
    await expect(panel.getByText('Saved “After discussion”.')).toBeVisible();
    await expect(earlier.locator('option')).toHaveCount(2);

    // One click puts the comparison on the room's screen.
    await panel.getByRole('button', { name: 'Show this comparison on the room display', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'On the room display', exact: true, pressed: true })).toBeVisible();
    await expect(page.getByLabel('Display shows')).toHaveValue('compare');
    const comparison = display.getByTestId('display-comparison-view');
    await expect(comparison.getByText('Before results shown: Shift question', { exact: true })).toBeVisible();
    await expect(comparison.getByText('After discussion', { exact: true })).toBeVisible();
    const card = display.getByTestId('display-comparison');
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('heading', { name: 'Shift question' })).toBeVisible();
    await expect(card.getByText('2 → 3 responses', { exact: true })).toBeVisible();
    // Each answer has a bar for each snapshot, labelled with count and share.
    await expect(card.getByLabel('Before results shown: Shift question: 1, 50%', { exact: true })).toHaveCount(2);
    await expect(card.getByLabel('After discussion: 1, 33%', { exact: true })).toHaveCount(3);
    await expect(card.getByLabel('After discussion: 0, 0%', { exact: true })).toHaveCount(2);
    await expect(display.getByTestId('display-question')).toHaveCount(0);

    // With no later snapshot chosen, the display compares against the latest
    // one, so a snapshot saved while the comparison is up appears by itself.
    await panel.getByLabel('Later snapshot').selectOption('');
    await panel.getByRole('button', { name: 'Show this comparison on the room display', exact: true }).click();
    await expect(comparison.getByText('After discussion', { exact: true })).toBeVisible();
    await panel.getByLabel('Snapshot name').fill('End of the evening');
    await panel.getByRole('button', { name: 'Save snapshot', exact: true }).click();
    await expect(comparison.getByText('End of the evening', { exact: true })).toBeVisible();
    await expect(comparison.getByText('After discussion', { exact: true })).toHaveCount(0);

    // Back to the questions.
    await page.getByLabel('Display shows').selectOption('all');
    await expect(display.getByTestId('display-comparison-view')).toHaveCount(0);
    await expect(display.getByTestId('display-question')).toHaveCount(1);

    // "Before and after" on its own compares the first and the latest snapshot.
    await page.getByLabel('Display shows').selectOption('compare');
    await expect(display.getByTestId('display-comparison-view').getByText('End of the evening', { exact: true })).toBeVisible();
  } finally {
    await displayContext.close();
  }
});

test('the room display hides a comparison until the moderator shows the question\'s results', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Hidden shift', 'Yes/No');
  await rooms.pool.query(
    `INSERT INTO votes (question_id, value, user_id)
     SELECT id, 'Yes', 'seed-a' FROM questions WHERE discussion_id = $1`, [room.id]
  );
  const displayContext = await browser.newContext();
  try {
    await page.goto(asModerator(room));
    await page.getByRole('button', { name: 'Opinion Snapshots' }).click();
    const panel = page.getByRole('region', { name: 'Opinion snapshots' });
    await panel.getByLabel('Snapshot name').fill('Start');
    await panel.getByRole('button', { name: 'Save snapshot', exact: true }).click();
    await expect(panel.getByText('Saved “Start”.')).toBeVisible();
    await page.getByLabel('Display shows').selectOption('compare');

    const display = await displayContext.newPage();
    await display.goto(`/discussion/${room.slug}/display`);
    const card = display.getByTestId('display-comparison');
    await expect(card.getByRole('heading', { name: 'Hidden shift question' })).toBeVisible();
    // The screen has not voted, so it gets no saved tallies yet.
    await expect(card.getByText(/Hidden until the moderator shows/)).toBeVisible();
    await expect(card.getByTestId('display-comparison-rows')).toHaveCount(0);

    // Showing the results opens the saved ones on the screen too.
    await page.getByRole('button', { name: 'Show results', exact: true }).click();
    await expect(card.getByLabel('Start: 1, 100%', { exact: true })).toBeVisible();
    await expect(card.getByText(/Hidden until the moderator shows/)).toHaveCount(0);
  } finally {
    await displayContext.close();
  }
});

test('the room display compares a numerical question as one paired histogram', async ({ page, request, rooms }) => {
  const room = await rooms.create('Estimate', 'Numerical');
  const question = (await rooms.pool.query('SELECT id FROM questions WHERE discussion_id = $1', [room.id])).rows[0].id;
  const save = name => request.post(`/api/discussions/${room.slug}/snapshots`, { data: { name, adminToken: room.adminToken } });
  await rooms.pool.query("UPDATE discussions SET results_visibility = 'always', display_layout = 'compare' WHERE id = $1", [room.id]);
  await rooms.pool.query(
    "INSERT INTO votes (question_id, value, user_id) VALUES ($1, '0.5', 'seed-a'), ($1, '60', 'seed-b')", [question]
  );
  expect((await save('Before')).ok()).toBeTruthy();
  await rooms.pool.query("UPDATE votes SET value = '20' WHERE question_id = $1 AND user_id = 'seed-b'", [question]);
  expect((await save('After')).ok()).toBeTruthy();

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/discussion/${room.slug}/display`);
  const card = page.getByTestId('display-comparison');
  await expect(card.getByTestId('display-comparison-average')).toHaveText('Average 30.3 → 10.3(-20)');
  // One column per snapshot in each of the ten bins.
  await expect(card.getByLabel(/^Before, /)).toHaveCount(10);
  await expect(card.getByLabel('Before, 0 to <10: 1, 50%', { exact: true })).toBeVisible();
  await expect(card.getByLabel('Before, 60 to <70: 1, 50%', { exact: true })).toBeVisible();
  await expect(card.getByLabel('After, 20 to <30: 1, 50%', { exact: true })).toBeVisible();
  await expect(card.getByLabel('After, 60 to <70: 0, 0%', { exact: true })).toHaveCount(1);
  // The whole comparison fits on a screen nobody scrolls.
  const box = await card.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(1080);
});
