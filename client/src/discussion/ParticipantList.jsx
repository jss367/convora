import React from 'react';
import PropTypes from 'prop-types';

// Participant management: promote a participant to moderator. Only people who
// have voted or responded appear here — the server can't name silent viewers.
export default function ParticipantList({ participants, selfHandle, canDemote, onRefresh, onPromote, onDemote }) {
    return (
        <div className="bg-white border border-indigo-100 rounded-md p-4 text-sm">
            <div className="flex items-center justify-between mb-3">
                <span className="font-semibold text-gray-700">Participants</span>
                <button
                    onClick={onRefresh}
                    className="text-xs text-indigo-600 underline hover:text-indigo-800"
                >
                    Refresh
                </button>
            </div>
            {participants.length === 0 ? (
                <p className="text-gray-500">
                    No participants yet. People show up here once they vote or post a response.
                </p>
            ) : (
                <ul className="divide-y divide-gray-100">
                    {participants.map((participant) => (
                        <li key={participant.id} className="flex items-center justify-between py-2">
                            <span className="text-gray-800">
                                {participant.pseudonym}
                                {participant.id === selfHandle && (
                                    <span className="text-gray-400"> (you)</span>
                                )}
                            </span>
                            {/* Never offer promote/remove on your own row: self-promote or
                                self-remove tangles the creator's admin_token with a per-user
                                grant. Show only the Moderator badge if applicable. */}
                            {participant.id === selfHandle ? (
                                participant.isModerator ? (
                                    <span className="text-xs font-medium text-indigo-700 bg-indigo-50 px-2 py-1 rounded">
                                        Moderator
                                    </span>
                                ) : null
                            ) : participant.isModerator ? (
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-indigo-700 bg-indigo-50 px-2 py-1 rounded">
                                        Moderator
                                    </span>
                                    {canDemote && (
                                        <button
                                            onClick={() => onDemote(participant.id)}
                                            className="text-xs px-2 py-1 rounded bg-white border border-red-300 text-red-600 hover:bg-red-50"
                                        >
                                            Remove
                                        </button>
                                    )}
                                </div>
                            ) : (
                                <button
                                    onClick={() => onPromote(participant.id)}
                                    className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700"
                                >
                                    Make moderator
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

ParticipantList.propTypes = {
    participants: PropTypes.arrayOf(PropTypes.shape({
        id: PropTypes.string.isRequired,
        pseudonym: PropTypes.string,
        isModerator: PropTypes.bool,
    })).isRequired,
    selfHandle: PropTypes.string,
    canDemote: PropTypes.bool.isRequired,
    onRefresh: PropTypes.func.isRequired,
    onPromote: PropTypes.func.isRequired,
    onDemote: PropTypes.func.isRequired,
};
