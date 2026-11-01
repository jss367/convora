// Browser and integration tests must never modify a development/production DB.
const { Client } = require('pg');

function assertSafeTestDatabase(connectionString) {
  if (process.env.ALLOW_NON_TEST_DATABASE === '1') return;
  // Constructing a client only parses its configuration; it does not connect.
  // Use the driver's effective target, including URL overrides and PG* defaults.
  const { host, database } = new Client({ connectionString }).connectionParameters;
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!localHosts.has(host) || typeof database !== 'string' || !database.endsWith('_test')) {
    throw new Error(
      `Refusing to run destructive tests against ${host}/${database}. ` +
      'Use a localhost database whose name ends with "_test", or set ALLOW_NON_TEST_DATABASE=1 for a disposable database.'
    );
  }
}

module.exports = { assertSafeTestDatabase };
