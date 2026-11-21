const { Worker } = require('node:worker_threads');

class ClusterBusyError extends Error {}

function projectQuestions(questions) {
  const statements = [];
  const participantIds = new Map();
  let hiddenStatementCount = 0;
  for (const { type, id, text, votes, resultsHidden } of questions) {
    if (type !== 'Agreement') continue;
    if (resultsHidden) {
      hiddenStatementCount++;
      continue;
    }
    if (!votes?.length) continue;
    const projectedVotes = [];
    for (const { userId, value } of votes) {
      if (!userId) continue;
      if (!participantIds.has(userId)) participantIds.set(userId, participantIds.size + 1);
      projectedVotes.push({ userId: participantIds.get(userId), value });
    }
    statements.push({ type, id, text, votes: projectedVotes });
  }
  return { statements, hiddenStatementCount };
}

function runWorker(worker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let result;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error('Cluster worker timed out');
      worker.terminate().catch(reject);
    }, timeoutMs);
    worker.once('message', message => { result = message; });
    worker.once('messageerror', err => { failure = err; });
    worker.once('error', err => { failure = err; });
    worker.once('exit', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error(`Cluster worker exited without success (code ${code})`));
      else resolve(result);
    });
  });
}

function createClusterService({
  maxQueued = 2,
  timeoutMs = 30000,
  createWorker = statements => new Worker(require.resolve('./cluster-worker'), { workerData: statements }),
} = {}) {
  let active = false;
  const queue = [];

  return function analyzeViewerClusters(loadQuestions) {
    if (active && queue.length >= maxQueued) return Promise.reject(new ClusterBusyError('Cluster analysis is busy. Try again.'));
    return new Promise((resolve, reject) => {
      async function start() {
        active = true;
        try {
          const { statements, hiddenStatementCount } = projectQuestions(await loadQuestions());
          const analysis = await runWorker(createWorker(statements), timeoutMs);
          resolve({ ...analysis, hiddenStatementCount });
        } catch (err) {
          reject(err);
        } finally {
          const next = queue.shift();
          if (next) next();
          else active = false;
        }
      }
      if (active) queue.push(start);
      else start();
    });
  };
}

module.exports = { analyzeViewerClusters: createClusterService(), createClusterService, ClusterBusyError };
