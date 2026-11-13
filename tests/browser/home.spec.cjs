const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'convora_discussions';

async function createDiscussion(request, label) {
  const topic = `${label} ${Date.now()} ${Math.random().toString(16).slice(2)}`;
  const response = await request.post('/api/discussions', { data: { topic } });
  expect(response.ok()).toBeTruthy();
  return response.json();
}

test('the home page lists only discussions this browser created or opened', async ({ page, request }) => {
  const theirs = await createDiscussion(request, 'Someone else');
  const opened = await createDiscussion(request, 'Opened by link');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your Discussions' })).toBeVisible();
  await expect(page.getByText('Discussions are unlisted')).toBeVisible();
  await expect(page.getByText(theirs.topic)).toHaveCount(0);
  await expect(page.getByText(opened.topic)).toHaveCount(0);

  // Opening a discussion by its link remembers it.
  await page.goto(`/discussion/${opened.slug}`);
  await expect(page.getByRole('heading', { name: `Discussion: ${opened.topic}` })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('link', { name: opened.topic })).toBeVisible();
  await expect(page.getByText(theirs.topic)).toHaveCount(0);

  // Creating one remembers it too.
  const createdTopic = `Created here ${Date.now()}`;
  await page.getByPlaceholder('Enter discussion topic').fill(createdTopic);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Discussion: ${createdTopic}` })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('link', { name: createdTopic })).toBeVisible();
  await expect(page.getByRole('link', { name: opened.topic })).toBeVisible();
  await expect(page.getByText(theirs.topic)).toHaveCount(0);
});

test('the home page survives stale, corrupt, and unavailable storage', async ({ page, request, browser }) => {
  const opened = await createDiscussion(request, 'Still here');
  await page.goto('/');

  // A remembered discussion that no longer exists is dropped, and a stale
  // title is replaced by the current one.
  await page.evaluate(([key, slug]) => {
    localStorage.setItem(key, JSON.stringify([
      { slug: 'deleted-discussion-that-never-existed', topic: 'Deleted discussion', lastVisited: 2 },
      { slug, topic: 'Stale title', lastVisited: 1 },
      { slug: 'Not A Slug', topic: 'Malformed entry' },
      null,
    ]));
  }, [STORAGE_KEY, opened.slug]);
  await page.reload();
  await expect(page.getByRole('link', { name: opened.topic })).toBeVisible();
  await expect(page.getByText('Deleted discussion')).toHaveCount(0);
  await expect(page.getByText('Malformed entry')).toHaveCount(0);
  await expect(page.getByText('Stale title')).toHaveCount(0);
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  expect(stored.map(entry => entry.slug)).toEqual([opened.slug]);

  // Corrupt data renders the empty state instead of breaking the page.
  await page.evaluate(key => localStorage.setItem(key, '{not json'), STORAGE_KEY);
  await page.reload();
  await expect(page.getByText('Discussions are unlisted')).toBeVisible();

  // A discussion this browser moderates is listed even without a list entry.
  await page.evaluate(slug => localStorage.setItem(`convora_admin_${slug}`, 'not-a-real-token'), opened.slug);
  await page.reload();
  await expect(page.getByRole('link', { name: opened.topic })).toBeVisible();

  // With localStorage unavailable, the page still renders and can be used.
  const blocked = await browser.newContext();
  try {
    await blocked.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() { throw new DOMException('Storage is disabled', 'SecurityError'); },
      });
    });
    const blockedPage = await blocked.newPage();
    await blockedPage.goto('/');
    await expect(blockedPage.getByRole('heading', { name: 'Your Discussions' })).toBeVisible();
    await expect(blockedPage.getByText('Discussions are unlisted')).toBeVisible();
  } finally {
    await blocked.close();
  }
});
