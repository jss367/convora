require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const path = require('path');
const cors = require('cors');
const { createVoteStore } = require('./votes');
const { registerQuestionTools } = require('./question-tools');
const { createInterestUpdates } = require('./interest-updates');
const { registerSpeakingQueue } = require('./speaking-queue');
const interestUpdates = createInterestUpdates();
const { logError, logInfo } = require('./logging');
const { initializeDatabase, createTransactionRunner } = require('./database');
const { slugifyTopic } = require('./discussion-names');
const { bindSocketUser } = require('./participant-identity');
const { createDiscussions, getOrCreateDiscussionForSlug } = require('./discussions');
const { createDiscussionStateReader } = require('./discussion-state');
const { createQuestionViews } = require('./question-views');
const { createQuestionStore } = require('./question-store');
const { createModeratorRoles, registerModeratorRoles } = require('./moderator-roles');
const { createPseudonyms, registerPseudonyms } = require('./pseudonyms');
const { createResponseInteractions, registerResponseInteractions } = require('./response-interactions');
const { createSnapshotStore } = require('./opinion-snapshot-store');
const { createShortCodes } = require('./short-codes');
const { createRoomBroadcasts } = require('./room-broadcasts');
const { registerRoomMembership } = require('./room-membership');
const { registerPostingAndVoting } = require('./posting-and-voting');
const { registerQuestionModeration } = require('./question-moderation');
const { registerDiscussionSettings } = require('./discussion-settings');
const { registerDiscussionApi } = require('./discussion-api');
const { registerResultsApi } = require('./results-api');

const app = express();
const server = http.createServer(app);

const isProduction = process.env.NODE_ENV === 'production';
const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

app.use((req, res, next) => {
  logInfo(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Enable CORS for your client URL
app.use(cors({
  origin: clientUrl,
  credentials: true,
}));

const io = socketIo(server, {
  cors: {
    origin: clientUrl,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Without DATABASE_URL, development uses the Docker Compose database that
// `npm run dev:db` starts (see README). Production must name its database.
const DEVELOPMENT_DATABASE_URL = 'postgresql://convora:convora@127.0.0.1:54329/convora';
if (isProduction && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set when NODE_ENV is production.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || DEVELOPMENT_DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

const { addVote, clearVote } = createVoteStore(pool);
const withTransaction = createTransactionRunner(pool);
const { getDiscussionBySlug, resolveDiscussionRoute, createDiscussion, isDiscussionLocked } = createDiscussions(pool);
const {
  verifyAdmin, verifyCreator, claimModerator, listParticipants, resolveParticipant, promoteModerator, revokeModerator,
} = createModeratorRoles(pool);
const { getQuestions, getResultsAccess, getQuestionsForViewer } = createQuestionViews(pool);
const { getDiscussionState } = createDiscussionStateReader(pool);
const { addQuestion, getQuestionForTopic, findSimilarQuestion, setQuestionInterest } = createQuestionStore({
  pool, withTransaction, verifyAdmin, getOrCreateDiscussionForSlug,
});
const { canonicalPseudonym, assignPseudonym } = createPseudonyms(pool);
const { toggleResponseVote, getResponseContext, getMyBrainstormState } = createResponseInteractions({ pool, withTransaction });
const { saveOpinionSnapshot, saveSnapshotBeforeReveal } = createSnapshotStore(pool);
const { generateDiscussionShortCode } = createShortCodes({ pool, verifyAdmin });
const {
  audience, emitPresence, emitPseudonymSync, emitDiscussionState, emitDiscussion, emitQuestions,
  resendQuestionsIfPersonalized, notifyQuestionNoteModerators, notifySpeakingQueue,
  deliverModeratorToken, revokeModeratorToken,
} = createRoomBroadcasts({ io, getQuestions, getResultsAccess, getDiscussionState, getDiscussionBySlug });

app.use(express.json());
app.use('/api/discussions/:topic/:resource', (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});
const currentAccount = require('./moderator-accounts').registerModeratorAccounts(app, pool);
app.use(express.static(path.join(__dirname, 'dist')));

// WebSocket handlers
io.on('connection', (socket) => {
  logInfo('New client connected');
  registerQuestionTools(socket, { slugifyTopic, bindSocketUser, withTransaction, verifyAdmin, notifyModerators: notifyQuestionNoteModerators, logError });
  registerSpeakingQueue(socket, { pool, withTransaction, verifyAdmin, bindSocketUser, notify: notifySpeakingQueue, logError });
  registerRoomMembership(socket, {
    pool, emitPresence, emitDiscussion, emitQuestions, emitDiscussionState, resendQuestionsIfPersonalized,
    logError, logInfo,
  });
  registerPostingAndVoting(socket, {
    pool, interestUpdates, addQuestion, findSimilarQuestion, getQuestionForTopic, canonicalPseudonym,
    addVote, clearVote, setQuestionInterest, emitQuestions, emitDiscussion, logError,
  });
  registerModeratorRoles(socket, {
    claimModerator, verifyAdmin, verifyCreator, listParticipants, resolveParticipant, promoteModerator,
    revokeModerator, deliverModeratorToken, revokeModeratorToken, emitDiscussion, emitDiscussionState,
    emitQuestions, resendQuestionsIfPersonalized, logError,
  });
  registerQuestionModeration(socket, {
    pool, withTransaction, verifyAdmin, isDiscussionLocked, saveSnapshotBeforeReveal, audience,
    emitQuestions, emitDiscussionState, logError,
  });
  registerDiscussionSettings(socket, {
    pool, withTransaction, verifyAdmin, emitDiscussion, emitDiscussionState, emitQuestions, logError,
  });
  registerResponseInteractions(socket, {
    pool, withTransaction, verifyAdmin, toggleResponseVote, getResponseContext, getMyBrainstormState,
    canonicalPseudonym, emitQuestions, logError,
  });
  registerPseudonyms(socket, { pool, assignPseudonym, emitPseudonymSync, emitQuestions, logError });
});

// HTTP routes
registerDiscussionApi(app, {
  pool, io, withTransaction, verifyAdmin, currentAccount, createDiscussion, resolveDiscussionRoute,
  generateDiscussionShortCode, audience, emitDiscussion, emitQuestions, logError, logInfo,
});
registerResultsApi(app, {
  pool, verifyAdmin, getDiscussionBySlug, getQuestionsForViewer, saveOpinionSnapshot, audience, logError,
});

// Catch-all route
app.get(/.*/, (req, res) => {
  // Pass the directory as `root`: with a single absolute path, send rejects any
  // dot-directory in it, which breaks checkouts under paths like `.worktrees/`.
  res.sendFile('index.html', { root: path.join(__dirname, 'dist') });
});

// Express's default error handler prints raw errors, including parser input and
// database details. Route unexpected failures through the same safe logger.
app.use((error, req, res, next) => {
  logError('Unhandled request error:', error);
  if (res.headersSent) return next(new Error('Request failed'));
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    ? error.status : 500;
  res.status(status).json({ error: status < 500 ? 'Invalid request' : 'Server error' });
});

const PORT = process.env.PORT || 3001;

// Create the schema on a fresh deploy, then run required migrations before
// accepting connections so that no client can query a column or table that
// doesn't exist yet (e.g. votes.pseudonym, or the response_votes table that
// getQuestions selects from on the first join). Order matters: create tables
// first, then run all migrations against the existing/just-created schema, then
// start listening.
initializeDatabase(pool)
  .then(() => {
    server.listen(PORT, () => logInfo(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    logError('Failed to initialize database, exiting:', err);
    process.exit(1);
  });
