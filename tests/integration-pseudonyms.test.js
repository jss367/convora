const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const {
  useIntegrationServer,
  claimModerator,
  addBrainstormQuestion,
  jsonRequest,
  connectSocket,
  waitForQuestions,
  emitWithAck,
  waitForEvent,
  uniqueTopic,
} = require('./helpers/integration.cjs');

const { pool } = useIntegrationServer(__filename);

// Create a discussion row (assignPseudonym only reserves once one exists) by
// seeding it with a question, the way the first contributor would.
async function seedDiscussion(topic) {
  const seed = await connectSocket();
  try {
    seed.emit('joinDiscussion', topic);
    await addBrainstormQuestion(seed, topic, 'Seed');
  } finally {
    seed.disconnect();
  }
}

test('Socket.IO sanitizes display names: anonymous stores null, long names are clamped', async () => {
  const topic = uniqueTopic('names');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(
      author,
      (questions) => questions.length === 1,
      'question broadcast'
    );
    author.emit('addQuestion', topic, {
      text: 'Pick a name mode',
      type: 'Open Ended',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];

    // Anonymous mode sends a blank name; the server stores null so the display
    // layer falls back to "Anonymous".
    const anonUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'idea-anon'),
      'anonymous vote'
    );
    voter.emit('vote', topic, question.id, 'idea-anon', 'anon-user', '   ');
    const anonVote = (await anonUpdate)[0].votes.find((v) => v.value === 'idea-anon');
    assert.equal(anonVote.pseudonym, null);

    // A typed-in name longer than the cap is clamped to 40 characters.
    const longName = 'X'.repeat(100);
    const longUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'idea-long'),
      'long-name vote'
    );
    voter.emit('vote', topic, question.id, 'idea-long', 'long-user', longName);
    const longVote = (await longUpdate)[0].votes.find((v) => v.value === 'idea-long');
    assert.equal(longVote.pseudonym, 'X'.repeat(40));
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('client pure-JS SHA-256 fallback matches the server ownership-token hash', async () => {
  // The client uses crypto.subtle when available, but falls back to this pure-JS
  // SHA-256 in insecure contexts (e.g. served over a plain http:// LAN IP via the
  // join-QR flow). The fallback MUST produce the same hex digest the server uses
  // for ownership tokens, or participants there can't recognize their own votes.
  const { sha256Hex } = await import('../client/src/sha256.mjs');
  const inputs = ['123:abcDEF', '42:café 🦦', 'x:y', '', 'a'.repeat(200), '9f3a:Mellow Otter'];
  for (const s of inputs) {
    const fallback = sha256Hex(new TextEncoder().encode(s));
    const node = crypto.createHash('sha256').update(s).digest('hex');
    assert.equal(fallback, node, `SHA-256 mismatch for ${JSON.stringify(s)}`);
  }
});

test('participant handle formula matches between client and server', async () => {
  // The moderator panel hides promote/remove on the viewer's own row by matching
  // the server's opaque handle: "participant-" + first 16 hex of sha256(userId).
  // The client computes it from the same sha256Hex this asserts against the
  // server hash, so they must agree — otherwise the self row fails open to
  // showing its own controls again. The shared SHA module has an explicit .mjs
  // extension so this check also works on older supported Node 20 releases.
  const { sha256Hex } = await import('../client/src/sha256.mjs');
  const ids = ['user-1', 'guest-user-1', 'Z9f3a2b1c0d4e5f6', 'a'.repeat(80)];
  for (const id of ids) {
    const client = `participant-${sha256Hex(new TextEncoder().encode(String(id))).slice(0, 16)}`;
    const server = `participant-${crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 16)}`;
    assert.equal(client, server, `participant handle mismatch for ${JSON.stringify(id)}`);
  }
});

