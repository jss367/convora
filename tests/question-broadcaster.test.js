const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createQuestionBroadcaster } = require('../question-broadcaster');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function receiver(data = {}) {
  const messages = [];
  return { data, messages, emit(event, questions) { assert.equal(event, 'questions'); messages.push(questions); } };
}

function fixture(overrides = {}) {
  const reads = [], room = receiver();
  const broadcaster = createQuestionBroadcaster({
    getQuestions(slug, { respondents }) {
      const next = reads.shift();
      assert.ok(next, `unexpected read for ${slug}`);
      next.started.resolve({ slug, respondents });
      return next.result.promise;
    },
    getResultsAccess: async () => ({ alwaysShow: true, isModerator: () => false }),
    withoutQueued: questions => questions,
    audience: () => room,
    displays: () => null,
    participants: () => [],
    ...overrides,
  });
  function nextRead() {
    const started = deferred(), result = deferred();
    reads.push({ started, result });
    return { started: started.promise, finish: result.resolve, fail: result.reject };
  }
  return { broadcaster, nextRead, room };
}

test('overlapping requests share the next unstarted run; each caller waits only for its own run', async () => {
  const { broadcaster, nextRead, room } = fixture();
  const firstRead = nextRead(), secondRead = nextRead();
  const first = broadcaster.broadcast('topic');
  assert.equal(broadcaster.broadcast('topic'), first);
  await firstRead.started;
  const second = broadcaster.broadcast('topic');
  assert.notEqual(second, first);
  assert.equal(broadcaster.broadcast('topic'), second);
  const deliveredBeforeNextRead = secondRead.started.then(() => room.messages.slice());
  firstRead.finish(['first']);
  await first;
  assert.deepEqual(await deliveredBeforeNextRead, [['first']]);
  assert.deepEqual(room.messages, [['first']]);
  assert.equal(broadcaster.activeRoomCount, 1);
  secondRead.finish(['second']);
  await second;
  assert.deepEqual(room.messages, [['first'], ['second']]);
  assert.equal(broadcaster.activeRoomCount, 0);
});

test('a later delivered run supersedes a personal read; its room stays alive until both finish', async () => {
  const { broadcaster, nextRead, room } = fixture();
  const personalRead = nextRead(), roomRead = nextRead(), socket = receiver();
  const personal = broadcaster.sendTo('topic', socket);
  await personalRead.started;
  const broadcast = broadcaster.broadcast('topic');
  await roomRead.started;
  roomRead.finish(['new']);
  await broadcast;
  assert.equal(broadcaster.activeRoomCount, 1);
  personalRead.finish(['stale']);
  await personal;
  assert.deepEqual(room.messages, [['new']]);
  assert.deepEqual(socket.messages, []);
  assert.equal(broadcaster.activeRoomCount, 0);
});

test('a broadcast that started before a personal read does not supersede it', async () => {
  const { broadcaster, nextRead } = fixture();
  const roomRead = nextRead(), personalRead = nextRead(), socket = receiver();
  const broadcast = broadcaster.broadcast('topic');
  await roomRead.started;
  const personal = broadcaster.sendTo('topic', socket);
  await personalRead.started;
  roomRead.finish(['room']);
  await broadcast;
  personalRead.finish(['own']);
  await personal;
  assert.deepEqual(socket.messages, [['own']]);
  assert.equal(broadcaster.activeRoomCount, 0);
});

test('partial fanout failure rejects its callers, preserves an older personal read, and drains the follow-up', async () => {
  const failure = new Error('emit failed');
  const firstTarget = receiver(), personalTarget = receiver();
  let failOnce = true;
  const { broadcaster, nextRead } = fixture({
    withoutQueued: questions => questions.slice(),
    participants: () => [firstTarget, { data: {}, emit() { if (failOnce) { failOnce = false; throw failure; } } }],
  });
  const personalRead = nextRead(), brokenRead = nextRead(), followupRead = nextRead();
  const personal = broadcaster.sendTo('topic', personalTarget);
  await personalRead.started;
  const broken = broadcaster.broadcast('topic');
  assert.equal(broadcaster.broadcast('topic'), broken);
  await brokenRead.started;
  const followup = broadcaster.broadcast('topic');
  brokenRead.finish(['broken']);
  await assert.rejects(broken, error => error === failure);
  await followupRead.started;
  personalRead.finish(['personal']);
  await personal;
  assert.deepEqual(personalTarget.messages, [['personal']]);
  assert.equal(broadcaster.activeRoomCount, 1);
  followupRead.finish(['retry']);
  await followup;
  assert.deepEqual(firstTarget.messages, [['broken'], ['retry']]);
  assert.equal(broadcaster.activeRoomCount, 0);
});

