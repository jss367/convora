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
    // Each option is its own labelled bar, drawn for the big screen.
    await expect(question.getByLabel('Strongly Agree: 1, 33%', { exact: true })).toBeVisible();
    await expect(question.getByLabel('Agree: 1, 33%', { exact: true })).toBeVisible();
    await expect(question.getByLabel('Disagree: 1, 33%', { exact: true })).toBeVisible();
    await expect(question.getByTestId('display-results-hidden')).toHaveCount(0);
    await expect(popup.getByTestId('display-question').getByText(/67% agree/)).toBeVisible();
    await page.getByRole('button', { name: 'Vote Strongly Agree on "Room display question"', exact: true, pressed: true }).click();
    await expect(question.getByLabel('Strongly Agree: 0, 0%', { exact: true })).toBeVisible();
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

test('the moderator moves or hides the display QR code and shows one question at a time', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Display controls', 'Agreement');
  await rooms.pool.query(
    'INSERT INTO questions (discussion_id, text, type) VALUES ($1, $2, $3)',
    [room.id, 'Newest display question', 'Open Ended']
  );
  const moderatorContext = await browser.newContext();
  try {
    await page.goto(`/discussion/${room.slug}/display`);
    const qr = page.getByRole('img', { name: /^QR code to join/ });
    await expect(qr).toBeVisible();
    await expect(page.getByTestId('display-question')).toHaveCount(2);

    const moderator = await moderatorContext.newPage();
    await moderator.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
    const qrSetting = moderator.getByLabel('Display QR');
    const layoutSetting = moderator.getByLabel('Display shows');

    // A small QR code in the header still lets people join.
    await qrSetting.selectOption('corner');
    await expect(page.getByTestId('display-header').getByTestId('display-join')).toBeVisible();
    await expect(qr).toBeVisible();
    await expect(page.getByTestId('display-join-link')).toBeVisible();

    await qrSetting.selectOption('hidden');
    await expect(qr).toHaveCount(0);
    await expect(page.getByTestId('display-join-link')).toHaveCount(0);
    // The header keeps its count; the moderator's own page is the one person here.
    await expect(page.getByText('1 person here now', { exact: true })).toBeVisible();

    // One question at a time: the newest, until the moderator pins one.
    await layoutSetting.selectOption('focus');
    const shown = page.getByTestId('display-question');
    await expect(shown).toHaveCount(1);
    await expect(shown.getByRole('heading', { name: 'Newest display question' })).toBeVisible();
    await rooms.pool.query('UPDATE questions SET pinned = TRUE WHERE discussion_id = $1 AND type = $2', [room.id, 'Agreement']);
    await moderator.getByLabel('Display QR').selectOption('full');
    await page.reload();
    await expect(shown).toHaveCount(1);
    await expect(shown.getByRole('heading', { name: /Display controls question/ })).toBeVisible();
    await expect(qr).toBeVisible();

    await layoutSetting.selectOption('all');
    await expect(page.getByTestId('display-question')).toHaveCount(2);
  } finally {
    await moderatorContext.close();
  }
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
  await expect(question.getByText('2 responses', { exact: true })).toBeVisible();
  await expect(question.getByText('Average -50', { exact: true })).toBeVisible();
  await expect(question.getByTestId('display-histogram-axis').locator('span'))
    .toHaveText(['-100', '-80', '-60', '-40', '-20', '0']);
  // The two endpoints must land in opposite end bins of the actual range.
  const bars = question.getByTestId('display-histogram-bin');
  await expect(bars).toHaveCount(10);
  await expect(bars.first()).toHaveAttribute('aria-label', '1 response');
  await expect(bars.last()).toHaveAttribute('aria-label', '1 response');
});

// A fake Screen Wake Lock API that counts the locks held, and releases them
// when the tab is hidden as browsers do. With deferred, requests stay pending
// until the test calls window.__wakeLock.grant() or window.__wakeLock.deny().
// With api 'missing' the browser has no Screen Wake Lock API, as on older smart
// TVs; with 'refused' every request is rejected.
async function fakeWakeLock(page, { deferred = false, api = 'working' } = {}) {
  await page.addInitScript(({ deferredRequests, apiMode }) => {
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
      value: apiMode === 'missing' ? undefined : {
        request: async type => {
          if (type !== 'screen') throw new Error('unexpected wake lock type');
          window.__wakeLock.requests += 1;
          if (apiMode === 'refused') throw new DOMException('Wake lock refused', 'NotAllowedError');
          if (deferredRequests) await new Promise((resolve, reject) => pending.push({ resolve, reject }));
          const lock = { released: false, release: async () => { lock.released = true; } };
          locks.push(lock);
          return lock;
        },
      },
    });
  }, { deferredRequests: deferred, apiMode: api });
}

