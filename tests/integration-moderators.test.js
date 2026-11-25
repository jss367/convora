const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const { once } = require('node:events');
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

test('Google verification issues an expiring session and only a creator can link a discussion', async () => {
  const express = require('express');
  const { registerModeratorAccounts } = require('../moderator-accounts');
  const app = express();
  app.use(express.json());
  const clientId = 'test-client';
  const subject = crypto.randomUUID();
  const google = {
    async verifyIdToken({ idToken, audience }) {
      assert.equal(audience, clientId);
      if (idToken !== 'verified-fixture') throw Error('unverified');
      return { getPayload: () => ({ sub: subject, email: 'moderator@example.test' }) };
    },
  };
  registerModeratorAccounts(app, pool, { clientId, google, secure: false });
  const listener = app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const origin = 'http://127.0.0.1:' + listener.address().port;
  const headers = { 'Content-Type': 'application/json', 'X-Convora-Account': '1' };
  const post = (path, body, extra = {}) => fetch(origin + '/api/account/' + path, {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post('login', { credential: 'unverified' })).status, 401);
    assert.equal((await post('login', { credential: 'verified-fixture' }, { Origin: 'https://other.example' })).status, 403);
    const login = await post('login', { credential: 'verified-fixture' });
    assert.equal(login.status, 204);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);
    headers.Cookie = cookie.split(';')[0];
    const { slug, adminToken, id } = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('creator') })).body;
    const promoted = crypto.randomUUID();
    await pool.query('INSERT INTO discussion_moderators (discussion_id, user_id, token) VALUES ($1, $2, $3)',
      [id, crypto.randomUUID(), promoted]);
    const link = async token => (await post('link', { discussions: [{ slug, token }] })).json();
    assert.deepEqual(await link(promoted), { linked: 0 });
    assert.deepEqual(await link(adminToken), { linked: 1 });
    assert.deepEqual(await link(adminToken), { linked: 0 });
    await pool.query("UPDATE moderator_sessions SET expires_at = now() WHERE google_sub = $1", [subject]);
    assert.equal((await fetch(origin + '/api/account/access/' + slug, { headers })).status, 401);
  } finally {
    await new Promise(resolve => listener.close(resolve));
    await pool.query('DELETE FROM moderator_sessions WHERE google_sub = $1', [subject]);
  }
});

test('speaking queues enforce room scope, ownership, lock and moderator access', async () => {
  const room = (await jsonRequest('POST', '/api/discussions', { topic: uniqueTopic('hands') })).body;
  const { rows: [question, queued] } = await pool.query(`INSERT INTO questions (discussion_id,text,type,queued)
    VALUES ($1,'Live','Agreement',false), ($1,'Later','Agreement',true) RETURNING id`, [room.id]);
  const guests = await Promise.all([connectSocket(), connectSocket()]);
  const participants = [crypto.randomUUID(), crypto.randomUUID()];
  const change = (index, extra) => emitWithAck(guests[index], 'changeSpeakingQueue', room.slug, {
    questionId: question.id, userId: participants[index], name: `Speaker ${index}`, action: 'raise', ...extra,
  });
  const read = (index, token) => emitWithAck(guests[index], 'readSpeakingQueue', room.slug, participants[index], token);
  try {
    await Promise.all(guests.map((guest, index) => {
      const joined = waitForEvent(guest, 'discussionState');
      guest.emit('joinDiscussion', room.slug);
      guest.emit('identify', room.slug, participants[index]);
      return joined;
    }));
    assert.equal((await change(0)).ok, false);
    await pool.query('UPDATE discussions SET hands_enabled = true WHERE id = $1', [room.id]);
    assert.equal((await change(0, { questionId: queued.id })).ok, false);
    assert.equal((await change(0)).ok, true);
    assert.equal((await change(0)).ok, true);
    const { entries } = await read(0);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].mine, true);
    assert.deepEqual((await read(1, 'invalid')).entries, []);
    assert.equal((await change(1, { action: 'done', entryId: entries[0].id })).ok, false);
    assert.equal((await change(1, { action: 'lower', userId: participants[0] })).ok, true);
    const host = await read(1, room.adminToken);
    assert.equal(host.entries[0].name, 'Speaker 0');
    assert.ok(!JSON.stringify(host.entries).includes(participants[0]));
    await pool.query('UPDATE discussions SET locked = true WHERE id = $1', [room.id]);
    assert.equal((await change(1)).ok, false);
    await pool.query('UPDATE discussions SET locked = false WHERE id = $1', [room.id]);
    assert.equal((await change(1, { action: 'done', entryId: entries[0].id, token: room.adminToken })).ok, true);
    assert.deepEqual((await read(0)).entries, []);
  } finally {
    guests.forEach(guest => guest.disconnect());
  }
});

