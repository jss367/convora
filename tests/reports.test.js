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

test('empty discussions produce a usable report without invalid statistics', async () => {
  const summary = buildSummary(discussion, []);
  assert.deepEqual(summary.counts, { questions: 0, responses: 0, participants: 0, byType: {}, hiddenResults: 0 });
  assert.deepEqual(summary.topConsensus, []);
  assert.deepEqual(summary.topDivisive, []);
  const html = await renderReportHtml(summary);
  assert.match(html, /Planning Report/);
  assert.match(html, /No major unresolved tensions detected/);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('printable reports escape discussion titles and question content', async () => {
  const summary = buildSummary({ ...discussion, topic: '<script>alert("title")</script>' }, [
    { id: 1, text: '<img src=x onerror="alert(1)"> & details', type: 'Yes/No', votes: [] },
  ]);
  const html = await renderReportHtml(summary);
  assert.doesNotMatch(html, /<script>|<img /);
  assert.match(html, /&lt;script&gt;alert\(&quot;title&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; details/);
});

test('reports emphasize prompt phrases without interpreting HTML, answer options, or arithmetic', async () => {
  const text = 'Would it *try* or **<wait & see>**? What is 2 * 3?';
  const summary = buildSummary(discussion, [
    { id: 1, text, type: 'Multiple Choice', options: ['*Yes*', '**No**'], votes: [] },
  ]);
  const html = await renderReportHtml(summary);
  assert.equal(summary.questions[0].text, text);
  assert.match(html, /Would it <em>try<\/em> or <strong>&lt;wait &amp; see&gt;<\/strong>\? What is 2 \* 3\?/);
  assert.match(html, /\*\*No\*\*/);
  assert.match(html, /\*Yes\*/);
  assert.doesNotMatch(html, /<em>Yes<\/em>/);
});

test('questions with hidden results are listed but contribute to no count, ranking, or signal', async () => {
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
  const html = await renderReportHtml(summary);
  assert.match(html, /Results for 2 questions are hidden until you vote/);
  assert.equal(html.match(/Hidden until you vote/g).length, 2);
  assert.doesNotMatch(html, /NaN|Infinity|undefined/);
});

test('Multiple Choice summaries count each option in order and stay out of the opinion rankings', async () => {
  const question = {
    id: 1, text: 'p(doom) over the last year?', type: 'Multiple Choice',
    options: ['Higher', 'Lower', 'About the same'],
    votes: [vote(1, 'a', 'Higher'), vote(2, 'b', 'Lower'), vote(3, 'c', 'Lower'), vote(4, 'd', 'Not an option')],
  };
  const summary = buildSummary(discussion, [question]);
  const [summarized] = summary.questions;
  assert.deepEqual(summarized.options, ['Higher', 'Lower', 'About the same']);
  assert.deepEqual(summarized.optionCounts, { Higher: 1, Lower: 2, 'About the same': 0 });
  assert.deepEqual(summarized.leadingOptions, ['Lower']);
  assert.deepEqual(summary.topDivisive, []);
  assert.deepEqual(summary.facilitatorDashboard.mostDivisiveStatements, []);
  assert.match(await renderReportHtml(summary), /Higher: 1 \/ Lower: 2 \/ About the same: 0/);

  const tied = buildSummary(discussion, [{ ...question, votes: [vote(1, 'a', 'Higher'), vote(2, 'b', 'Lower')] }]);
  assert.deepEqual(tied.questions[0].leadingOptions, ['Higher', 'Lower']);
  assert.deepEqual(buildSummary(discussion, [{ ...question, votes: [] }]).questions[0].leadingOptions, []);
});

test('printable reports escape Multiple Choice option text', async () => {
  const summary = buildSummary(discussion, [{
    id: 1, text: 'Pick one', type: 'Multiple Choice',
    options: ['<img src=x onerror=alert(1)>', 'Plain'],
    votes: [vote(1, 'a', 'Plain')],
  }]);
  const html = await renderReportHtml(summary);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;: 0 \/ Plain: 1/);
});

test('a hidden Multiple Choice summary keeps its options but no counts', async () => {
  const summary = buildSummary(discussion, [{
    id: 1, text: 'p(doom)?', type: 'Multiple Choice', options: ['Higher', 'Lower'],
    votes: [], resultsHidden: true, created_at: '2026-01-01T00:00:00Z',
  }]);
  assert.deepEqual(summary.questions, [{
    id: 1, text: 'p(doom)?', type: 'Multiple Choice', createdAt: '2026-01-01T00:00:00Z',
    options: ['Higher', 'Lower'], resultsHidden: true,
  }]);
  const html = await renderReportHtml(summary);
  assert.match(html, /Options: Higher \/ Lower\. Results hidden until you vote/);
  assert.doesNotMatch(html, /Higher: \d/);
});
