const crypto = require('crypto');
const { slugifyTopic, slugFromTitle, formatTopicTitle, titleFromSlug, suffixSlug } = require('./discussion-names');

// All creation and deletion paths serialize on the same slug, including the
// absent-row case that row locks cannot protect. Tombstones survive restarts.
async function lockDiscussionSlug(db, slug) {
  // Ordinary writers remain concurrent. Deletion takes this lock exclusively
  // first, before acquiring its canonical/title slug locks and discussion row.
  await db.query("SELECT pg_advisory_xact_lock_shared(hashtext('discussion_routes'))");
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`discussion_lifecycle:${slug}`]);
  const deleted = await db.query('SELECT 1 FROM deleted_discussion_slugs WHERE slug = $1', [slug]);
  return deleted.rows.length > 0;
}

async function getOrCreateDiscussionForSlug(db, slug) {
  const canonicalSlug = slugifyTopic(slug);
  if (await lockDiscussionSlug(db, canonicalSlug)) throw new Error('Discussion has been deleted');
  const result = await db.query(
    `INSERT INTO discussions (topic, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id, topic, slug`,
    [titleFromSlug(canonicalSlug), canonicalSlug]
  );
  return result.rows[0];
}

function createDiscussions(pool) {
  async function getDiscussionBySlug(slug) {
    const canonicalSlug = slugifyTopic(slug);
    const result = await pool.query(
      'SELECT id, topic, slug, short_code, created_at FROM discussions WHERE slug = $1 ORDER BY id DESC LIMIT 1',
      [canonicalSlug]
    );
    return result.rows[0] || null;
  }

  async function resolveDiscussionRoute(routeTopic) {
    const displayTopic = formatTopicTitle(routeTopic);
    const slug = slugifyTopic(routeTopic);
    // A live canonical route wins over a deleted room's colliding title alias.
    if (displayTopic === slug) {
      const canonical = await pool.query('SELECT id, topic, slug, created_at FROM discussions WHERE slug = $1', [slug]);
      if (canonical.rows.length) return canonical.rows[0];
      const deletedCanonical = await pool.query('SELECT 1 FROM deleted_discussion_slugs WHERE slug = $1', [slug]);
      if (deletedCanonical.rows.length) return null;
    }
    const alias = await pool.query('SELECT 1 FROM deleted_discussion_aliases WHERE topic = $1', [displayTopic]);
    if (alias.rows.length) return { deleted: true };
    // A reused title gets a new route; old deleted links must not redirect to it.
    const deleted = await pool.query('SELECT 1 FROM deleted_discussion_slugs WHERE slug = $1', [slug]);
    if (deleted.rows.length) return null;
    const result = await pool.query(
      `SELECT id, topic, slug, created_at
         FROM discussions
        WHERE topic = $1 OR slug = $2
        ORDER BY CASE WHEN topic = $1 THEN 0 ELSE 1 END, id
        LIMIT 1`,
      [displayTopic, slug]
    );
    return result.rows[0] || null;
  }

  // Create a discussion (or look up the existing one) and, when it has no
  // moderator yet, make the creator its moderator by minting a fresh admin token.
  // Returns the discussion id plus an adminToken that is non-null ONLY when this
  // caller became the moderator. If a moderator already exists, adminToken is null
  // and the existing token is never disclosed — so re-creating an already-moderated
  // topic can't hand its controls to whoever re-submits it.
  // Shares claimModerator()'s advisory-lock + COALESCE upsert so the create-time
  // claim is race-safe against concurrent creates and lazy (question-post) creation.
  // `listed` applies only when this caller becomes the moderator. Creating a
  // discussion whose title already exists joins it, and joining must not change
  // how a discussion someone else moderates is listed.
  async function createDiscussion(topic, { listed = false, subject = null } = {}) {
    const displayTopic = formatTopicTitle(topic);
    const baseSlug = slugFromTitle(displayTopic);
    const token = crypto.randomBytes(16).toString('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [displayTopic]);

      const existing = await client.query(
        'SELECT id, topic, slug, admin_token FROM discussions WHERE topic = $1 LIMIT 1',
        [displayTopic]
      );
      if (existing.rows.length > 0 && !await lockDiscussionSlug(client, existing.rows[0].slug)) {
        const updated = await client.query(
          `UPDATE discussions
              SET creator_google_sub = CASE WHEN admin_token IS NULL THEN $4 ELSE creator_google_sub END,
                  listed = CASE WHEN admin_token IS NULL THEN $3 ELSE listed END,
                  admin_token = COALESCE(admin_token, $2)
            WHERE id = $1
            RETURNING id, topic, slug, admin_token`,
          [existing.rows[0].id, token, listed, subject]
        );
        await client.query('COMMIT');
        const row = updated.rows[0];
        return {
          id: row.id,
          topic: row.topic,
          slug: row.slug,
          adminToken: row.admin_token === token ? token : null,
        };
      }

      let row = null;
      for (let suffix = 1; suffix <= 1000; suffix += 1) {
        const slug = suffixSlug(baseSlug, suffix);
        if (await lockDiscussionSlug(client, slug)) continue;
        const result = await client.query(
          `INSERT INTO discussions (topic, slug, admin_token, listed, creator_google_sub)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id, topic, slug, admin_token`,
          [displayTopic, slug, token, listed, subject]
        );

        if (result.rows.length > 0) {
          row = result.rows[0];
          break;
        }
      }

      if (!row) {
        throw new Error(`Could not create a unique slug for discussion topic: ${displayTopic}`);
      }

      await client.query('COMMIT');
      // The stored token equals ours exactly when we just minted it (fresh row, or
      // an existing row that had no moderator); otherwise a moderator already held it.
      return {
        id: row.id,
        topic: row.topic,
        slug: row.slug,
        adminToken: row.admin_token === token ? token : null,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // Whether voting is currently closed for a discussion.
  async function isDiscussionLocked(topic) {
    const slug = slugifyTopic(topic);
    const result = await pool.query('SELECT locked FROM discussions WHERE slug = $1', [slug]);
    return result.rows.length > 0 ? result.rows[0].locked === true : false;
  }

  return { getDiscussionBySlug, resolveDiscussionRoute, createDiscussion, isDiscussionLocked };
}

module.exports = { lockDiscussionSlug, getOrCreateDiscussionForSlug, createDiscussions };
