import { useState } from 'react';
import { getEffectiveNameMode } from '../identity';

// Answering questions: sending, undoing, and deleting votes, and the
// numerical drafts a participant has typed or dragged but not yet submitted.
export function useVoteActions(socket, { sendVote, discussionSlug, userId, displayName, identity, adminToken }) {
    const [sliderValues, setSliderValues] = useState({});

    // onResult is optional. The server acks a stored vote with { added: true }
    // and free-text limits with { added: false, reason: 'limit' }.
    const handleVote = (questionId, value, onResult) => {
        // Send the name mode too: in pseudonym mode the server persists our
        // reserved handle instead of this possibly-pre-reservation displayName,
        // closing the submit-before-reservation collision window (#57). We send the
        // EFFECTIVE mode so a blank-custom name (shown as the pseudonym) canonicalizes.
        // A vote means "set my answer to this value" and is safe to repeat; undo
        // is the separate handleClearVote. While one is awaiting the server's
        // acknowledgment the question's controls are disabled and a second
        // submission is refused (#72).
        const args = [discussionSlug, questionId, value, userId, displayName, getEffectiveNameMode(identity)];
        const draft = sliderValues[questionId];
        args.push(result => {
            // A refused answer goes back into the draft it was cleared from
            // below, unless the participant has started another since.
            if (!result?.ok && draft !== undefined) {
                setSliderValues(prev => (prev[questionId] === undefined ? { ...prev, [questionId]: draft } : prev));
            }
            if (typeof onResult === 'function') onResult(result);
        });
        const sent = sendVote(questionId, value, 'vote', ...args);
        if (!sent) return;
        setSliderValues(prev => ({ ...prev, [questionId]: undefined }));
    };

    // Explicit undo for Agreement and Yes/No votes.
    const handleClearVote = (questionId) => {
        sendVote(questionId, null, 'clearVote', discussionSlug, questionId, userId);
    };

    // Brainstorm answers are individual rows, so they're removed by vote id
    // (a participant can only delete their own).
    const handleDeleteVote = (questionId, voteId) => {
        socket.emit('deleteVote', discussionSlug, voteId, userId);
    };

    // Moderator-only: remove any participant's response/idea, regardless of
    // owner (spam control). The server re-checks the admin token.
    const handleModeratorDeleteVote = (questionId, voteId) => {
        socket.emit('moderatorDeleteVote', discussionSlug, voteId, adminToken);
    };

    const handleSliderChange = (questionId, value) => {
        setSliderValues(prev => ({ ...prev, [questionId]: value }));
    };

    return { sliderValues, handleVote, handleClearVote, handleDeleteVote, handleModeratorDeleteVote, handleSliderChange };
}
