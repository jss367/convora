// Socket.IO starts with Engine.IO HTTP polling and may upgrade to WebSocket.
// Observe both transports so privacy assertions include the initial snapshot.
function observeQuestionPayloads(page) {
  const payloads = [];
  const errors = [];
  function capture(body) {
    if (typeof body !== 'string') return;
    // Engine.IO separates packets in a polling response with a record separator.
    for (const packet of body.split('\x1e')) {
      if (packet.startsWith('42["questions",')) payloads.push(packet);
    }
  }
  page.on('websocket', socket => {
    socket.on('framereceived', event => capture(event.payload));
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname !== '/socket.io/' || url.searchParams.get('transport') !== 'polling'
        || response.request().method() !== 'GET') return;
    response.text().then(capture).catch(error => errors.push(error.message));
  });
  return { payloads, errors };
}

module.exports = { observeQuestionPayloads };
