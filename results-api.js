const { slugifyTopic } = require('./discussion-names');
const { analyzeViewerClusters, ClusterBusyError } = require('./cluster-service');
const { buildSummary, renderReportHtml } = require('./reports');
const { MAX_SNAPSHOT_NAME_LENGTH, redactSnapshot } = require('./opinion-snapshot-store');
const { sanitizeFilename, responsesCsv } = require('./discussion-export');

// REST callers identify themselves with the same secrets the socket uses, sent
// as headers so they stay out of URLs and request logs.
function restViewer(req) {
  return {
    userId: req.get('x-convora-user') || null,
    token: req.get('x-convora-moderator') || null,
  };
}

function registerResultsApi(app, {
  pool, verifyAdmin, getDiscussionBySlug, getQuestionsForViewer, saveOpinionSnapshot, audience, logError,
}) {
  async function getDiscussionSummary(topic, viewer = {}) {
    const discussion = await getDiscussionBySlug(topic);
    if (!discussion) {
      return null;
    }

    // Internal use: keep the raw stable user_id on each vote so buildSummary can
    // count distinct participants (anonymous/duplicate display names must not
    // collapse). buildFacilitatorDashboard re-keys to participant-N before any
    // of this reaches a client, so the raw ids never leave the server.
    // Results the viewer may not see yet are removed here, before anything is
    // aggregated, so no count or ranking in the summary can be derived from them.
    const questions = await getQuestionsForViewer(topic, { ...viewer, includeUserIds: true });

    return buildSummary(discussion, questions);
  }

  app.get('/api/discussions/:topic/snapshots', async (req, res) => {
    try {
      const discussion = await getDiscussionBySlug(req.params.topic);
      if (!discussion) return res.status(404).json({ error: 'Discussion not found' });
      const result = await pool.query(
        `SELECT id, name, created_at AS "createdAt", data
         FROM opinion_snapshots WHERE discussion_id = $1 ORDER BY id`,
        [discussion.id]
      );
      // A snapshot holds the same tallies as the live question, so a participant
      // who has not answered a question does not get its saved results either.
      // Questions deleted since the snapshot can no longer be answered and stay.
      const questions = await getQuestionsForViewer(discussion.slug, restViewer(req));
      const hiddenIds = new Set(questions.filter(q => q.resultsHidden).map(q => q.id));
      res.json({ snapshots: result.rows.map(snapshot => redactSnapshot(snapshot, hiddenIds)) });
    } catch (err) {
      logError('Error loading opinion snapshots:', err);
      res.status(500).json({ error: 'Could not load opinion snapshots.' });
    }
  });

  app.post('/api/discussions/:topic/snapshots', async (req, res) => {
    try {
      const discussionId = await verifyAdmin(req.params.topic, req.body?.adminToken);
      if (!discussionId) return res.status(403).json({ error: 'Only a moderator can save a snapshot.' });
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name || name.length > MAX_SNAPSHOT_NAME_LENGTH) {
        return res.status(400).json({ error: 'Enter a snapshot name of 1–120 characters.' });
      }
      const saved = await saveOpinionSnapshot(discussionId, name);
      if (saved.empty) {
        return res.status(400).json({ error: 'Add a numerical, agreement, yes/no, or multiple choice question before saving a snapshot.' });
      }
      // Open snapshot panels and the room display reload their list.
      audience(slugifyTopic(req.params.topic)).emit('snapshotsChanged');
      res.status(201).json(saved.snapshot);
    } catch (err) {
      logError('Error saving opinion snapshot:', err);
      res.status(500).json({ error: 'Could not save the opinion snapshot. Try again.' });
    }
  });

  app.get('/api/discussions/:topic/summary', async (req, res) => {
    try {
      const summary = await getDiscussionSummary(req.params.topic, restViewer(req));

      if (!summary) {
        return res.status(404).json({ error: 'Discussion not found' });
      }

      res.json(summary);
    } catch (err) {
      logError('Request failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Read-only opinion clustering ("opinion groups"). Computes participant groups
  // from existing Agreement votes on the fly; writes nothing. Kept separate from
  // the summary so the experimental clusters view can be removed cleanly.
  app.get('/api/discussions/:topic/clusters', async (req, res) => {
    try {
      const discussion = await getDiscussionBySlug(req.params.topic);
      if (!discussion) {
        return res.status(404).json({ error: 'Discussion not found' });
      }

      // Opt into raw user ids: clustering groups participants by stable id, and
      // this runs server-side only — the response carries aggregate cluster data
      // (sizes, per-statement means), never individual ids.
      // Statements the viewer may not see results for arrive with no votes, so
      // the groups are computed only from statements this viewer has answered.
      const analysis = await analyzeViewerClusters(() =>
        getQuestionsForViewer(req.params.topic, { ...restViewer(req), includeUserIds: true })
      );

      res.json({
        discussion: {
          id: discussion.id,
          topic: discussion.topic,
          createdAt: discussion.created_at,
        },
        ...analysis,
      });
    } catch (err) {
      if (err instanceof ClusterBusyError) return res.status(503).json({ error: err.message });
      logError('Request failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/discussions/:topic/export.json', async (req, res) => {
    try {
      const summary = await getDiscussionSummary(req.params.topic, restViewer(req));

      if (!summary) {
        return res.status(404).json({ error: 'Discussion not found' });
      }

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(req.params.topic)}-summary.json"`);
      res.send(JSON.stringify(summary, null, 2));
    } catch (err) {
      logError('Request failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/discussions/:topic/report.html', async (req, res) => {
    try {
      const summary = await getDiscussionSummary(req.params.topic, restViewer(req));

      if (!summary) {
        return res.status(404).json({ error: 'Discussion not found' });
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(req.params.topic)}-final-report.html"`);
      res.send(await renderReportHtml(summary));
    } catch (err) {
      logError('Request failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });

  app.get('/api/discussions/:topic/export.csv', async (req, res) => {
    try {
      const discussion = await getDiscussionBySlug(req.params.topic);
      if (!discussion) {
        return res.status(404).json({ error: 'Discussion not found' });
      }

      const questions = await getQuestionsForViewer(req.params.topic, restViewer(req));
    const csv = responsesCsv(discussion, questions);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(req.params.topic)}-responses.csv"`);
      res.send(csv);
    } catch (err) {
      logError('Request failed:', err);
      res.status(500).json({ error: 'Server error' });
    }
  });
}

module.exports = { registerResultsApi };