test('read failures release idle rooms without blocking independent rooms', async () => {
  const { broadcaster, nextRead, room } = fixture();
  const personalRead = nextRead(), brokenRead = nextRead(), goodRead = nextRead();
  const personal = broadcaster.sendTo('personal', receiver());
  const broken = broadcaster.broadcast('broken');
  await brokenRead.started;
  const good = broadcaster.broadcast('good');
  assert.equal((await goodRead.started).slug, 'good');
  assert.equal(broadcaster.activeRoomCount, 3);
  goodRead.finish(['good']);
  await good;
  assert.deepEqual(room.messages, [['good']]);
  personalRead.fail(new Error('personal failed'));
  await assert.rejects(personal, /personal failed/);
  assert.equal(broadcaster.activeRoomCount, 1);
  brokenRead.fail(new Error('room failed'));
  await assert.rejects(broken, /room failed/);
  assert.equal(broadcaster.activeRoomCount, 0);
});

for (const alwaysShow of [false, true]) {
  test(`queued questions require a current room moderator; displays never inherit credentials (alwaysShow=${alwaysShow})`, async () => {
    const published = [{ id: 1 }], all = [...published, { id: 2, queued: true }];
    const proof = { slug: 'topic', token: 'valid' };
    const moderator = receiver({ moderator: proof });
    const viewer = receiver({ userId: 'user', moderator: { ...proof, token: 'revoked' } });
    const otherTab = receiver({ userId: 'user', moderator: { ...proof, slug: 'elsewhere' } });
    const display = receiver({ isDisplay: true, display: 'topic', moderator: proof, userId: 'user' });
    const { broadcaster, nextRead, room } = fixture({
      getResultsAccess: async () => ({ alwaysShow, isModerator: token => token === 'valid' }),
      withoutQueued: questions => { assert.equal(questions, all); return published; },
      displayView: (questions, respondents) => ({ display: true, questions, respondents }),
      hideUnansweredResults: (questions, respondents, userId) => ({ userId, questions, respondents }),
      displays: () => display,
      participants: () => [moderator, viewer, otherTab],
    });
    const read = nextRead(), broadcast = broadcaster.broadcast('topic');
    const { respondents } = await read.started;
    read.finish(all);
    await broadcast;
    assert.deepEqual(room.messages, []);
    assert.deepEqual(moderator.messages, [all]);
    assert.deepEqual(viewer.messages, [alwaysShow ? published : { userId: 'user', questions: published, respondents }]);
    assert.equal(otherTab.messages[0], viewer.messages[0]);
    assert.deepEqual(display.messages, [alwaysShow ? published : { display: true, questions: published, respondents }]);

    const displayRead = nextRead(), personal = broadcaster.sendTo('topic', display);
    const own = await displayRead.started;
    displayRead.finish(all);
    await personal;
    assert.deepEqual(display.messages[1], alwaysShow ? published : { display: true, questions: published, respondents: own.respondents });
    assert.equal(moderator.messages.length, 1);
  });
}

test('a personal send checks the visit and display room after loading, even for a uniform payload', async () => {
  const { broadcaster, nextRead } = fixture();
  const socket = receiver(), display = receiver({ isDisplay: true, display: 'topic' });
  const read = nextRead(), displayRead = nextRead();
  let current = true;
  const personal = broadcaster.sendTo('topic', socket, () => current);
  const screen = broadcaster.sendTo('topic', display);
  await Promise.all([read.started, displayRead.started]);
  current = false;
  display.data.display = 'another-room';
  read.finish(['old visit']);
  displayRead.finish(['old display']);
  await Promise.all([personal, screen]);
  assert.deepEqual(socket.messages, []);
  assert.deepEqual(display.messages, []);
  assert.equal(broadcaster.activeRoomCount, 0);
});
