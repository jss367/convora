const { test, expect } = require('./lifecycle-fixtures.cjs');
const { observeQuestionPayloads } = require('../helpers/question-payloads.cjs');

async function seedVotes(rooms, room) {
  await rooms.pool.query(
    `INSERT INTO votes (question_id, value, user_id)
     SELECT id, v.value, v.user_id FROM questions,
       (VALUES ('Agree', 'seed-a'), ('Disagree', 'seed-b')) AS v(value, user_id)
     WHERE discussion_id = $1`, [room.id]
  );
}

test('the room display shows response counts but no results until the moderator always shows them', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Room display', 'Agreement');
  await seedVotes(rooms, room);
  const displayContext = await browser.newContext();
  const moderatorContext = await browser.newContext();
  try {
    // A participant is in the room before the display opens.
    await page.goto(`/discussion/${room.slug}`);
    await expect(page.getByText('1 person here now', { exact: true })).toBeVisible();

    const display = await displayContext.newPage();
    const { payloads, errors } = observeQuestionPayloads(display);
    await display.goto(`/discussion/${room.slug}/display`);
    const question = display.getByTestId('display-question');
    await expect(question.getByRole('heading', { name: 'Room display question', exact: true })).toBeVisible();
    await expect(question.getByText('2 responses', { exact: true })).toBeVisible();
    await expect(display.getByTestId('display-join-link')).toHaveText(`127.0.0.1:4173/discussion/${room.slug}`);
    await expect(display.getByRole('img', { name: /^QR code to join/ })).toBeVisible();
    // The display does not count itself, on its own screen or anyone else's.
    await expect(display.getByText('1 person here now', { exact: true })).toBeVisible();
    await expect(page.getByText('1 person here now', { exact: true })).toBeVisible();
    // It is read-only: nothing to vote with, no tally, and none sent to it.
    await expect(display.getByRole('button')).toHaveCount(0);
    await expect(display.getByText(/: \d+$/)).toHaveCount(0);
    await expect(display.getByText(/% agree/)).toHaveCount(0);
    await expect.poll(() => payloads.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    expect(payloads.join('')).not.toMatch(/"value"|Disagree|ownerToken/);

    // A participant's vote updates the count live, and still reveals nothing.
    const before = payloads.length;
    await page.getByRole('button', { name: 'Vote Strongly Agree on "Room display question"', exact: true }).click();
    await expect(question.getByText('3 responses', { exact: true })).toBeVisible();
    await expect.poll(() => payloads.length).toBeGreaterThan(before);
    expect(payloads.join('')).not.toMatch(/"value"|Disagree|Strongly Agree|ownerToken/);

    // The moderator opens the display from the moderator bar. Its link carries
    // no moderator token, so it shows the same as the projected screen.
    const moderator = await moderatorContext.newPage();
    await moderator.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
    const link = moderator.getByRole('link', { name: 'Open room display', exact: true });
    await expect(link).toHaveAttribute('href', `/discussion/${room.slug}/display`);
    const [popup] = await Promise.all([moderator.waitForEvent('popup'), link.click()]);
    await expect(popup.getByTestId('display-question').getByText('3 responses', { exact: true })).toBeVisible();
    expect(popup.url()).not.toContain('admin');
    await expect(popup.getByText(/: \d+$/)).toHaveCount(0);

    // Always show results: the displays switch to live results at once.
    await moderator.getByRole('combobox').filter({ has: moderator.locator('option[value="after_vote"]') }).selectOption('always');
    await expect(question.getByText('Strongly Agree: 1', { exact: true })).toBeVisible();
    await expect(question.getByText('Agree: 1', { exact: true })).toBeVisible();
    await expect(question.getByText('Disagree: 1', { exact: true })).toBeVisible();
    await expect(popup.getByTestId('display-question').getByText(/3 votes · 67% agree/)).toBeVisible();
    await page.getByRole('button', { name: 'Vote Strongly Agree on "Room display question"', exact: true, pressed: true }).click();
    await expect(question.getByText('Strongly Agree: 0', { exact: true })).toBeVisible();
    await expect(question.getByText('2 responses', { exact: true })).toBeVisible();
    // Participants still count once each: the participant and the moderator.
    await expect(display.getByText('2 people here now', { exact: true })).toBeVisible();
  } finally {
    await displayContext.close();
    await moderatorContext.close();
  }
});

