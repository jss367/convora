import React, { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDiscussionSocket, useDiscussionRoom, useConnectionLost, usePendingVotes } from './hooks/useDiscussionRoom';
import { useParticipantIdentity } from './hooks/useParticipantIdentity';
import { useQuestionInterest } from './hooks/useQuestionInterest';
import { useModeratorAccess } from './hooks/useModeratorAccess';
import { useOpinionSnapshotsPanel } from './hooks/useOpinionSnapshotsPanel';
import { useDiscussionTitleEditor } from './hooks/useDiscussionTitleEditor';
import { useShareLinks } from './hooks/useShareLinks';
import { useDiscussionActions } from './hooks/useDiscussionActions';
import { useCanonicalRoute } from './hooks/useCanonicalRoute';
import { useClustersFlag } from './hooks/useClustersFlag';
import { useBrainstormResponses } from './hooks/useBrainstormResponses';
import { useDiscussionTheme, DEFAULT_THEME } from './hooks/useDiscussionTheme';
import { useModeratorParticipants } from './hooks/useModeratorParticipants';
import { useQuestionModeration } from './hooks/useQuestionModeration';
import { useVoteActions } from './hooks/useVoteActions';
import { useQuestionFilters } from './hooks/useQuestionFilters';
import { slugifyTopic } from './slugs';
import OpinionSnapshots from './OpinionSnapshots';
import { useModeratorLinkPrompt } from './ModeratorLinkPanel';
import { useSpeakingQueue } from './questions/SpeakingQueue';
import { getNumericalRange } from './questions/questionHelpers.mjs';
import QuestionComposer, { useQuestionComposer } from './questions/QuestionComposer.jsx';
import VotingControls from './questions/VotingControls';
import { QuestionTypes, ALL_REACTION_KEYS } from './questions/config';
import DiscussionTitle from './discussion/DiscussionTitle';
import IdentityBar from './discussion/IdentityBar';
import DiscussionToolbar from './discussion/DiscussionToolbar';
import { ClearResponsesDialog, DeleteDiscussionDialog, DuplicateDiscussionDialog } from './discussion/DiscussionDialogs';
import ShareDialog from './discussion/ShareDialog';
import ModeratorControls from './discussion/ModeratorControls';
import QueuedQuestions from './discussion/QueuedQuestions';
import QuestionFilters from './discussion/QuestionFilters';
import QuestionCard from './discussion/QuestionCard';

