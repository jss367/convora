const { test, expect } = require('./lifecycle-fixtures.cjs');

test('participants can submit identical responses repeatedly', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Duplicate ideas', 'Open Ended');
  const otherContext = await browser.newContext();
  try {
    await page.goto(`/discussion/${room.slug}`);
    const input = page.getByPlaceholder('Enter a response');
    const submit = page.getByRole('button', { name: 'Add Response', exact: true });
    await input.fill('Internships and job shadowing');
    await submit.click();
    await expect(page.getByRole('listitem')).toHaveCount(1);
    await input.fill('internships   and JOB shadowing');
    await submit.click();
    await expect(page.getByRole('listitem')).toHaveCount(2);
    await input.fill('Internships and job shadowing');
    await submit.click();
    await expect(page.getByRole('listitem')).toHaveCount(3);

    const other = await otherContext.newPage();
    await other.goto(page.url());
    await other.getByPlaceholder('Enter a response').fill('INTERNSHIPS and job shadowing');
    await other.getByRole('button', { name: 'Add Response', exact: true }).click();
    await expect(other.getByRole('listitem')).toHaveCount(4);

    await input.fill('Career fairs');
    await submit.click();
    await expect(page.getByRole('listitem')).toHaveCount(5);
    await expect(other.getByRole('listitem')).toHaveCount(5);
    await expect(page.getByRole('status')).toHaveCount(0);
    const stored = await rooms.pool.query(
      'SELECT v.value FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.discussion_id = $1 ORDER BY v.id', [room.id]
    );
    expect(stored.rows.map(row => row.value)).toEqual(['Internships and job shadowing', 'internships   and JOB shadowing', 'Internships and job shadowing', 'INTERNSHIPS and job shadowing', 'Career fairs']);
    await page.reload();
    await expect(page.getByRole('listitem')).toHaveCount(5);
  } finally {
    await otherContext.close();
  }
});
