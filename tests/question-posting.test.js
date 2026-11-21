const assert = require('node:assert/strict');
const { test } = require('node:test');
const { postingMode, questionDisposition } = require('../question-posting');

for (const [mode, room, participant] of [
  ['open', {}, { queued: false, suggested: false }],
  ['moderator_only', { moderator_only_questions: true }, { reason: 'moderator_only' }],
  ['approval', { question_approval_required: true }, { queued: true, suggested: true }],
]) {
  test(`${mode}: the room determines publication, including for a legacy participant`, () => {
    assert.equal(postingMode(room), mode);
    assert.deepEqual(questionDisposition(room, false, false), participant);
    for (const requested of [false, true]) {
      assert.deepEqual(questionDisposition(room, true, requested), { queued: requested, suggested: false });
      for (const moderator of [false, true]) {
        assert.deepEqual(questionDisposition({ ...room, locked: true }, moderator, requested), { reason: 'locked' });
      }
    }
    assert.deepEqual(questionDisposition(room, false, true), mode === 'open' ? { reason: 'not_authorized' } : participant);
  });
}
