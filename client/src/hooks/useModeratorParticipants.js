import { useCallback, useEffect, useState } from 'react';

// The moderator's participant list: who has voted or responded, and whether
// each is a moderator. The page owns whether the list is shown, because
// moderator access closes it when this user's moderator status is revoked.
export function useModeratorParticipants(socket, {
    discussionSlug, adminToken, setCanDemote, setError, showParticipants, setShowParticipants,
}) {
    const [participants, setParticipants] = useState([]);

    // Pull the participant list (moderator-only). The server returns opaque
    // handles + pseudonyms, never raw user ids.
    const refreshParticipants = useCallback(() => {
        if (!adminToken) return;
        socket.emit('listParticipants', discussionSlug, adminToken, (resp) => {
            if (resp && resp.success) {
                setParticipants(resp.participants);
                setCanDemote(!!resp.canDemote);
            } else if (resp && resp.error === 'not_authorized') {
                setError('You are no longer a moderator of this discussion.');
            }
        });
    }, [discussionSlug, adminToken]);

    const handleToggleParticipants = () => {
        const next = !showParticipants;
        setShowParticipants(next);
        if (next) refreshParticipants();
    };

    // Promote a participant to moderator. The server delivers them their own
    // token live and returns the refreshed list.
    const handlePromoteParticipant = (participantId) => {
        socket.emit('promoteModerator', discussionSlug, adminToken, participantId, (resp) => {
            if (resp && resp.success) {
                setParticipants(resp.participants);
                setCanDemote(!!resp.canDemote);
            } else if (resp && resp.error === 'participant_offline') {
                setError('That participant needs to have the discussion open to be made a moderator. Ask them to open it, then try again.');
            } else {
                setError('Could not promote that participant. Try refreshing the list.');
            }
        });
    };

    // Remove a participant's moderator status. Creator-only; the server pushes a
    // moderatorRevoked event to that user so their controls disappear live.
    const handleDemoteParticipant = (participantId) => {
        socket.emit('demoteModerator', discussionSlug, adminToken, participantId, (resp) => {
            if (resp && resp.success) {
                setParticipants(resp.participants);
                setCanDemote(!!resp.canDemote);
            } else if (resp && resp.error === 'not_authorized') {
                setError('Only the discussion creator can remove a moderator.');
            } else {
                setError('Could not remove that moderator. Try refreshing the list.');
            }
        });
    };

    // The participant list is fetched on request, so after navigation the
    // previous room's would stay on screen with buttons that act on this one.
    useEffect(() => {
        setParticipants([]);
        setShowParticipants(false);
    }, [discussionSlug]);

    return {
        participants, refreshParticipants, handleToggleParticipants,
        handlePromoteParticipant, handleDemoteParticipant,
    };
}
