import React from 'react';
import PropTypes from 'prop-types';

// The discussion's heading. A moderator also gets a rename button beside it,
// which swaps the heading for an inline editor.
export default function DiscussionTitle({ title, isAdmin, canRename, editor }) {
    const {
        editingTitle, titleDraft, setTitleDraft, renameButtonRef,
        handleStartRename, handleRenameDiscussion, cancelRename,
    } = editor;
    if (isAdmin && editingTitle) {
        return (
            <div className="mb-2 flex flex-col items-center gap-2">
                <input
                    type="text"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) handleRenameDiscussion();
                        if (e.key === 'Escape') cancelRename();
                    }}
                    autoFocus
                    maxLength={200}
                    placeholder="Discussion name"
                    aria-label="Discussion name"
                    className="w-full max-w-xl p-2 border rounded text-3xl font-bold text-center text-gray-800"
                />
                <div className="flex gap-2">
                    <button
                        onClick={handleRenameDiscussion}
                        className="px-3 py-1 rounded bg-primary text-white hover:bg-opacity-90"
                    >
                        Save
                    </button>
                    <button
                        onClick={cancelRename}
                        className="px-3 py-1 rounded bg-gray-300 hover:bg-gray-400"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        );
    }
    // Phones drop the "Discussion:" prefix visually; it stays in the
    // heading's accessible name.
    // The rename button sits beside the heading, not inside it, so it
    // stays out of the heading's accessible name.
    return (
        <div className="mb-2 flex items-center justify-center gap-2">
            <h1 className="min-w-0 text-2xl sm:text-4xl font-bold text-center text-gray-800"><span className="sr-only sm:not-sr-only">Discussion: </span>{title}</h1>
            {isAdmin && (
                <button
                    type="button"
                    ref={renameButtonRef}
                    onClick={handleStartRename}
                    disabled={!canRename}
                    aria-label="Rename discussion"
                    title="Rename discussion"
                    className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                >
                    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                        <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                    </svg>
                </button>
            )}
        </div>
    );
}

DiscussionTitle.propTypes = {
    title: PropTypes.string,
    isAdmin: PropTypes.bool.isRequired,
    // False until the discussion has loaded, so a rename never starts from
    // the route slug.
    canRename: PropTypes.bool.isRequired,
    editor: PropTypes.shape({
        editingTitle: PropTypes.bool.isRequired,
        titleDraft: PropTypes.string.isRequired,
        setTitleDraft: PropTypes.func.isRequired,
        renameButtonRef: PropTypes.object.isRequired,
        handleStartRename: PropTypes.func.isRequired,
        handleRenameDiscussion: PropTypes.func.isRequired,
        cancelRename: PropTypes.func.isRequired,
    }).isRequired,
};
