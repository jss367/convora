const { test, expect } = require('@playwright/test');

test('a viewer can retry a busy opinion-group analysis without reloading the page', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/discussions/cluster-retry/clusters', route => {
    attempts++;
    return route.fulfill(attempts === 1
      ? { status: 503, json: { error: 'Busy' } }
      : { json: { eligible: false, reason: 'Not enough votes yet.' } });
  });
  await page.goto('/discussion/cluster-retry/clusters');
  await expect(page.getByRole('alert')).toContainText('busy');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('Not enough votes yet.')).toBeVisible();
  expect(attempts).toBe(2);
});
