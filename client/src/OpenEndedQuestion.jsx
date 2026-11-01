import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';

const OpenEndedQuestion = ({ question, userVote, handleVote, ownedVoteIds, upvotedVoteIds, handleResponseVote, locked, isAdmin, onModeratorDeleteVote }) => {
    const savedResponse = userVote?.value ?? '';
    const [response, setResponse] = useState(savedResponse);

    // Socket broadcasts recreate vote objects even when this answer is unchanged.
    // Only a changed saved answer or question should replace the local draft.
    useEffect(() => {
        setResponse(savedResponse);
    }, [question.id, savedResponse]);

    // Most-upvoted responses first; ties keep submission order (vote id).
    const sortedResponses = [...(question.votes || [])].sort(
        (a, b) => (b.upvotes || 0) - (a.upvotes || 0) || a.id - b.id
    );

    return (
        <div>
            {!locked && (
                <>
                    <textarea
                        value={response}
                        onChange={(e) => setResponse(e.target.value)}
                        className="w-full p-2 border rounded mb-2"
                        rows="4"
                        placeholder="Enter your response here"
                    />
                    <button
                        onClick={() => {
                            const trimmed = response.trim();
                            if (trimmed === '') {
                                return;
                            }
                            handleVote(question.id, trimmed);
                        }}
                        disabled={response.trim() === ''}
                        className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90 transition duration-300 mb-4 disabled:opacity-50"
                    >
                        {userVote ? 'Update Response' : 'Submit Response'}
                    </button>
                </>
            )}

            {question.votes && question.votes.length > 0 && (
                <div className="mt-4">
                    <h3 className="font-semibold mb-2">All Responses:</h3>
                    <ul className="space-y-2">
                        {sortedResponses.map((vote) => {
                            // Ownership is matched via the per-response token
                            // (the server no longer sends raw user ids); the
                            // parent precomputes the set of ids we own/upvoted.
                            const isOwnResponse = ownedVoteIds.has(vote.id);
                            const isYou = isOwnResponse;
                            const upvotes = vote.upvotes || 0;
                            const hasUpvoted = upvotedVoteIds.has(vote.id);
                            return (
                                <li key={vote.id} className="bg-gray-50 rounded-md p-3 flex items-start gap-3">
                                    <button
                                        onClick={() => handleResponseVote(vote.id)}
                                        disabled={isOwnResponse || locked}
                                        title={isOwnResponse ? "You can't upvote your own response" : 'Upvote'}
                                        className={`flex flex-col items-center justify-center px-2 py-1 rounded-md border transition duration-200 ${hasUpvoted
                                            ? 'bg-primary text-white border-primary'
                                            : 'bg-white text-gray-600 border-gray-300 hover:border-primary'
                                            } ${(isOwnResponse || locked) ? 'opacity-40 cursor-not-allowed' : ''}`}
                                    >
                                        <span className="leading-none">▲</span>
                                        <span className="text-xs font-semibold">{upvotes}</span>
                                    </button>
                                    <div className="flex-1">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="text-xs font-semibold text-gray-500 mb-1">
                                                {vote.pseudonym || 'Anonymous'}
                                                {isYou && ' (you)'}
                                            </div>
                                            {isAdmin && (
                                                <button
                                                    onClick={() => onModeratorDeleteVote(question.id, vote.id)}
                                                    title="Remove this response (moderator)"
                                                    className="text-xs text-red-500 hover:text-red-700 shrink-0"
                                                >
                                                    Remove
                                                </button>
                                            )}
                                        </div>
                                        <div className="text-gray-800 whitespace-pre-wrap">{vote.value}</div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </div>
    );
};

OpenEndedQuestion.propTypes = {
    question: PropTypes.shape({
        id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
        votes: PropTypes.arrayOf(PropTypes.shape({
            ownerToken: PropTypes.string,
            value: PropTypes.string.isRequired,
            pseudonym: PropTypes.string,
            upvotes: PropTypes.number,
            upvoterTokens: PropTypes.array
        }))
    }).isRequired,
    userVote: PropTypes.shape({
        ownerToken: PropTypes.string,
        value: PropTypes.string
    }),
    handleVote: PropTypes.func.isRequired,
    ownedVoteIds: PropTypes.instanceOf(Set).isRequired,
    upvotedVoteIds: PropTypes.instanceOf(Set).isRequired,
    handleResponseVote: PropTypes.func.isRequired,
    locked: PropTypes.bool,
    isAdmin: PropTypes.bool,
    onModeratorDeleteVote: PropTypes.func
};

export default OpenEndedQuestion;
