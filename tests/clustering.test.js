const assert = require('node:assert/strict');
const { test } = require('node:test');
const { analyzeClusters } = require('../clustering');

const vote = (userId, value) => ({ userId, value });

// Two clear camps of three. On the first statement the "against" camp votes
// Disagree, Disagree, Strongly Disagree: the case where the label used to read
// "Strongly disagrees" above a tally of "Disagree: 3".
function townHall() {
  return [
    {
      id: 1,
      text: 'Adopt the four-day week',
      type: 'Agreement',
      votes: [
        vote('a1', 'Strongly Agree'), vote('a2', 'Strongly Agree'), vote('a3', 'Agree'),
        vote('b1', 'Disagree'), vote('b2', 'Disagree'), vote('b3', 'Strongly Disagree'),
      ],
    },
    {
      id: 2,
      text: 'Test scores will drop',
      type: 'Agreement',
      votes: [
        vote('a1', 'Strongly Disagree'), vote('a2', 'Disagree'), vote('a3', 'Unsure'),
        vote('b1', 'Strongly Agree'), vote('b2', 'Strongly Agree'), vote('b3', 'Strongly Agree'),
      ],
    },
  ];
}

function againstGroupOnFirstStatement(analysis) {
  return analysis.clusters
    .map(c => c.definingStatements.find(st => st.id === 1))
    .find(st => st && st.mean < 0);
}

test('cluster statements report the strong votes separately from the totals', () => {
  const analysis = analyzeClusters(townHall());
  assert.equal(analysis.eligible, true);
  assert.equal(analysis.k, 2);

  const against = againstGroupOnFirstStatement(analysis);
  assert.equal(against.voters, 3);
  assert.equal(against.disagree, 3);
  assert.equal(against.stronglyDisagree, 1);
  assert.equal(against.stronglyAgree, 0);
  assert.equal(against.agree, 0);

  for (const cluster of analysis.clusters) {
    for (const st of cluster.definingStatements) {
      assert.ok(st.stronglyAgree <= st.agree);
      assert.ok(st.stronglyDisagree <= st.disagree);
      assert.equal(st.agree + st.unsure + st.disagree, st.voters);
    }
  }
});

test('the opinion group tally shows the five buckets behind the stance label', async () => {
  const { leaning, stanceBuckets } = await import('../client/src/stance.mjs');
  const against = againstGroupOnFirstStatement(analyzeClusters(townHall()));

  assert.equal(leaning(against.mean).label, 'Strongly disagrees');
  assert.deepEqual(
    stanceBuckets(against).map(b => [b.label, b.count]),
    [['Strongly disagree', 1], ['Disagree', 2]]
  );

  // Buckets keep their order, add up to the voters, and leave out empty ones.
  const mixed = stanceBuckets({ agree: 3, unsure: 1, disagree: 2, stronglyAgree: 1, stronglyDisagree: 2 });
  assert.deepEqual(
    mixed.map(b => [b.key, b.count]),
    [['stronglyDisagree', 2], ['unsure', 1], ['agree', 2], ['stronglyAgree', 1]]
  );

  // A payload without the strong counts falls back to the three merged buckets.
  assert.deepEqual(
    stanceBuckets({ agree: 0, unsure: 0, disagree: 3 }).map(b => [b.label, b.count]),
    [['Disagree', 3]]
  );
});
