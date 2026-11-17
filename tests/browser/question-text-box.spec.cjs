const { test, expect } = require('./lifecycle-fixtures.cjs');

test('the question box grows to show a long question, and Enter still submits it', async ({ page, rooms }) => {
  const room = await rooms.create('Long question box');
  await page.goto(`/discussion/${room.slug}`);
  const input = page.getByPlaceholder('Enter a new question or statement');
  const oneLineHeight = (await input.boundingBox()).height;

  const text = 'How will AI systems displace human governments? '.repeat(6).trim();
  await input.fill(text);
  const grown = await input.boundingBox();
  expect(grown.height).toBeGreaterThan(oneLineHeight * 1.5);
  // All of the text is visible, so the box never scrolls.
  expect(await input.evaluate(box => box.scrollHeight <= box.clientHeight)).toBe(true);

  await input.press('Enter');
  await expect(page.getByRole('heading', { name: text, exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  expect((await input.boundingBox()).height).toBeCloseTo(oneLineHeight, 0);
});