// One discussion. This component owns the room's data (the discussion, its
// questions, presence, and settings), wires the hooks that act on it, and lays
// out the page. Socket subscriptions are registered in a fixed order: the
// snapshot and deletion listeners before useDiscussionRoom joins the room.
const DiscussionPage = () => {
    const { topic } = useParams();
    const navigate = useNavigate();
    const discussionSlug = slugifyTopic(topic);
    const socket = useDiscussionSocket();
    const connectionLost = useConnectionLost(socket);
    const [pendingVotes, sendVote] = usePendingVotes(socket);
    const [discussion, setDiscussion] = useState(null);
    const [questions, setQuestions] = useState([]);
    const [error, setError] = useState(null);
    const snapshots = useOpinionSnapshotsPanel(socket);
    const [presence, setPresence] = useState(0);
    const [discussionState, setDiscussionState] = useState({
        locked: false, moderatorOnly: false, hasModerator: false, theme: DEFAULT_THEME,
        reactionsEnabled: false, reactionsVisible: true, commentsEnabled: false, questionDownvotesEnabled: false,
        reactionKeys: ALL_REACTION_KEYS,
    });
    // Losing moderator access closes the participant list, so whether it is
    // shown is decided here, before useModeratorAccess.
    const [showParticipants, setShowParticipants] = useState(false);

    const closeParticipants = useCallback(() => setShowParticipants(false), []);
    const {
        identity, userId, displayName, effectivePseudonym, pseudonymReserved,
        shufflePending, selfHandle, ownedVoteIds, ownedCommentIds,
        interestedQuestionIds, downvotedQuestionIds, interestReady, isMyVote, handlePseudonymSync, handleRegeneratePseudonym,
        handleSelectNameMode, handleCustomNameChange,
    } = useParticipantIdentity(socket, { topic, discussionSlug, discussionId: discussion?.id, questions });
    const questionInterest = useQuestionInterest(socket, {
        discussionSlug, userId, questions, interestedQuestionIds, downvotedQuestionIds, interestReady,
    });
    const {
        adminToken, setAdminToken, canDemote, setCanDemote,
        handleModeratorGranted, handleModeratorRevoked,
    } = useModeratorAccess(socket, {
        topic, discussionSlug,
        discussionTitle: discussion?.slug === discussionSlug ? discussion.topic : null,
        onRevoked: closeParticipants,
    });

    const moderatorLink = useModeratorLinkPrompt(discussionSlug, adminToken);
    const isAdmin = !!adminToken;
    const titleEditor = useDiscussionTitleEditor(socket, { discussion, discussionSlug, adminToken, setError });
    const share = useShareLinks({ discussionSlug, shortCode: discussion?.short_code, adminToken, moderatorLink, setError });
    const actions = useDiscussionActions(socket, { discussionSlug, adminToken, isAdmin, navigate, setError });
    const approvalRequired = discussionState.postingMode === 'approval' && !isAdmin;
    const composer = useQuestionComposer({ socket, discussionSlug, adminToken, setError, approvalRequired });
    const { onQuestionsLoaded, onSimilarQuestion } = composer;
    const { locked, moderatorOnly } = discussionState;
    // Which epistemic reactions are active for this session (creator-configurable,
    // a subset of the catalog). Falls back to the full catalog until the server's
    // discussionState arrives.
    const activeReactionKeys = discussionState.reactionKeys || ALL_REACTION_KEYS;
    const discussionTitle = discussion?.topic || topic;

    useCanonicalRoute(topic, discussionSlug, navigate);
    const showClusters = useClustersFlag(topic);

    const handleClaimModerator = () => {
        socket.emit('claimModerator', discussionSlug, (resp) => {
            if (resp && resp.success) {
                try {
                    localStorage.setItem(`convora_admin_${discussionSlug}`, resp.token);
                } catch (e) {
                    console.warn('Failed to store admin token:', e);
                }
                setAdminToken(resp.token);
            } else {
                setError('This discussion already has a moderator.');
            }
        });
    };

    const handleQuestionsUpdate = useCallback((updatedQuestions) => {
        onQuestionsLoaded();
        setQuestions(prevQuestions => {
            // The server always emits a full snapshot of the discussion's
            // questions, so we rebuild the list from the incoming set. Building
            // a fresh map (rather than merging into the previous one) prunes any
            // question the moderator deleted — ids absent from the snapshot drop
            // out instead of lingering as visible/votable stale entries.
            const prevMap = new Map(prevQuestions.map(q => [q.id, q]));
            const nextMap = new Map();
            updatedQuestions.forEach(q => {
                const prev = prevMap.get(q.id);
                nextMap.set(q.id, {
                    timestamp: Date.now(),
                    ...prev,
                    ...q,
                    ...(q.type === QuestionTypes.NUMERICAL ? getNumericalRange(q) : {}),
                    votes: q.votes || prev?.votes || [],
                });
            });
            return Array.from(nextMap.values());
        });
    }, [onQuestionsLoaded]);

    const brainstorm = useBrainstormResponses(socket, { topic, userId, displayName, identity, adminToken });

    useDiscussionRoom(socket, {
        topic, discussionSlug, userId,
        onDiscussion: setDiscussion, onQuestions: handleQuestionsUpdate,
        onPresence: setPresence, onState: setDiscussionState,
        onSimilarQuestion, onBrainstormState: brainstorm.setMyBrainstorm,
        onModeratorGranted: handleModeratorGranted, onModeratorRevoked: handleModeratorRevoked,
        onPseudonymSync: handlePseudonymSync,
        // The server's reason for refusing an action, such as a vote sent just
        // as the discussion was locked. Nothing else would tell the participant.
        onError: payload => { if (typeof payload?.message === 'string') setError(payload.message); },
    });

    const speakingQueue = useSpeakingQueue(socket, discussionSlug, discussion?.slug === discussionSlug && discussionState.handsEnabled, userId, adminToken, displayName);
    const theme = useDiscussionTheme(discussionState.theme);
    const participantList = useModeratorParticipants(socket, {
        discussionSlug, adminToken, setCanDemote, setError, showParticipants, setShowParticipants,
    });
    const moderation = useQuestionModeration(socket, { discussionSlug, adminToken });
    const votes = useVoteActions(socket, { sendVote, discussionSlug, userId, displayName, identity, adminToken });
    const filters = useQuestionFilters(questions, isMyVote);
    const { orderedQuestions, queuedQuestions, filtersActive, canArrangePublished } = filters;

    // What VotingControls passes on to OpenEndedQuestion for brainstorm answers.
    const openEnded = {
        ownedVoteIds,
        ownedCommentIds,
        handleDeleteVote: votes.handleDeleteVote,
        isAdmin,
        myBrainstorm: brainstorm.myBrainstorm,
        activeReactionKeys,
        onSetRating: brainstorm.handleSetRating,
        onToggleReaction: brainstorm.handleToggleReaction,
        onAddComment: brainstorm.handleAddComment,
        onDeleteComment: brainstorm.handleDeleteComment,
        onModeratorDeleteVote: votes.handleModeratorDeleteVote,
        onModeratorDeleteComment: brainstorm.handleModeratorDeleteComment,
    };

    return (
        <div
            ref={actions.discussionContentRef}
            role="region"
            aria-label={`Discussion: ${topic}`}
            tabIndex={-1}
            className="max-w-4xl mx-auto mt-10 sm:px-4"
        >
            <DiscussionTitle title={discussionTitle} isAdmin={isAdmin} canRename={!!discussion?.topic} editor={titleEditor} />

            <IdentityBar
                identity={identity}
                displayName={displayName}
                presence={presence}
                effectivePseudonym={effectivePseudonym}
                pseudonymReserved={pseudonymReserved}
                shufflePending={shufflePending}
                onSelectNameMode={handleSelectNameMode}
                onRegeneratePseudonym={handleRegeneratePseudonym}
                onCustomNameChange={handleCustomNameChange}
            />

            <DiscussionToolbar
                topic={topic}
                discussionSlug={discussionSlug}
                isAdmin={isAdmin}
                canDemote={canDemote}
                showClusters={showClusters}
                showSnapshots={snapshots.showSnapshots}
                shareButtonRef={share.shareButtonRef}
                actionsMenuButtonRef={actions.actionsMenuButtonRef}
                onShare={() => share.setShowShareModal(true)}
                onToggleSnapshots={() => snapshots.setShowSnapshots(open => !open)}
                onDuplicate={actions.duplicate.onOpen}
                onClear={actions.clear.onOpen}
                onDelete={actions.remove.onOpen}
            />

            {snapshots.showSnapshots && (
                <OpinionSnapshots
                    key={discussionSlug}
                    discussionSlug={discussionSlug}
                    adminToken={adminToken}
                    userId={userId}
                    refreshSignal={snapshots.snapshotRefreshSignal}
                    display={{
                        layout: discussionState.displayLayout,
                        beforeId: discussionState.displayBeforeSnapshotId ?? undefined,
                        afterId: discussionState.displayAfterSnapshotId ?? undefined,
                    }}
                    onDisplay={isAdmin ? (settings) => socket.emit('setDisplaySettings', discussionSlug, settings, adminToken) : undefined}
                />
            )}

            {actions.clear.cleared && <p role="status">{actions.clear.cleared.refreshed
                ? 'Votes and responses cleared. Your questions are still here.'
                : 'Votes and responses were cleared, but the live view did not update. Ask anyone still seeing old responses to reload. Do not clear again.'}</p>}
            {actions.clear.open && <ClearResponsesDialog action={actions.clear} discussionTitle={discussionTitle} />}
            {actions.remove.open && <DeleteDiscussionDialog action={actions.remove} discussionTitle={discussionTitle} />}
            {actions.duplicate.open && <DuplicateDiscussionDialog action={actions.duplicate} />}
            {share.showShareModal && <ShareDialog share={share} isAdmin={isAdmin} />}

            <ModeratorControls
                socket={socket}
                topic={topic}
                discussionSlug={discussionSlug}
                adminToken={adminToken}
                isAdmin={isAdmin}
                discussionState={discussionState}
                theme={theme}
                activeReactionKeys={activeReactionKeys}
                moderatorLink={moderatorLink}
                share={share}
                participantList={participantList}
                selfHandle={selfHandle}
                canDemote={canDemote}
                showParticipants={showParticipants}
                onClaimModerator={handleClaimModerator}
            />

            {/* Locked banner */}
            {locked && (
                <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-md p-3 text-center">
                    🔒 This discussion is locked. Voting and new statements are closed.
                </div>
            )}

            {/* Near-duplicate prompt */}
            <QuestionComposer composer={composer} questionCount={questions.length}
                locked={locked} moderatorOnly={moderatorOnly} isAdmin={isAdmin} approvalRequired={approvalRequired} />
            {error && <div className="text-red-500 mb-4">{error}</div>}
            {connectionLost && (
                <div
                    role="status"
                    className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-4 py-2 text-sm text-white shadow-lg"
                >
                    Connection lost. Reconnecting…
                </div>
            )}
            {isAdmin && queuedQuestions.length > 0 && (
                <QueuedQuestions queuedQuestions={queuedQuestions} locked={locked} moderation={moderation} />
            )}
            <QuestionFilters filters={filters} />

            {/* Questions list */}
            {filtersActive && orderedQuestions.length === 0 && (
                <p role="status" className="mb-3 text-gray-600">No questions match your filters.</p>
            )}
            {isAdmin && orderedQuestions.length > 1 && (
                <p className="mb-3 text-sm text-gray-600">{canArrangePublished
                    ? 'Use Move up or Move down to change the order participants see. Pinned questions stay first.'
                    : 'To rearrange questions, choose Moderator order, select All types, and turn off the unanswered filter.'}</p>
            )}
            {orderedQuestions.map((question, index) => (
                <QuestionCard
                    key={question.id}
                    question={question}
                    previous={orderedQuestions[index - 1]}
                    next={orderedQuestions[index + 1]}
                    socket={socket}
                    discussionSlug={discussionSlug}
                    adminToken={adminToken}
                    discussionState={discussionState}
                    locked={locked}
                    isAdmin={isAdmin}
                    canArrangePublished={canArrangePublished}
                    moderation={moderation}
                    questionInterest={questionInterest}
                    interestedQuestionIds={interestedQuestionIds}
                    downvotedQuestionIds={downvotedQuestionIds}
                    isMyVote={isMyVote}
                    interestReady={interestReady}
                    userId={userId}
                    connectionLost={connectionLost}
                    pendingVotes={pendingVotes}
                    speakingQueue={speakingQueue}
                    displayName={displayName}
                >
                    <VotingControls
                        question={question}
                        locked={locked}
                        pendingVotes={pendingVotes}
                        sliderValues={votes.sliderValues}
                        isMyVote={isMyVote}
                        handleVote={votes.handleVote}
                        handleClearVote={votes.handleClearVote}
                        handleSliderChange={votes.handleSliderChange}
                        openEnded={openEnded}
                    />
                </QuestionCard>
            ))}
        </div>
    );
};

export default DiscussionPage;
