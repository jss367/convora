// Interest writes and recovery reads share a per-participant/question queue.
// Register work before it starts so recovery cannot overtake a slow transaction,
// even when the participant reconnects on a different socket.
function createInterestUpdates() {
  const pending = new Map();
  return {
    run(topic, questionId, userId, work) {
      const key = JSON.stringify([topic, questionId, userId]);
      const previous = pending.get(key) || Promise.resolve();
      const result = previous.catch(() => {}).then(work);
      pending.set(key, result);
      const cleanup = () => { if (pending.get(key) === result) pending.delete(key); };
      result.then(cleanup, cleanup);
      return result;
    },
  };
}

module.exports = { createInterestUpdates };
