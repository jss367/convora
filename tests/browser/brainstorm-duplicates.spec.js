const { test, expect } = require('./lifecycle-fixtures.cjs');

test('duplicate ideas show a notice and participants can keep submitting distinct ideas', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Duplicate ideas', 'Brainstorm');
  const otherContext = await browser.newContext();
  try {
    await page.goto(`/discussion/${room.slug}`);
    const input = page.getByPlaceholder('Add an idea (you can add as many as you like)');
    const submit = page.getByRole('button', { name: 'Add Idea', exact: true });
    await input.fill('Internships and job shadowing');
    await submit.click();
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await input.fill('internships   and JOB shadowing');
    await submit.click();
    await expect(page.getByRole('status')).toContainText('is already on the list');
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await input.fill('Internships and job shadowing');
    await submit.click();
    await expect(page.getByRole('status')).toContainText('“Internships and job shadowing”');

    const other = await otherContext.newPage();
    await other.goto(page.url());
    await other.getByPlaceholder('Add an idea (you can add as many as you like)').fill('INTERNSHIPS and job shadowing');
    await other.getByRole('button', { name: 'Add Idea', exact: true }).click();
    await expect(other.getByRole('status')).toContainText('is already on the list');
    await expect(other.getByRole('listitem')).toHaveCount(1);

    await input.fill('Career fairs');
    await submit.click();
    await expect(page.getByRole('listitem')).toHaveCount(2);
    await expect(other.getByRole('listitem')).toHaveCount(2);
    await expect(page.getByRole('status')).toHaveCount(0);
    const stored = await rooms.pool.query(
      'SELECT v.value FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.discussion_id = $1 ORDER BY v.id', [room.id]
    );
    expect(stored.rows.map(row => row.value)).toEqual(['Internships and job shadowing', 'Career fairs']);
    await page.reload();
    await expect(page.getByRole('listitem')).toHaveCount(2);
  } finally {
    await otherContext.close();
  }
});
