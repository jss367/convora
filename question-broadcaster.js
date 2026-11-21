function createQuestionBroadcaster({
  getQuestions, getResultsAccess, withoutQueued, displayView, hideUnansweredResults,
  audience, displays, participants,
}) {
  const rooms = new Map();

  function roomFor(slug) {
    if (!rooms.has(slug)) {
      rooms.set(slug, { started: 0, delivered: 0, tail: null, queued: null, personal: 0 });
    }
    return rooms.get(slug);
  }

  function releaseIfIdle(slug, room) {
    if (!room.tail && room.personal === 0) rooms.delete(slug);
  }

  async function load(slug) {
    const respondents = new Map();
    const questions = await getQuestions(slug, { respondents });
    const access = await getResultsAccess(slug);
    return { questions, respondents, access };
  }

  function deliver(slug, { questions, respondents, access }, socket = null) {
    if (socket?.data.isDisplay && socket.data.display !== slug) return;
    const published = withoutQueued(questions);
    if (access.alwaysShow && published === questions) {
      (socket || audience(slug)).emit('questions', questions);
      return;
    }

    const forDisplay = () => access.alwaysShow ? published : displayView(published, respondents);
    if (socket?.data.isDisplay) {
      socket.emit('questions', forDisplay());
      return;
    }
    if (!socket) displays(slug)?.emit('questions', forDisplay());

    const views = new Map();
    for (const target of socket ? [socket] : participants(slug)) {
      const moderator = target.data.moderator;
      if (moderator && moderator.slug === slug && access.isModerator(moderator.token)) {
        target.emit('questions', questions);
      } else if (access.alwaysShow) {
        target.emit('questions', published);
      } else {
        const userId = target.data.userId || null;
        if (!views.has(userId)) views.set(userId, hideUnansweredResults(published, respondents, userId));
        target.emit('questions', views.get(userId));
      }
    }
  }

  function broadcast(slug) {
    const room = roomFor(slug);
    if (room.queued) return room.queued;
    const start = async () => {
      room.queued = null;
      const run = ++room.started;
      const snapshot = await load(slug);
      deliver(slug, snapshot);
      room.delivered = run;
    };
    const run = (room.tail || Promise.resolve()).then(start, start);
    room.tail = room.queued = run;
    const release = () => {
      if (room.tail !== run) return;
      room.tail = null;
      releaseIfIdle(slug, room);
    };
    run.then(release, release);
    return run;
  }

  async function sendTo(slug, socket, isCurrent = () => true) {
    const room = roomFor(slug);
    const startedAfterRun = room.started;
    room.personal++;
    try {
      const snapshot = await load(slug);
      if (room.delivered <= startedAfterRun && isCurrent()) deliver(slug, snapshot, socket);
    } finally {
      room.personal--;
      releaseIfIdle(slug, room);
    }
  }

  return { broadcast, sendTo, get activeRoomCount() { return rooms.size; } };
}

module.exports = { createQuestionBroadcaster };
