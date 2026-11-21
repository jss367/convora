function createDiscussionStateSender(readState, audience) {
  const rooms = new Map();
  return async function sendState(slug, socket = null, isCurrent = () => true) {
    const room = rooms.get(slug) || { pending: 0, started: 0, lastBroadcast: 0, latestRead: 0 };
    rooms.set(slug, room);
    room.pending++;
    const read = ++room.started;
    try {
      const state = await readState(slug);
      if (read < room.lastBroadcast || !isCurrent()) return;
      if (read > room.latestRead) {
        room.latestRead = read;
        room.latestState = state;
      }
      (socket || audience(slug)).emit('discussionState', room.latestState);
      if (!socket) room.lastBroadcast = room.latestRead;
    } finally {
      if (--room.pending === 0) rooms.delete(slug);
    }
  };
}

module.exports = { createDiscussionStateSender };
