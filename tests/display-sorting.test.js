const test = require('node:test');
const assert = require('node:assert/strict');

test('display sorting supports chronological, interest and opinion orders with optional pin priority', async () => {
  const { sortDisplayQuestions: sort } = await import('../client/src/display/sortDisplayQuestions.mjs');
  const questions = [
    { id: 1, type: 'Agreement', interestCount: 2, votes: [{ value: 'Agree' }, { value: 'Disagree' }] },
    { id: 2, type: 'Yes/No', interestCount: 1, votes: [{ value: 'Yes' }, { value: 'Yes' }] },
    { id: 3, type: 'Agreement', interestCount: 3, votes: [{ value: 'No' }, { value: 'Disagree' }] },
    { id: 4, type: 'Open Ended', pinned: true, votes: [{ value: 'Yes' }, { value: 'Yes' }, { value: 'Yes' }] },
  ];
  const ids = (mode, pins = false) => sort(questions, mode, pins).map(q => q.id);
  assert.deepEqual(ids('oldest'), [1, 2, 3, 4]);
  assert.deepEqual(ids('newest'), [4, 3, 2, 1]);
  assert.deepEqual(ids('interesting'), [3, 1, 2, 4]);
  assert.deepEqual(ids('agreement'), [2, 1, 4, 3]);
  assert.deepEqual(ids('disagreement'), [3, 1, 4, 2]);
  assert.deepEqual(ids('controversial'), [1, 4, 3, 2]);
  assert.deepEqual(ids('interesting', true), [4, 3, 1, 2]);
  assert.deepEqual(sort(questions).map(q => q.id), [4, 1, 2, 3]);
  assert.deepEqual(questions.map(q => q.id), [1, 2, 3, 4]);
  questions[1].resultsHidden = true;
  assert.deepEqual(ids('agreement'), [1, 4, 3, 2]);
});
