import { useState } from 'react';
import { getEffectiveNameMode } from '../identity';

// Ratings, reactions, and comments on open-ended (brainstorm) responses.
export function useBrainstormResponses(socket, { topic, userId, displayName, identity, adminToken }) {
    // This user's own brainstorm ratings/reactions, kept separately from the
    // (aggregate-only, unattributable) broadcast so we can highlight their
    // selections. Only this user mutates it, so optimistic updates are safe; we
    // fetch the authoritative copy once on join to survive reloads.
    const [myBrainstorm, setMyBrainstorm] = useState({ ratings: {}, reactions: {} });

    // Set/clear one axis of this user's rating on a brainstorm idea. Toggles off
    // when the same value is re-selected. Updates local "mine" state optimistically
    // (no other actor can change this user's own rating) and tells the server.
    const handleSetRating = (responseId, axis, value) => {
        const current = myBrainstorm.ratings[responseId]?.[axis] ?? null;
        const next = current === value ? null : value;
        setMyBrainstorm(prev => {
            const ratings = { ...prev.ratings, [responseId]: { ...prev.ratings[responseId], [axis]: next } };
            return { ...prev, ratings };
        });
        socket.emit('setResponseRating', topic, responseId, axis, next, userId);
    };

    const handleToggleReaction = (responseId, reaction) => {
        setMyBrainstorm(prev => {
            const set = new Set(prev.reactions[responseId] || []);
            if (set.has(reaction)) set.delete(reaction); else set.add(reaction);
            return { ...prev, reactions: { ...prev.reactions, [responseId]: [...set] } };
        });
        socket.emit('toggleResponseReaction', topic, responseId, reaction, userId);
    };

    const handleAddComment = (responseId, body, onResult) => {
        // Pass the name mode so pseudonym-mode comments persist under our reserved
        // handle rather than a pre-reservation local pick (#57); see handleVote.
        socket.timeout(10000).emit('addResponseComment', topic, responseId, body, userId, displayName, getEffectiveNameMode(identity),
            (error, result) => onResult?.(!error && result?.added === true));
    };

    const handleDeleteComment = (commentId) => {
        socket.emit('deleteResponseComment', topic, commentId, userId);
    };

    // Moderator-only: remove any participant's comment, regardless of owner.
    const handleModeratorDeleteComment = (commentId) => {
        socket.emit('moderatorDeleteResponseComment', topic, commentId, adminToken);
    };

    return {
        myBrainstorm, setMyBrainstorm,
        handleSetRating, handleToggleReaction, handleAddComment, handleDeleteComment, handleModeratorDeleteComment,
    };
}
