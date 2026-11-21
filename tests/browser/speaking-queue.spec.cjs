const { test, expect } = require('./lifecycle-fixtures.cjs');

test('hand raising is optional, private, ordered and survives reconnects', async ({ page: host, browser, rooms }) => {
  const room = await rooms.create('Speaking queue', 'Agreement');
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const alice = await first.newPage();
    const bob = await second.newPage();
    const url = `/discussion/${room.slug}`;
    await Promise.all([host.goto(`${url}?admin=${room.adminToken}`), alice.goto(url), bob.goto(url)]);
    const toggle = host.getByRole('switch', { name: 'Hand raising' });
    await expect(toggle).not.toBeChecked();
    const raise = page => page.getByRole('button', { name: 'Raise hand to speak' });
    await expect(raise(alice)).toHaveCount(0);
    await toggle.click();
    await raise(alice).click();
    const waiting = host.getByRole('region', { name: 'Speaking queue' }).getByRole('listitem');
    await expect(waiting).toHaveCount(1);
    await expect(bob.getByRole('region', { name: 'Speaking queue' }).getByRole('listitem')).toHaveCount(0);
    await alice.reload();
    await expect(alice.getByRole('button', { name: 'Lower hand' })).toBeEnabled();
    await raise(bob).click();
    await expect(waiting).toHaveCount(2);
    await waiting.first().getByRole('button').click();
    await expect(raise(alice)).toBeEnabled();
    await expect(bob.getByRole('button', { name: 'Lower hand' })).toBeEnabled();
    await toggle.click();
    await expect(bob.getByRole('region', { name: 'Speaking queue' })).toHaveCount(0);
    await toggle.click();
    await expect(raise(bob)).toBeEnabled();
    await expect(waiting).toHaveCount(0);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
