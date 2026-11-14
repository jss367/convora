const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { observeQuestionPayloads } = require('./helpers/question-payloads.cjs');

function response(page, body, { url = 'http://localhost/socket.io/?EIO=4&transport=polling', method = 'GET' } = {}) {
  page.emit('response', {
    url: () => url,
    request: () => ({ method: () => method }),
    text: async () => { if (body instanceof Error) throw body; return body; },
  });
}

const snapshot = '42["questions",[{"id":1,"votes":[]}]]';

test('captures initial polling snapshots, batched packets and later WebSocket updates', async () => {
  const page = new EventEmitter();
  const observed = observeQuestionPayloads(page);
  response(page, `0{"sid":"session"}\x1e${snapshot}\x1e2`);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed.payloads, [snapshot]);
  const socket = new EventEmitter();
  page.emit('websocket', socket);
  socket.emit('framereceived', { payload: '3probe' });
  socket.emit('framereceived', { payload: Buffer.from(snapshot) });
  const update = '42["questions",[{"id":2,"votes":[]}]]';
  socket.emit('framereceived', { payload: update });
  assert.deepEqual(observed.payloads, [snapshot, update]);
  assert.deepEqual(observed.errors, []);
});

test('ignores unrelated HTTP responses and outgoing polling acknowledgments', async () => {
  const page = new EventEmitter();
  const observed = observeQuestionPayloads(page);
  response(page, snapshot, { url: 'http://localhost/api/discussions' });
  response(page, snapshot, { url: 'http://localhost/socket.io/?transport=websocket' });
  response(page, snapshot, { method: 'POST' });
  response(page, '40{"sid":"session"}\x1e42["topic","room"]');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed.payloads, []);
  assert.deepEqual(observed.errors, []);
});

test('retains response read failures so privacy checks cannot silently lose traffic', async () => {
  const page = new EventEmitter();
  const observed = observeQuestionPayloads(page);
  response(page, Error('body unavailable'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed.errors, ['body unavailable']);
  assert.deepEqual(observed.payloads, []);
});
