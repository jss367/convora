const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { once } = require('node:events');
const {
  useIntegrationServer,
  jsonRequest,
  connectSocket,
  startServer,
  stopServer,
  emitWithAck,
  waitForEvent,
  withTimeout,
  uniqueTopic,
  joinAs,
} = require('./helpers/integration.cjs');

const server = useIntegrationServer(__filename);
const { pool } = server;

for (const order of ['delete-first', 'rename-first']) {
  test(`promoted moderator rename and creator deletion serialize when ${order}`, async () => {
    const created = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('rename-delete') })).body;
    const title = uniqueTopic('Requested New Title');
    const token = 'promoted-' + crypto.randomUUID();
    await pool.query('INSERT INTO discussion_moderators (discussion_id, user_id, token) VALUES ($1, $2, $3)', [created.id, 'promoted-renamer', token]);
    const socket = await connectSocket();
    const blocker = await pool.connect();
    let deleting;
    let renaming;
    const waitForLocks = async count => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'");
        if (result.rows[0].n >= count) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Timed out waiting for rename/deletion operations');
    };
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM discussions WHERE id = $1 FOR UPDATE', [created.id]);
      if (order === 'delete-first') deleting = jsonRequest('DELETE', `/api/discussions/${created.slug}`, { adminToken: created.adminToken });
      else renaming = emitWithAck(socket, 'setTopic', created.slug, title, token);
      await waitForLocks(1);
      if (order === 'delete-first') renaming = emitWithAck(socket, 'setTopic', created.slug, title, token);
      else deleting = jsonRequest('DELETE', `/api/discussions/${created.slug}`, { adminToken: created.adminToken });
      await waitForLocks(2);
      await blocker.query('COMMIT');
      const [deleted, renamed] = await Promise.all([deleting, renaming]);
      assert.equal(deleted.status, 200);
      assert.equal(renamed.updated, order === 'rename-first');
      assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent(title)}`)).status, order === 'rename-first' ? 410 : 404);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM discussions WHERE id = $1', [created.id])).rows[0].n, 0);
    } finally {
      await blocker.query('ROLLBACK');
      await Promise.allSettled([deleting, renaming].filter(Boolean));
      blocker.release();
      socket.disconnect();
    }
  });
}

test('deleting rooms with swapped title aliases does not invert lifecycle locks', async () => {
  const a = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('swap-a') })).body;
  const b = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('swap-b') })).body;
  const socket = await connectSocket();
  try {
    assert.equal((await emitWithAck(socket, 'setTopic', a.slug, b.topic + '!', a.adminToken)).updated, true);
    assert.equal((await emitWithAck(socket, 'setTopic', b.slug, a.topic + '!', b.adminToken)).updated, true);
    const results = await withTimeout(Promise.all([
      jsonRequest('DELETE', `/api/discussions/${a.slug}`, { adminToken: a.adminToken }),
      jsonRequest('DELETE', `/api/discussions/${b.slug}`, { adminToken: b.adminToken }),
      jsonRequest('POST', '/api/discussions', { topic: a.topic }),
    ]), 5000, 'Concurrent alias deletion/creation deadlocked');
    assert.deepEqual(results.map(result => result.status), [200, 200, 200]);
  } finally { socket.disconnect(); }
});

test('deletion reserves renamed title aliases without hiding another live canonical room', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('old-title') });
  const title = uniqueTopic('Renamed Title');
  const alias = title.toLowerCase().replace(/\s+/g, '-');
  const { socket } = await joinAs(created.body.slug, 'alias-visitor');
  try {
    assert.equal((await emitWithAck(socket, 'setTopic', created.body.slug, title, created.body.adminToken)).updated, true);
    assert.equal((await jsonRequest('DELETE', `/api/discussions/${created.body.slug}`, { adminToken: created.body.adminToken })).status, 200);
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent(title)}`)).status, 410);
    const missing = waitForEvent(socket, 'discussionDeleted');
    socket.emit('joinDiscussion', alias);
    assert.deepEqual(await missing, { slug: alias });
    assert.equal((await emitWithAck(socket, 'claimModerator', alias)).success, false);
    assert.equal((await emitWithAck(socket, 'addQuestion', alias, { text: 'Stale alias submission', type: 'Agreement' }, true)).added, false);
    const live = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('Collision Room') });
    const original = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('collision-original') });
    const collidingTitle = live.body.topic + '!';
    assert.equal((await emitWithAck(socket, 'setTopic', original.body.slug, collidingTitle, original.body.adminToken)).updated, true);
    assert.equal((await jsonRequest('DELETE', `/api/discussions/${original.body.slug}`, { adminToken: original.body.adminToken })).status, 200);
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent(collidingTitle)}`)).status, 410);
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${live.body.slug}`)).body.id, live.body.id);
    const exactAlias = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('exact-alias-original') });
    assert.equal((await emitWithAck(socket, 'setTopic', exactAlias.body.slug, live.body.slug, exactAlias.body.adminToken)).updated, true);
    assert.equal((await jsonRequest('DELETE', `/api/discussions/${exactAlias.body.slug}`, { adminToken: exactAlias.body.adminToken })).status, 200);
    // Even an exact deleted title equal to another room's canonical slug must
    // not mask that live route in the resolver.
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${live.body.slug}`)).body.id, live.body.id);
    assert.equal((await emitWithAck(socket, 'addQuestion', live.body.slug, { text: 'The other room stays usable', type: 'Agreement' }, true)).added, true);
    await stopServer();
    await startServer();
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent(title)}`)).status, 410);
  } finally { socket.disconnect(); }
});

