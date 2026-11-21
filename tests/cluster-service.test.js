const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Worker } = require('node:worker_threads');
const { ClusterBusyError, createClusterService } = require('../cluster-service');

const workerPath = require.resolve('../cluster-worker');
const realWorker = workerData => new Worker(workerPath, { workerData });

test('worker input excludes hidden and unrelated data and substitutes local participant IDs', async () => {
  const votes = [{ userId: 'token', value: 'Agree', explanation: 'private' }];
  const analyze = createClusterService({ createWorker(statements) {
    assert.deepEqual(statements, [1, 2].map(id => ({
      id, type: 'Agreement', text: `Statement ${id}`, votes: [{ userId: 1, value: 'Agree' }],
    })));
    return realWorker(statements);
  } });
  const result = await analyze(() => [
    { id: 1, type: 'Agreement', text: 'Statement 1', votes, author: 'private' },
    { id: 3, type: 'Agreement', text: 'Hidden', votes, resultsHidden: true },
    { id: 4, type: 'Text', votes, resultsHidden: true },
    { id: 2, type: 'Agreement', text: 'Statement 2', votes },
  ]);
  assert.equal(result.hiddenStatementCount, 1);
  assert.equal(result.participantCount, 1);
});

test('one running worker, two FIFO waiters, excess rejected without loading questions', async () => {
  const loads = [];
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let first = true;
  const analyze = createClusterService({ createWorker(statements) {
    if (!first) return realWorker(statements);
    first = false;
    const worker = new Worker(`require('node:worker_threads').parentPort.once('message', () => require(${JSON.stringify(workerPath)}))`,
      { eval: true, workerData: statements });
    signalStarted(worker);
    return worker;
  } });
  const submit = id => analyze(() => { loads.push(id); return []; });
  const running = submit(1);
  const worker = await started;
  const second = submit(2);
  const third = submit(3);
  await assert.rejects(submit(4), ClusterBusyError);
  assert.deepEqual(loads, [1]);
  worker.postMessage('finish');
  for (const result of await Promise.all([running, second, third])) assert.equal(result.eligible, false);
  await submit(5);
  assert.deepEqual(loads, [1, 2, 3, 5]);
});

for (const [name, fail, expected] of [
  ['startup failure', () => { throw new Error('cannot start'); }, /cannot start/],
  ['worker exception', () => new Worker('throw new Error("analysis failed")', { eval: true }), /analysis failed/],
  ['exit without result', () => new Worker('', { eval: true }), /exited without success/],
]) {
  test(`${name} rejects its request and the queued request succeeds`, async () => {
    let first = true;
    const analyze = createClusterService({ createWorker(statements) {
      if (!first) return realWorker(statements);
      first = false;
      return fail();
    } });
    const failed = analyze(() => []);
    const queued = analyze(() => []);
    await assert.rejects(failed, expected);
    assert.equal((await queued).eligible, false);
  });
}

test('timeout reaps a stalled worker before starting queued work', async () => {
  let worker;
  const analyze = createClusterService({ timeoutMs: 50, createWorker() {
    worker = new Worker('setInterval(() => {}, 1000)', { eval: true });
    return worker;
  } });
  const failed = analyze(() => []);
  const queued = analyze(() => {
    assert.equal(worker.threadId, -1);
    throw new Error('question load failed');
  });
  await Promise.all([assert.rejects(failed, /timed out/), assert.rejects(queued, /question load failed/)]);
});
