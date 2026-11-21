const { parentPort, workerData } = require('node:worker_threads');
const { analyzeClusters } = require('./clustering');

parentPort.postMessage(analyzeClusters(workerData));
