const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSummary, renderReportHtml } = require('../reports');

const discussion = { id: 1, topic: 'Planning', slug: 'planning', created_at: '2026-01-01T00:00:00Z' };
const vote = (id, userId, value) => ({ id, userId, value, pseudonym: null });

test('discussion reports summarize all question types without exposing stable identities', () => {
  const questions = [
    { id: 1, text: 'Proceed?', type: 'Agreement', votes: [vote(1, 'secret-a', 'Agree'), vote(2, 'secret-b', 'Disagree')] },
    { id: 2, text: 'Ready?', type: 'Yes/No', votes: [vote(3, 'secret-a', 'Yes'), vote(4, 'secret-b', 'No')] },
    { id: 3, text: 'Likelihood', type: 'Numerical', min_value: 0, max_value: 100, votes: [vote(5, 'secret-a', '30'), vote(6, 'secret-b', '50')] },
    { id: 4, text: 'Why?', type: 'Open Ended', votes: [vote(7, 'secret-a', 'An explanation')] },
    { id: 5, text: 'Alternatives', type: 'Brainstorm', votes: [vote(8, 'secret-b', '["First", "Second"]')] },
  ];
  const summary = buildSummary(discussion, questions);
  assert.deepEqual(summary.counts, {
    questions: 5, responses: 8, participants: 2,
    byType: { Agreement: 1, 'Yes/No': 1, Numerical: 1, 'Open Ended': 1, Brainstorm: 1 },
    hiddenResults: 0,
  });
  const [agreement, binary, numerical, written, brainstorm] = summary.questions;
  assert.equal(agreement.label, 'Divisive');
  assert.equal(binary.label, 'Divisive');
  assert.deepEqual(binary.optionCounts, { No: 1, Yes: 1 });
  assert.equal(numerical.average, 40);
  assert.equal(numerical.standardDeviation, 10);
  assert.equal(written.responses[0].value, 'An explanation');
  assert.deepEqual(brainstorm.responses[0].value, ['First', 'Second']);
  assert.equal(summary.topDivisive.length, 2);
  assert.equal(summary.facilitatorDashboard.participantStats.length, 2);
  assert.doesNotMatch(JSON.stringify(summary), /secret-a|secret-b|userId/);
});

test('empty discussions produce a usable report without invalid statistics', () => {
  const summary = buildSummary(discussion, []);
  assert.deepEqual(summary.counts, { questions: 0, responses: 0, participants: 0, byType: {}, hiddenResults: 0 });
  assert.deepEqual(summary.topConsensus, []);
  assert.deepEqual(summary.topDivisive, []);
  const html = renderReportHtml(summary);
  assert.match(html, /Planning Report/);
  assert.match(html, /No major unresolved tensions detected/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('printable reports escape discussion titles and question content', () => {
  const summary = buildSummary({ ...discussion, topic: '<script>alert("title")</script>' }, [
    { id: 1, text: '<img src=x onerror="alert(1)"> & details', type: 'Yes/No', votes: [] },
  ]);
  const html = renderReportHtml(summary);
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; details/);
});

test('questions with hidden results are listed but contribute to no count, ranking, or signal', () => {
  const summary = buildSummary(discussion, [
    { id: 1, text: 'Proceed?', type: 'Agreement', votes: [vote(1, 'secret-a', 'Agree'), vote(2, 'secret-b', 'Disagree')] },
    { id: 2, text: 'Ready?', type: 'Yes/No', votes: [], resultsHidden: true },
    { id: 3, text: 'Likelihood', type: 'Numerical', min_value: 0, max_value: 100, votes: [], resultsHidden: true },
  ]);
  assert.deepEqual(summary.counts, {
    questions: 3, responses: 2, participants: 2,
    byType: { Agreement: 1, 'Yes/No': 1, Numerical: 1 },
    hiddenResults: 2,
  });
  assert.deepEqual(summary.questions.slice(1), [
    { id: 2, text: 'Ready?', type: 'Yes/No', createdAt: undefined, resultsHidden: true },
    { id: 3, text: 'Likelihood', type: 'Numerical', createdAt: undefined, resultsHidden: true },
  ]);
  // A hidden question must not be reported as a prompt nobody answered.
  assert.deepEqual(summary.facilitatorDashboard.unansweredPrompts, []);
  const html = renderReportHtml(summary);
  assert.match(html, /Results for 2 questions are hidden until you vote/);
  assert.equal(html.match(/Hidden until you vote/g).length, 2);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});
