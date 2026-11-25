const { slugifyTopic } = require('./discussion-names');
const { VALID_QUESTION_TYPES } = require('./question-data');
const { postingMode } = require('./question-posting');
const { DEFAULT_RESULTS_VISIBILITY, resolveResultsVisibility } = require('./question-views');
const { DEFAULT_REACTION_KEYS, resolveReactionKeys } = require('./response-interactions');

// Color themes a moderator may apply to a discussion. Must stay in sync with
// the [data-theme] palettes in client/src/index.css and THEME_KEYS in
// client/src/DiscussionPage.jsx. 'indigo' is the default/original look.
const ALLOWED_THEMES = ['indigo', 'orange', 'emerald', 'rose', 'slate'];
const DEFAULT_THEME = 'indigo';

// The room display's presentation, chosen by the moderator so nobody has to
// touch the shared screen. The first entry of each is the default.
// displayQr: the join QR code large in a sidebar, small in a corner, or hidden.
// displayLayout: every question, or one at a time. The one question is the one
// a moderator chose with "Show on display" (displayQuestionId); when they chose
// none it is the first pinned question, otherwise the newest. 'compare' shows
// two saved opinion snapshots side by side (displayBeforeSnapshotId and
// displayAfterSnapshotId), for that one question when a moderator chose one.
const DISPLAY_QR_MODES = ['full', 'corner', 'hidden'];
const DISPLAY_LAYOUTS = ['all', 'focus', 'compare'];
const DISPLAY_SORTS = ['oldest', 'newest', 'interesting', 'agreement', 'disagreement', 'controversial', 'moderator'];

async function comparisonIncludesQuestion(db, discussionId, beforeId, afterId, questionId) {
  const result = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM opinion_snapshots
        WHERE discussion_id = $1 AND id IN (
          COALESCE($2, (SELECT min(id) FROM opinion_snapshots WHERE discussion_id = $1)),
          COALESCE($3, (SELECT max(id) FROM opinion_snapshots WHERE discussion_id = $1))
        ) AND (data->'questions') @> $4::jsonb
     ) AS included`, [discussionId, beforeId, afterId, JSON.stringify([{ id: questionId }])]);
  return result.rows[0].included;
}

function createDiscussionStateReader(pool) {
  // Read the lock state, the moderator-only-questions state, the chosen color
  // theme, whether a moderator has been claimed, and the discussion-wide
  // brainstorm interaction flags. The flags live on the discussion (not
  // individual questions) so a moderator opens reactions/comments for the whole
  // room at once; this channel drives the moderator's toggle buttons and gates
  // the participant-facing reaction/comment UI.
  async function getDiscussionState(topic) {
    const slug = slugifyTopic(topic);
    const result = await pool.query(
      `SELECT d.id, locked, moderator_only_questions, question_approval_required, theme, reaction_keys, results_visibility, listed,
              display_qr, display_layout, display_sort, display_question_type, display_pinned_first, display_hidden_question_ids,
              (SELECT q.id FROM questions q
                WHERE q.id = d.display_question_id AND q.discussion_id = d.id AND NOT q.queued) AS display_question_id,
              (SELECT s.id FROM opinion_snapshots s
                WHERE s.id = d.display_before_snapshot_id AND s.discussion_id = d.id) AS display_before_snapshot_id,
              (SELECT s.id FROM opinion_snapshots s
                WHERE s.id = d.display_after_snapshot_id AND s.discussion_id = d.id) AS display_after_snapshot_id,
              admin_token IS NOT NULL AS has_moderator,
              reactions_enabled, reactions_visible, comments_enabled, question_downvotes_enabled, hands_enabled
         FROM discussions d WHERE slug = $1`,
      [slug]
    );
    if (result.rows.length === 0) {
      return {
        locked: false, moderatorOnly: false, postingMode: 'open', hasModerator: false, theme: DEFAULT_THEME,
        reactionsEnabled: false, reactionsVisible: true, commentsEnabled: false, questionDownvotesEnabled: false,
        reactionKeys: [...DEFAULT_REACTION_KEYS],
        resultsVisibility: DEFAULT_RESULTS_VISIBILITY,
        listed: false,
        displayQr: DISPLAY_QR_MODES[0],
        displayLayout: DISPLAY_LAYOUTS[0],
        displayBaseLayout: DISPLAY_LAYOUTS[0],
        displaySort: DISPLAY_SORTS[0],
        displayQuestionType: 'all',
        displayPinnedFirst: true,
        displayQuestionId: null,
        displayHiddenQuestionIds: [],
        displayBeforeSnapshotId: null,
        displayAfterSnapshotId: null,
      };
    }
    const row = result.rows[0];
    const baseLayout = DISPLAY_LAYOUTS.includes(row.display_layout) ? row.display_layout : 'all';
    const comparisonMissing = baseLayout === 'compare' && row.display_question_id != null
      && !await comparisonIncludesQuestion(pool, row.id, row.display_before_snapshot_id, row.display_after_snapshot_id, row.display_question_id);
    return {
      locked: row.locked === true,
      moderatorOnly: row.moderator_only_questions === true,
      questionDownvotesEnabled: row.question_downvotes_enabled === true,
      postingMode: postingMode(row),
      hasModerator: row.has_moderator === true,
      theme: row.theme || DEFAULT_THEME,
      reactionsEnabled: row.reactions_enabled === true,
      reactionsVisible: row.reactions_visible === true,
      commentsEnabled: row.comments_enabled === true,
      handsEnabled: row.hands_enabled === true,
      reactionKeys: resolveReactionKeys(row.reaction_keys),
      resultsVisibility: resolveResultsVisibility(row.results_visibility),
      listed: row.listed === true,
      displayQr: DISPLAY_QR_MODES.includes(row.display_qr) ? row.display_qr : DISPLAY_QR_MODES[0],
      displayBaseLayout: baseLayout,
      displayLayout: row.display_layout === 'spotlight' && row.display_question_id != null ? 'focus' : baseLayout,
      displaySort: DISPLAY_SORTS.includes(row.display_sort) ? row.display_sort : DISPLAY_SORTS[0],
      displayQuestionType: VALID_QUESTION_TYPES.has(row.display_question_type) ? row.display_question_type : 'all',
      displayPinnedFirst: row.display_pinned_first !== false,
      // The question a moderator put on the display, or null when they chose
      // none or it has since been deleted.
      displayQuestionId: comparisonMissing ? null : row.display_question_id ?? null,
      displayHiddenQuestionIds: row.display_hidden_question_ids,
      // The snapshots the before-and-after view compares; null means the display
      // picks the first snapshot and the latest one.
      displayBeforeSnapshotId: row.display_before_snapshot_id ?? null,
      displayAfterSnapshotId: row.display_after_snapshot_id ?? null,
    };
  }

  return { getDiscussionState };
}

module.exports = {
  ALLOWED_THEMES, DISPLAY_QR_MODES, DISPLAY_LAYOUTS, DISPLAY_SORTS,
  comparisonIncludesQuestion, createDiscussionStateReader,
};
