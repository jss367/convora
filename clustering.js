// Participant opinion clustering for Convora ("opinion groups" view).
//
// This module is deliberately self-contained and dependency-free: it consumes
// the plain question objects that getQuestions() already returns and produces a
// JSON-serializable analysis. It performs no database access and is wired into
// the server through a single read-only endpoint, so the experimental clusters
// view can be added or removed without touching the voting flow.
//
// Approach (a lightweight take on the Pol.is model):
//   1. Build a participant x statement matrix from Agreement votes.
//   2. Cluster participants with k-means (k chosen by silhouette score).
//   3. For each group, surface the statements that most define it, plus
//      "bridging" statements every group agrees on and the most divisive ones.

const AGREEMENT_SCORES = {
  'Strongly Disagree': -2,
  Disagree: -1,
  Unsure: 0,
  Agree: 1,
  'Strongly Agree': 2,
};

// Below these thresholds clustering is noise rather than signal.
const MIN_PARTICIPANTS = 4;
const MIN_STATEMENTS = 2;
const MAX_CLUSTERS = 5;

// Deterministic PRNG (mulberry32). The same votes must always yield the same
// groups, since people reload this view and compare it over time.
function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distSq(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

// Build the participant x statement matrix from Agreement questions only.
//   matrix[i][j] = participant i's score on statement j (0 when they didn't vote)
//   voted[i][j]  = whether participant i actually cast a vote on statement j
function buildVoteMatrix(questions) {
  const statements = questions
    .filter(q => q.type === 'Agreement')
    .map(q => ({ id: q.id, text: q.text }));

  // userId -> Map(statementId -> score). votes arrive ordered by id, so a later
  // entry overwrites an earlier one and the latest vote wins.
  const byUser = new Map();
  questions
    .filter(q => q.type === 'Agreement')
    .forEach(q => {
      (q.votes || []).forEach(v => {
        if (!v.userId || !(v.value in AGREEMENT_SCORES)) {
          return;
        }
        if (!byUser.has(v.userId)) {
          byUser.set(v.userId, new Map());
        }
        byUser.get(v.userId).set(q.id, AGREEMENT_SCORES[v.value]);
      });
    });

  const participants = [...byUser.keys()];
  const matrix = [];
  const voted = [];
  participants.forEach(uid => {
    const scores = byUser.get(uid);
    matrix.push(statements.map(s => (scores.has(s.id) ? scores.get(s.id) : 0)));
    voted.push(statements.map(s => (scores.has(s.id) ? 1 : 0)));
  });

  return { statements, participants, matrix, voted };
}

function kmeans(matrix, k, rng) {
  const n = matrix.length;
  const dim = matrix[0].length;

  // k-means++ seeding for stable, well-spread initial centroids.
  const centroids = [matrix[Math.floor(rng() * n)].slice()];
  while (centroids.length < k) {
    const dists = matrix.map(p => Math.min(...centroids.map(c => distSq(p, c))));
    const total = dists.reduce((s, d) => s + d, 0);
    let idx;
    if (total === 0) {
      idx = Math.floor(rng() * n);
    } else {
      let r = rng() * total;
      idx = 0;
      while (idx < n - 1 && r > dists[idx]) {
        r -= dists[idx];
        idx += 1;
      }
    }
    centroids.push(matrix[idx].slice());
  }

  const assignments = new Array(n).fill(-1);
  for (let iter = 0; iter < 100; iter += 1) {
    let changed = false;
    for (let i = 0; i < n; i += 1) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c += 1) {
        const d = distSq(matrix[i], centroids[c]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }

    const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
    const counts = new Array(k).fill(0);
    for (let i = 0; i < n; i += 1) {
      counts[assignments[i]] += 1;
      const row = matrix[i];
      const target = sums[assignments[i]];
      for (let d = 0; d < dim; d += 1) {
        target[d] += row[d];
      }
    }
    for (let c = 0; c < k; c += 1) {
      if (counts[c] === 0) {
        // Reseed an emptied cluster so k stays meaningful.
        centroids[c] = matrix[Math.floor(rng() * n)].slice();
      } else {
        for (let d = 0; d < dim; d += 1) {
          centroids[c][d] = sums[c][d] / counts[c];
        }
      }
    }

    if (!changed) {
      break;
    }
  }

  return { assignments };
}

// Mean silhouette score in [-1, 1]; higher means tighter, better-separated
// clusters. Used to pick k. O(n^2) but group discussions are small.
function silhouette(matrix, assignments, k) {
  const n = matrix.length;
  const groups = Array.from({ length: k }, () => []);
  assignments.forEach((a, i) => groups[a].push(i));

  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const own = groups[assignments[i]];
    if (own.length <= 1) {
      continue; // singleton contributes 0
    }
    let a = 0;
    for (const j of own) {
      if (j !== i) {
        a += Math.sqrt(distSq(matrix[i], matrix[j]));
      }
    }
    a /= own.length - 1;

    let b = Infinity;
    for (let c = 0; c < k; c += 1) {
      if (c === assignments[i] || groups[c].length === 0) {
        continue;
      }
      let d = 0;
      for (const j of groups[c]) {
        d += Math.sqrt(distSq(matrix[i], matrix[j]));
      }
      d /= groups[c].length;
      if (d < b) {
        b = d;
      }
    }
    if (b !== Infinity) {
      total += (b - a) / Math.max(a, b);
    }
  }
  return total / n;
}