test('Socket.IO ownership tokens hide stable ids and differ per response', async () => {
  const topic = uniqueTopic('tokens');
  const author = await connectSocket();
  const voter = await connectSocket();

  // Tokens are keyed by the response's own row id, not the question id.
  const tokenFor = (voteId, userId) =>
    crypto.createHash('sha256').update(`${voteId}:${userId}`).digest('hex');

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    // Two open-ended questions, both answered by the SAME browser (same userId).
    const q1Update = waitForQuestions(author, (qs) => qs.length === 1, 'q1 broadcast');
    author.emit('addQuestion', topic, {
      text: 'Prompt one?', type: 'Open Ended', minValue: null, maxValue: null, options: [],
    });
    const q1 = (await q1Update)[0];

    const q2Update = waitForQuestions(author, (qs) => qs.length === 2, 'q2 broadcast');
    author.emit('addQuestion', topic, {
      text: 'Prompt two?', type: 'Open Ended', minValue: null, maxValue: null, options: [],
    });
    const q2 = (await q2Update).find((q) => q.id !== q1.id);

    const v1Update = waitForQuestions(
      author,
      (qs) => qs.find((q) => q.id === q1.id)?.votes?.length === 1,
      'q1 vote'
    );
    voter.emit('vote', topic, q1.id, 'answer one', 'same-browser', 'Same Browser');
    const vote1 = (await v1Update).find((q) => q.id === q1.id).votes[0];

    const v2Update = waitForQuestions(
      author,
      (qs) => qs.find((q) => q.id === q2.id)?.votes?.length === 1,
      'q2 vote'
    );
    voter.emit('vote', topic, q2.id, 'answer two', 'same-browser', 'Same Browser');
    const vote2 = (await v2Update).find((q) => q.id === q2.id).votes[0];

    // No raw ids leak, and the same browser gets a DIFFERENT token per response
    // (here, across two prompts) — so a socket observer can't correlate them.
    // The token is self-matchable from the response's own id.
    assert.equal('userId' in vote1, false);
    assert.equal(vote1.ownerToken, tokenFor(vote1.id, 'same-browser'));
    assert.equal(vote2.ownerToken, tokenFor(vote2.id, 'same-browser'));
    assert.notEqual(vote1.ownerToken, vote2.ownerToken);

    await pool.query('UPDATE discussions SET reactions_enabled = TRUE, reactions_visible = TRUE WHERE id = (SELECT discussion_id FROM questions WHERE id = $1)', [q1.id]);
    // Upvoter ids are likewise tokenized per response (and self-matchable).
    const upUpdate = waitForQuestions(
      author,
      (qs) => qs.find((q) => q.id === q1.id)?.votes?.[0]?.upvotes === 1,
      'q1 upvote'
    );
    author.emit('toggleResponseVote', topic, vote1.id, 'upvoter-x');
    const upvoted = (await upUpdate).find((q) => q.id === q1.id).votes[0];
    assert.equal(upvoted.upvoters, undefined);
    assert.deepEqual(upvoted.upvoterTokens, [tokenFor(vote1.id, 'upvoter-x')]);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test("Socket.IO de-correlates one participant's multiple Brainstorm ideas", async () => {
  const topic = uniqueTopic('brainstorm-tokens');
  const author = await connectSocket();
  const voter = await connectSocket();

  const tokenFor = (voteId, userId) =>
    crypto.createHash('sha256').update(`${voteId}:${userId}`).digest('hex');

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const qUpdate = waitForQuestions(author, (qs) => qs.length === 1, 'brainstorm prompt');
    author.emit('addQuestion', topic, {
      text: 'Brainstorm anything', type: 'Open Ended', minValue: null, maxValue: null, options: [],
    });
    const question = (await qUpdate)[0];

    // The SAME anonymous browser submits two separate ideas to the same prompt.
    const idea1Update = waitForQuestions(
      author,
      (qs) => qs[0]?.votes?.some((v) => v.value === 'idea one'),
      'first idea'
    );
    voter.emit('vote', topic, question.id, 'idea one', 'one-browser', '   ');
    await idea1Update;

    const idea2Update = waitForQuestions(
      author,
      (qs) => qs[0]?.votes?.length === 2,
      'second idea'
    );
    voter.emit('vote', topic, question.id, 'idea two', 'one-browser', '   ');
    const votes = (await idea2Update)[0].votes;

    const v1 = votes.find((v) => v.value === 'idea one');
    const v2 = votes.find((v) => v.value === 'idea two');

    // Both ideas are anonymous and come from the same browser, yet each carries
    // a DIFFERENT ownerToken (keyed by the response's own id) — so a socket
    // observer can't group them as one participant's. Under the old per-question
    // scheme these tokens would have been identical.
    assert.equal('userId' in v1, false);
    assert.equal('userId' in v2, false);
    assert.notEqual(v1.ownerToken, v2.ownerToken);

    // Each token is still self-matchable from the response's id, so the author's
    // own client can recognize both ideas as theirs.
    assert.equal(v1.ownerToken, tokenFor(v1.id, 'one-browser'));
    assert.equal(v2.ownerToken, tokenFor(v2.id, 'one-browser'));
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('Summary counts anonymous participants distinctly and never leaks raw user ids', async () => {
  const topic = uniqueTopic('summary-anon');
  const author = await connectSocket();
  const voterA = await connectSocket();
  const voterB = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voterA.emit('joinDiscussion', topic);
    voterB.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(author, (qs) => qs.length === 1, 'question broadcast');
    author.emit('addQuestion', topic, {
      text: 'What do you think?',
      type: 'Open Ended',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];

    // Two distinct browsers (different stable user ids) both submit anonymously,
    // so both broadcast pseudonyms collapse to "Anonymous". They must still be
    // counted as TWO participants in the summary (which reads the real user_id
    // internally), not merged into one.
    const firstVote = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'first anon answer'),
      'first anon vote'
    );
    voterA.emit('vote', topic, question.id, 'first anon answer', 'browser-aaaaaaaa1', '   ');
    await firstVote;

    const secondVote = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.some((v) => v.value === 'second anon answer'),
      'second anon vote'
    );
    voterB.emit('vote', topic, question.id, 'second anon answer', 'browser-bbbbbbbb2', '   ');
    await secondVote;

    const summaryResponse = await jsonRequest('GET', `/api/discussions/${topic}/summary`);
    assert.equal(summaryResponse.status, 200);
    assert.equal(summaryResponse.body.counts.participants, 2);

    // The client-facing summary must not echo any raw 16-char user id. The real
    // ids used here are 'browser-aaaaaaaa1' / 'browser-bbbbbbbb2'; assert neither
    // appears, and that no participant entry carries a raw id field.
    const serialized = JSON.stringify(summaryResponse.body);
    assert.equal(serialized.includes('browser-aaaaaaaa1'), false);
    assert.equal(serialized.includes('browser-bbbbbbbb2'), false);
    for (const participant of summaryResponse.body.facilitatorDashboard.participantStats) {
      assert.match(participant.id, /^participant-\d+$/);
    }
  } finally {
    author.disconnect();
    voterA.disconnect();
    voterB.disconnect();
  }
});

test('updateDisplayName retroactively renames a participant\'s prior responses', async () => {
  const topic = uniqueTopic('rename');
  const author = await connectSocket();
  const voter = await connectSocket();

  try {
    author.emit('joinDiscussion', topic);
    voter.emit('joinDiscussion', topic);

    const questionUpdate = waitForQuestions(author, (qs) => qs.length === 1, 'question broadcast');
    author.emit('addQuestion', topic, {
      text: 'Share a thought',
      type: 'Open Ended',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const question = (await questionUpdate)[0];

    const voteUpdate = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes.length === 1,
      'initial vote'
    );
    voter.emit('vote', topic, question.id, 'my response', 'rename-user', 'Original Name');
    const initial = (await voteUpdate)[0].votes[0];
    assert.equal(initial.pseudonym, 'Original Name');

    // Switching to a new display name must rewrite the existing response.
    const renamed = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes[0] && qs[0].votes[0].pseudonym === 'Renamed Person',
      'renamed broadcast'
    );
    voter.emit('updateDisplayName', topic, 'rename-user', 'Renamed Person');
    const after = (await renamed)[0].votes[0];
    assert.equal(after.pseudonym, 'Renamed Person');

    // Switching to anonymous (blank name) clears the stored pseudonym to null.
    const anonymized = waitForQuestions(
      author,
      (qs) => qs[0] && qs[0].votes[0] && qs[0].votes[0].pseudonym === null,
      'anonymized broadcast'
    );
    voter.emit('updateDisplayName', topic, 'rename-user', '   ');
    const anon = (await anonymized)[0].votes[0];
    assert.equal(anon.pseudonym, null);
  } finally {
    author.disconnect();
    voter.disconnect();
  }
});

test('Two participants proposing the same handle get distinct ones — no numbered duplicate', async () => {
  const topic = uniqueTopic('pseudonym-unique');
  await seedDiscussion(topic);

  const a = await connectSocket();
  const b = await connectSocket();
  try {
    const ra = await emitWithAck(a, 'requestPseudonym', topic, 'user-a', 'Tidy Newt');
    const rb = await emitWithAck(b, 'requestPseudonym', topic, 'user-b', 'Tidy Newt');

    // First claimant keeps the proposed name; the second is handed a different
    // adjective-animal combination, never "Tidy Newt 2".
    assert.equal(ra.pseudonym, 'Tidy Newt');
    assert.ok(rb.pseudonym, 'second participant should receive a handle');
    assert.notEqual(rb.pseudonym, 'Tidy Newt');
    assert.ok(!/\d/.test(rb.pseudonym), `deconflicted handle should have no number suffix: ${rb.pseudonym}`);
  } finally {
    a.disconnect();
    b.disconnect();
  }
});

test('A handle is stable for a returning user and reusable across discussions', async () => {
  const topicA = uniqueTopic('pseudonym-stable-a');
  const topicB = uniqueTopic('pseudonym-stable-b');
  await seedDiscussion(topicA);
  await seedDiscussion(topicB);

  const socket = await connectSocket();
  try {
    const first = await emitWithAck(socket, 'requestPseudonym', topicA, 'user-x', 'Tidy Newt');
    assert.equal(first.pseudonym, 'Tidy Newt');

    // Re-requesting (e.g. after a reload) returns the same reservation, even if a
    // different name is proposed.
    const again = await emitWithAck(socket, 'requestPseudonym', topicA, 'user-x', 'Brave Fox');
    assert.equal(again.pseudonym, 'Tidy Newt');

    // The same handle is free in a separate discussion, so the user can hold it
    // there too — uniqueness is only enforced within a discussion.
    const other = await emitWithAck(socket, 'requestPseudonym', topicB, 'user-x', 'Tidy Newt');
    assert.equal(other.pseudonym, 'Tidy Newt');
  } finally {
    socket.disconnect();
  }
});

test('Regenerating yields a different handle that stays unique', async () => {
  const topic = uniqueTopic('pseudonym-regen');
  await seedDiscussion(topic);

  const a = await connectSocket();
  const b = await connectSocket();
  try {
    const original = await emitWithAck(a, 'requestPseudonym', topic, 'user-a', 'Tidy Newt');
    assert.equal(original.pseudonym, 'Tidy Newt');
    // Someone else holds "Brave Fox" so a shuffle can't land on it.
    await emitWithAck(b, 'requestPseudonym', topic, 'user-b', 'Brave Fox');

    const shuffled = await emitWithAck(a, 'regeneratePseudonym', topic, 'user-a');
    assert.ok(shuffled.pseudonym, 'shuffle should return a handle');
    assert.notEqual(shuffled.pseudonym, 'Tidy Newt'); // must change
    assert.notEqual(shuffled.pseudonym, 'Brave Fox');  // must stay unique

    // The new handle is now the stable one for this user.
    const after = await emitWithAck(a, 'requestPseudonym', topic, 'user-a', 'Tidy Newt');
    assert.equal(after.pseudonym, shuffled.pseudonym);
  } finally {
    a.disconnect();
    b.disconnect();
  }
});

test('Before the discussion exists, handles are previews (unreserved) and reserve once it does', async () => {
  const topic = uniqueTopic('pseudonym-preview');
  const socket = await connectSocket();
  try {
    // No question has been added yet, so there is no discussion row to reserve
    // against. The server must flag these as unreserved so the client keeps
    // asking — otherwise the handle would never be inserted and could collide.
    const preview = await emitWithAck(socket, 'requestPseudonym', topic, 'user-a', 'Tidy Newt');
    assert.equal(preview.pseudonym, 'Tidy Newt');
    assert.equal(preview.reserved, false);

    const shufflePreview = await emitWithAck(socket, 'regeneratePseudonym', topic, 'user-a');
    assert.ok(shufflePreview.pseudonym);
    assert.equal(shufflePreview.reserved, false);

    // Nothing was persisted while the discussion didn't exist.
    const beforeRows = await pool.query('SELECT COUNT(*)::int AS n FROM discussion_pseudonyms');
    assert.equal(beforeRows.rows[0].n, 0);

    // Once the discussion exists, the same request reserves for real.
    await seedDiscussion(topic);
    const reserved = await emitWithAck(socket, 'requestPseudonym', topic, 'user-a', 'Tidy Newt');
    assert.equal(reserved.pseudonym, 'Tidy Newt');
    assert.equal(reserved.reserved, true);

    const afterRows = await pool.query(
      'SELECT pseudonym FROM discussion_pseudonyms WHERE user_id = $1', ['user-a']);
    assert.equal(afterRows.rows.length, 1);
    assert.equal(afterRows.rows[0].pseudonym, 'Tidy Newt');
  } finally {
    socket.disconnect();
  }
});

test('Shuffling in one tab syncs the new handle to the same user\'s other tabs', async () => {
  const topic = uniqueTopic('pseudonym-sync');
  await seedDiscussion(topic);
  const tabA = await connectSocket();
  const tabB = await connectSocket();
  try {
    // Two tabs of the same browser share a userId. Each must join the room and
    // identify so the server can route a shuffle's sync to the other tab.
    tabA.emit('joinDiscussion', topic);
    tabB.emit('joinDiscussion', topic);
    tabA.emit('identify', topic, 'user-tabs');
    tabB.emit('identify', topic, 'user-tabs');
    const first = await emitWithAck(tabA, 'requestPseudonym', topic, 'user-tabs', 'Tidy Newt');
    assert.equal(first.pseudonym, 'Tidy Newt');
    // The second tab shares the reservation (same userId).
    const shared = await emitWithAck(tabB, 'requestPseudonym', topic, 'user-tabs', 'Tidy Newt');
    assert.equal(shared.pseudonym, 'Tidy Newt');

    // Tab A shuffles; Tab B should be told the new handle so it stops using the
    // now-freed "Tidy Newt".
    const synced = waitForEvent(tabB, 'pseudonymSync');
    const shuffled = await emitWithAck(tabA, 'regeneratePseudonym', topic, 'user-tabs');
    const payload = await synced;
    assert.equal(payload.pseudonym, shuffled.pseudonym);
    assert.notEqual(payload.pseudonym, 'Tidy Newt');
  } finally {
    tabA.disconnect();
    tabB.disconnect();
  }
});

test('A newcomer avoids a handle already shown on a pre-existing response', async () => {
  const topic = uniqueTopic('pseudonym-backfill');
  const seeder = await connectSocket();
  try {
    seeder.emit('joinDiscussion', topic);
    const question = await addBrainstormQuestion(seeder, topic, 'Ideas?');
    // Simulate a participant who responded BEFORE this feature shipped: a vote
    // carrying a handle, with no row in discussion_pseudonyms.
    const idea = waitForQuestions(seeder, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    seeder.emit('vote', topic, question.id, 'My idea', 'old-user', 'Tidy Newt');
    await idea;
  } finally {
    seeder.disconnect();
  }

  // No reservation row exists yet, but "Tidy Newt" is already displayed.
  const reservations = await pool.query('SELECT COUNT(*)::int AS n FROM discussion_pseudonyms');
  assert.equal(reservations.rows[0].n, 0);

  const newcomer = await connectSocket();
  const returning = await connectSocket();
  try {
    // A new participant proposing the same handle must be deconflicted away from
    // the one an existing response already shows.
    const fresh = await emitWithAck(newcomer, 'requestPseudonym', topic, 'user-new', 'Tidy Newt');
    assert.equal(fresh.reserved, true);
    assert.notEqual(fresh.pseudonym, 'Tidy Newt');

    // The original responder (same userId) can still reclaim the handle their
    // existing response already shows.
    const reclaimed = await emitWithAck(returning, 'requestPseudonym', topic, 'old-user', 'Tidy Newt');
    assert.equal(reclaimed.pseudonym, 'Tidy Newt');
  } finally {
    newcomer.disconnect();
    returning.disconnect();
  }
});

test('A pseudonym-mode vote sent before the reservation ack persists under the reserved handle (#57)', async () => {
  const topic = uniqueTopic('pseudonym-canon-vote');
  const holder = await connectSocket();
  const latecomer = await connectSocket();
  try {
    holder.emit('joinDiscussion', topic);
    latecomer.emit('joinDiscussion', topic);
    // Adding a question creates the discussion row so handles can be reserved.
    const question = await addBrainstormQuestion(holder, topic, 'Ideas?');

    // "Tidy Newt" is already taken in this discussion.
    const taken = await emitWithAck(holder, 'requestPseudonym', topic, 'user-holder', 'Tidy Newt');
    assert.equal(taken.pseudonym, 'Tidy Newt');

    // The latecomer's local pick collides, so the server reserves a DIFFERENT
    // handle. That reservation exists server-side while the client is still — for
    // the round-trip window — showing and sending its unreserved local pick.
    const reserved = await emitWithAck(latecomer, 'requestPseudonym', topic, 'user-late', 'Tidy Newt');
    assert.notEqual(reserved.pseudonym, 'Tidy Newt');

    // Simulate the race: the latecomer votes in pseudonym mode but still sends the
    // colliding pre-reservation name. The server must store the reserved handle so
    // no duplicate "Tidy Newt" ever appears.
    const ideaUpdate = waitForQuestions(holder, (qs) => {
      const q = qs.find((x) => x.id === question.id);
      return q && q.votes.length === 1;
    }, 'latecomer idea');
    latecomer.emit('vote', topic, question.id, 'My idea', 'user-late', 'Tidy Newt', 'pseudonym');
    const stored = (await ideaUpdate).find((x) => x.id === question.id).votes[0];

    assert.equal(stored.pseudonym, reserved.pseudonym, 'vote should persist under the reserved handle');
    assert.notEqual(stored.pseudonym, 'Tidy Newt', 'no duplicate "Tidy Newt" should be stored');
  } finally {
    holder.disconnect();
    latecomer.disconnect();
  }
});

test('A pseudonym-mode vote with NO prior reservation still gets a unique handle, not the colliding pick (#57)', async () => {
  const topic = uniqueTopic('pseudonym-canon-noreserve');
  const holder = await connectSocket();
  const latecomer = await connectSocket();
  try {
    holder.emit('joinDiscussion', topic);
    latecomer.emit('joinDiscussion', topic);
    const question = await addBrainstormQuestion(holder, topic, 'Ideas?');

    // "Tidy Newt" is taken in this discussion.
    const taken = await emitWithAck(holder, 'requestPseudonym', topic, 'user-holder', 'Tidy Newt');
    assert.equal(taken.pseudonym, 'Tidy Newt');

    // The harder race (Codex P2 on #58): the latecomer's vote BEATS its own
    // requestPseudonym round-trip, so no reservation row exists for them yet — and
    // it sends the colliding local pick. The server must create/await a reservation
    // at write time rather than fall back to storing "Tidy Newt".
    const ideaUpdate = waitForQuestions(holder, (qs) => {
      const q = qs.find((x) => x.id === question.id);
      return q && q.votes.length === 1;
    }, 'latecomer idea');
    latecomer.emit('vote', topic, question.id, 'My idea', 'user-late', 'Tidy Newt', 'pseudonym');
    const stored = (await ideaUpdate).find((x) => x.id === question.id).votes[0];

    assert.notEqual(stored.pseudonym, 'Tidy Newt', 'must not store the colliding handle');
    assert.ok(stored.pseudonym, 'a deconflicted handle should be stored');

    // The created reservation is now the stable handle for this user, so a later
    // requestPseudonym returns the SAME name the vote was stored under (no rename).
    const reserved = await emitWithAck(latecomer, 'requestPseudonym', topic, 'user-late', 'Tidy Newt');
    assert.equal(reserved.pseudonym, stored.pseudonym, 'write-path reservation should be stable');
  } finally {
    holder.disconnect();
    latecomer.disconnect();
  }
});

test('Concurrent reservations for the same user converge to one handle, not an overwrite (#58)', async () => {
  const topic = uniqueTopic('pseudonym-converge');
  const holder = await connectSocket();
  const tabA = await connectSocket();
  const tabB = await connectSocket();
  try {
    holder.emit('joinDiscussion', topic);
    tabA.emit('joinDiscussion', topic);
    tabB.emit('joinDiscussion', topic);
    await addBrainstormQuestion(holder, topic, 'Ideas?');

    // "Tidy Newt" is taken, so the same new user gets deconflicted either way —
    // forcing the allocation path, not the cheap "already reserved" early return.
    await emitWithAck(holder, 'requestPseudonym', topic, 'user-holder', 'Tidy Newt');

    // Two tabs of the SAME user race their reservation at once (the vote/comment
    // write path and requestPseudonym hit this same allocator). First-wins must
    // make them agree; the old DO UPDATE could let the second overwrite the first,
    // splitting the handle across the user's responses.
    const [ra, rb] = await Promise.all([
      emitWithAck(tabA, 'requestPseudonym', topic, 'race-user', 'Tidy Newt'),
      emitWithAck(tabB, 'requestPseudonym', topic, 'race-user', 'Tidy Newt'),
    ]);
    assert.notEqual(ra.pseudonym, 'Tidy Newt');
    assert.equal(ra.pseudonym, rb.pseudonym, 'both tabs must converge on one handle');

    const rows = await pool.query(
      "SELECT COUNT(*)::int AS n FROM discussion_pseudonyms WHERE user_id = 'race-user'");
    assert.equal(rows.rows[0].n, 1, 'exactly one reservation row for the user');
  } finally {
    holder.disconnect();
    tabA.disconnect();
    tabB.disconnect();
  }
});

test('A pseudonym-mode comment sent before the reservation ack persists under the reserved handle (#57)', async () => {
  const topic = uniqueTopic('pseudonym-canon-comment');
  const mod = await connectSocket();
  const holder = await connectSocket();
  const latecomer = await connectSocket();
  try {
    mod.emit('joinDiscussion', topic);
    holder.emit('joinDiscussion', topic);
    latecomer.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'What should we try?');

    // A dedicated participant occupies "Tidy Newt" so it's taken in this discussion.
    const taken = await emitWithAck(holder, 'requestPseudonym', topic, 'user-holder', 'Tidy Newt');
    assert.equal(taken.pseudonym, 'Tidy Newt');

    // An idea for the latecomer to comment on.
    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'Run a pilot', 'user-mod', 'Planner', 'pseudonym');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabled = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabled;

    // "Tidy Newt" is taken, so the latecomer is reserved a different handle.
    const reserved = await emitWithAck(latecomer, 'requestPseudonym', topic, 'user-late', 'Tidy Newt');
    assert.notEqual(reserved.pseudonym, 'Tidy Newt');

    // Race: comment in pseudonym mode but still sending the colliding local pick.
    const commentUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1,
      'comment added'
    );
    const ack = await emitWithAck(
      latecomer, 'addResponseComment', topic, responseId, 'A point', 'user-late', 'Tidy Newt', 'pseudonym');
    assert.equal(ack.added, true);
    const comment = (await commentUpdate)[0].votes[0].comments[0];

    assert.equal(comment.pseudonym, reserved.pseudonym, 'comment should persist under the reserved handle');
    assert.notEqual(comment.pseudonym, 'Tidy Newt', 'no duplicate "Tidy Newt" should be stored');
  } finally {
    mod.disconnect();
    holder.disconnect();
    latecomer.disconnect();
  }
});