test('deletion rejects queued and stale question submissions without reusing the deleted slug', async () => {
  const topic = uniqueTopic('delete-race');
  const created = await jsonRequest('POST', '/api/discussions', { topic });
  const { id, slug, adminToken } = created.body;
  const { socket } = await joinAs(slug, 'stale-participant');
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM discussions WHERE id = $1 FOR UPDATE', [id]);
    const deleting = jsonRequest('DELETE', `/api/discussions/${slug}`, { adminToken });
    const waitForLocks = async count => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'");
        if (result.rows[0].n >= count) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Timed out waiting for blocked lifecycle operations');
    };
    await waitForLocks(1);
    const adding = emitWithAck(socket, 'addQuestion', slug, { text: 'A queued stale question', type: 'Agreement' }, true);
    await waitForLocks(2);
    await blocker.query('COMMIT');
    assert.equal((await deleting).status, 200);
    assert.equal((await adding).added, false);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM discussions WHERE slug = $1', [slug])).rows[0].n, 0);
    assert.equal((await emitWithAck(socket, 'addQuestion', slug, { text: 'A later stale question', type: 'Agreement' }, true)).added, false);
    assert.equal((await emitWithAck(socket, 'claimModerator', slug)).success, false);
    await stopServer();
    await startServer();
    const restarted = await connectSocket();
    try {
      const deletedJoin = waitForEvent(restarted, 'discussionDeleted');
      restarted.emit('joinDiscussion', slug);
      assert.deepEqual(await deletedJoin, { slug });
    } finally { restarted.disconnect(); }
    const replacement = await jsonRequest('POST', '/api/discussions', { topic });
    assert.equal(replacement.status, 200);
    assert.notEqual(replacement.body.slug, slug);
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${slug}`)).status, 404);
    assert.equal((await jsonRequest('DELETE', `/api/discussions/${replacement.body.slug}`, { adminToken: replacement.body.adminToken })).status, 200);
    const source = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('copy-source') });
    const duplicate = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: source.body.slug, newTopic: topic });
    assert.equal(duplicate.status, 200);
    assert.notEqual(duplicate.body.newSlug, slug);
    assert.notEqual(duplicate.body.newSlug, replacement.body.slug);
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${slug}`)).status, 404);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    socket.disconnect();
  }
});