test('creating a discussion makes the creator its moderator', async () => {
  const topic = uniqueTopic('creator-mod');

  const createResponse = await jsonRequest('POST', '/api/discussions', { topic });
  assert.equal(createResponse.status, 200);
  // The creator gets a moderator token back on the request that establishes it.
  assert.match(createResponse.body.adminToken, /^[a-f0-9]{32}$/);
  assert.match(createResponse.body.slug, /^creator-mod-/);

  // The returned token is the discussion's stored admin token — i.e. it really
  // grants moderation (verifyAdmin matches on this exact value).
  const stored = await pool.query('SELECT admin_token FROM discussions WHERE topic = $1', [topic]);
  assert.equal(stored.rows[0].admin_token, createResponse.body.adminToken);
});

test('re-creating an already-moderated discussion does not hand over moderation', async () => {
  const topic = uniqueTopic('creator-mod-repeat');

  const first = await jsonRequest('POST', '/api/discussions', { topic });
  const firstToken = first.body.adminToken;
  assert.match(firstToken, /^[a-f0-9]{32}$/);

  // A second create for the same topic must NOT mint or disclose a token —
  // otherwise anyone could seize moderation by re-submitting an existing topic.
  const second = await jsonRequest('POST', '/api/discussions', { topic });
  assert.equal(second.status, 200);
  assert.equal(second.body.success, true);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.slug, first.body.slug);
  assert.equal(second.body.adminToken, null);

  // The original moderator's token is untouched.
  const stored = await pool.query('SELECT admin_token FROM discussions WHERE topic = $1', [topic]);
  assert.equal(stored.rows[0].admin_token, firstToken);
});

test('a moderator can promote a participant, granting them working controls', async () => {
  const topic = uniqueTopic('promote');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'guest-user-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    // The guest identifies so the server can route a moderator grant to them.
    guest.emit('identify', topic, guestUserId);

    // Add a question and have the guest vote, so they become a known participant.
    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, {
      text: 'Promote me?',
      type: 'Agreement',
      minValue: null,
      maxValue: null,
      options: [],
    });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Guest Otter');
    await voteRecorded;

    // The moderator sees the guest via an opaque, stable handle — never a raw
    // user id, and not a positional index.
    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(list.success, true);
    assert.equal(list.participants.length, 1);
    assert.match(list.participants[0].id, /^participant-[a-f0-9]{16}$/);
    assert.equal(list.participants[0].pseudonym, 'Guest Otter');
    assert.equal(list.participants[0].isModerator, false);
    assert.equal(list.participants[0].userId, undefined);
    const guestHandle = list.participants[0].id;

    // Promotion delivers a token to the guest live and flips their flag.
    const granted = waitForEvent(guest, 'moderatorGranted');
    const promote = await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    assert.equal(promote.success, true);
    assert.equal(promote.participants[0].isModerator, true);

    const grant = await granted;
    assert.match(grant.token, /^[a-f0-9]{32}$/);

    // The granted token really moderates: the guest can now lock the discussion.
    guest.emit('setLocked', topic, true, grant.token);
    const locked = await waitForEvent(mod, 'discussionState', (state) => state.locked === true);
    assert.equal(locked.locked, true);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a moderator sets the discussion color theme and it broadcasts to everyone', async () => {
  const topic = uniqueTopic('theme');
  const mod = await connectSocket();
  const guest = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    // A fresh discussion defaults to the original 'indigo' look.
    const claimed = await waitForEvent(guest, 'discussionState', (s) => s.hasModerator === true);
    assert.equal(claimed.theme, 'indigo');

    // The moderator switches theme; every participant receives the new value.
    const themed = waitForEvent(guest, 'discussionState', (s) => s.theme === 'orange');
    mod.emit('setTheme', topic, 'orange', token);
    assert.equal((await themed).theme, 'orange');

    // An unknown theme is rejected (error to the sender) and never broadcast.
    const rejected = waitForEvent(mod, 'error', (e) => /theme/i.test(e.message));
    mod.emit('setTheme', topic, 'chartreuse', token);
    await rejected;

    // The stored theme is unchanged: a fresh join still reports 'orange'.
    const rejoin = await connectSocket();
    try {
      rejoin.emit('joinDiscussion', topic);
      const state = await waitForEvent(rejoin, 'discussionState');
      assert.equal(state.theme, 'orange');
    } finally {
      rejoin.disconnect();
    }
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a non-moderator cannot set the discussion theme', async () => {
  const topic = uniqueTopic('theme-deny');
  await jsonRequest('POST', '/api/discussions', { topic });

  const stranger = await connectSocket();
  try {
    stranger.emit('joinDiscussion', topic);
    const rejected = waitForEvent(stranger, 'error', (e) => /authoriz/i.test(e.message));
    stranger.emit('setTheme', topic, 'orange', 'bogus-token');
    await rejected;

    // The theme stays at the default for everyone who joins afterward.
    const observer = await connectSocket();
    try {
      observer.emit('joinDiscussion', topic);
      const state = await waitForEvent(observer, 'discussionState');
      assert.equal(state.theme, 'indigo');
    } finally {
      observer.disconnect();
    }
  } finally {
    stranger.disconnect();
  }
});

