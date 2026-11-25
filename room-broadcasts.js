const { slugifyTopic } = require('./discussion-names');
const { createQuestionBroadcaster } = require('./question-broadcaster');
const { createDiscussionStateSender } = require('./discussion-state-sender');
const { withoutQueued, displayView, hideUnansweredResults } = require('./question-views');
const { logError } = require('./logging');

// A room display (/discussion/:topic/display) is a read-only screen shown to the
// whole room. Its sockets join this room instead of the discussion's own room,
// so they never count as participants, and they receive their own view of the
// questions (see displayView).
function displayRoom(slug) {
  return `display:${slug}`;
}

// Who in a discussion receives what: presence, the questions, the discussion
// and its state, and the pushes meant for one participant's sockets.
function createRoomBroadcasts({ io, getQuestions, getResultsAccess, getDiscussionState, getDiscussionBySlug }) {
  // Emit the number of distinct PEOPLE currently in a discussion room to everyone
  // there. We count by identity, not by raw socket: a single person routinely
  // holds several sockets at once — a second browser tab, or (very common on
  // mobile) a connection that just dropped but whose server-side timeout hasn't
  // fired yet while its reconnected replacement is already in the room. Counting
  // sockets reported those as extra "people" — the "it says 2 but there's no one
  // else here" symptom. Sockets that haven't run `identify` yet fall back to
  // their own id, so several genuinely anonymous viewers still each count once.
  //
  // Room displays (see joinDisplay) are kept in their own room, so they are never
  // counted here, but they receive the count so the screen can show it.
  function emitPresence(topic) {
    if (!topic) return;
    const room = io.sockets.adapter.rooms.get(topic);
    const people = new Set();
    if (room) {
      for (const socketId of room) {
        const member = io.sockets.sockets.get(socketId);
        people.add(member?.data.userId || socketId);
      }
    }
    audience(topic).emit('presence', people.size);
  }

  // Everyone watching a discussion: its participants and its room displays. Used
  // for broadcasts every viewer gets alike (the discussion, its state, presence).
  function audience(slug) {
    return io.to(slug).to(displayRoom(slug));
  }

  // Push a freshly reserved handle to a user's OTHER sockets in a discussion (all
  // but the originating socket, which receives it via its ack). Used after a
  // shuffle so a second tab open on the same discussion stops submitting under the
  // old handle, which is now free for another participant to claim. Sockets are
  // tagged with their userId via the 'identify' event.
  function emitPseudonymSync(slug, userId, pseudonym, exceptSocketId) {
    const room = io.sockets.adapter.rooms.get(slug);
    if (!room) return;
    for (const socketId of room) {
      if (socketId === exceptSocketId) continue;
      const member = io.sockets.sockets.get(socketId);
      if (member && member.data.userId === userId) {
        // Include the slug so a tab that has since navigated to another discussion
        // can recognize and ignore a sync meant for the room it just left.
        member.emit('pseudonymSync', { slug, pseudonym });
      }
    }
  }

  const emitDiscussionState = createDiscussionStateSender(getDiscussionState, audience);
  const emitDiscussion = createDiscussionStateSender(getDiscussionBySlug, audience, 'discussion');

  function participantSockets(slug) {
    return [...(io.sockets.adapter.rooms.get(slug) || [])].map(id => io.sockets.sockets.get(id)).filter(Boolean);
  }

  async function notifyQuestionNoteModerators(slug, questionId) {
    const access = await getResultsAccess(slug);
    for (const target of participantSockets(slug)) {
      const moderator = target.data.moderator;
      if (!target.data.isDisplay && moderator?.slug === slug && access.isModerator(moderator.token)) {
        target.emit('questionNotesChanged', { slug, questionId });
      }
    }
  }

  const questionBroadcaster = createQuestionBroadcaster({
    getQuestions, getResultsAccess, withoutQueued, displayView, hideUnansweredResults,
    audience,
    displays(slug) {
      const room = displayRoom(slug);
      return io.sockets.adapter.rooms.get(room)?.size ? io.to(room) : null;
    },
    participants: participantSockets,
  });

  function emitQuestions(topic, onlySocket = null, isCurrent) {
    const slug = slugifyTopic(topic);
    return onlySocket ? questionBroadcaster.sendTo(slug, onlySocket, isCurrent) : questionBroadcaster.broadcast(slug);
  }

  // A socket's view can change without any vote: it identifies itself after
  // joining, or gains or loses moderator access. Independent answers personalize
  // the payload even in rooms that always show poll results.
  async function resendQuestionsIfPersonalized(socket) {
    const slug = socket.data.topic;
    if (!slug) return;
    const visit = socket.data.discussionVisit;
    const current = () => socket.data.topic === slug && socket.data.discussionVisit === visit;
    try {
      if (current()) await emitQuestions(slug, socket, current);
    } catch (error) {
      logError('Error resending questions:', error);
    }
  }

  function notifySpeakingQueue(slug, owner) {
    for (const id of io.sockets.adapter.rooms.get(slug) || []) {
      const target = io.sockets.sockets.get(id);
      if (target && (target.data.moderator?.slug === slug || (owner && target.data.userId === owner))) {
        target.emit('speakingQueueChanged', slug);
      }
    }
  }

  // Push a freshly granted moderator token to every connected socket belonging to
  // the given user in the discussion's room, so promotion takes effect live.
  // Returns how many sockets received it — 0 means the user isn't currently
  // connected/identified, so the grant can't reach them.
  function deliverModeratorToken(topic, userId, token) {
    const room = io.sockets.adapter.rooms.get(topic);
    if (!room) return 0;
    let delivered = 0;
    for (const socketId of room) {
      const target = io.sockets.sockets.get(socketId);
      if (target && target.data.userId === userId) {
        target.emit('moderatorGranted', { token });
        delivered++;
      }
    }
    return delivered;
  }

  // Tell a demoted user's connected sockets their moderation was revoked so their
  // UI drops the controls promptly. Best-effort/live-only: the grant is already
  // gone from the DB, so the token stops working immediately regardless of whether
  // the user is connected to receive this (verifyAdmin re-checks on every action).
  function revokeModeratorToken(topic, userId) {
    const room = io.sockets.adapter.rooms.get(topic);
    if (!room) return;
    for (const socketId of room) {
      const target = io.sockets.sockets.get(socketId);
      if (target && target.data.userId === userId) {
        target.emit('moderatorRevoked');
      }
    }
  }

  return {
    audience, emitPresence, emitPseudonymSync, emitDiscussionState, emitDiscussion, emitQuestions,
    resendQuestionsIfPersonalized, notifyQuestionNoteModerators, notifySpeakingQueue,
    deliverModeratorToken, revokeModeratorToken,
  };
}

module.exports = { displayRoom, createRoomBroadcasts };
