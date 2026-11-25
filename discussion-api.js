const crypto = require('crypto');
const { slugifyTopic, slugFromTitle, formatTopicTitle, suffixSlug } = require('./discussion-names');
const { lockDiscussionSlug } = require('./discussions');

// Discussions are unlisted unless their moderator lists them: they are reachable
// by link or short link only, so no endpoint enumerates them (the public list
// above holds only discussions a moderator chose to list). This lookup returns
// only the discussions whose exact slugs the caller already knows (the browser
// remembers the ones it created or opened) and nothing when no slugs are sent.
const MAX_KNOWN_SLUGS = 50;

// The discussions their moderators chose to list publicly, newest first. Only
// what the home page shows: title, slug and creation time.
const MAX_PUBLIC_DISCUSSIONS = 100;

function registerDiscussionApi(app, {
  pool, io, withTransaction, verifyAdmin, currentAccount, createDiscussion, resolveDiscussionRoute,
  generateDiscussionShortCode, audience, emitDiscussion, emitQuestions, logError, logInfo,
}) {
  app.post('/api/discussions', async (req, res) => {
    const { topic, listed } = req.body;
    try {
      // The creator becomes the moderator: createDiscussion mints an admin token
      // and returns it when (and only when) this caller is the one establishing
      // the discussion's moderator. The client persists it so the person who made
      // the session lands as its moderator instead of racing others for the role.
      const owner = await currentAccount(req);
      const discussion = await createDiscussion(topic, { listed: listed === true, subject: owner?.google_sub });
      res.json({ success: true, ...discussion, accountLinked: !!(owner && discussion.adminToken) });
    } catch (err) {
      logError('Request failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/discussions/resolve/:topic', async (req, res) => {
    try {
      const discussion = await resolveDiscussionRoute(req.params.topic);
      if (discussion?.deleted) {
        return res.status(410).json({ error: 'Discussion was deleted', deleted: true });
      }
      if (!discussion) {
        return res.status(404).json({ error: 'Discussion not found' });
      }
      res.json(discussion);
    } catch (err) {
      logError('Request failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.delete('/api/discussions/:topic/responses', async (req, res) => {
    const slug = slugifyTopic(req.params.topic);
    const token = req.body?.adminToken;
    const forbidden = () => res.status(403).json({ error: 'Only a moderator can clear votes and responses.' });
    if (typeof token !== 'string' || !token) return forbidden();
    try {
      const cleared = await withTransaction(async client => {
        const id = await verifyAdmin(slug, token, client);
        if (!id) return false;
        await client.query('SELECT id FROM discussions WHERE id = $1 FOR UPDATE', [id]);
        await client.query('SELECT id FROM questions WHERE discussion_id = $1 ORDER BY id FOR UPDATE', [id]);
        await client.query('DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [id]);
        await client.query('DELETE FROM question_interest WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [id]);
        await client.query('DELETE FROM question_tool_notes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [id]);
        await client.query('DELETE FROM speaking_queue WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [id]);
        await client.query('UPDATE questions SET results_revealed = false WHERE discussion_id = $1 AND independent_answers AND results_revealed', [id]);
        return true;
      });
      if (!cleared) return forbidden();
    } catch (error) {
      logError('Error clearing discussion responses:', error);
      return res.status(500).json({ error: 'Could not clear votes and responses.' });
    }
    io.to(slug).emit('speakingQueueChanged', slug);
    try {
      await emitQuestions(slug);
      res.sendStatus(204);
    } catch (error) {
      logError('Error broadcasting cleared responses:', error);
      res.json({ refreshed: false });
    }
  });

  // Only the creator credential can permanently delete a discussion. Lock the
  // parent and questions before removing children so concurrent inserts cannot
  // slip between the deletes. All other dependent tables cascade automatically.
  app.delete('/api/discussions/:topic', async (req, res) => {
    const token = req.body?.adminToken;
    if (typeof token !== 'string' || !token) {
      return res.status(403).json({ error: 'Only the creator can delete this discussion.' });
    }
    const slug = slugifyTopic(req.params.topic);
    let client;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      // Deletion reserves several related routes. Exclude lifecycle writers
      // before taking any slug/row lock so aliases cannot invert their order.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('discussion_routes'))");
      await lockDiscussionSlug(client, slug);
      const result = await client.query(
        'SELECT id, topic FROM discussions WHERE slug = $1 AND admin_token = $2 FOR UPDATE',
        [slug, token]
      );
      if (!result.rows.length) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the creator can delete this discussion.' });
      }
      const id = result.rows[0].id;
      const title = result.rows[0].topic;
      const alias = slugifyTopic(title);
      await lockDiscussionSlug(client, alias);
      const otherOwner = await client.query('SELECT id FROM discussions WHERE slug = $1 AND id <> $2', [alias, id]);
      if (!otherOwner.rows.length) {
        await client.query('INSERT INTO deleted_discussion_slugs (slug) VALUES ($1) ON CONFLICT DO NOTHING', [alias]);
      }
      await client.query('INSERT INTO deleted_discussion_aliases (topic) VALUES ($1) ON CONFLICT DO NOTHING', [title]);
      await client.query('SELECT id FROM questions WHERE discussion_id = $1 ORDER BY id FOR UPDATE', [id]);
      await client.query('DELETE FROM votes WHERE question_id IN (SELECT id FROM questions WHERE discussion_id = $1)', [id]);
      await client.query('DELETE FROM questions WHERE discussion_id = $1', [id]);
      await client.query('INSERT INTO deleted_discussion_slugs (slug) VALUES ($1) ON CONFLICT DO NOTHING', [slug]);
      await client.query('DELETE FROM discussions WHERE id = $1', [id]);
      await client.query('COMMIT');
      audience(slug).emit('discussionDeleted', { slug });
      emitDiscussion.broadcastValue(slug, null);
      audience(slug).emit('questions', []);
      res.json({ deleted: true });
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      logError('Error deleting discussion:', error);
      res.status(500).json({ error: 'Could not delete the discussion. Please try again.' });
    } finally {
      if (client) client.release();
    }
  });

  app.post('/api/discussions/:topic/short-link', async (req, res) => {
    try {
      const result = await generateDiscussionShortCode(req.params.topic, req.body?.adminToken, req.body?.shortCode);
      if (!result.success) {
        if (result.error === 'not_authorized') {
          return res.status(403).json({ error: 'Not authorized' });
        }
        if (result.error === 'invalid') {
          return res.status(400).json({ error: 'Use 2-40 letters, numbers, or hyphens; start and end with a letter or number.' });
        }
        if (result.error === 'taken') {
          return res.status(409).json({ error: 'Short link already taken' });
        }
        return res.status(404).json({ error: 'Discussion not found' });
      }

      res.json({
        success: true,
        slug: result.slug,
        shortCode: result.shortCode,
        shortPath: `/s/${result.shortCode}`,
      });
    } catch (err) {
      logError('Error generating short link:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/discussions/public', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT topic, slug, created_at FROM discussions
          WHERE listed = TRUE
          ORDER BY created_at DESC, id DESC
          LIMIT $1`,
        [MAX_PUBLIC_DISCUSSIONS]
      );
      res.json(result.rows);
    } catch (err) {
      logError('Request failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/discussions', async (req, res) => {
    try {
      const raw = Array.isArray(req.query.slugs) ? req.query.slugs : [req.query.slugs];
      const slugs = [...new Set(
        raw
          .filter(value => typeof value === 'string')
          .flatMap(value => value.split(','))
          // Exact canonical slugs only: this must not double as a title search.
          .filter(slug => slug !== '' && slugifyTopic(slug) === slug)
      )].slice(0, MAX_KNOWN_SLUGS);
      if (slugs.length === 0) {
        return res.json([]);
      }
      const result = await pool.query(
        `SELECT DISTINCT ON (slug) topic, slug, created_at
           FROM discussions
          WHERE slug = ANY($1::text[])
          ORDER BY slug, id DESC`,
        [slugs]
      );
      res.json(result.rows);
    } catch (err) {
      logError('Request failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.post('/api/duplicate-discussion', async (req, res) => {
    const { originalTopic, newTopic } = req.body;

    if (!originalTopic || !newTopic) {
      logInfo('Missing required fields');
      return res.status(400).json({ error: 'Original topic and new topic are required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get the original discussion, including its interaction flags so the copy
      // preserves whether reactions/comments were enabled (and reactions
      // revealed) rather than silently resetting them to the defaults.
      const originalDiscussionResult = await client.query(
        `SELECT id, reactions_enabled, reactions_visible, comments_enabled, theme, results_visibility,
                question_downvotes_enabled, hands_enabled, moderator_only_questions, question_approval_required FROM discussions WHERE slug = $1`,
        [slugifyTopic(originalTopic)]
      );

      if (originalDiscussionResult.rows.length === 0) {
        throw new Error('Original discussion not found');
      }

      const originalDiscussion = originalDiscussionResult.rows[0];
      const originalDiscussionId = originalDiscussion.id;
      // Anyone with the link may duplicate a discussion and becomes the copy's
      // moderator, so the copy gets the original's queued questions only when the
      // caller proves they already moderate the original. Otherwise duplicating
      // would be a way to read a queue that only moderators are sent.
      const copyModeratorDrafts = !!(await verifyAdmin(originalTopic, req.body.adminToken, client));

      // Create new discussion. Duplicating into an existing topic would merge
      // questions into that discussion, so treat the unique conflict as a user
      // error instead.
      // Mint an admin token so the person duplicating lands as its moderator
      // (same creator-is-moderator rule as POST /api/discussions). Slug
      // collisions get a suffix, but exact topic duplicates are rejected.
      const displayNewTopic = formatTopicTitle(newTopic);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [displayNewTopic]);
      const existingNewTopic = await client.query(
        'SELECT id FROM discussions WHERE topic = $1 LIMIT 1',
        [displayNewTopic]
      );
      if (existingNewTopic.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Discussion topic already exists' });
      }

      const owner = await currentAccount(req, client);
      const newAdminToken = crypto.randomBytes(16).toString('hex');
      const baseNewSlug = slugFromTitle(displayNewTopic);
      let newDiscussion = null;
      for (let suffix = 1; suffix <= 1000; suffix += 1) {
        const newSlug = suffixSlug(baseNewSlug, suffix);
        if (await lockDiscussionSlug(client, newSlug)) continue;
        const newDiscussionResult = await client.query(
          `INSERT INTO discussions (topic, slug, admin_token, reactions_enabled, reactions_visible, comments_enabled, theme, results_visibility, creator_google_sub,
                                    question_downvotes_enabled, hands_enabled, moderator_only_questions, question_approval_required)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id, topic, slug`,
          [displayNewTopic, newSlug, newAdminToken,
            originalDiscussion.reactions_enabled,
            originalDiscussion.reactions_visible,
            originalDiscussion.comments_enabled,
            originalDiscussion.theme,
            originalDiscussion.results_visibility, owner?.google_sub, originalDiscussion.question_downvotes_enabled, originalDiscussion.hands_enabled,
            originalDiscussion.moderator_only_questions, originalDiscussion.question_approval_required]
        );

        if (newDiscussionResult.rows.length > 0) {
          newDiscussion = newDiscussionResult.rows[0];
          break;
        }
      }

      if (!newDiscussion) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Could not create a unique discussion slug' });
      }

      const newDiscussionId = newDiscussion.id;

      // Copy questions from original to new discussion. The interaction flags now
      // live on the discussion (copied above), not per question.
      await client.query(`
        INSERT INTO questions (discussion_id, text, type, min_value, max_value, options, max_responses, show_attribution, queued, participant_suggested, tools, independent_answers, published_position)
        SELECT $1, text, type, min_value, max_value, options, max_responses, show_attribution, queued, participant_suggested, tools, independent_answers, published_position
        FROM questions
        WHERE discussion_id = $2 AND (NOT queued OR ($3 AND NOT participant_suggested))
        ORDER BY CASE WHEN queued THEN COALESCE(queue_position, id) ELSE id END, id
      `, [newDiscussionId, originalDiscussionId, copyModeratorDrafts]);

      // Carry the session-level reaction set (see reaction_keys) for the same
      // reason as the per-question flags above: a duplicate should preserve the
      // creator's chosen reactions, not silently reset to the defaults.
      await client.query(
        'UPDATE discussions SET reaction_keys = (SELECT reaction_keys FROM discussions WHERE id = $2) WHERE id = $1',
        [newDiscussionId, originalDiscussionId]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        newTopic: newDiscussion.topic,
        newSlug: newDiscussion.slug,
        adminToken: newAdminToken,
        accountLinked: !!owner,
      });
    } catch (error) {
      await client.query('ROLLBACK');
      logError('Error duplicating discussion:', error);
      res.status(500).json({ error: 'Failed to duplicate discussion' });
    } finally {
      client.release();
    }
  });

  app.get('/s/:shortCode', async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT slug FROM discussions WHERE short_code = $1 LIMIT 1',
        [req.params.shortCode]
      );

      if (result.rows.length === 0) {
        return res.status(404).send('Short link not found');
      }

      res.redirect(302, `/discussion/${result.rows[0].slug}`);
    } catch (err) {
      logError('Error resolving short link:', err);
      res.status(500).send('Server error');
    }
  });
}

module.exports = { registerDiscussionApi };
