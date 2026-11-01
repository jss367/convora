const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assertSafeTestDatabase } = require('../scripts/test-database');

test('the database guard checks effective connection settings without connecting', () => {
  const originalOverride = process.env.ALLOW_NON_TEST_DATABASE;
  const originalHost = process.env.PGHOST;
  const originalDatabase = process.env.PGDATABASE;
  delete process.env.ALLOW_NON_TEST_DATABASE;
  try {
    for (const url of [
      'postgresql://user:password@localhost/convora_test',
      'postgresql://user:password@127.0.0.1:54330/convora_test',
      'postgresql://user:password@[::1]/convora_test',
      'postgresql://user:password@remote.invalid/convora_test?host=127.0.0.1',
    ]) {
      assert.doesNotThrow(() => assertSafeTestDatabase(url));
    }
    for (const url of [
      'postgresql://user:password@remote.invalid/convora_test',
      'postgresql://user:password@localhost/production',
      'postgresql://user:password@localhost/convora_test?host=remote.invalid',
      'postgresql://user:password@localhost/convora_test?host=remote.invalid&database=production',
      'postgresql://user:password@localhost/convora_test?host=%72emote.invalid',
      'postgresql://user:password@localhost/convora_test?host=127.0.0.1&host=remote.invalid',
    ]) {
      assert.throws(() => assertSafeTestDatabase(url), /Refusing to run destructive tests/);
    }

    // An omitted host/database can inherit a remote or non-test PG* default.
    process.env.PGHOST = 'remote.invalid';
    process.env.PGDATABASE = 'production';
    assert.throws(() => assertSafeTestDatabase('postgresql:///convora_test'), /Refusing/);
    assert.throws(() => assertSafeTestDatabase('postgresql://localhost/'), /Refusing/);
  } finally {
    for (const [key, value] of Object.entries({
      ALLOW_NON_TEST_DATABASE: originalOverride, PGHOST: originalHost, PGDATABASE: originalDatabase,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