// Per-statement breakdown for a set of participant indices, counting only
// people who actually voted on that statement.
function statementStats(memberIdxs, j, matrix, voted) {
  let sum = 0;
  let voters = 0;
  let agree = 0;
  let disagree = 0;
  let unsure = 0;
  for (const i of memberIdxs) {
    if (!voted[i][j]) {
      continue;
    }
    voters += 1;
    const s = matrix[i][j];
    sum += s;
    if (s > 0) {
      agree += 1;
    } else if (s < 0) {
      disagree += 1;
    } else {
      unsure += 1;
    }
  }
  return {
    mean: voters ? sum / voters : 0,
    voters,
    agree,
    disagree,
    unsure,
    noVote: memberIdxs.length - voters,
  };
}

function buildClusterReport(statements, participants, matrix, voted, assignments, k, score) {
  const allIdx = participants.map((_, i) => i);
  const members = Array.from({ length: k }, () => []);
  assignments.forEach((a, i) => members[a].push(i));

  // Each group: the statements where it diverges most from everyone else.
  const clusters = members.map((memberIdxs, c) => {
    const rest = allIdx.filter(i => assignments[i] !== c);
    const perStatement = statements.map((s, j) => {
      const inStats = statementStats(memberIdxs, j, matrix, voted);
      const restStats = statementStats(rest, j, matrix, voted);
      return {
        id: s.id,
        text: s.text,
        mean: inStats.mean,
        agree: inStats.agree,
        disagree: inStats.disagree,
        unsure: inStats.unsure,
        noVote: inStats.noVote,
        voters: inStats.voters,
        divergence: Math.abs(inStats.mean - restStats.mean),
      };
    });
    const definingStatements = perStatement
      .filter(st => st.voters > 0)
      .sort((a, b) => b.divergence - a.divergence)
      .slice(0, 5);
    return {
      id: c,
      label: `Group ${String.fromCharCode(65 + c)}`,
      size: memberIdxs.length,
      definingStatements,
    };
  });

  // Statement-level view across groups, for bridging vs. divisive lists.
  const perStatement = statements.map((s, j) => {
    const clusterMeans = members.map(memberIdxs => statementStats(memberIdxs, j, matrix, voted).mean);
    const overall = statementStats(allIdx, j, matrix, voted);
    const opinions = clusterMeans.filter(m => Math.abs(m) > 0.1);
    const signs = new Set(opinions.map(m => Math.sign(m)));
    return {
      id: s.id,
      text: s.text,
      clusterMeans,
      overallMean: overall.mean,
      voters: overall.voters,
      agree: overall.agree,
      disagree: overall.disagree,
      // Every group that has an opinion leans the same way.
      allGroupsAgree: opinions.length > 0 && signs.size === 1,
      minMagnitude: Math.min(...clusterMeans.map(m => Math.abs(m))),
      spread: Math.max(...clusterMeans) - Math.min(...clusterMeans),
      direction: overall.mean > 0 ? 'agree' : overall.mean < 0 ? 'disagree' : 'split',
    };
  });

  const bridging = perStatement
    .filter(st => st.allGroupsAgree && st.voters >= 2 && Math.abs(st.overallMean) >= 0.5)
    .sort((a, b) => b.minMagnitude - a.minMagnitude || a.spread - b.spread)
    .slice(0, 5);

  const divisive = perStatement
    .filter(st => st.voters >= 2)
    .sort((a, b) => b.spread - a.spread)
    .slice(0, 5);

  return {
    eligible: true,
    k,
    silhouette: score,
    participantCount: participants.length,
    statementCount: statements.length,
    clusters,
    bridging,
    divisive,
  };
}

// Main entry point. Returns either {eligible: false, reason} when there isn't
// enough data, or the full cluster analysis.
function analyzeClusters(questions) {
  const { statements, participants, matrix, voted } = buildVoteMatrix(questions);

  if (participants.length < MIN_PARTICIPANTS || statements.length < MIN_STATEMENTS) {
    return {
      eligible: false,
      reason: `Opinion groups need at least ${MIN_PARTICIPANTS} participants and ${MIN_STATEMENTS} agreement statements with votes. So far there are ${participants.length} participant(s) and ${statements.length} agreement statement(s).`,
      participantCount: participants.length,
      statementCount: statements.length,
    };
  }

  const rng = makeRng(0x9e3779b9);
  const maxK = Math.min(MAX_CLUSTERS, participants.length - 1);
  let best = null;
  for (let k = 2; k <= maxK; k += 1) {
    const { assignments } = kmeans(matrix, k, rng);
    if (new Set(assignments).size < k) {
      continue; // collapsed into fewer real groups; skip
    }
    const score = silhouette(matrix, assignments, k);
    if (!best || score > best.score) {
      best = { k, assignments, score };
    }
  }

  if (!best) {
    const { assignments } = kmeans(matrix, 2, rng);
    best = { k: 2, assignments, score: silhouette(matrix, assignments, 2) };
  }

  return buildClusterReport(statements, participants, matrix, voted, best.assignments, best.k, best.score);
}

module.exports = { analyzeClusters, buildVoteMatrix, AGREEMENT_SCORES };
