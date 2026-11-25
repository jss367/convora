const crypto = require('crypto');

// Resolve the authoritative userId for a socket connection.
//
// Identity is a per-CONNECTION property, not a per-message one. We pin it to the
// socket the first time the client presents its id (via `identify` on connect, or
// the first ownership action), and from then on every vote / rating / reaction /
// comment / delete / rename derives ownership from `socket.data.userId` — never
// from a userId field re-supplied in each individual message. That is what stops
// a participant from acting as someone else: a socket can only ever be the one
// identity it first claimed and cannot switch mid-connection, so naming a
// different id in a later message is ignored rather than honored.
//
// This is layered on top of the fact that userId is an unguessable per-browser
// secret that is never put on the wire (getQuestions replaces it with per-response
// ownership tokens — see the tokenization there), so a client cannot learn, and
// therefore cannot claim, an identity that isn't its own in the first place.
//
// `claimed` is consulted ONLY to bootstrap an as-yet-unpinned socket; once pinned
// it is ignored. Returns null if the socket has no identity and none was supplied.
function bindSocketUser(socket, claimed) {
  if (!socket.data.userId && claimed) {
    socket.data.userId = claimed;
  }
  return socket.data.userId || null;
}

// Per-response, non-reversible ownership token broadcast in place of raw stable
// user ids (see getQuestions). Definition: sha256(idPart + ':' + userId), hex,
// where idPart is the vote's own row id. No server secret needed — userIds are
// long random strings, and folding in the per-response id means the same
// browser gets a different token for every response (so an anonymous
// participant's multiple ideas in one prompt can't be grouped).
//
// IMPORTANT: must stay byte-for-byte identical to ownerToken() in
// client/src/identity.js. Change one, change both.
function ownerToken(idPart, userId) {
  if (idPart === null || idPart === undefined || !userId) return null;
  return crypto.createHash('sha256').update(`${idPart}:${userId}`).digest('hex');
}

module.exports = { bindSocketUser, ownerToken };
