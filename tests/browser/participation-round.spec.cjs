const { test, expect } = require('./lifecycle-fixtures.cjs');

test('revealing and resetting a round protects the next group’s answers and clears hands', async ({ page: host, browser, request, rooms }) => {
  const room = await rooms.create('Independent round');
  const path = `/discussion/${room.slug}`;
  await rooms.pool.query("UPDATE discussions SET hands_enabled = true, results_visibility = 'always' WHERE id=$1", [room.id]);
  const guest = await browser.newPage();
  const screen = await browser.newPage();
  try {
    await host.goto(`${path}?admin=${room.adminToken}`);
    await host.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await host.getByRole('checkbox', { name: /Collect independent answers/ }).last().check();
    await host.getByRole('button', { name: 'Save', exact: true }).click();
    await Promise.all([guest.goto(new URL(path, host.url()).href), screen.goto(new URL(`${path}/display`, host.url()).href)]);
    const answer = async text => {
      await guest.getByPlaceholder('Enter a response').fill(text);
      await guest.getByRole('button', { name: 'Add Response', exact: true }).click();
      await expect(guest.getByText(text, { exact: true })).toBeVisible();
      await expect(host.getByText(text, { exact: true })).toBeVisible();
    };
    await answer('First group idea');
    await guest.getByRole('button', { name: 'Raise hand to speak' }).click();
    await expect(host.getByRole('button', { name: /Mark .* as called on/ })).toBeVisible();
    await expect(screen.getByText('First group idea', { exact: true })).toHaveCount(0);
    await host.getByRole('button', { name: 'Reveal answers' }).click();
    await expect(screen.getByText('First group idea', { exact: true })).toBeVisible();
    expect((await request.delete(`/api/discussions/${room.slug}/responses`, { data: { adminToken: room.adminToken } })).status()).toBe(204);
    await expect(screen.getByText('First group idea', { exact: true })).toHaveCount(0);
    await expect(guest.getByRole('button', { name: 'Raise hand to speak' })).toBeEnabled();
    await answer('Second group idea');
    await expect(screen.getByText('Second group idea', { exact: true })).toHaveCount(0);
    await expect(host.getByRole('button', { name: 'Reveal answers' })).toBeVisible();
  } finally {
    await Promise.all([guest.close(), screen.close()]);
  }
});
