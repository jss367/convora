const { slugifyTopic } = require('./discussion-names');
const { bindSocketUser } = require('./participant-identity');
const { displayRoom } = require('./room-broadcasts');

// The only events a room display's socket may send (see socket.use below).
const DISPLAY_EVENTS = new Set(['joinDisplay', 'leaveDisplay']);

function registerRoomMembership(socket, {
  pool, emitPresence, emitDiscussion, emitQuestions, emitDiscussionState, resendQuestionsIfPersonalized,
  logError, logInfo,
}) {
  // A socket that has opened a room display stays read-only for the rest of its
  // connection: it can switch which discussion it displays, and nothing else. It
  // cannot vote, write, identify as a participant or prove a moderator token, so
  // the screen never adds to any count and never receives a moderator's view.
  // Requests that expect an acknowledgment are told why they were refused.
  socket.use(([event, ...args], next) => {
    if (!socket.data.isDisplay || DISPLAY_EVENTS.has(event)) return next();
    const ack = args[args.length - 1];
    if (typeof ack === 'function') ack({ ok: false, success: false, error: 'display_read_only' });
  });

  // Open the read-only room display for a discussion. The socket joins the
  // display room, never the discussion's own room, so presence does not count it.
  socket.on('joinDisplay', async (topic) => {
    const discussionSlug = slugifyTopic(topic);
    socket.data.isDisplay = true;
    // Each join supersedes any earlier one still loading, so a slow join cannot
    // send one discussion's data to a screen that has moved to another.
    const join = (socket.data.displayJoin || 0) + 1;
    socket.data.displayJoin = join;
    const current = () => socket.data.displayJoin === join && socket.data.display === discussionSlug;
    // A socket that was a participant somewhere stops being one.
    const previousTopic = socket.data.topic;
    if (previousTopic) {
      socket.leave(previousTopic);
      socket.data.topic = null;
      emitPresence(previousTopic);
    }
    const previousDisplay = socket.data.display;
    if (previousDisplay && previousDisplay !== discussionSlug) socket.leave(displayRoom(previousDisplay));
    socket.join(displayRoom(discussionSlug));
    socket.data.display = discussionSlug;
    try {
      await emitDiscussion(discussionSlug, socket, current);
      if (!current()) return;
      await emitQuestions(discussionSlug, socket, current);
      await emitDiscussionState(discussionSlug, socket, current);
      if (!current()) return;
      emitPresence(discussionSlug);
    } catch (error) {
      logError('Error opening room display:', error);
      if (current()) socket.emit('error', { message: 'Failed to get questions' });
    }
  });

  socket.on('leaveDisplay', (topic) => {
    const slug = topic ? slugifyTopic(topic) : socket.data.display;
    if (!slug) return;
    socket.leave(displayRoom(slug));
    // Also invalidates any join of this display that is still loading.
    if (socket.data.display === slug) socket.data.display = null;
  });

  socket.on('joinDiscussion', async (topic) => {
    const discussionSlug = slugifyTopic(topic);
    socket.data.discussionVisit = (socket.data.discussionVisit || 0) + 1;
    // A join still loading when the socket moves to another discussion must not
    // send this one's data after it (the client cannot tell the payloads apart).
    const visit = socket.data.discussionVisit;
    const current = () => socket.data.topic === discussionSlug && socket.data.discussionVisit === visit;
    // If this socket was viewing another discussion, leave it so presence
    // counts stay accurate as the user navigates within the SPA.
    const previousTopic = socket.data.topic;
    if (previousTopic && previousTopic !== discussionSlug) {
      socket.leave(previousTopic);
      emitPresence(previousTopic);
    }

    socket.join(discussionSlug);
    socket.data.topic = discussionSlug;
    emitPresence(discussionSlug);

    try {
      // A late visitor or reconnect may have missed the deletion broadcast.
      // Null discussion data alone also means a never-created lazy route, so
      // distinguish a permanently deleted route using its durable tombstone.
      const deleted = await pool.query('SELECT 1 FROM deleted_discussion_slugs WHERE slug = $1', [discussionSlug]);
      if (!current()) return;
      if (deleted.rows.length) {
        socket.leave(discussionSlug);
        socket.data.topic = null;
        emitPresence(discussionSlug);
        socket.emit('discussionDeleted', { slug: discussionSlug });
        return;
      }
      await emitDiscussion(discussionSlug, socket, current);
      if (!current()) return;
      await emitQuestions(discussionSlug, socket, current);
      await emitDiscussionState(discussionSlug, socket, current);
    } catch (error) {
      logError('Error getting questions:', error);
      if (current()) socket.emit('error', { message: 'Failed to get questions' });
    }
  });

  // Pin this socket to the client's persistent userId (see bindSocketUser) so the
  // server can route a live moderator grant to it when a moderator promotes this
  // user, and so every ownership action on the connection is attributed correctly.
  //
  // Deliberately does NOT hand back an existing moderator token here: re-delivering
  // a token to anyone who merely supplies a promoted user's id would let a leaked
  // id be replayed into moderator access. A genuinely promoted user receives their
  // token live at promotion time and persists it locally (so it survives reloads /
  // reconnects via verifyAdmin); we never re-mint it from the id alone.
  socket.on('identify', (topic, userId) => {
    const wasAnonymous = !socket.data.userId;
    bindSocketUser(socket, userId);
    // `joinDiscussion` usually arrives before `identify`, so the presence count
    // broadcast on join may have counted this socket as its own anonymous person.
    // Now that we know who it is, recompute so it merges with the user's other
    // sockets instead of inflating the count until the next join/leave.
    if (wasAnonymous && socket.data.userId && socket.data.topic) {
      emitPresence(socket.data.topic);
      // The questions sent on join were built before we knew who this is, so
      // they hid the results of questions this participant has already answered.
      resendQuestionsIfPersonalized(socket);
    }
  });

  socket.on('leaveDiscussion', (topic) => {
    // The client unmounted its discussion page; drop it from the room and
    // recompute presence so the counter doesn't over-report lingering viewers.
    const roomToLeave = topic || socket.data.topic;
    if (!roomToLeave) return;
    socket.leave(roomToLeave);
    if (socket.data.topic === roomToLeave) {
      socket.data.discussionVisit = (socket.data.discussionVisit || 0) + 1;
      socket.data.topic = null;
    }
    emitPresence(roomToLeave);
  });

  socket.on('disconnect', () => {
    logInfo('Client disconnected');
    // The socket has already left its rooms by now, so the count reflects the
    // remaining participants.
    emitPresence(socket.data.topic);
  });
}

module.exports = { registerRoomMembership };