test('a moderator can rename the discussion while the slug stays stable', async () => {
  const topic = uniqueTopic('rename');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;
  const slug = creator.body.slug;

  const mod = await connectSocket();
  const guest = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    await waitForEvent(guest, 'discussion', (d) => d && d.topic === topic);

    // The moderator renames; everyone in the room receives the new title on the
    // same 'discussion' channel that delivered it on join.
    const renamed = waitForEvent(guest, 'discussion', (d) => d && d.topic === 'Renamed Topic');
    const ack = await emitWithAck(mod, 'setTopic', slug, 'Renamed Topic', adminToken);
    assert.deepEqual(ack, { updated: true });
    const broadcast = await renamed;

    // Only the display title changed: the slug (the routing key every URL and
    // socket room is keyed on) is untouched, so existing links stay valid.
    assert.equal(broadcast.slug, slug);

    // The rename persists: a fresh join, addressing the discussion by its
    // unchanged slug, reports the new title.
    const rejoin = await connectSocket();
    try {
      rejoin.emit('joinDiscussion', slug);
      const state = await waitForEvent(rejoin, 'discussion', (d) => d && d.slug === slug);
      assert.equal(state.topic, 'Renamed Topic');
    } finally {
      rejoin.disconnect();
    }
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('renaming is rejected for non-moderators and blank titles', async () => {
  const topic = uniqueTopic('rename-deny');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;
  const slug = creator.body.slug;

  const stranger = await connectSocket();
  const mod = await connectSocket();

  try {
    stranger.emit('joinDiscussion', topic);
    mod.emit('joinDiscussion', topic);

    // No valid moderator token: rejected, with an error surfaced to the sender.
    const rejected = waitForEvent(stranger, 'error', (e) => /authoriz/i.test(e.message));
    const denyAck = await emitWithAck(stranger, 'setTopic', slug, 'Hijacked', 'bogus-token');
    assert.deepEqual(denyAck, { updated: false, reason: 'not_authorized' });
    await rejected;

    // A moderator submitting a blank title is rejected rather than renamed to
    // the 'Discussion' placeholder formatTopicTitle would otherwise produce.
    const blankAck = await emitWithAck(mod, 'setTopic', slug, '   ', adminToken);
    assert.deepEqual(blankAck, { updated: false, reason: 'invalid' });

    // Neither attempt changed the stored title.
    const observer = await connectSocket();
    try {
      observer.emit('joinDiscussion', slug);
      const state = await waitForEvent(observer, 'discussion', (d) => d && d.slug === slug);
      assert.equal(state.topic, topic);
    } finally {
      observer.disconnect();
    }
  } finally {
    stranger.disconnect();
    mod.disconnect();
  }
});

test('renaming to an existing discussion title is rejected as a duplicate', async () => {
  // discussions.topic is unique, so renaming one discussion to another's exact
  // title raises a Postgres unique-violation. The server should surface that as
  // a distinct 'duplicate' reason (not a generic error) and leave both titles
  // untouched so the moderator can pick a different name.
  const topicA = uniqueTopic('rename-dup-a');
  const topicB = uniqueTopic('rename-dup-b');
  const creatorA = await jsonRequest('POST', '/api/discussions', { topic: topicA });
  const creatorB = await jsonRequest('POST', '/api/discussions', { topic: topicB });
  const adminTokenA = creatorA.body.adminToken;
  const slugA = creatorA.body.slug;
  const slugB = creatorB.body.slug;

  const mod = await connectSocket();
  try {
    mod.emit('joinDiscussion', topicA);

    // Moderator of A tries to rename A to B's exact title: rejected as duplicate.
    const dupAck = await emitWithAck(mod, 'setTopic', slugA, topicB, adminTokenA);
    assert.deepEqual(dupAck, { updated: false, reason: 'duplicate' });

    // Neither title changed: A still reads topicA, B still reads topicB.
    const observerA = await connectSocket();
    const observerB = await connectSocket();
    try {
      observerA.emit('joinDiscussion', slugA);
      const stateA = await waitForEvent(observerA, 'discussion', (d) => d && d.slug === slugA);
      assert.equal(stateA.topic, topicA);

      observerB.emit('joinDiscussion', slugB);
      const stateB = await waitForEvent(observerB, 'discussion', (d) => d && d.slug === slugB);
      assert.equal(stateB.topic, topicB);
    } finally {
      observerA.disconnect();
      observerB.disconnect();
    }
  } finally {
    mod.disconnect();
  }
});

test('a non-moderator cannot list or promote participants', async () => {
  const topic = uniqueTopic('promote-deny');
  await jsonRequest('POST', '/api/discussions', { topic });

  const stranger = await connectSocket();
  try {
    stranger.emit('joinDiscussion', topic);

    const list = await emitWithAck(stranger, 'listParticipants', topic, 'bogus-token');
    assert.equal(list.success, false);
    assert.equal(list.error, 'not_authorized');

    const promote = await emitWithAck(stranger, 'promoteModerator', topic, 'bogus-token', 'participant-1');
    assert.equal(promote.success, false);
    assert.equal(promote.error, 'not_authorized');
  } finally {
    stranger.disconnect();
  }
});

test('promoting an offline participant fails and does not leave a dangling grant', async () => {
  const topic = uniqueTopic('promote-offline');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'offline-guest-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Offline?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Absent Owl');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;

    // Guest leaves before being promoted. Wait until the server has processed
    // the disconnect (presence drops to just the moderator) so the promote can't
    // find a socket to deliver to.
    const presenceDropped = waitForEvent(mod, 'presence', (count) => count === 1);
    guest.disconnect();
    await presenceDropped;

    const promote = await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    assert.equal(promote.success, false);
    assert.equal(promote.error, 'participant_offline');

    // The grant was rolled back — the participant is not left marked a moderator.
    const after = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(after.participants[0].isModerator, false);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('presence counts distinct people, not sockets', async () => {
  const topic = uniqueTopic('presence-dedup');
  await jsonRequest('POST', '/api/discussions', { topic });

  const tabA = await connectSocket();
  const tabB = await connectSocket();
  const other = await connectSocket();

  // Join + identify a socket, then wait until its presence count settles to
  // `expected`. Also wait for the server's per-join 'questions' emit so the
  // join's DB reads have flushed before we move on — otherwise a read left in
  // flight when the test ends can deadlock the next test's TRUNCATE.
  const joinAs = async (sock, userId, expected) => {
    const ready = waitForQuestions(sock, () => true, `${userId} join`);
    const settled = waitForEvent(sock, 'presence', (count) => count === expected);
    sock.emit('joinDiscussion', topic);
    sock.emit('identify', topic, userId);
    await ready;
    assert.equal(await settled, expected);
  };

  try {
    await joinAs(tabA, 'person-1', 1);  // one person opens the discussion
    await joinAs(tabB, 'person-1', 1);  // same person, second tab → still one person
    await joinAs(other, 'person-2', 2); // a genuinely different person → two

    // The first person closes one of their two tabs. They are still here via the
    // other tab, so the count broadcast on that disconnect must remain 2.
    const afterTabClose = waitForEvent(other, 'presence');
    tabB.disconnect();
    assert.equal(await afterTabClose, 2);
  } finally {
    tabA.disconnect();
    tabB.disconnect();
    other.disconnect();
  }
});

test('the creator can remove a moderator, revoking their access live', async () => {
  const topic = uniqueTopic('demote');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'demote-guest-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Demote me?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Doomed Crab');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(list.canDemote, true); // the creator may remove moderators
    const guestHandle = list.participants[0].id;

    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    const grant = await granted;

    // The granted token works before demotion (a promoted mod is not the creator).
    const asMod = await emitWithAck(guest, 'listParticipants', topic, grant.token);
    assert.equal(asMod.success, true);
    assert.equal(asMod.canDemote, false);

    // The creator removes them: the guest is told live and the flag clears.
    const revoked = waitForEvent(guest, 'moderatorRevoked');
    const demote = await emitWithAck(mod, 'demoteModerator', topic, adminToken, guestHandle);
    assert.equal(demote.success, true);
    assert.equal(demote.participants[0].isModerator, false);
    await revoked;

    // Their token no longer grants moderation.
    const afterRevoke = await emitWithAck(guest, 'listParticipants', topic, grant.token);
    assert.equal(afterRevoke.success, false);
    assert.equal(afterRevoke.error, 'not_authorized');
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a promoted moderator cannot remove moderators (creator-only)', async () => {
  const topic = uniqueTopic('demote-deny');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'demote-deny-guest';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Q?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Power Hungry Yak');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;

    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    const grant = await granted;

    // A promoted moderator is not the creator: their own token can't demote.
    const demote = await emitWithAck(guest, 'demoteModerator', topic, grant.token, guestHandle);
    assert.equal(demote.success, false);
    assert.equal(demote.error, 'not_authorized');

    // Still a moderator — the rejected attempt revoked nothing.
    const after = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    assert.equal(after.participants[0].isModerator, true);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('a moderator who deleted their only response can still be removed', async () => {
  const topic = uniqueTopic('demote-novotes');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'novotes-guest';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    // The guest becomes a participant by posting a Brainstorm idea.
    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Ideas?', type: 'Open Ended', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const ideaPosted = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'idea posted');
    guest.emit('vote', topic, questionId, 'My only idea', guestUserId, 'Fleeting Crab');
    const voteId = (await ideaPosted)[0].votes[0].id;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;
    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    await granted;

    // The guest deletes their only idea — they now have no votes, so the
    // vote-derived list would normally drop them.
    const ideaRemoved = waitForQuestions(mod, (questions) => questions[0] && questions[0].votes.length === 0, 'idea removed');
    guest.emit('deleteVote', topic, voteId, guestUserId);
    await ideaRemoved;

    // They must still appear as a moderator so the creator can remove them.
    const afterDelete = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const stillListed = afterDelete.participants.find((p) => p.id === guestHandle);
    assert.ok(stillListed, 'a vote-less moderator should still be listed');
    assert.equal(stillListed.isModerator, true);

    // ...and the creator can demote them; afterwards they have neither votes nor
    // a grant, so they drop out of the list entirely.
    const demote = await emitWithAck(mod, 'demoteModerator', topic, adminToken, guestHandle);
    assert.equal(demote.success, true);
    assert.equal(demote.participants.find((p) => p.id === guestHandle), undefined);
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test('checkModerator rejects a revoked token so offline demotions clear stale UI', async () => {
  const topic = uniqueTopic('check-mod');
  const creator = await jsonRequest('POST', '/api/discussions', { topic });
  const adminToken = creator.body.adminToken;

  const mod = await connectSocket();
  const guest = await connectSocket();
  const guestUserId = 'check-guest-1';

  try {
    mod.emit('joinDiscussion', topic);
    guest.emit('joinDiscussion', topic);
    guest.emit('identify', topic, guestUserId);

    const questionAdded = waitForQuestions(mod, (questions) => questions.length === 1, 'question added');
    mod.emit('addQuestion', topic, { text: 'Q?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const questionId = (await questionAdded)[0].id;

    const voteRecorded = waitForQuestions(guest, (questions) => questions[0] && questions[0].votes.length === 1, 'guest vote');
    guest.emit('vote', topic, questionId, 'Agree', guestUserId, 'Soon Gone Fox');
    await voteRecorded;

    const list = await emitWithAck(mod, 'listParticipants', topic, adminToken);
    const guestHandle = list.participants[0].id;
    const granted = waitForEvent(guest, 'moderatorGranted');
    await emitWithAck(mod, 'promoteModerator', topic, adminToken, guestHandle);
    const grant = await granted;

    // While granted, the token checks out — but as a per-user grant, not the
    // creator token, so isCreator is false (the client uses this to avoid
    // setting canDemote for a mere moderator).
    assert.deepEqual(await emitWithAck(guest, 'checkModerator', topic, grant.token), { ok: true, isModerator: true, isCreator: false });

    // After removal the same token no longer checks out — this is what lets an
    // offline-demoted user's client drop its stale token on next load.
    await emitWithAck(mod, 'demoteModerator', topic, adminToken, guestHandle);
    assert.deepEqual(await emitWithAck(guest, 'checkModerator', topic, grant.token), { ok: true, isModerator: false, isCreator: false });

    // The creator's own token still checks out, and is flagged as the creator
    // token so a creator who never opened the participant panel still gets
    // canDemote initialized on load — preventing a moderatorGranted push from
    // clobbering the real creator token.
    assert.deepEqual(await emitWithAck(mod, 'checkModerator', topic, adminToken), { ok: true, isModerator: true, isCreator: true });
  } finally {
    mod.disconnect();
    guest.disconnect();
  }
});

test("a moderator can delete any participant's response (spam control)", async () => {
  const topic = uniqueTopic('mod-delete-idea');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Ideas?');

    // A participant (not the moderator) posts the response.
    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'spam spam spam', 'spammer-1', 'Spammer');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // The moderator removes it even though they did not author it.
    const deleteUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 0, 'idea removed by moderator');
    mod.emit('moderatorDeleteVote', topic, responseId, token);
    assert.deepEqual((await deleteUpdate)[0].votes, []);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test("a non-moderator cannot delete another participant's response", async () => {
  const topic = uniqueTopic('mod-delete-deny');
  const mod = await connectSocket();
  const stranger = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    stranger.emit('joinDiscussion', topic);
    await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'Ideas?');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    mod.emit('vote', topic, question.id, 'keep me', 'author-1', 'Author');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    // A stranger with a bogus token is rejected, not silently obeyed.
    const denied = waitForEvent(stranger, 'error');
    stranger.emit('moderatorDeleteVote', topic, responseId, 'bogus-token');
    await denied;

    // Re-joining re-sends the current state; the response is still there.
    const refreshed = waitForQuestions(stranger, (qs) => qs[0] && qs[0].id === question.id, 'state refreshed');
    stranger.emit('joinDiscussion', topic);
    const votes = (await refreshed)[0].votes;
    assert.equal(votes.length, 1);
    assert.equal(votes[0].id, responseId);
  } finally {
    mod.disconnect();
    stranger.disconnect();
  }
});

test("a moderator can delete any participant's comment (spam control)", async () => {
  const topic = uniqueTopic('mod-delete-comment');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);
    const question = await addBrainstormQuestion(mod, topic, 'What should we try?');

    const ideaUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'idea added');
    participant.emit('vote', topic, question.id, 'A real idea', 'user-idea', 'Planner');
    const responseId = (await ideaUpdate)[0].votes[0].id;

    const enabledUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].commentsEnabled === true, 'comments enabled');
    mod.emit('setDiscussionFlags', topic, { comments_enabled: true }, token);
    await enabledUpdate;

    const commentUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 1,
      'comment added'
    );
    const ack = await emitWithAck(
      participant, 'addResponseComment', topic, responseId, 'buy now at spam.example', 'spammer-2', 'Spammer');
    assert.equal(ack.added, true);
    const comment = (await commentUpdate)[0].votes[0].comments[0];

    // The moderator removes a comment they did not author.
    const deleteUpdate = waitForQuestions(
      mod,
      (qs) => qs[0] && qs[0].votes[0] && (qs[0].votes[0].comments || []).length === 0,
      'comment removed by moderator'
    );
    mod.emit('moderatorDeleteResponseComment', topic, comment.id, token);
    assert.deepEqual((await deleteUpdate)[0].votes[0].comments, []);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('a moderator cannot delete a poll vote via moderatorDeleteVote (aggregate data)', async () => {
  const topic = uniqueTopic('mod-delete-poll-deny');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    // Agreement polls are aggregate data, not spammable free text. The
    // moderator-delete feature is scoped to written responses, so the backend
    // must refuse to remove a poll vote even with a valid token.
    const questionAdded = waitForQuestions(mod, (qs) => qs.length === 1, 'poll added');
    mod.emit('addQuestion', topic, { text: 'Agree?', type: 'Agreement', minValue: null, maxValue: null, options: [] });
    const question = (await questionAdded)[0];

    const voteUpdate = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'poll vote recorded');
    participant.emit('vote', topic, question.id, 'Agree', 'poll-voter', 'Voter');
    const voteId = (await voteUpdate)[0].votes[0].id;

    // The moderator targets the poll vote id directly, as if from the console.
    // The handler always re-broadcasts questions after running, so waiting for
    // that broadcast guarantees the (no-op) delete query has completed before
    // we assert. The poll vote must still be there.
    const afterDelete = waitForQuestions(mod, (qs) => qs[0] && qs[0].id === question.id, 'state after delete');
    mod.emit('moderatorDeleteVote', topic, voteId, token);
    const votes = (await afterDelete)[0].votes;
    assert.equal(votes.length, 1);
    assert.equal(votes[0].id, voteId);
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('moderator-only mode lets only moderators add questions while voting stays open', async () => {
  const topic = uniqueTopic('mod-only-questions');
  const mod = await connectSocket();
  const participant = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    participant.emit('joinDiscussion', topic);
    const token = await claimModerator(mod, topic);

    // Turn on moderator-only questions and wait for the state to broadcast.
    const restricted = waitForEvent(participant, 'discussionState', (s) => s.moderatorOnly === true);
    mod.emit('setModeratorOnly', topic, true, token);
    await restricted;

    // A participant with no moderator token is bounced...
    const rejected = await emitWithAck(
      participant,
      'addQuestion',
      topic,
      { text: 'Can I ask this?', type: 'Agreement', minValue: null, maxValue: null, options: [] },
      false,
      null
    );
    assert.equal(rejected.added, false, 'participant submission must be rejected');
    assert.equal(rejected.reason, 'moderator_only');

    // ...but the moderator can add a question with their token. Register the
    // listener before emitting: the server broadcasts 'questions' before it acks.
    const questionAdded = waitForQuestions(mod, (qs) => qs.length === 1, 'moderator question added');
    const modAdded = await emitWithAck(
      mod,
      'addQuestion',
      topic,
      { text: 'Moderator agenda item', type: 'Agreement', minValue: null, maxValue: null, options: [] },
      false,
      token
    );
    assert.equal(modAdded.added, true, 'moderator submission must be accepted');

    const questions = await questionAdded;
    const questionId = questions[0].id;
    assert.equal(questions[0].text, 'Moderator agenda item');

    // Voting stays open for everyone even while questions are restricted.
    const voted = waitForQuestions(mod, (qs) => qs[0] && qs[0].votes.length === 1, 'participant vote recorded');
    participant.emit('vote', topic, questionId, 'Agree', 'user-voter', 'Voter');
    await voted;

    // Reopening lets participants add questions again.
    const opened = waitForEvent(participant, 'discussionState', (s) => s.moderatorOnly === false);
    mod.emit('setModeratorOnly', topic, false, token);
    await opened;

    const accepted = await emitWithAck(
      participant,
      'addQuestion',
      topic,
      { text: 'Now I can ask', type: 'Agreement', minValue: null, maxValue: null, options: [] },
      false,
      null
    );
    assert.equal(accepted.added, true, 'participant submission must be accepted once reopened');
  } finally {
    mod.disconnect();
    participant.disconnect();
  }
});

test('setModeratorOnly rejects callers without a valid moderator token', async () => {
  const topic = uniqueTopic('mod-only-auth');
  const mod = await connectSocket();
  const intruder = await connectSocket();

  try {
    mod.emit('joinDiscussion', topic);
    intruder.emit('joinDiscussion', topic);
    await claimModerator(mod, topic);

    // An attempt with a bogus token must not change the discussion's state.
    const errored = waitForEvent(intruder, 'error');
    intruder.emit('setModeratorOnly', topic, true, 'not-a-real-token');
    await errored;

    // beforeEach truncates, and only the moderator's claim created a discussion,
    // so the single row reflects whether the bogus token managed to flip the flag.
    const state = await pool.query('SELECT moderator_only_questions FROM discussions');
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].moderator_only_questions, false);
  } finally {
    mod.disconnect();
    intruder.disconnect();
  }
});
