const { test, expect } = require('./lifecycle-fixtures.cjs');

for (const setting of ['limit', 'attribution', 'unchanged']) {
  test(`Post anyway preserves newer response settings: ${setting}`, async ({ page, rooms }) => {
    const room = await rooms.create('Similar response settings');
    let releasePrompt;
    let upgraded = false;
    await page.routeWebSocket(/\/socket\.io\//, route => {
      const upstream = route.connectToServer();
      route.onMessage(message => {
        if (message === '5') upgraded = true;
        upstream.send(message);
      });
      upstream.onMessage(message => {
        if (typeof message === 'string' && message.startsWith('42')
            && JSON.parse(message.slice(message.indexOf('[')))[0] === 'similarQuestion') {
          releasePrompt = () => route.send(message);
        } else route.send(message);
      });
    });
    await page.goto(`/discussion/${room.slug}`);
    await expect.poll(() => upgraded).toBe(true);
    const draft = page.getByPlaceholder('Enter a new question or statement');
    await draft.fill('Similar response settings question!');
    await page.locator('form').getByRole('combobox').selectOption('Open Ended');
    const limit = page.getByLabel('Maximum responses per person (blank for unlimited)');
    const attribution = page.getByLabel('Show author pseudonyms');
    await limit.fill('2');
    await draft.press('Enter');
    await expect.poll(() => Boolean(releasePrompt)).toBe(true);
    if (setting === 'limit') await limit.fill('3');
    if (setting === 'attribution') await attribution.uncheck();
    releasePrompt();
    await page.getByRole('button', { name: 'Post anyway', exact: true }).click();
    await expect.poll(async () => (await rooms.pool.query(
      'SELECT max_responses, show_attribution FROM questions WHERE discussion_id = $1 AND text = $2',
      [room.id, 'Similar response settings question!']
    )).rows).toEqual([{ max_responses: 2, show_attribution: true }]);
    if (setting === 'unchanged') {
      await expect(draft).toHaveValue('');
    } else {
      await expect(draft).toHaveValue('Similar response settings question!');
      await expect(limit).toHaveValue(setting === 'limit' ? '3' : '2');
      await expect(attribution).toBeChecked({ checked: setting !== 'attribution' });
    }
  });
}
