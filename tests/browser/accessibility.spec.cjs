const { test, expect } = require('./lifecycle-fixtures.cjs');

test('vote buttons are named for their option and question and expose the chosen one as pressed', async ({ page, rooms }) => {
  const room = await rooms.create('Named votes', 'Agreement');
  await page.goto(`/discussion/${room.slug}`);
  const button = option => page.getByRole('button', { name: `Vote ${option} on "Named votes question"`, exact: true });
  const options = ['Strongly Agree', 'Agree', 'Unsure', 'Disagree', 'Strongly Disagree'];
  for (const option of options) {
    await expect(button(option)).toHaveAttribute('aria-pressed', 'false');
  }
  // No button is left with only the generic visible text as its name.
  await expect(page.getByRole('button', { name: 'Vote', exact: true })).toHaveCount(0);

  await button('Agree').click();
  await expect(button('Agree')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { pressed: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Undo Vote', exact: true })).toHaveCount(0);

  // Choosing another option moves the pressed state; pressing it again clears it.
  await button('Strongly Disagree').click();
  await expect(button('Strongly Disagree')).toHaveAttribute('aria-pressed', 'true');
  await expect(button('Agree')).toHaveAttribute('aria-pressed', 'false');
  await button('Strongly Disagree').click();
  await expect(page.getByRole('button', { pressed: true })).toHaveCount(0);
  const stored = await rooms.pool.query(
    'SELECT value FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [room.id]
  );
  expect(stored.rows).toEqual([]);
});

test('brainstorm agreement buttons have full names, a pressed state, and a visible label on keyboard focus', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Rated ideas', 'Brainstorm');
  await rooms.pool.query('UPDATE discussions SET reactions_enabled = TRUE WHERE id = $1', [room.id]);
  const authorContext = await browser.newContext();
  try {
    const author = await authorContext.newPage();
    await author.goto(`http://127.0.0.1:4173/discussion/${room.slug}`);
    await author.getByPlaceholder('Add an idea (you can add as many as you like)').fill('Longer lunch breaks');
    await author.getByRole('button', { name: 'Add Idea', exact: true }).click();

    await page.goto(`/discussion/${room.slug}`);
    const rate = label => page.getByRole('button', { name: `${label}: "Longer lunch breaks"`, exact: true });
    for (const label of ['Strongly Disagree', 'Disagree', 'Unsure', 'Agree', 'Strongly Agree']) {
      await expect(rate(label)).toHaveAttribute('aria-pressed', 'false');
    }
    await expect(page.getByRole('button', { name: 'SA', exact: true })).toHaveCount(0);

    await rate('Strongly Agree').click();
    await expect(rate('Strongly Agree')).toHaveAttribute('aria-pressed', 'true');
    await expect(rate('Agree')).toHaveAttribute('aria-pressed', 'false');

    // The full label is hidden until the button is hovered or reached by keyboard.
    const tooltip = rate('Disagree').getByText('Disagree', { exact: true });
    await page.mouse.move(0, 0);
    await expect(tooltip).toBeHidden();
    await rate('Strongly Disagree').focus();
    await page.keyboard.press('Tab');
    await expect(rate('Disagree')).toBeFocused();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(tooltip).toBeHidden();
    await rate('Disagree').hover();
    await expect(tooltip).toBeVisible();
  } finally {
    await authorContext.close();
  }
});

test('the Share panel is a modal dialog: focus moves in, stays in, Escape closes it, and focus returns', async ({ page, rooms }) => {
  const room = await rooms.create('Share dialog');
  await page.goto(`/discussion/${room.slug}`);
  const share = page.getByRole('button', { name: 'Share', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Share this discussion', exact: true });
  const focusInDialog = () => dialog.evaluate(el => el.contains(document.activeElement) && el !== document.activeElement);

  await share.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('button', { name: 'Copy', exact: true })).toBeFocused();

  // Tab wraps from the last control to the first, and Shift+Tab back again.
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  await close.focus();
  await page.keyboard.press('Tab');
  expect(await focusInDialog()).toBe(true);
  await expect(dialog.getByRole('textbox').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press('Tab');
    expect(await focusInDialog()).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(share).toBeFocused();

  // Closing with the button also hands focus back.
  await share.press('Enter');
  await expect(dialog).toBeVisible();
  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(share).toBeFocused();
});

test('the Duplicate Discussion panel is a modal dialog that returns focus to the More button', async ({ page, rooms }) => {
  const room = await rooms.create('Duplicate dialog');
  await page.goto(`/discussion/${room.slug}`);
  const more = page.getByRole('button', { name: 'More ▾', exact: true });
  await more.click();
  await page.getByRole('menuitem', { name: 'Duplicate Discussion', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Duplicate Discussion', exact: true });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('textbox', { name: 'New topic name', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Duplicate', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
});

test('the similar-statement prompt is a modal dialog that closes on Escape', async ({ page, rooms }) => {
  const room = await rooms.create('Similar dialog', 'Agreement');
  await page.goto(`/discussion/${room.slug}`);
  const input = page.getByPlaceholder('Enter a new question or statement');
  await input.fill('Similar dialog question!');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'A similar statement already exists', exact: true });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog.getByRole('button', { name: 'Use existing', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Post anyway', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(input).toBeFocused();
});


test('Share and Duplicate stay above the floating QR and contain background focus', async ({ page, rooms }) => {
  const room = await rooms.create('Modal above QR');
  await page.goto(`/discussion/${room.slug}?admin=${encodeURIComponent(room.adminToken)}`);
  await page.getByRole('button', { name: 'Show join QR', exact: true }).click();
  const resize = page.getByRole('slider', { name: 'Resize join QR code', exact: true });
  await expect(resize).toBeVisible();
  for (const name of ['Share this discussion', 'Duplicate Discussion']) {
    if (name === 'Share this discussion') {
      await page.getByRole('button', { name: 'Share', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'More ▾', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Duplicate Discussion', exact: true }).click();
    }
    const dialog = page.getByRole('dialog', { name, exact: true });
    await expect(dialog).toBeVisible();
    // At a point on the background QR slider, hit-testing must reach the modal
    // overlay or its panel instead of the background resize control.
    expect(await resize.evaluate(el => {
      const rect = el.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return document.querySelector('[role="dialog"]').parentElement.contains(hit);
    })).toBe(true);
    await resize.focus();
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
  // Focus confinement is removed when the last modal closes.
  await resize.focus();
  await expect(resize).toBeFocused();
});