test('the room display shows written responses and the discussion title', async ({ page, rooms }) => {
  const room = await rooms.create('Written display');
  await rooms.pool.query(
    `INSERT INTO votes (question_id, value, user_id)
     SELECT id, 'A response everyone can read', 'seed-a' FROM questions WHERE discussion_id = $1`, [room.id]
  );
  await page.goto(`/discussion/${room.slug}/display`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(room.topic);
  await expect(page.getByText('A response everyone can read', { exact: true })).toBeVisible();
  await expect(page.getByText('1 response', { exact: true })).toBeVisible();
  await expect(page.getByText('0 people here now', { exact: true })).toBeVisible();
});

test('the room display says when the discussion does not exist', async ({ page }) => {
  await page.goto('/discussion/no-such-discussion-for-the-display/display');
  await expect(page.getByText('Discussion not found', { exact: true })).toBeVisible();
});

test('the room display preserves a numerical range ending at zero', async ({ page, rooms }) => {
  const room = await rooms.create('Negative range display', 'Numerical');
  await rooms.pool.query("UPDATE discussions SET results_visibility = 'always' WHERE id = $1", [room.id]);
  await rooms.pool.query('UPDATE questions SET min_value = -100, max_value = 0 WHERE discussion_id = $1', [room.id]);
  await rooms.pool.query(
    `INSERT INTO votes (question_id, value, user_id)
     SELECT id, v.value, v.user_id FROM questions,
       (VALUES ('-100', 'seed-a'), ('0', 'seed-b')) AS v(value, user_id)
     WHERE discussion_id = $1`, [room.id]
  );
  await page.goto(`/discussion/${room.slug}/display`);
  const question = page.getByTestId('display-question');
  await expect(question.getByText('2 responses · average -50.0', { exact: true })).toBeVisible();
  const axis = question.locator('.ml-7.flex.justify-between');
  await expect(axis.locator('span')).toHaveText(['-100', '0']);
  // The two endpoints must land in opposite end bins of the actual range.
  const bars = question.locator('[title$=" response"], [title$=" responses"]');
  await expect(bars).toHaveCount(10);
  await expect(bars.first()).toHaveAttribute('title', '1 response');
  await expect(bars.last()).toHaveAttribute('title', '1 response');
});

// A fake Screen Wake Lock API that counts the locks held, and releases them
// when the tab is hidden as browsers do. With deferred, requests stay pending
// until the test calls window.__wakeLock.grant() or window.__wakeLock.deny().
async function fakeWakeLock(page, { deferred = false } = {}) {
  await page.addInitScript(deferredRequests => {
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const locks = [];
    const pending = [];
    window.__wakeLock = {
      requests: 0,
      pending: () => pending.length,
      held: () => locks.filter(lock => !lock.released).length,
      grant: () => pending.splice(0).forEach(({ resolve }) => resolve()),
      deny: () => pending.splice(0).forEach(({ reject }) => reject(new DOMException('Document is hidden', 'NotAllowedError'))),
      setVisibility(next) {
        visibility = next;
        if (next === 'hidden') locks.forEach(lock => { lock.released = true; });
        document.dispatchEvent(new Event('visibilitychange'));
      },
    };
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async type => {
          if (type !== 'screen') throw new Error('unexpected wake lock type');
          window.__wakeLock.requests += 1;
          if (deferredRequests) await new Promise((resolve, reject) => pending.push({ resolve, reject }));
          const lock = { released: false, release: async () => { lock.released = true; } };
          locks.push(lock);
          return lock;
        },
      },
    });
  }, deferred);
}

const leaveDisplay = page => page.evaluate(() => {
  window.history.pushState({}, '', '/');
  window.dispatchEvent(new PopStateEvent('popstate'));
});

test('the room display keeps the screen awake, and asks again after the tab was hidden', async ({ page, rooms }) => {
  const room = await rooms.create('Wake lock room', 'Agreement');
  await fakeWakeLock(page);

  await page.goto(`/discussion/${room.slug}/display`);
  await expect(page.getByTestId('display-question')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__wakeLock.held())).toBe(1);

  await page.evaluate(() => window.__wakeLock.setVisibility('hidden'));
  expect(await page.evaluate(() => window.__wakeLock.held())).toBe(0);
  await page.evaluate(() => window.__wakeLock.setVisibility('visible'));
  await expect.poll(() => page.evaluate(() => window.__wakeLock.held())).toBe(1);
  expect(await page.evaluate(() => window.__wakeLock.requests)).toBe(2);

  // Leaving the display for a participant page lets the screen sleep again.
  await leaveDisplay(page);
  await expect.poll(() => page.evaluate(() => window.__wakeLock.held())).toBe(0);
});

test('the room display never holds two wake locks when the tab flips during a request', async ({ page, rooms }) => {
  const room = await rooms.create('Wake lock race room', 'Agreement');
  await fakeWakeLock(page, { deferred: true });
  await page.goto(`/discussion/${room.slug}/display`);
  await expect(page.getByTestId('display-question')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__wakeLock.pending())).toBe(1);

  // Hidden and shown again before the first request is granted: no second
  // request starts alongside it.
  await page.evaluate(() => {
    window.__wakeLock.setVisibility('hidden');
    window.__wakeLock.setVisibility('visible');
  });
  expect(await page.evaluate(() => window.__wakeLock.requests)).toBe(1);
  await page.evaluate(() => window.__wakeLock.grant());
  await expect.poll(() => page.evaluate(() => window.__wakeLock.held())).toBe(1);
  expect(await page.evaluate(() => window.__wakeLock.requests)).toBe(1);

  await leaveDisplay(page);
  await expect.poll(() => page.evaluate(() => window.__wakeLock.held())).toBe(0);
});

test('the room display asks again when a request is refused after the tab flipped during it', async ({ page, rooms }) => {
  const room = await rooms.create('Wake lock refused room', 'Agreement');
  await fakeWakeLock(page, { deferred: true });
  await page.goto(`/discussion/${room.slug}/display`);
  await expect(page.getByTestId('display-question')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__wakeLock.pending())).toBe(1);

  // Hidden and shown while the request is pending, and the browser refuses it
  // because the document was hidden. The skipped visibility change is replayed.
  await page.evaluate(() => {
    window.__wakeLock.setVisibility('hidden');
    window.__wakeLock.setVisibility('visible');
  });
  await page.evaluate(() => window.__wakeLock.deny());
  await expect.poll(() => page.evaluate(() => window.__wakeLock.pending())).toBe(1);
  expect(await page.evaluate(() => window.__wakeLock.requests)).toBe(2);
  await page.evaluate(() => window.__wakeLock.grant());
  await expect.poll(() => page.evaluate(() => window.__wakeLock.held())).toBe(1);
  expect(await page.evaluate(() => window.__wakeLock.requests)).toBe(2);
});
