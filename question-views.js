const { slugifyTopic } = require('./discussion-names');
const { OPINION_TYPES } = require('./opinion-snapshots');
const { parseOptions } = require('./question-data');
const { independentAnswerView } = require('./independent-answers');
const { ownerToken } = require('./participant-identity');

// When participants may see the results of Agreement, Yes/No, Multiple Choice
// and Numerical questions (the tallied types, OPINION_TYPES). 'after_vote' is the default:
// seeing the room's answer first pulls people toward it, so a participant gets a
// question's results only once they have answered it. 'always' shows results to
// everyone. Moderators see results in both modes. Open Ended and Brainstorm
// questions are not affected: their responses are the discussion itself, not a
// tally, and they keep their own reaction/comment toggles.
const RESULTS_VISIBILITY_MODES = ['after_vote', 'always'];
const DEFAULT_RESULTS_VISIBILITY = 'after_vote';

function resolveResultsVisibility(value) {
  return RESULTS_VISIBILITY_MODES.includes(value) ? value : DEFAULT_RESULTS_VISIBILITY;
}

const MODERATOR_ORDER_SQL = 'q.published_position ASC NULLS LAST, q.created_at DESC NULLS LAST, q.id DESC';

// One viewer's copy of the questions: tallied questions this participant has not
// answered lose their votes, and with them every count, percentage, average and
// individual value, and are marked resultsHidden so the client can say why.
// `respondents` comes from the same getQuestions call as `questions`, so the
// decision and the data describe the same moment. Returns `questions` itself
// when nothing needs hiding.
function hideUnansweredResults(questions, respondents, userId) {
  let hidden = false;
  const view = questions.map(question => {
    const answeredBy = respondents.get(question.id);
    if (!answeredBy || (userId && answeredBy.has(userId))) return question;
    hidden = true;
    return { ...question, votes: [], resultsHidden: true };
  });
  return hidden ? view : questions;
}

// The room display's copy of the questions when results are shown only after
// voting. A display is not a voter, so it has answered nothing and every tallied
// question loses its votes exactly as for a participant who has not answered.
// It keeps only how many responses the question has, so the room can watch
// answers come in without seeing what they are.
function displayView(questions, respondents) {
  return questions.map(question => (respondents.has(question.id)
    ? { ...question, votes: [], resultsHidden: true, responseCount: (question.votes || []).length }
    : question));
}

// The questions without the queued ones: those a moderator has written but not
// published yet (see publishQuestion). Returns `questions` itself when none is
// queued.
function withoutQueued(questions) {
  return questions.some(question => question.queued) ? questions.filter(question => !question.queued) : questions;
}

