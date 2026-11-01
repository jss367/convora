// Browser and integration tests must never modify a development/production DB.
function assertSafeTestDatabase(connectionString) {
  if (process.env.ALLOW_NON_TEST_DATABASE === '1') return;
  const url = new URL(connectionString);
  const databaseName = url.pathname.replace(/^\//, '');
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!localHosts.has(url.hostname) || !databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run destructive tests against ${url.hostname}/${databaseName}. ` +
      'Use a localhost database whose name ends with "_test", or set ALLOW_NON_TEST_DATABASE=1 for a disposable database.'
    );
  }
}

module.exports = { assertSafeTestDatabase };
