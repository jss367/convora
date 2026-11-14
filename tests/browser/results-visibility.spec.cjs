const { test, expect } = require('./lifecycle-fixtures.cjs');
const { observeQuestionPayloads } = require('../helpers/question-payloads.cjs');

const HINT = 'Results appear after you vote';

test('results stay hidden until a participant votes, appear without moving the page, and hide again on undo', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Results gate', 'Agreement');
  await rooms.pool.query(
    `INSERT INTO votes (question_id, value, user_id)
     SELECT id, v.value, v.user_id FROM questions,
       (VALUES ('Agree', 'seed-a'), ('Disagree', 'seed-b')) AS v(value, user_id)
     WHERE discussion_id = $1`, [room.id]
  );
  // Everything the server sends this participant about the questions.
  const { payloads, errors } = observeQuestionPayloads(page);
  const otherContext = await browser.newContext();
  const moderatorContext = await browser.newContext();
  try {
    await page.goto(`/discussion/${room.slug}`);
    const hint = page.getByText(HINT, { exact: true });
    await expect(hint).toBeVisible();
    // The options are offered without their counts, and no tally is on the page.
    const voteButtons = page.getByRole('button', { name: /^Vote .+ on "Results gate question"$/ });
    await expect(voteButtons).toHaveCount(5);
    await expect(page.getByText('Agree', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/: \d+$/)).toHaveCount(0);
    await expect(page.getByText(/\d+ votes?\b/)).toHaveCount(0);
    // Hidden on the server, not just in the page.
    await expect.poll(() => payloads.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    expect(payloads.join('')).not.toMatch(/"value"|Disagree|ownerToken/);

    // Another participant voting does not reveal anything either.
    const other = await otherContext.newPage();
    await other.goto(`/discussion/${room.slug}`);
    await expect(other.getByText(HINT, { exact: true })).toBeVisible();
    const before = payloads.length;
    await other.getByRole('button', { name: 'Vote Strongly Disagree on "Results gate question"', exact: true }).click();
    await expect(other.getByText('3 votes', { exact: false })).toBeVisible();
    await expect.poll(() => payloads.length).toBeGreaterThan(before);
    expect(errors).toEqual([]);
    await expect(hint).toBeVisible();
    expect(payloads.join('')).not.toMatch(/"value"|Disagree|ownerToken/);

    // Voting reveals the results in place: the vote buttons do not move. Measured
    // from the question's heading, because clicking can scroll the page.
    const heading = page.getByRole('heading', { name: 'Results gate question', exact: true });
    const offset = async button => (await button.boundingBox()).y - (await heading.boundingBox()).y;
    const position = await offset(voteButtons.first());
    await voteButtons.first().click();
    const undo = page.getByRole('button', { name: 'Vote Strongly Agree on "Results gate question"', exact: true, pressed: true });
    await expect(undo).toBeVisible();
    await expect(hint).toHaveCount(0);
    await expect(page.getByText('4 votes', { exact: false })).toBeVisible();
    await expect(page.getByText('Strongly Agree: 1', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Strongly Disagree: 1', { exact: true }).first()).toBeVisible();
    expect(await offset(undo)).toBe(position);

    // Live updates arrive as before once this participant has voted.
    await other.getByRole('button', { name: 'Vote Unsure on "Results gate question"', exact: true }).click();
    await expect(page.getByText('Unsure: 1', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Strongly Disagree: 0', { exact: true }).first()).toBeVisible();

    // Undoing the vote hides them again, in the same place.
    await undo.click();
    await expect(hint).toBeVisible();
    await expect(page.getByText(/: \d+$/)).toHaveCount(0);
    expect(await offset(voteButtons.first())).toBe(position);

    // A moderator sees results without voting, and can show them to everyone.
    const moderator = await moderatorContext.newPage();
    await moderator.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
    await expect(moderator.getByText('3 votes', { exact: false })).toBeVisible();
    await expect(moderator.getByText(HINT, { exact: true })).toHaveCount(0);
    const setting = moderator.getByRole('combobox').filter({ has: moderator.locator('option[value="after_vote"]') });
    await expect(setting).toHaveValue('after_vote');
    await setting.selectOption('always');
    await expect(setting).toHaveValue('always');
    await expect(hint).toHaveCount(0);
    await expect(page.getByText('3 votes', { exact: false })).toBeVisible();
    expect(await offset(voteButtons.first())).toBe(position);
  } finally {
    await otherContext.close();
    await moderatorContext.close();
  }
});