function createQuestionViews(pool) {
  // Who may see every result in a discussion: everyone when results are always
  // shown, otherwise only holders of a current moderator token (the creator's or a
  // promoted moderator's). Tokens are read fresh on each call, so a revoked
  // moderator loses the full view at the next payload.
  async function getResultsAccess(topic) {
    const result = await pool.query(
      `SELECT d.results_visibility, d.admin_token,
              ARRAY(SELECT m.token FROM discussion_moderators m WHERE m.discussion_id = d.id) AS moderator_tokens
         FROM discussions d WHERE d.slug = $1 ORDER BY d.id DESC LIMIT 1`,
      [slugifyTopic(topic)]
    );
    const row = result.rows[0];
    const tokens = new Set(row ? [row.admin_token, ...row.moderator_tokens].filter(Boolean) : []);
    return {
      alwaysShow: resolveResultsVisibility(row?.results_visibility) === 'always',
      isModerator: token => typeof token === 'string' && tokens.has(token),
    };
  }

  // The questions as one REST caller may see them. `token` is a moderator token
  // and `userId` the participant's id, both optional; a caller that supplies
  // neither is treated as a participant who has answered nothing. Queued
  // questions are left out for everyone, moderators included: they have no
  // responses, so they have no place in a summary, an export or a snapshot.
  async function getQuestionsForViewer(topic, { userId = null, token = null, includeUserIds = false } = {}) {
    const respondents = new Map();
    const questions = withoutQueued(await getQuestions(topic, { includeUserIds, respondents }));
    // Read access after the questions: if the mode or a moderator grant changes
    // in between, the stricter of the two states wins or a rebroadcast follows.
    const access = await getResultsAccess(topic);
    if (access.isModerator(token)) return questions;
    const safe = independentAnswerView(questions);
    return access.alwaysShow ? safe : hideUnansweredResults(safe, respondents, userId);
  }

  // `respondents`, when given, is filled with question id -> Set of the user ids
  // that answered it, for the tallied question types only, so a caller can decide
  // whose results to hide from the same rows it is about to send. Questions whose
  // results a moderator has revealed are left out: nothing hides them from anyone,
  // in the questions, the room display, the summary, snapshots or exports.
  async function getQuestions(topic, { includeUserIds = false, respondents = null, independentOwners = null } = {}) {
    const slug = slugifyTopic(topic);
    const query = `
      SELECT 
        q.id, 
        q.text, 
        q.type, 
        q.min_value,
        q.max_value,
        q.options,
        q.max_responses,
        q.show_attribution,
        q.created_at,
        q.tools,
        q.pinned,
        q.queued,
        (row_number() OVER (PARTITION BY q.queued ORDER BY ${MODERATOR_ORDER_SQL}))::integer AS "moderatorOrder",
        q.participant_suggested,
        q.results_revealed,
        q.independent_answers AS "independentAnswers",
        d.reactions_enabled,
        d.reactions_visible,
        d.comments_enabled,
        (SELECT COALESCE(json_agg(qi.user_id ORDER BY qi.id), '[]'::json)
           FROM question_interest qi WHERE qi.question_id = q.id AND NOT qi.downvote) AS interest_voters,
        (SELECT COALESCE(json_agg(qi.user_id ORDER BY qi.id), '[]'::json)
           FROM question_interest qi WHERE qi.question_id = q.id AND qi.downvote AND d.question_downvotes_enabled) AS downvoters,
        COALESCE(json_agg(
          json_build_object(
            'id', v.id,
            'value', v.value,
            'userId', v.user_id,
            'pseudonym', v.pseudonym,
            'created_at', v.created_at,
            'upvotes', (SELECT COUNT(*) FROM response_votes rv WHERE rv.response_id = v.id),
            'upvoters', (SELECT COALESCE(json_agg(rv.user_id), '[]'::json) FROM response_votes rv WHERE rv.response_id = v.id)
          ) ORDER BY v.id
        ) FILTER (WHERE v.id IS NOT NULL), '[]'::json) as votes
      FROM questions q
      JOIN discussions d ON q.discussion_id = d.id
      LEFT JOIN votes v ON q.id = v.question_id
      WHERE d.slug = $1
      GROUP BY q.id, d.id
      ORDER BY q.queued, CASE WHEN q.queued THEN COALESCE(q.queue_position, q.id) END,
               q.pinned DESC, q.created_at NULLS FIRST, q.id
    `;

    const result = await pool.query(query, [slug]);
    if (independentOwners) {
      for (const row of result.rows) {
        if (!row.independentAnswers || row.results_revealed) continue;
        for (const vote of row.votes) {
          if (!vote.userId) continue;
          if (!independentOwners.has(vote.userId)) independentOwners.set(vote.userId, new Set());
          independentOwners.get(vote.userId).add(vote.id);
        }
      }
    }
    if (respondents) {
      for (const row of result.rows) {
        if (!OPINION_TYPES.includes(row.type) || row.results_revealed === true) continue;
        const votes = Array.isArray(row.votes) ? row.votes : [];
        respondents.set(row.id, new Set(votes.map(vote => vote.userId).filter(Boolean)));
      }
    }
    // interest_voters holds raw user ids, so it is taken out of the row here and
    // only its count and per-question tokens are sent.
    const questions = result.rows.map(({ results_revealed: revealed, interest_voters: interestVoters, downvoters, participant_suggested: suggested, ...row }) => ({
      ...row,
      // How many participants marked this question as interesting, and a token
      // for each so a client can recognize its own mark. Tokens are namespaced
      // (`question:<id>`) so one can never equal a response's ownership token
      // and link a participant to an anonymous response with the same numeric id.
      interestCount: Array.isArray(interestVoters) ? interestVoters.length : 0,
      downvoteCount: downvoters.length,
      downvoterTokens: downvoters.map(uid => ownerToken(`question:${row.id}`, uid)),
      interestVoterTokens: (Array.isArray(interestVoters) ? interestVoters : [])
        .map(uid => ownerToken(`question:${row.id}`, uid)),
      maxResponses: row.max_responses,
      showAttribution: row.show_attribution,
      minValue: row.min_value,
      maxValue: row.max_value,
      reactionsEnabled: row.reactions_enabled === true,
      reactionsVisible: row.reactions_visible === true,
      commentsEnabled: row.comments_enabled === true,
      // Always present, so a client that merges successive payloads sees the flag
      // clear once the results arrive. Set by hideUnansweredResults.
      resultsHidden: false,
      // Whether a moderator has shown this question's results to everyone.
      resultsRevealed: revealed === true,
      // Written by a moderator but not published yet. Only moderators are sent
      // queued questions (see withoutQueued).
      queued: row.queued === true,
      ...(row.queued && suggested ? { suggested: true } : {}),
      options: parseOptions(row.options),
      // Replace raw stable user ids on the wire with per-response ownership
      // tokens so a socket observer can't correlate a participant's responses —
      // not across prompts, and not even across multiple ideas in the same
      // Brainstorm prompt. Each token is keyed by the vote's own row id, so one
      // anonymous participant's separate ideas each carry a DIFFERENT token and
      // can't be grouped. Each client recomputes the same token for its own votes
      // (see ownerToken() in client/src/identity.js — the two MUST match).
      votes: (Array.isArray(row.votes) ? row.votes : []).map(vote => {
        // Internal callers (e.g. getDiscussionSummary) opt into keeping the raw
        // stable user_id so they can count distinct participants correctly. This
        // path is SERVER-SIDE ONLY and must never feed a socket/API response.
        if (includeUserIds) return { ...vote, pseudonym: row.show_attribution === false ? null : vote.pseudonym };
        const tokenized = {
          ...vote,
          pseudonym: row.show_attribution === false ? null : vote.pseudonym,
          ownerToken: ownerToken(vote.id, vote.userId),
          upvoterTokens: (Array.isArray(vote.upvoters) ? vote.upvoters : [])
            .map(uid => ownerToken(vote.id, uid)),
        };
        delete tokenized.userId;
        delete tokenized.upvoters;
        return tokenized;
      }),
    }));
    await attachBrainstormInteractions(questions, { includeUserIds });
    return questions;
  }

  // Enrich Brainstorm responses in place with aggregated interaction data:
  // quality up/down tallies, the agreement distribution, reaction counts, and
  // comments. Everything here is an aggregate or a pseudonymous comment — never
  // a list of who voted which way — so reactions stay unattributable. Ratings and
  // reactions are only attached when the moderator currently has them revealed;
  // comments only when comments are enabled. This enforces the hide/disable
  // toggles server-side rather than trusting the client to omit hidden data.
  async function attachBrainstormInteractions(questions, { includeUserIds = false } = {}) {
    const ratingIds = [];
    const commentIds = [];
    for (const q of questions) {
      if (!['Open Ended', 'Brainstorm'].includes(q.type)) continue;
      const votes = q.votes || [];
      if (q.reactionsEnabled && q.reactionsVisible) {
        for (const v of votes) ratingIds.push(v.id);
      }
      if (q.commentsEnabled) {
        for (const v of votes) commentIds.push(v.id);
      }
    }

    const ratingsByResponse = new Map();
    const reactionsByResponse = new Map();
    if (ratingIds.length > 0) {
      const qualityResult = await pool.query(
        `SELECT response_id,
                COUNT(*) FILTER (WHERE quality > 0) AS up,
                COUNT(*) FILTER (WHERE quality < 0) AS down
         FROM response_ratings
         WHERE response_id = ANY($1::int[])
         GROUP BY response_id`,
        [ratingIds]
      );
      for (const r of qualityResult.rows) {
        ratingsByResponse.set(r.response_id, {
          qualityUp: Number(r.up),
          qualityDown: Number(r.down),
          agreementCounts: {},
        });
      }

      const agreementResult = await pool.query(
        `SELECT response_id, agreement, COUNT(*) AS c
         FROM response_ratings
         WHERE response_id = ANY($1::int[]) AND agreement IS NOT NULL
         GROUP BY response_id, agreement`,
        [ratingIds]
      );
      for (const r of agreementResult.rows) {
        const entry = ratingsByResponse.get(r.response_id)
          || { qualityUp: 0, qualityDown: 0, agreementCounts: {} };
        entry.agreementCounts[r.agreement] = Number(r.c);
        ratingsByResponse.set(r.response_id, entry);
      }

      const reactionResult = await pool.query(
        `SELECT response_id, reaction, COUNT(*) AS c
         FROM response_reactions
         WHERE response_id = ANY($1::int[])
         GROUP BY response_id, reaction`,
        [ratingIds]
      );
      for (const r of reactionResult.rows) {
        const counts = reactionsByResponse.get(r.response_id) || {};
        counts[r.reaction] = Number(r.c);
        reactionsByResponse.set(r.response_id, counts);
      }
    }

    const commentsByResponse = new Map();
    if (commentIds.length > 0) {
      const commentResult = await pool.query(
        `SELECT id, response_id, user_id, pseudonym, body, created_at
         FROM response_comments
         WHERE response_id = ANY($1::int[])
         ORDER BY created_at, id`,
        [commentIds]
      );
      for (const c of commentResult.rows) {
        const list = commentsByResponse.get(c.response_id) || [];
        // Like votes, comments carry a per-comment ownership token rather than the
        // raw user id, so the author can recognize (and delete) their own without
        // exposing who wrote what. The token is namespaced (`comment:<id>`) so it
        // can't collide with a vote's token: comment ids and vote ids are separate
        // sequences that both start at 1, and an un-namespaced token would let a
        // client link a comment author to an equally-numbered anonymous idea. The
        // client mirrors this namespace (see commentOwnerToken in DiscussionPage).
        const comment = { id: c.id, pseudonym: c.pseudonym, body: c.body, created_at: c.created_at };
        if (includeUserIds) {
          comment.userId = c.user_id;
        } else {
          comment.ownerToken = ownerToken(`comment:${c.id}`, c.user_id);
        }
        list.push(comment);
        commentsByResponse.set(c.response_id, list);
      }
    }

    for (const q of questions) {
      if (!['Open Ended', 'Brainstorm'].includes(q.type)) continue;
      const reveal = q.reactionsEnabled && q.reactionsVisible;
      for (const v of q.votes || []) {
        // Legacy upvotes and positive quality ratings share storage. Hiding
        // feedback must also hide these aliases, even if reactions are disabled.
        if (!q.reactionsVisible) {
          v.upvotes = 0;
          if ('upvoterTokens' in v) v.upvoterTokens = [];
          if ('upvoters' in v) v.upvoters = [];
        }
        if (reveal) {
          const rating = ratingsByResponse.get(v.id);
          v.qualityUp = rating ? rating.qualityUp : 0;
          v.qualityDown = rating ? rating.qualityDown : 0;
          v.agreementCounts = rating ? rating.agreementCounts : {};
          v.reactionCounts = reactionsByResponse.get(v.id) || {};
        }
        if (q.commentsEnabled) {
          v.comments = commentsByResponse.get(v.id) || [];
        }
      }
    }
  }

  return { getQuestions, getResultsAccess, getQuestionsForViewer };
}

module.exports = {
  RESULTS_VISIBILITY_MODES, DEFAULT_RESULTS_VISIBILITY, MODERATOR_ORDER_SQL, resolveResultsVisibility,
  hideUnansweredResults, displayView, withoutQueued, createQuestionViews,
};
