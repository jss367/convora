// Socket handlers can still be finishing reads after their client disconnects.
// TRUNCATE takes ACCESS EXCLUSIVE locks, which can deadlock those multi-table
// reads when they acquire relations in a different order. DELETE's table locks
// are compatible with ordinary SELECTs. Delete children first for the two
// non-cascading foreign keys; dependent interaction/moderator rows cascade.
// Keep generated IDs increasing so an old request cannot reference a new row
// merely because cleanup reused its ID.
async function cleanupDiscussions(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM votes');
    await client.query('DELETE FROM questions');
    await client.query('DELETE FROM discussions');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { cleanupDiscussions };
