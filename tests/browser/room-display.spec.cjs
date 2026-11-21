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

test('a hidden join code stays hidden while the display waits for its settings', async ({ page, rooms }) => {
  const room = await rooms.create('Hidden join code');
  await rooms.pool.query("UPDATE discussions SET display_qr = 'hidden' WHERE id = $1", [room.id]);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/socket.io/**', async route => { await gate; await route.continue(); });
  try {
    await page.goto(`/discussion/${room.slug}/display`);
    await expect(page.getByText('Loading…', { exact: true })).toBeVisible();
    await expect(page.getByTestId('display-join')).toHaveCount(0);
  } finally { release(); }
  await expect(page.getByRole('heading', { name: 'Hidden join code question' })).toBeVisible();
  await expect(page.getByTestId('display-join')).toHaveCount(0);
});

test('a comparison refuses an absent question without replacing the current spotlight', async ({ page, browser, rooms, request }) => {
  const room = await rooms.create('Original', 'Agreement');
  const path = `/discussion/${room.slug}`;
  const save = await request.post(`/api/discussions/${room.slug}/snapshots`, { data: { name: 'Before', adminToken: room.adminToken } });
  expect(save.status()).toBe(201);
  await rooms.pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Added later', 'Agreement')", [room.id]);
  const projector = await browser.newPage();
  try {
    await projector.goto(`${path}/display`);
    await page.goto(`${path}?admin=${room.adminToken}`);
    const card = title => page.locator('.shadow-lg').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).last();
    await page.getByLabel('Layout', { exact: true }).selectOption('compare');
    const comparison = projector.getByTestId('display-comparison-view');
    await expect(comparison).toBeVisible();
    await card('Original question').getByRole('button', { name: 'Show on display', exact: true }).click();
    await expect(card('Original question').getByRole('button', { name: 'Back to full comparison' })).toBeVisible();
    await card('Added later').getByRole('button', { name: 'Show on display', exact: true }).click();
    await expect(card('Added later').getByRole('alert')).toContainText('not in the selected snapshots');
    await expect(card('Original question').getByRole('button', { name: 'Back to full comparison' })).toBeVisible();
    await expect(comparison.getByRole('heading', { name: 'Original question' })).toBeVisible();
  } finally { await projector.close(); }
});

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
    // Its only control is the full-screen button.
    await expect(display.getByRole('button')).toHaveText(['Full screen']);
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
  await page.goto(`/discussion/${room.slug}/display`);
  const question = page.getByTestId('display-question');
  await expect(question.getByText('0 responses', { exact: true })).toBeVisible();
  await expect(question.locator('header')).not.toContainText('0 responses');
  await rooms.pool.query(
    `INSERT INTO votes (question_id, value, user_id)
     SELECT id, 'A response everyone can read', 'seed-a' FROM questions WHERE discussion_id = $1`, [room.id]
  );
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(room.topic);
  await expect(page.getByText('A response everyone can read', { exact: true })).toBeVisible();
  await expect(question.locator('header').getByText('1 response', { exact: true })).toBeVisible();
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
    const qrSetting = moderator.getByLabel('QR code', { exact: true });
    const layoutSetting = moderator.getByLabel('Layout', { exact: true });

    // A small QR code at the bottom-left still lets people join.
    await qrSetting.selectOption('corner');
    await expect(page.getByTestId('display-footer').getByTestId('display-join')).toBeVisible();
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
    await moderator.getByLabel('QR code', { exact: true }).selectOption('full');
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

test('the room display labels each value once on a short numerical scale', async ({ page, rooms }) => {
  const room = await rooms.create('Short scale display', 'Numerical');
  await rooms.pool.query("UPDATE discussions SET results_visibility = 'always' WHERE id = $1", [room.id]);
  await rooms.pool.query('UPDATE questions SET min_value = 1, max_value = 5 WHERE discussion_id = $1', [room.id]);
  await rooms.pool.query(
    `INSERT INTO votes (question_id, value, user_id)
     SELECT id, v.value, v.user_id FROM questions,
       (VALUES ('1', 'seed-a'), ('5', 'seed-b')) AS v(value, user_id)
     WHERE discussion_id = $1`, [room.id]
  );
  await page.goto(`/discussion/${room.slug}/display`);
  const question = page.getByTestId('display-question');
  // One bar per value, each labelled once: no second "5" for the maximum.
  await expect(question.getByTestId('display-histogram-axis').locator('span')).toHaveText(['1', '2', '3', '4', '5']);
  const bars = question.getByTestId('display-histogram-bin');
  await expect(bars).toHaveCount(5);
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

test('the room display goes full screen and hides its controls and the cursor when idle', async ({ page, rooms }) => {
  const room = await rooms.create('Full screen room', 'Agreement');
  await page.clock.install();
  await page.goto(`/discussion/${room.slug}/display`);
  await expect(page.getByTestId('display-question')).toBeVisible();

  const enter = page.getByTestId('display-header').getByRole('button', { name: 'Full screen', exact: true });
  await enter.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  const exit = page.getByRole('button', { name: 'Exit full screen', exact: true });
  await expect(exit).toBeVisible();

  // Nobody touches the mouse: the button and the cursor fade out.
  const main = page.getByRole('main', { name: 'Room display' });
  await page.clock.runFor(3500);
  await expect(exit).toHaveCSS('opacity', '0');
  await expect(main).toHaveCSS('cursor', 'none');

  // Moving the mouse brings them back.
  await page.mouse.move(200, 200);
  await page.mouse.move(220, 210);
  await expect(exit).toHaveCSS('opacity', '1');
  await expect(main).not.toHaveCSS('cursor', 'none');

  await exit.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBe(null);
  await expect(enter).toBeVisible();
});

test('the room display lists Multiple Choice options while results are hidden, then charts them', async ({ browser, rooms }) => {
  const room = await rooms.create('Choice display', 'Multiple Choice');
  await rooms.pool.query('UPDATE questions SET options = $1 WHERE discussion_id = $2',
    [JSON.stringify(['Higher', 'Lower', 'About the same']), room.id]);
  const context = await browser.newContext();
  try {
    const display = await context.newPage();
    const question = display.getByTestId('display-question');

    // Results always shown but nobody has voted yet: the choices are still on
    // screen, each at zero, so the room knows what it is choosing between.
    await rooms.pool.query("UPDATE discussions SET results_visibility = 'always' WHERE id = $1", [room.id]);
    await display.goto(`/discussion/${room.slug}/display`);
    await expect(question.getByText('0 responses', { exact: true })).toBeVisible();
    await expect(question.locator('header')).not.toContainText('0 responses');
    await expect(question.getByTestId('display-chart').getByLabel('Higher: 0, 0%')).toBeVisible();
    await expect(question.getByTestId('display-chart').getByLabel('Lower: 0, 0%')).toBeVisible();
    await expect(question.getByTestId('display-chart').getByLabel('About the same: 0, 0%')).toBeVisible();

    await rooms.pool.query("UPDATE discussions SET results_visibility = 'after_vote' WHERE id = $1", [room.id]);
    await rooms.pool.query(
      `INSERT INTO votes (question_id, value, user_id)
       SELECT id, v.value, v.user_id FROM questions,
         (VALUES ('Higher', 'seed-a'), ('Higher', 'seed-b'), ('Lower', 'seed-c')) AS v(value, user_id)
       WHERE discussion_id = $1`, [room.id]
    );
    await display.reload();
    await expect(question.getByTestId('display-results-hidden')).toContainText('3');
    await expect(question.getByTestId('display-choice-options').getByRole('listitem'))
      .toHaveText(['Higher', 'Lower', 'About the same']);
    await expect(question.getByTestId('display-chart')).toHaveCount(0);

    await rooms.pool.query("UPDATE discussions SET results_visibility = 'always' WHERE id = $1", [room.id]);
    await display.reload();
    const chart = question.getByTestId('display-chart');
    await expect(chart.getByRole('listitem')).toHaveCount(3);
    await expect(chart.getByLabel('Higher: 2, 67%')).toBeVisible();
    await expect(chart.getByLabel('Lower: 1, 33%')).toBeVisible();
    await expect(chart.getByLabel('About the same: 0, 0%')).toBeVisible();
    await expect(question.getByText('67% Higher', { exact: true })).toBeVisible();
    await expect(display.getByTestId('display-choice-options')).toHaveCount(0);

    // Back to results after voting, with this one question revealed by the
    // moderator and the display showing one question at a time: the chart
    // fills the screen.
    await rooms.pool.query(
      "UPDATE discussions SET results_visibility = 'after_vote', display_layout = 'focus' WHERE id = $1", [room.id]
    );
    await rooms.pool.query('UPDATE questions SET results_revealed = TRUE WHERE discussion_id = $1', [room.id]);
    await display.reload();
    const focused = display.getByTestId('display-question');
    await expect(focused.getByTestId('display-chart').getByLabel('Higher: 2, 67%')).toBeVisible();
    await expect(focused.getByText('67% Higher', { exact: true })).toHaveClass(/text-6xl/);
    await expect(display.getByTestId('display-results-hidden')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

for (const layout of ['all', 'focus']) {
  test('long choice labels wrap within their display column in ' + layout + ' layout', async ({ page, rooms }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const room = await rooms.create('Long display choices', 'Multiple Choice');
    const longOption = 'X'.repeat(100);
    await rooms.pool.query('UPDATE questions SET options = $1 WHERE discussion_id = $2',
      [JSON.stringify([longOption, 'Short']), room.id]);
    await rooms.pool.query("UPDATE discussions SET results_visibility = 'always', display_layout = $1 WHERE id = $2",
      [layout, room.id]);
    await rooms.pool.query(
      "INSERT INTO votes (question_id, value, user_id) SELECT id, 'Short', 'wrap-voter' FROM questions WHERE discussion_id = $1",
      [room.id]
    );
    await page.goto(`/discussion/${room.slug}/display`);
    const label = page.getByTestId('display-chart').getByText(longOption, { exact: true });
    await expect(label).toBeVisible();
    const fits = await label.evaluate(element => {
      const column = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      return Array.from(range.getClientRects()).every(rect => rect.left >= column.left - 1 && rect.right <= column.right + 1);
    });
    expect(fits).toBe(true);

    // The same option must also fit when it becomes the chart's headline.
    await rooms.pool.query('UPDATE votes SET value = $1 WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $2)',
      [longOption, room.id]);
    await page.reload();
    await expect(page.getByTestId('display-chart')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

for (const layout of ['all', 'focus']) {
  test('long choice labels wrap inside the hidden-results option list in ' + layout + ' layout', async ({ page, rooms }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const room = await rooms.create('Long hidden choices', 'Multiple Choice');
    const longOption = 'Y'.repeat(100);
    await rooms.pool.query('UPDATE questions SET options = $1 WHERE discussion_id = $2',
      [JSON.stringify([longOption, 'Short']), room.id]);
    // Results only after voting, with one response: the display shows the count
    // and the options, not the chart.
    await rooms.pool.query("UPDATE discussions SET results_visibility = 'after_vote', display_layout = $1 WHERE id = $2",
      [layout, room.id]);
    await rooms.pool.query(
      "INSERT INTO votes (question_id, value, user_id) SELECT id, 'Short', 'wrap-voter' FROM questions WHERE discussion_id = $1",
      [room.id]
    );
    await page.goto(`/discussion/${room.slug}/display`);
    const card = page.getByTestId('display-question');
    const pill = card.getByTestId('display-choice-options').getByText(longOption, { exact: true });
    await expect(pill).toBeVisible();
    const fits = await pill.evaluate(element => {
      const cardBox = element.closest('[data-testid="display-question"]').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      return Array.from(range.getClientRects()).every(rect => rect.left >= cardBox.left - 1 && rect.right <= cardBox.right + 1);
    });
    expect(fits).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}


test('corner QR stays in view while long questions scroll above it', async ({ page, rooms }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const room = await rooms.create('Long corner display', 'Open Ended');
  await rooms.pool.query("UPDATE discussions SET display_qr = 'corner' WHERE id = $1", [room.id]);
  await rooms.pool.query('UPDATE questions SET text = $1 WHERE discussion_id = $2',
    ['Long question content '.repeat(500), room.id]);
  await page.goto(`/discussion/${room.slug}/display`);
  const footer = page.getByTestId('display-footer');
  await expect(footer).toBeInViewport({ ratio: 1 });
  const questions = page.getByRole('region', { name: 'Questions', exact: true });
  const bounds = await questions.evaluate(element => {
    const scroller = element.parentElement;
    const box = scroller.getBoundingClientRect();
    return { bottom: box.bottom, scrollable: scroller.scrollHeight > scroller.clientHeight };
  });
  expect(bounds.scrollable).toBe(true);
  const footerBox = await footer.boundingBox();
  expect(bounds.bottom).toBeLessThanOrEqual(footerBox.y);
  const joinBox = await page.getByTestId('display-join').boundingBox();
  expect(joinBox.x).toBeLessThan(100);
  await questions.evaluate(element => { element.parentElement.scrollTop = element.parentElement.scrollHeight; });
  await expect(footer).toBeInViewport({ ratio: 1 });
});


test('corner QR and questions remain reachable below a tall header', async ({ page, rooms }) => {
  await page.setViewportSize({ width: 480, height: 360 });
  const room = await rooms.create('A long room title that wraps onto many lines on a small display '.repeat(2), 'Open Ended');
  await rooms.pool.query("UPDATE discussions SET display_qr = 'corner' WHERE id = $1", [room.id]);
  await page.goto(`/discussion/${room.slug}/display`);
  const questions = page.getByRole('region', { name: 'Questions', exact: true });
  await expect(questions).toBeVisible();
  await questions.scrollIntoViewIfNeeded();
  await expect(questions).toBeInViewport();
  const qr = page.getByRole('img', { name: /^QR code to join/ });
  await qr.scrollIntoViewIfNeeded();
  await expect(qr).toBeInViewport({ ratio: 1 });
});

test('display sorting updates live, persists and is available only in the all-questions layout', async ({ page, browser, rooms }) => {
  const room = await rooms.create('Sort display', 'Agreement');
  await rooms.pool.query('UPDATE questions SET pinned = TRUE WHERE discussion_id = $1', [room.id]);
  await rooms.pool.query(
    'INSERT INTO questions (discussion_id, text, type) VALUES ($1, $2, $3)',
    [room.id, 'Newest question', 'Yes/No']
  );
  const context = await browser.newContext();
  try {
    await page.goto(`/discussion/${room.slug}/display`);
    const headings = page.getByTestId('display-question').getByRole('heading');
    await expect(headings).toHaveText(['📌Sort display question', 'Newest question']);
    const moderator = await context.newPage();
    await moderator.goto(`/discussion/${room.slug}?admin=${room.adminToken}`);
    const controls = moderator.getByRole('group', { name: 'Display controls', exact: true });
    await controls.getByLabel('Sort', { exact: true }).selectOption('newest');
    await expect(headings).toHaveText(['📌Sort display question', 'Newest question']);
    await controls.getByRole('switch', { name: 'Pinned questions first' }).click();
    await expect(headings).toHaveText(['Newest question', '📌Sort display question']);
    await page.reload();
    await expect(headings).toHaveText(['Newest question', '📌Sort display question']);
    await moderator.reload();
    await expect(controls.getByLabel('Sort', { exact: true })).toHaveValue('newest');
    await expect(controls.getByRole('switch', { name: 'Pinned questions first' })).toHaveAttribute('aria-checked', 'false');
    await controls.getByLabel('Layout', { exact: true }).selectOption('focus');
    await expect(controls.getByLabel('Sort', { exact: true })).toHaveCount(0);
    await controls.getByLabel('Layout', { exact: true }).selectOption('all');
    await expect(headings).toHaveText(['Newest question', '📌Sort display question']);
    await controls.getByLabel('Sort', { exact: true }).selectOption('oldest');
    await expect(headings).toHaveText(['📌Sort display question', 'Newest question']);
  } finally {
    await context.close();
  }
});
