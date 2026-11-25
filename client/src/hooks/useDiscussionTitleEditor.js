import { useEffect, useRef, useState } from 'react';

// Inline moderator rename of the discussion title. titleDraft holds the
// in-progress edit; editingTitle swaps the <h1> for the editor.
export function useDiscussionTitleEditor(socket, { discussion, discussionSlug, adminToken, setError }) {
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    // The rename button is replaced by the editor while renaming, so hand
    // focus back to it when the editor closes.
    const renameButtonRef = useRef(null);
    const wasEditingTitle = useRef(false);
    useEffect(() => {
        if (wasEditingTitle.current && !editingTitle) renameButtonRef.current?.focus();
        wasEditingTitle.current = editingTitle;
    }, [editingTitle]);

    // Open the inline title editor, seeding it with the loaded discussion's
    // actual title. Guard until the discussion has loaded so we never seed the
    // editor from the route slug (or a previous room) and then save THAT as the
    // new title; the rename button is also disabled until then.
    const handleStartRename = () => {
        if (!discussion?.topic) return;
        setTitleDraft(discussion.topic);
        setEditingTitle(true);
    };

    // Persist a renamed discussion. Only the display title changes server-side;
    // the slug (and thus this page's URL and everyone's room) stays put, so the
    // ack is the only thing we wait on before closing the editor. The new title
    // arrives for everyone — us included — over the broadcast 'discussion' event.
    const handleRenameDiscussion = () => {
        const trimmed = titleDraft.trim();
        if (!trimmed) {
            setError('Discussion name cannot be empty.');
            return;
        }
        socket.emit('setTopic', discussionSlug, trimmed, adminToken, (resp) => {
            if (resp && resp.updated) {
                setEditingTitle(false);
            } else if (resp && resp.reason === 'not_authorized') {
                setError('You are no longer a moderator of this discussion.');
            } else if (resp && resp.reason === 'duplicate') {
                // Keep the editor open so the moderator can correct the name.
                setError('A discussion with that name already exists. Choose a different name.');
            } else {
                setError('Could not rename the discussion. Try again.');
            }
        });
    };

    // The rename editor is scoped to one discussion. The page is reused
    // across /discussion/:topic routes (only the param changes), so close any
    // open editor and clear its draft when the slug changes — otherwise a draft
    // seeded in one room could be saved into another the next time it's opened.
    useEffect(() => {
        setEditingTitle(false);
        setTitleDraft('');
    }, [discussionSlug]);

    return {
        editingTitle, titleDraft, setTitleDraft, renameButtonRef,
        handleStartRename, handleRenameDiscussion,
        cancelRename: () => setEditingTitle(false),
    };
}
