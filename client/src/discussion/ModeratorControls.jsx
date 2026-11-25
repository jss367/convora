import React from 'react';
import PropTypes from 'prop-types';
import ModeratorLinkPanel from '../ModeratorLinkPanel';
import ModeratorPanel from '../ModeratorPanel';
import ParticipantList from './ParticipantList';
import { THEMES } from '../hooks/useDiscussionTheme';

// Moderator controls: the private moderator link, the discussion settings,
// and the participant list. A visitor to a discussion without a moderator is
// offered the role instead.
export default function ModeratorControls({
    socket, topic, discussionSlug, adminToken, isAdmin, discussionState, theme, activeReactionKeys,
    moderatorLink, share, participantList, selfHandle, canDemote, showParticipants, onClaimModerator,
}) {
    const handleSetTheme = (themeKey) => {
        socket.emit('setTheme', discussionSlug, themeKey, adminToken);
    };

    const handleSetDiscussionFlags = (flags) => {
        socket.emit('setDiscussionFlags', topic, flags, adminToken);
    };

    // Set the active epistemic reactions for the whole session. The server
    // re-broadcasts discussionState, so we don't update local state optimistically.
    const handleSetReactionKeys = (keys) => {
        socket.emit('setReactionKeys', topic, keys, adminToken);
    };

    return (
        <div className="mb-6">
            {isAdmin && <ModeratorLinkPanel prompt={moderatorLink} adminUrl={share.adminUrl} onCopy={share.handleCopyAdminLink} />}
            {isAdmin ? (
                <ModeratorPanel
                    discussionSlug={discussionSlug}
                    state={discussionState}
                    theme={theme}
                    themes={THEMES}
                    activeReactionKeys={activeReactionKeys}
                    onSetLocked={(on) => socket.emit('setLocked', discussionSlug, on, adminToken)}
                    onSetPostingMode={(mode) => discussionState.postingMode
                        ? socket.emit('setPostingMode', discussionSlug, mode, adminToken)
                        : socket.emit('setModeratorOnly', discussionSlug, mode === 'moderator_only', adminToken)}
                    onSetListed={(on) => socket.emit('setListed', discussionSlug, on, adminToken)}
                    onSetResultsVisibility={(value) => socket.emit('setResultsVisibility', discussionSlug, value, adminToken)}
                    onSetDisplaySettings={(settings) => socket.emit('setDisplaySettings', discussionSlug, settings, adminToken)}
                    onSetTheme={handleSetTheme}
                    onSetFlags={handleSetDiscussionFlags}
                    onSetReactionKeys={handleSetReactionKeys}
                    linkPrompt={moderatorLink}
                    linkCopied={share.adminLinkCopied}
                    onCopyLink={share.handleCopyAdminLink}
                    showParticipants={showParticipants}
                    onToggleParticipants={participantList.handleToggleParticipants}
                >
                    <ParticipantList
                        participants={participantList.participants}
                        selfHandle={selfHandle}
                        canDemote={canDemote}
                        onRefresh={participantList.refreshParticipants}
                        onPromote={participantList.handlePromoteParticipant}
                        onDemote={participantList.handleDemoteParticipant}
                    />
                </ModeratorPanel>
            ) : !discussionState.hasModerator ? (
                <button
                    onClick={onClaimModerator}
                    className="text-sm text-gray-600 underline hover:text-gray-800"
                >
                    Become moderator
                </button>
            ) : null}
        </div>
    );
}

ModeratorControls.propTypes = {
    socket: PropTypes.object.isRequired,
    topic: PropTypes.string.isRequired,
    discussionSlug: PropTypes.string.isRequired,
    adminToken: PropTypes.string,
    isAdmin: PropTypes.bool.isRequired,
    discussionState: PropTypes.object.isRequired,
    theme: PropTypes.string.isRequired,
    activeReactionKeys: PropTypes.arrayOf(PropTypes.string).isRequired,
    moderatorLink: PropTypes.object.isRequired,
    share: PropTypes.shape({
        adminUrl: PropTypes.string.isRequired,
        adminLinkCopied: PropTypes.bool.isRequired,
        handleCopyAdminLink: PropTypes.func.isRequired,
    }).isRequired,
    participantList: PropTypes.shape({
        participants: PropTypes.array.isRequired,
        refreshParticipants: PropTypes.func.isRequired,
        handleToggleParticipants: PropTypes.func.isRequired,
        handlePromoteParticipant: PropTypes.func.isRequired,
        handleDemoteParticipant: PropTypes.func.isRequired,
    }).isRequired,
    selfHandle: PropTypes.string,
    canDemote: PropTypes.bool.isRequired,
    showParticipants: PropTypes.bool.isRequired,
    onClaimModerator: PropTypes.func.isRequired,
};
