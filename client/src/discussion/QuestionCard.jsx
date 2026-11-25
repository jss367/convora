import React from 'react';
import PropTypes from 'prop-types';
import { formatPrompt } from '../questions/formatPrompt';
import { plainPrompt } from '../questions/promptEmphasis.mjs';
import QuestionEditor from '../questions/QuestionEditor';
import QuestionTools from '../questions/QuestionTools';
import SpeakingQueue from '../questions/SpeakingQueue';
import { QuestionTypes } from '../questions/config';

// A moderator's controls for one published question: reorder, edit, reveal
// results, choose what the room display shows, pin, and delete.
function ModeratorQuestionControls({ question, previous, next, discussionState, canArrangePublished, moderation }) {
    const {
        setEditingQuestionId, spotlightErrorFor, handleDeleteQuestion, handleToggleResultsRevealed,
        handleTogglePin, handleShowOnDisplay, handleSetHiddenOnDisplay, swapPublishedQuestions,
    } = moderation;
    // A question can only be edited before anyone has responded — once
    // it has votes, its wording is locked in (matches the server guard).
    const hasResponses = (question.votes?.length || 0) > 0;
    const hiddenOnDisplay = discussionState.displayHiddenQuestionIds?.includes(question.id);
    // Whether the room display is showing this question on its own: its
    // live results, or its before-and-after comparison.
    const onDisplay = ['focus', 'compare'].includes(discussionState.displayLayout)
        && discussionState.displayQuestionId === question.id;
    const returnLabel = {
        all: 'Back to all questions',
        focus: 'Resume automatic selection',
        compare: 'Back to full comparison',
    }[discussionState.displayBaseLayout || discussionState.displayLayout];
    const spotlightError = spotlightErrorFor(question.id);
    return (
        <div className="flex flex-wrap justify-end gap-2 ml-auto max-w-full">
            {canArrangePublished && [['up', previous], ['down', next]].map(([direction, neighbor]) => (
                <button key={direction} disabled={!neighbor || neighbor.pinned !== question.pinned}
                    aria-label={`Move ${direction}: ${question.text}`}
                    onClick={() => direction === 'up' ? swapPublishedQuestions(neighbor, question) : swapPublishedQuestions(question, neighbor)}
                    className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-50"
                >Move {direction}</button>
            ))}
            {!hasResponses && (
                <button
                    onClick={() => setEditingQuestionId(question.id)}
                    className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                >
                    Edit
                </button>
            )}
            {question.independentAnswers && !question.queued && !question.resultsRevealed && (
                <button onClick={() => handleToggleResultsRevealed(question.id, false)}
                    className="text-xs px-2 py-1 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50">
                    Reveal answers
                </button>
            )}
            {discussionState.resultsVisibility !== 'always'
                && [QuestionTypes.AGREEMENT, QuestionTypes.YES_NO, QuestionTypes.MULTIPLE_CHOICE, QuestionTypes.NUMERICAL].includes(question.type) && (
                <button
                    onClick={() => handleToggleResultsRevealed(question.id, question.resultsRevealed)}
                    aria-pressed={question.resultsRevealed === true}
                    title={question.resultsRevealed
                        ? 'Go back to showing results only to people who have voted'
                        : 'Show the results to everyone now, including on the room display. The first time, a “before” snapshot of the room’s answers is saved.'}
                    className="text-xs px-2 py-1 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                >
                    {question.resultsRevealed ? 'Hide results' : 'Show results'}
                </button>
            )}
            {!hiddenOnDisplay && <button
                onClick={() => handleShowOnDisplay(onDisplay ? null : question.id)}
                title={onDisplay ? returnLabel : 'Show this question on its own on the room display'}
                className={`text-xs px-2 py-1 rounded border border-indigo-300 ${onDisplay
                    ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                    : 'text-indigo-700 hover:bg-indigo-50'}`}
            >
                {onDisplay ? returnLabel : 'Show on display'}
            </button>}
            {spotlightError && (
                <span role="alert" className="text-sm text-red-700">{spotlightError.message}</span>
            )}
            <button
                onClick={() => handleSetHiddenOnDisplay(question.id, !hiddenOnDisplay)}
                title={hiddenOnDisplay ? 'Include this question on the room display again' : 'Hide this question on the room display only. Participants can still answer it.'}
                className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
            >
                {hiddenOnDisplay ? 'Restore to display' : 'Hide from display'}
            </button>
            <button
                onClick={() => handleTogglePin(question.id, question.pinned)}
                className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
            >
                {question.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button
                onClick={() => handleDeleteQuestion(question.id)}
                className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50"
            >
                Delete
            </button>
        </div>
    );
}

ModeratorQuestionControls.propTypes = {
    question: PropTypes.object.isRequired,
    previous: PropTypes.object,
    next: PropTypes.object,
    discussionState: PropTypes.object.isRequired,
    canArrangePublished: PropTypes.bool.isRequired,
    moderation: PropTypes.object.isRequired,
};

// One published question: its upvote/downvote buttons and prompt, the
// moderator's controls, the answer controls passed as children, the question's
// tools, and its speaking queue. A moderator editing it sees the editor instead.
export default function QuestionCard({
    question, previous, next, children, socket, discussionSlug, adminToken, discussionState, locked, isAdmin,
    canArrangePublished, moderation, questionInterest, interestedQuestionIds, downvotedQuestionIds,
    isMyVote, interestReady, userId, connectionLost, pendingVotes, speakingQueue, displayName,
}) {
    const { editingQuestionId, editingDrafts, setEditingDrafts, closeQuestionEditor, handleEditQuestion } = moderation;
    const handleToggleInterest = questionInterest.toggle;
    const isEditing = editingQuestionId === question.id;
    const questionVotes = [{ name: 'Upvote', symbol: '▲', direction: true, pressed: interestedQuestionIds.has(question.id), count: question.interestCount || 0 }];
    if (discussionState.questionDownvotesEnabled) questionVotes.push({ name: 'Downvote', symbol: '▼', direction: 'down', pressed: downvotedQuestionIds.has(question.id), count: question.downvoteCount || 0 });
    const interestPending = questionInterest.pending.has(question.id);
    return (
    <div data-question-id={question.id} className="bg-white shadow-lg rounded-lg p-6 mb-6">
        {isEditing ? (
            <QuestionEditor
                question={question}
                draft={editingDrafts[question.id]}
                onDraftChange={draft => setEditingDrafts(current => ({ ...current, [question.id]: draft }))}
                onSave={handleEditQuestion}
                onCancel={closeQuestionEditor}
            />
        ) : (
        <>
        {/* On a narrow screen the moderator's buttons wrap below the
            title instead of squeezing it into a thin column. */}
        <div className="flex flex-wrap justify-between items-start gap-x-4 gap-y-2 mb-4">
            <div className="flex items-start gap-3 min-w-0 flex-1 basis-64">
                <div className="shrink-0 flex flex-col gap-1">
                {questionVotes.map(({ name, symbol, direction, pressed, count }) => <button
                    key={name}
                    type="button"
                    onClick={() => handleToggleInterest(question.id, direction)}
                    disabled={locked || !questionInterest.ready || interestPending}
                    aria-busy={interestPending}
                    aria-pressed={pressed}
                    aria-label={`${name} "${plainPrompt(question.text)}"`}
                    aria-describedby={`${name}-count-${question.id}`}
                    className={`flex flex-col items-center px-2 py-1 rounded-md border transition duration-200 ${pressed
                        ? 'bg-primary text-white border-primary'
                        : 'bg-white text-gray-600 border-gray-300 hover:border-primary'} ${locked ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                    <span aria-hidden="true" className="leading-none">{symbol}</span>
                    <span id={`${name}-count-${question.id}`} className="text-xs font-semibold">
                        {count}<span className="sr-only"> {name.toLowerCase()}{count === 1 ? '' : 's'}</span>
                    </span>
                </button>)}
                </div>
                <h2 className="text-xl font-semibold min-w-0 break-words">
                    {question.pinned && <span className="mr-1" title="Pinned">📌</span>}
                    {formatPrompt(question.text)}
                </h2>
            </div>
            {isAdmin && (
                <ModeratorQuestionControls question={question} previous={previous} next={next}
                    discussionState={discussionState} canArrangePublished={canArrangePublished} moderation={moderation} />
            )}
        </div>
        <p className="mb-4 text-sm text-gray-500">Type: {question.type}</p>
        {children}
        <QuestionTools question={question} socket={socket} slug={discussionSlug} token={adminToken}
            vote={question.votes?.find(vote => isMyVote(question, vote))} locked={locked}
            disabled={!interestReady || !userId || connectionLost || pendingVotes[question.id] !== undefined} />
        {discussionState.handsEnabled && <SpeakingQueue queue={speakingQueue} questionId={question.id} moderator={isAdmin}
            locked={!!locked || connectionLost} name={displayName} />}
        </>
        )}
    </div>
    );
}

QuestionCard.propTypes = {
    question: PropTypes.object.isRequired,
    previous: PropTypes.object,
    next: PropTypes.object,
    children: PropTypes.node,
    socket: PropTypes.object.isRequired,
    discussionSlug: PropTypes.string.isRequired,
    adminToken: PropTypes.string,
    discussionState: PropTypes.object.isRequired,
    locked: PropTypes.bool,
    isAdmin: PropTypes.bool.isRequired,
    canArrangePublished: PropTypes.bool.isRequired,
    moderation: PropTypes.object.isRequired,
    questionInterest: PropTypes.shape({
        toggle: PropTypes.func.isRequired,
        ready: PropTypes.bool,
        pending: PropTypes.instanceOf(Set).isRequired,
    }).isRequired,
    interestedQuestionIds: PropTypes.instanceOf(Set).isRequired,
    downvotedQuestionIds: PropTypes.instanceOf(Set).isRequired,
    isMyVote: PropTypes.func.isRequired,
    interestReady: PropTypes.bool,
    userId: PropTypes.string,
    connectionLost: PropTypes.bool,
    pendingVotes: PropTypes.object.isRequired,
    speakingQueue: PropTypes.object.isRequired,
    displayName: PropTypes.string,
};
