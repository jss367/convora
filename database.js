const migrations = require('./migrations');
const { logError } = require('./logging');

async function initializeDatabase(pool) {
  const client = await pool.connect();
  let releaseError;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('convora:schema_migrations'))");
    const ledger = await client.query("SELECT to_regclass('schema_migrations') AS relation");
    if (!ledger.rows[0].relation) {
      await client.query('CREATE TABLE schema_migrations (version integer PRIMARY KEY)');
    }
    const { rows: applied } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    if (!applied.every(({ version }, index) => migrations[index]?.[0] === version)) {
      throw new Error('Database migration history does not match this server version');
    }
    for (const [version, migrate] of migrations.slice(applied.length)) {
      try {
        await migrate(client);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      } catch (error) {
        logError(`Database migration ${version} (${migrate.name}) failed:`, error);
        throw error;
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      releaseError = rollbackError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

module.exports = { initializeDatabase };
