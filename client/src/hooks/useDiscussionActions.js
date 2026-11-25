import { useCallback, useEffect, useRef, useState } from 'react';
import { forgetDiscussion } from '../knownDiscussions';
import { moderatorLinkPromptState } from '../ModeratorLinkPanel';
import { useModalDialog } from './useModalDialog';

// The whole-discussion actions offered from the More menu: duplicate the
// discussion, clear its votes and responses, or delete it. Owns each one's
// dialog state and leaves the page when the discussion is deleted, here or
// by another moderator.
export function useDiscussionActions(socket, { discussionSlug, adminToken, isAdmin, navigate, setError }) {
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');
    const [clearTarget, setClearTarget] = useState(null);
    const [clearing, setClearing] = useState(false);
    const [clearError, setClearError] = useState('');
    const [clearedRoom, setClearedRoom] = useState(null);
    const [showDuplicateModal, setShowDuplicateModal] = useState(false);
    const [newTopicName, setNewTopicName] = useState('');
    // Modal panels: Escape closes, focus is kept inside while open and handed
    // back on close. Duplicate is opened from the More menu, whose item is gone
    // by then, so its focus returns to the More button.
    const actionsMenuButtonRef = useRef(null);
    const discussionContentRef = useRef(null);
    const duplicateReturnFocusRef = useRef(null);
    const deleteDialogRef = useModalDialog(showDeleteModal, () => { if (!deleting) setShowDeleteModal(false); }, actionsMenuButtonRef);
    const duplicateDialogRef = useModalDialog(showDuplicateModal, () => setShowDuplicateModal(false), duplicateReturnFocusRef);
    const showClearModal = isAdmin && clearTarget === discussionSlug;
    const clearDialogRef = useModalDialog(showClearModal, () => { if (!clearing) setClearTarget(null); }, actionsMenuButtonRef);

    const leaveDeletedDiscussion = useCallback(() => {
        forgetDiscussion(discussionSlug);
        navigate('/', { replace: true, state: { discussionDeleted: true } });
    }, [discussionSlug, navigate]);

    useEffect(() => {
        const onDeleted = ({ slug }) => {
            if (slug === discussionSlug) leaveDeletedDiscussion();
        };
        socket.on('discussionDeleted', onDeleted);
        return () => socket.off('discussionDeleted', onDeleted);
    }, [socket, discussionSlug, leaveDeletedDiscussion]);

    const openDuplicate = () => {
        duplicateReturnFocusRef.current = actionsMenuButtonRef.current;
        setShowDuplicateModal(true);
    };

    const openClear = () => {
        setClearError(''); setClearedRoom(null); setClearTarget(discussionSlug);
    };

    const openDelete = () => {
        setDeleteError(''); setShowDeleteModal(true);
    };

    const handleClearResponses = async () => {
        if (!showClearModal || clearing) return;
        setClearing(true);
        setClearError('');
        try {
            const response = await fetch(`/api/discussions/${encodeURIComponent(clearTarget)}/responses`, {
                method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken }),
            });
            if (!response.ok) throw new Error((await response.json()).error || 'Could not clear votes and responses.');
            const refreshed = response.status === 204 || (await response.json()).refreshed === true;
            setClearedRoom({ slug: clearTarget, refreshed });
            setClearTarget(null);
        } catch (error) {
            setClearError(error.message || 'Could not confirm that votes and responses were cleared.');
        } finally {
            setClearing(false);
        }
    };

    const handleDeleteDiscussion = async () => {
        if (deleting) return;
        setDeleting(true);
        setDeleteError('');
        try {
            const response = await fetch(`/api/discussions/${encodeURIComponent(discussionSlug)}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminToken }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Could not delete the discussion.');
            leaveDeletedDiscussion();
        } catch (error) {
            setDeleteError(error.message || 'Could not delete the discussion. Please try again.');
        } finally {
            setDeleting(false);
        }
    };

    const handleDuplicateDiscussion = async () => {
        if (newTopicName.trim() === '') {
            setError('New topic name cannot be empty.');
            return;
        }

        try {
            const response = await fetch('/api/duplicate-discussion', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                // The moderator token lets the copy keep this discussion's
                // queued questions; without it they are left out.
                body: JSON.stringify({ originalTopic: discussionSlug, newTopic: newTopicName, adminToken: adminToken || undefined }),
            });

            if (response.ok) {
                const result = await response.json();
                if (result.adminToken && !result.accountLinked) {
                    try {
                        localStorage.setItem(`convora_admin_${result.newSlug}`, result.adminToken);
                    } catch (e) {
                        console.warn('Failed to store admin token:', e);
                    }
                }
                // The route reuses DiscussionPage. Successful navigation must
                // land on destination content instead of its unrelated More
                // button. A stacked prompt inherits this target if it outlives
                // the Duplicate dialog.
                duplicateReturnFocusRef.current = discussionContentRef.current;
                navigate(`/discussion/${result.newSlug}`, result.adminToken && !result.accountLinked ? { state: moderatorLinkPromptState(result.newSlug) } : undefined);
            } else {
                const errorData = await response.json();
                setError(`Failed to duplicate discussion: ${errorData.error}`);
            }
        } catch (error) {
            console.error('Error duplicating discussion:', error);
            setError('An error occurred while duplicating the discussion.');
        }

        setShowDuplicateModal(false);
        setNewTopicName('');
    };

    return {
        actionsMenuButtonRef, discussionContentRef,
        duplicate: {
            open: showDuplicateModal, dialogRef: duplicateDialogRef, newTopicName, setNewTopicName,
            onOpen: openDuplicate, onClose: () => setShowDuplicateModal(false), onConfirm: handleDuplicateDiscussion,
        },
        clear: {
            open: showClearModal, dialogRef: clearDialogRef, pending: clearing, error: clearError,
            cleared: clearedRoom?.slug === discussionSlug ? clearedRoom : null,
            onOpen: openClear, onClose: () => setClearTarget(null), onConfirm: handleClearResponses,
        },
        remove: {
            open: showDeleteModal, dialogRef: deleteDialogRef, pending: deleting, error: deleteError,
            onOpen: openDelete, onClose: () => setShowDeleteModal(false), onConfirm: handleDeleteDiscussion,
        },
    };
}
