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

test('IME confirmation Enter does not submit or prevent the key event', async ({ page, rooms }) => {
  const room = await rooms.create('IME question box');
  await page.goto(`/discussion/${room.slug}`);
  const input = page.getByPlaceholder('Enter a new question or statement');
  await input.fill('An unfinished question');
  for (const composing of [true, false]) {
    const prevented = await input.evaluate((box, isComposing) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter', keyCode: 229, isComposing, bubbles: true, cancelable: true,
      });
      box.dispatchEvent(event);
      return event.defaultPrevented;
    }, composing);
    expect(prevented).toBe(false);
    await expect(input).toHaveValue('An unfinished question');
  }
});

test('multiline paste before a suffix preserves the insertion point', async ({ page, rooms }) => {
  const room = await rooms.create('Paste question box');
  await page.goto(`/discussion/${room.slug}`);
  const input = page.getByPlaceholder('Enter a new question or statement');
  await input.fill('prefix suffix');
  await input.evaluate(box => { box.focus(); box.setSelectionRange(6, 6); });
  // insertText exercises the same input normalization as a clipboard paste,
  // without requiring browser clipboard permissions.
  await page.keyboard.insertText(' first\nsecond');
  await expect(input).toHaveValue('prefix first second suffix');
  await page.keyboard.type('X');
  await expect(input).toHaveValue('prefix first secondX suffix');
});