const keepAwakeVideoPlaying = page => page.evaluate(() => {
  const video = document.querySelector('[data-testid="keep-awake-video"]');
  if (!video) return 'none';
  return video.paused ? 'paused' : 'playing';
});

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
  // A hidden display doesn't keep the screen on through the video either.
  expect(await keepAwakeVideoPlaying(page)).toBe('paused');
  await page.evaluate(() => window.__wakeLock.setVisibility('visible'));
  await expect.poll(() => page.evaluate(() => window.__wakeLock.held())).toBe(1);
  expect(await page.evaluate(() => window.__wakeLock.requests)).toBe(2);
  // A muted video plays as well, for TVs that ignore the wake lock.
  expect(await keepAwakeVideoPlaying(page)).toBe('playing');

  // Leaving the display for a participant page lets the screen sleep again.
  await leaveDisplay(page);
  await expect.poll(() => page.evaluate(() => window.__wakeLock.held())).toBe(0);
  expect(await keepAwakeVideoPlaying(page)).toBe('none');
});

for (const api of ['missing', 'refused']) {
  test(`the room display still stays awake with a muted video when the wake lock is ${api}`, async ({ page, rooms }) => {
    const room = await rooms.create(`Wake video ${api} room`, 'Agreement');
    await fakeWakeLock(page, { api });
    await page.goto(`/discussion/${room.slug}/display`);
    await expect(page.getByTestId('display-question')).toBeVisible();
    await expect.poll(() => keepAwakeVideoPlaying(page)).toBe('playing');
    expect(await page.evaluate(() => document.querySelector('[data-testid="keep-awake-video"]').muted)).toBe(true);

    // Paused while hidden, it plays again when the tab is shown; there is only
    // ever one video.
    await page.evaluate(() => window.__wakeLock.setVisibility('hidden'));
    expect(await keepAwakeVideoPlaying(page)).toBe('paused');
    await page.evaluate(() => window.__wakeLock.setVisibility('visible'));
    await expect.poll(() => keepAwakeVideoPlaying(page)).toBe('playing');
    expect(await page.locator('[data-testid="keep-awake-video"]').count()).toBe(1);

    await leaveDisplay(page);
    await expect.poll(() => keepAwakeVideoPlaying(page)).toBe('none');
  });
}

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

test('the moderator shows and hides one question\'s results on the room display', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Reveal on screen', 'Agreement');
  await seedVotes(rooms, room);
  const displayContext = await browser.newContext();
  const participantContext = await browser.newContext();
  try {
    const display = await displayContext.newPage();
    await display.goto(`/discussion/${room.slug}/display`);
    const question = display.getByTestId('display-question');
    await expect(question.getByText('2 responses', { exact: true })).toBeVisible();
    await expect(question.getByText('Vote on your phone. The moderator will show the results here.', { exact: true })).toBeVisible();
    await expect(question.getByText(/: \d+$/)).toHaveCount(0);

    const participant = await participantContext.newPage();
    await participant.goto(`/discussion/${room.slug}`);
    await expect(participant.getByText('Results appear after you vote', { exact: true })).toBeVisible();
    await expect(participant.getByRole('button', { name: 'Show results', exact: true })).toHaveCount(0);

    await page.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
    const show = page.getByRole('button', { name: 'Show results', exact: true });
    await expect(show).toHaveAttribute('aria-pressed', 'false');
    await show.click();
    const hide = page.getByRole('button', { name: 'Hide results', exact: true });
    await expect(hide).toHaveAttribute('aria-pressed', 'true');

    // Revealed for the room and for someone who has not voted.
    await expect(question.getByLabel('Agree: 1, 50%', { exact: true })).toBeVisible();
    await expect(question.getByLabel('Disagree: 1, 50%', { exact: true })).toBeVisible();
    await expect(participant.getByText('Results appear after you vote', { exact: true })).toHaveCount(0);
    await expect(participant.getByText('2 votes', { exact: false })).toBeVisible();

    await hide.click();
    await expect(question.getByText('Vote on your phone. The moderator will show the results here.', { exact: true })).toBeVisible();
    await expect(question.getByText(/: \d+$/)).toHaveCount(0);
    await expect(participant.getByText('Results appear after you vote', { exact: true })).toBeVisible();

    // With results always shown there is nothing to reveal.
    await page.getByRole('combobox').filter({ has: page.locator('option[value="after_vote"]') }).selectOption('always');
    await expect(question.getByLabel('Agree: 1, 50%', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(Show|Hide) results$/ })).toHaveCount(0);
  } finally {
    await displayContext.close();
    await participantContext.close();
  }
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
