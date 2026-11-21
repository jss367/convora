const POSTING_MODES = ['open', 'approval', 'moderator_only'];

function postingMode(room) {
  if (room.moderator_only_questions) return 'moderator_only';
  return room.question_approval_required ? 'approval' : 'open';
}

function questionDisposition(room, isModerator, queueRequested) {
  if (room.locked) return { reason: 'locked' };
  if (isModerator) return { queued: queueRequested, suggested: false };
  switch (postingMode(room)) {
    case 'moderator_only': return { reason: 'moderator_only' };
    case 'approval': return { queued: true, suggested: true };
    default: return queueRequested ? { reason: 'not_authorized' } : { queued: false, suggested: false };
  }
}

module.exports = { POSTING_MODES, postingMode, questionDisposition };