test('only the creator can delete a discussion, removing all contents and notifying viewers', async () => {
  const created = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('delete') });
  const other = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('keep') });
  const { id, slug, adminToken } = created.body;
  const q = (await pool.query("INSERT INTO questions (discussion_id, text, type) VALUES ($1, 'Idea', 'Brainstorm') RETURNING id", [id])).rows[0].id;
  const v = (await pool.query("INSERT INTO votes (question_id, value, user_id) VALUES ($1, 'Response', 'person') RETURNING id", [q])).rows[0].id;
  await pool.query("INSERT INTO response_votes (response_id, user_id) VALUES ($1, 'other')", [v]);
  await pool.query("INSERT INTO response_ratings (response_id, user_id, quality) VALUES ($1, 'other', 1)", [v]);
  await pool.query("INSERT INTO response_reactions (response_id, user_id, reaction) VALUES ($1, 'other', 'follows')", [v]);
  await pool.query("INSERT INTO response_comments (response_id, user_id, body) VALUES ($1, 'other', 'Comment')", [v]);
  await pool.query("INSERT INTO opinion_snapshots (discussion_id, name, data) VALUES ($1, 'Snapshot', '{}')", [id]);
  await pool.query("INSERT INTO discussion_moderators (discussion_id, user_id, token) VALUES ($1, 'other', 'promoted-token')", [id]);
  await pool.query("INSERT INTO discussion_pseudonyms (discussion_id, user_id, pseudonym) VALUES ($1, 'person', 'Happy Fox')", [id]);
  const endpoint = `/api/discussions/${slug}`;
  for (const token of [undefined, '', {}, 'wrong', 'promoted-token', other.body.adminToken]) {
    assert.equal((await jsonRequest('DELETE', endpoint, { adminToken: token })).status, 403);
  }
  assert.equal((await pool.query('SELECT id FROM votes WHERE id = $1', [v])).rowCount, 1);
  const socket = await connectSocket();
  try {
    const joined = once(socket, 'discussion');
    socket.emit('joinDiscussion', slug);
    await joined;
    const deleted = once(socket, 'discussionDeleted');
    const result = await jsonRequest('DELETE', endpoint, { adminToken });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { deleted: true });
    assert.deepEqual((await deleted)[0], { slug });
    for (const table of ['questions', 'votes', 'response_votes', 'response_ratings', 'response_reactions', 'response_comments', 'opinion_snapshots', 'discussion_moderators', 'discussion_pseudonyms']) {
      assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0, table);
    }
    assert.deepEqual((await pool.query('SELECT id FROM discussions')).rows.map(row => row.id), [other.body.id]);
    assert.equal((await jsonRequest('DELETE', endpoint, { adminToken })).status, 403);
  } finally {
    socket.disconnect();
  }
});

test('HTTP API creates and fetches discussions', async () => {
  const topic = uniqueTopic('http');
  const createResponse = await jsonRequest('POST', '/api/discussions', { topic });

  assert.equal(createResponse.status, 200);
  assert.equal(createResponse.body.success, true);
  assert.ok(Number.isInteger(createResponse.body.id) && createResponse.body.id > 0);
  assert.equal(createResponse.body.topic, topic);
  assert.match(createResponse.body.slug, /^http-/);
  assert.match(createResponse.body.adminToken, /^[a-f0-9]{32}$/);

  const fetchResponse = await jsonRequest('GET', `/api/discussions/resolve/${createResponse.body.slug}`);
  assert.equal(fetchResponse.status, 200);
  assert.equal(fetchResponse.body.topic, topic);
});

test('discussions are unlisted: the listing endpoint returns only slugs the caller already knows', async () => {
  const mine = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('unlisted-mine') });
  const theirs = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('Unlisted Theirs') });

  // An anonymous visitor who knows no slugs learns nothing.
  for (const query of ['', '?slugs=', '?slugs=,', '?admin=anything', '?slugs[]=x', '?slugs=%25', '?slugs=*']) {
    const anonymous = await jsonRequest('GET', `/api/discussions${query}`);
    assert.equal(anonymous.status, 200);
    assert.deepEqual(anonymous.body, [], `GET /api/discussions${query} leaked discussions`);
  }

  // Knowing one slug reveals that discussion and no other.
  const known = await jsonRequest('GET', `/api/discussions?slugs=${mine.body.slug},no-such-discussion`);
  assert.equal(known.status, 200);
  assert.deepEqual(known.body.map(row => row.slug), [mine.body.slug]);
  assert.equal(known.body[0].topic, mine.body.topic);
  assert.deepEqual(Object.keys(known.body[0]).sort(), ['created_at', 'slug', 'topic']);
  assert.equal(JSON.stringify(known.body).includes(theirs.body.slug), false);

  // Only exact slugs match; titles and partial slugs are not a search.
  assert.notEqual(theirs.body.topic, theirs.body.slug);
  const byTitle = await jsonRequest('GET', `/api/discussions?slugs=${encodeURIComponent(theirs.body.topic)}`);
  assert.deepEqual(byTitle.body.filter(row => row.slug === theirs.body.slug), []);
  const byPrefix = await jsonRequest('GET', '/api/discussions?slugs=unlisted');
  assert.deepEqual(byPrefix.body, []);

  // Sequential ids must not be an alternative way to enumerate discussions.
  const byId = await fetch(`${server.baseUrl}/api/discussions/${theirs.body.id}`);
  assert.equal((await byId.text()).includes(theirs.body.slug), false);

  // Creating a discussion is not announced to unrelated connected clients.
  const bystander = await connectSocket();
  try {
    let announced = false;
    bystander.onAny(() => { announced = true; });
    const quiet = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('unlisted-quiet') });
    assert.equal(quiet.status, 200);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(announced, false);
  } finally {
    bystander.disconnect();
  }
});

