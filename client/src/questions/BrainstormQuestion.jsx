import PropTypes from 'prop-types';
import React, { useState } from 'react';
import { AgreementMiniBar } from './OpinionResults';
import { AGREEMENT_SCALE, AGREEMENT_SHORT, EPISTEMIC_REACTIONS } from './config';

// A single brainstorm idea, with optional two-axis rating (quality up/down +
// agreement scale), epistemic reactions, and a comment thread — each shown only
// when the moderator has enabled/revealed it. Rating and reaction counts are
// aggregates; only this user's own selections (myRating/myReactions) are known
// to the client, so nothing reveals who voted which way.
const BrainstormIdea = ({
    vote, isOwn, isAdmin, ownedCommentIds, reactionsActive, activeReactionKeys, commentsEnabled, locked,
    myRating, myReactions, onDeleteVote, onModeratorDelete, onSetRating, onToggleReaction,
    onAddComment, onDeleteComment, onModeratorDeleteComment,
}) => {
    const [comment, setComment] = useState('');
    const net = (vote.qualityUp || 0) - (vote.qualityDown || 0);
    const comments = vote.comments || [];
    // You can't rate/react to your own idea (the server rejects it too), so
    // disable those controls on own ideas — but commenting on your own idea is
    // fine. Counts/histogram stay visible read-only either way.
    const ratingDisabled = locked || isOwn;

    const submitComment = () => {
        const trimmed = comment.trim();
        if (trimmed === '') return;
        onAddComment(vote.id, trimmed);
        setComment('');
    };

    return (
        <li className="bg-gray-50 rounded-md p-3">
            <div className="flex items-start gap-3">
                {reactionsActive && (
                    <div className="flex flex-col items-center shrink-0 select-none">
                        <button
                            type="button"
                            onClick={() => onSetRating(vote.id, 'quality', 1)}
                            disabled={ratingDisabled}
                            title="Worth considering"
                            className={`leading-none text-lg ${myRating.quality === 1 ? 'text-primary' : 'text-gray-400 hover:text-gray-600'} ${ratingDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >▲</button>
                        <span className="text-xs font-semibold text-gray-700">{net > 0 ? `+${net}` : net}</span>
                        <button
                            type="button"
                            onClick={() => onSetRating(vote.id, 'quality', -1)}
                            disabled={ratingDisabled}
                            title="Not worth considering"
                            className={`leading-none text-lg ${myRating.quality === -1 ? 'text-red-500' : 'text-gray-400 hover:text-gray-600'} ${ratingDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >▼</button>
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                        <span className="text-gray-800 whitespace-pre-wrap">
                            {vote.value}
                            {isOwn && <span className="text-xs text-gray-500"> (You)</span>}
                        </span>
                        {(isOwn || isAdmin) && (
                            <button
                                onClick={isOwn ? onDeleteVote : onModeratorDelete}
                                title={isOwn ? undefined : 'Remove this idea (moderator)'}
                                className="ml-2 text-sm text-red-500 hover:text-red-700 shrink-0"
                            >
                                {isOwn ? 'Delete' : 'Remove'}
                            </button>
                        )}
                    </div>

                    {reactionsActive && (
                        <div className="mt-2">
                            <div className="flex flex-wrap gap-1">
                                {AGREEMENT_SCALE.map(seg => (
                                    <button
                                        key={seg.key}
                                        type="button"
                                        onClick={() => onSetRating(vote.id, 'agreement', seg.key)}
                                        disabled={ratingDisabled}
                                        title={seg.label}
                                        className={`px-2 py-0.5 text-xs rounded border ${myRating.agreement === seg.key
                                            ? 'bg-primary text-white border-primary'
                                            : 'bg-white text-gray-600 border-gray-300 hover:border-primary'} ${ratingDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    >
                                        {AGREEMENT_SHORT[seg.key]}
                                    </button>
                                ))}
                            </div>
                            <AgreementMiniBar counts={vote.agreementCounts || {}} />
                        </div>
                    )}

                    {reactionsActive && (
                        <div className="flex flex-wrap gap-1 mt-2">
                            {EPISTEMIC_REACTIONS.filter(r => activeReactionKeys.includes(r.key)).map(r => {
                                const count = (vote.reactionCounts || {})[r.key] || 0;
                                const active = myReactions.includes(r.key);
                                return (
                                    <button
                                        key={r.key}
                                        type="button"
                                        onClick={() => onToggleReaction(vote.id, r.key)}
                                        disabled={ratingDisabled}
                                        title={r.label}
                                        className={`px-2 py-0.5 text-xs rounded-full border ${active
                                            ? 'bg-indigo-100 border-indigo-400 text-indigo-800'
                                            : 'bg-white border-gray-300 text-gray-600 hover:border-indigo-300'} ${ratingDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    >
                                        <span className="mr-1">{r.emoji}</span>{r.label}
                                        {count > 0 && <span className="ml-1 font-semibold">{count}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {commentsEnabled && (
                        <div className="mt-3 border-t border-gray-200 pt-2">
                            {comments.length > 0 && (
                                <ul className="space-y-1 mb-2">
                                    {comments.map(c => (
                                        <li key={c.id} className="text-sm flex items-start justify-between gap-2">
                                            <span>
                                                <span className="font-semibold text-gray-600">{c.pseudonym || 'Anonymous'}:</span>{' '}
                                                <span className="text-gray-800 whitespace-pre-wrap">{c.body}</span>
                                            </span>
                                            {(ownedCommentIds.has(c.id) || isAdmin) && (
                                                <button
                                                    onClick={() => (ownedCommentIds.has(c.id) ? onDeleteComment(c.id) : onModeratorDeleteComment(c.id))}
                                                    title={ownedCommentIds.has(c.id) ? undefined : 'Remove this comment (moderator)'}
                                                    className="text-xs text-red-500 hover:text-red-700 shrink-0"
                                                >
                                                    {ownedCommentIds.has(c.id) ? 'Delete' : 'Remove'}
                                                </button>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {!locked && (
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={comment}
                                        onChange={(e) => setComment(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') submitComment(); }}
                                        placeholder="Add a comment"
                                        className="flex-1 min-w-0 p-1.5 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                    />
                                    <button
                                        onClick={submitComment}
                                        disabled={comment.trim() === ''}
                                        className="shrink-0 px-3 py-1 text-sm bg-primary text-white rounded hover:bg-opacity-90 disabled:opacity-50"
                                    >
                                        Post
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </li>
    );
};

BrainstormIdea.propTypes = {
    vote: PropTypes.shape({
        id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
        value: PropTypes.string.isRequired,
        ownerToken: PropTypes.string,
        qualityUp: PropTypes.number,
        qualityDown: PropTypes.number,
        agreementCounts: PropTypes.object,
        reactionCounts: PropTypes.object,
        comments: PropTypes.array,
    }).isRequired,
    isOwn: PropTypes.bool,
    isAdmin: PropTypes.bool,
    ownedCommentIds: PropTypes.instanceOf(Set).isRequired,
    reactionsActive: PropTypes.bool,
    commentsEnabled: PropTypes.bool,
    activeReactionKeys: PropTypes.array.isRequired,
    locked: PropTypes.bool,
    myRating: PropTypes.object,
    myReactions: PropTypes.array,
    onDeleteVote: PropTypes.func.isRequired,
    onModeratorDelete: PropTypes.func,
    onSetRating: PropTypes.func.isRequired,
    onToggleReaction: PropTypes.func.isRequired,
    onAddComment: PropTypes.func.isRequired,
    onDeleteComment: PropTypes.func.isRequired,
    onModeratorDeleteComment: PropTypes.func,
};

// Participants can add any number of separate ideas and delete their own. The
// moderator can layer reactions (two-axis ratings + epistemic reactions) and
// comments on top, revealing them when the room shifts from generating ideas to
// evaluating them.
const BrainstormQuestion = ({
    question, ownedVoteIds, ownedCommentIds, handleVote, handleDeleteVote, locked, isAdmin, myBrainstorm,
    activeReactionKeys, onSetRating, onToggleReaction, onAddComment, onDeleteComment,
    onModeratorDeleteVote, onModeratorDeleteComment,
}) => {
    const [idea, setIdea] = useState('');
    const votes = question.votes || [];
    // Whether reactions/comments are available is set discussion-wide by the
    // moderator (see the moderator bar in DiscussionPage); each question carries
    // the resolved flags via getQuestions.
    const reactionsEnabled = question.reactionsEnabled;
    const reactionsVisible = question.reactionsVisible;
    const commentsEnabled = question.commentsEnabled;
    const reactionsActive = reactionsEnabled && reactionsVisible;

    const submitIdea = () => {
        if (idea.trim() === '') {
            return;
        }
        handleVote(question.id, idea.trim());
        setIdea('');
    };

    return (
        <div>
            {!locked && (
                <>
                    <textarea
                        value={idea}
                        onChange={(e) => setIdea(e.target.value)}
                        className="w-full p-2 border rounded mb-2"
                        rows="3"
                        placeholder="Add an idea (you can add as many as you like)"
                    />
                    <button
                        onClick={submitIdea}
                        disabled={idea.trim() === ''}
                        className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90 transition duration-300 mb-4 disabled:opacity-50"
                    >
                        Add Idea
                    </button>
                </>
            )}

            {reactionsEnabled && !reactionsVisible && (
                <p className="text-sm text-gray-500 mb-2">
                    Reactions are hidden for now — the moderator will open them up for the discussion.
                </p>
            )}

            {votes.length > 0 && (
                <div className="mt-4">
                    <h3 className="font-semibold mb-2">All Ideas ({votes.length}):</h3>
                    <ul className="space-y-2">
                        {votes.map((vote) => (
                            <BrainstormIdea
                                key={vote.id}
                                vote={vote}
                                // Ownership is matched via the per-response token
                                // (the server no longer sends raw user ids); the
                                // parent precomputes the sets of ids we own.
                                isOwn={ownedVoteIds.has(vote.id)}
                                isAdmin={isAdmin}
                                ownedCommentIds={ownedCommentIds}
                                reactionsActive={reactionsActive}
                                activeReactionKeys={activeReactionKeys}
                                commentsEnabled={commentsEnabled}
                                locked={locked}
                                myRating={myBrainstorm.ratings[vote.id] || {}}
                                myReactions={myBrainstorm.reactions[vote.id] || []}
                                onDeleteVote={() => handleDeleteVote(question.id, vote.id)}
                                onModeratorDelete={() => onModeratorDeleteVote(question.id, vote.id)}
                                onSetRating={onSetRating}
                                onToggleReaction={onToggleReaction}
                                onAddComment={onAddComment}
                                onDeleteComment={onDeleteComment}
                                onModeratorDeleteComment={onModeratorDeleteComment}
                            />
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};

BrainstormQuestion.propTypes = {
    question: PropTypes.shape({
        id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
        reactionsEnabled: PropTypes.bool,
        reactionsVisible: PropTypes.bool,
        commentsEnabled: PropTypes.bool,
        votes: PropTypes.arrayOf(PropTypes.shape({
            id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
            ownerToken: PropTypes.string,
            value: PropTypes.string.isRequired
        }))
    }).isRequired,
    ownedVoteIds: PropTypes.instanceOf(Set).isRequired,
    ownedCommentIds: PropTypes.instanceOf(Set).isRequired,
    handleVote: PropTypes.func.isRequired,
    handleDeleteVote: PropTypes.func.isRequired,
    locked: PropTypes.bool,
    isAdmin: PropTypes.bool,
    myBrainstorm: PropTypes.shape({
        ratings: PropTypes.object,
        reactions: PropTypes.object,
    }).isRequired,
    activeReactionKeys: PropTypes.array.isRequired,
    onSetRating: PropTypes.func.isRequired,
    onToggleReaction: PropTypes.func.isRequired,
    onAddComment: PropTypes.func.isRequired,
    onDeleteComment: PropTypes.func.isRequired,
    onModeratorDeleteVote: PropTypes.func,
    onModeratorDeleteComment: PropTypes.func,
};

export default BrainstormQuestion;