test('Custom names are stored verbatim, never replaced by the reserved handle (#57)', async () => {
  const topic = uniqueTopic('pseudonym-canon-custom');
  const mod = await connectSocket();
  const user = await connectSocket();
  try {
    mod.emit('joinDiscussion', topic);
    user.emit('joinDiscussion', topic);
    const question = await addBrainstormQuestion(mod, topic, 'Ideas?');

    // The user holds a reserved pseudonym in this discussion...
    const reserved = await emitWithAck(user, 'requestPseudonym', topic, 'user-1', 'Tidy Newt');
    assert.equal(reserved.pseudonym, 'Tidy Newt');

    // ...but submits in CUSTOM mode: their typed name must be stored as-is, never
    // canonicalized to the reserved handle (custom is a deliberate user choice).
    const customUpdate = waitForQuestions(mod, (qs) => {
      const q = qs.find((x) => x.id === question.id);
      return q && q.votes.length === 1;
    }, 'custom-mode idea');
    user.emit('vote', topic, question.id, 'My idea', 'user-1', 'Dr. Real Name', 'custom');
    const stored = (await customUpdate).find((x) => x.id === question.id).votes[0];

    assert.equal(stored.pseudonym, 'Dr. Real Name');
  } finally {
    mod.disconnect();
    user.disconnect();
  }
});