test('a creator can list a discussion publicly; everything else stays unlisted', async () => {
  const publicSlugs = async () => {
    const response = await jsonRequest('GET', '/api/discussions/public');
    assert.equal(response.status, 200);
    return response.body.map(row => row.slug);
  };

  // Unlisted by default, and ignored unless it is exactly true.
  const quiet = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('listing-default') });
  const sneaky = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('listing-truthy'), listed: 'yes' });
  assert.deepEqual(await publicSlugs(), []);

  // Listed at creation: shown with only its title, slug and creation time.
  const listed = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('listing-public'), listed: true });
  const list = (await jsonRequest('GET', '/api/discussions/public')).body;
  assert.deepEqual(list.map(row => row.slug), [listed.body.slug]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['created_at', 'slug', 'topic']);
  assert.equal(list[0].topic, listed.body.topic);

  // Typing an existing title joins that discussion and must not change its listing.
  const rejoin = await jsonRequest('POST', '/api/discussions', { topic: quiet.body.topic, listed: true });
  assert.equal(rejoin.body.slug, quiet.body.slug);
  assert.equal(rejoin.body.adminToken, null);
  const unlistAttempt = await jsonRequest('POST', '/api/discussions', { topic: listed.body.topic, listed: false });
  assert.equal(unlistAttempt.body.adminToken, null);
  assert.deepEqual(await publicSlugs(), [listed.body.slug]);

  // Only a moderator can change it, and everyone in the room hears the change.
  const { socket: participant } = await joinAs(quiet.body.slug, 'listing-participant');
  const mod = await connectSocket();
  try {
    const refused = waitForEvent(participant, 'error', error => /not authorized/i.test(error.message));
    participant.emit('setListed', quiet.body.slug, true, 'not-the-token');
    await refused;
    assert.deepEqual(await publicSlugs(), [listed.body.slug]);

    const shown = waitForEvent(participant, 'discussionState', state => state.listed === true);
    mod.emit('setListed', quiet.body.slug, true, quiet.body.adminToken);
    await shown;
    assert.deepEqual((await publicSlugs()).sort(), [listed.body.slug, quiet.body.slug].sort());

    const hidden = waitForEvent(participant, 'discussionState', state => state.listed === false);
    mod.emit('setListed', quiet.body.slug, false, quiet.body.adminToken);
    await hidden;
    assert.deepEqual(await publicSlugs(), [listed.body.slug]);
  } finally {
    participant.disconnect();
    mod.disconnect();
  }

  // A duplicate starts unlisted, whatever the original was.
  const copy = await jsonRequest('POST', '/api/duplicate-discussion', { originalTopic: listed.body.slug, newTopic: uniqueTopic('listing-copy') });
  assert.equal(copy.status, 200);
  assert.deepEqual(await publicSlugs(), [listed.body.slug]);
  assert.equal((await publicSlugs()).includes(sneaky.body.slug), false);
});

test('HTTP API creates distinct discussions for colliding slugs', async () => {
  const firstResponse = await jsonRequest('POST', '/api/discussions', { topic: 'C++' });
  const secondResponse = await jsonRequest('POST', '/api/discussions', { topic: 'C#' });

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(firstResponse.body.topic, 'C++');
  assert.equal(secondResponse.body.topic, 'C#');
  assert.equal(firstResponse.body.slug, 'c');
  assert.equal(secondResponse.body.slug, 'c-2');
  assert.match(firstResponse.body.adminToken, /^[a-f0-9]{32}$/);
  assert.match(secondResponse.body.adminToken, /^[a-f0-9]{32}$/);
  assert.notEqual(firstResponse.body.id, secondResponse.body.id);
});

test('HTTP API resolves legacy title routes before falling back to canonical slugs', async () => {
  await jsonRequest('POST', '/api/discussions', { topic: 'C++' });
  await jsonRequest('POST', '/api/discussions', { topic: 'C#' });

  const resolveTitle = await jsonRequest('GET', `/api/discussions/resolve/${encodeURIComponent('C#')}`);
  assert.equal(resolveTitle.status, 200);
  assert.equal(resolveTitle.body.topic, 'C#');
  assert.equal(resolveTitle.body.slug, 'c-2');

  const resolveSlug = await jsonRequest('GET', '/api/discussions/resolve/c');
  assert.equal(resolveSlug.status, 200);
  assert.equal(resolveSlug.body.topic, 'C++');
  assert.equal(resolveSlug.body.slug, 'c');
});

test('moderators can generate short links that redirect to the discussion', async () => {
  const topic = uniqueTopic('short-link');
  const createResponse = await jsonRequest('POST', '/api/discussions', { topic });
  const { adminToken, slug } = createResponse.body;

  const denied = await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken: 'bogus-token' });
  assert.equal(denied.status, 403);

  const generated = await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken });
  assert.equal(generated.status, 200);
  assert.equal(generated.body.success, true);
  assert.equal(generated.body.slug, slug);
  assert.match(generated.body.shortCode, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{6}$/);
  assert.equal(generated.body.shortPath, `/s/${generated.body.shortCode}`);

  const repeated = await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.shortCode, generated.body.shortCode);

  const redirect = await fetch(`${server.baseUrl}${generated.body.shortPath}`, { redirect: 'manual' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), `/discussion/${slug}`);

  const custom = await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken, shortCode: 'AI' });
  assert.equal(custom.status, 200);
  assert.equal(custom.body.shortCode, 'ai');
  assert.equal(custom.body.shortPath, '/s/ai');

  const customRedirect = await fetch(`${server.baseUrl}/s/ai`, { redirect: 'manual' });
  assert.equal(customRedirect.status, 302);
  assert.equal(customRedirect.headers.get('location'), `/discussion/${slug}`);

  const invalid = await jsonRequest('POST', `/api/discussions/${slug}/short-link`, { adminToken, shortCode: '-bad-' });
  assert.equal(invalid.status, 400);

  const other = await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('short-link-other') });
  const taken = await jsonRequest('POST', `/api/discussions/${other.body.slug}/short-link`, {
    adminToken: other.body.adminToken,
    shortCode: 'ai',
  });
  assert.equal(taken.status, 409);
});

test('long titles and suffixed collisions produce links that resolve to the intended discussion', async () => {
  const prefix = 'a'.repeat(77);
  const titles = [prefix + ' bc first', prefix + ' bc second', 'x'.repeat(79) + ' final word'];
  for (const [index, topic] of titles.entries()) {
    const created = await jsonRequest('POST', '/api/discussions', { topic });
    assert.equal(created.status, 200);
    const slug = created.body.slug;
    assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(slug.length <= 80);
    if (index === 1) assert.ok(slug.endsWith('-2'));
    assert.equal((await jsonRequest('GET', `/api/discussions/resolve/${slug}`)).body.id, created.body.id);
  }
});

test('previously issued truncated links survive startup and still open their own room', async () => {
  const prefix = 'z'.repeat(79);
  const slugs = [prefix, prefix + '-', 'w'.repeat(77) + '--2'];
  for (const [index, slug] of slugs.entries()) {
    await pool.query('INSERT INTO discussions (topic, slug) VALUES ($1, $2)', [`Saved room ${index}`, slug]);
  }
  await stopServer();
  await startServer();
  const display = await connectSocket();
  try {
    for (const [index, slug] of slugs.entries()) {
      const resolved = await jsonRequest('GET', `/api/discussions/resolve/${slug}`);
      assert.equal(resolved.body.topic, `Saved room ${index}`);
      const joined = waitForEvent(display, 'discussion');
      display.emit('joinDisplay', slug);
      assert.equal((await joined).slug, slug);
    }
  } finally { display.disconnect(); }
});

test('slug migration preserves literal slug-shaped legacy titles', async () => {
  await stopServer();
  await pool.query('DROP TABLE schema_migrations; TRUNCATE TABLE votes, questions, discussions RESTART IDENTITY CASCADE');
  await pool.query(`
    INSERT INTO discussions (topic, slug)
    VALUES
      ('C++', 'c'),
      ('c', 'c-2')
  `);

  await startServer();

  const migrated = await pool.query('SELECT topic, slug FROM discussions ORDER BY topic');
  assert.deepEqual(migrated.rows, [
    { topic: 'C++', slug: 'c-2' },
    { topic: 'c', slug: 'c' },
  ]);

  const resolveSlug = await jsonRequest('GET', '/api/discussions/resolve/c');
  assert.equal(resolveSlug.status, 200);
  assert.equal(resolveSlug.body.topic, 'c');
  assert.equal(resolveSlug.body.slug, 'c');
});
