import React from 'react';
import PropTypes from 'prop-types';

// Confirmation dialogs for the More menu's whole-discussion actions. Each
// takes the matching part of useDiscussionActions; the page renders them
// only while open.

const confirmActionShape = PropTypes.shape({
    dialogRef: PropTypes.object.isRequired,
    pending: PropTypes.bool.isRequired,
    error: PropTypes.string.isRequired,
    onClose: PropTypes.func.isRequired,
    onConfirm: PropTypes.func.isRequired,
});

export function ClearResponsesDialog({ action, discussionTitle }) {
    const { dialogRef, pending: clearing, error: clearError, onClose, onConfirm } = action;
    return (
        <div className="fixed inset-0 z-50 bg-gray-600 bg-opacity-50 flex items-center justify-center p-4">
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="clear-title" aria-describedby="clear-description" tabIndex={-1} className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
                <h2 id="clear-title" className="text-xl font-bold mb-4">Clear votes and responses?</h2>
                <p id="clear-description" className="text-gray-700 mb-4">This permanently removes all answers, interest marks, private question notes, raised hands, and response comments, ratings, and reactions from “{discussionTitle}”. Independent-answer questions start collecting privately again. Your questions, settings, saved snapshots, and link stay the same. This cannot be undone.</p>
                {clearError && <p role="alert" className="text-red-700 mb-4">{clearError}</p>}
                <div className="flex justify-end gap-2">
                    <button type="button" data-autofocus disabled={clearing} onClick={onClose} className="px-4 py-2 rounded bg-gray-200 disabled:opacity-50">Cancel</button>
                    <button type="button" disabled={clearing} onClick={onConfirm} className="px-4 py-2 rounded bg-red-700 text-white disabled:opacity-50">{clearing ? 'Clearing…' : 'Clear votes and responses'}</button>
                </div>
            </div>
        </div>
    );
}

ClearResponsesDialog.propTypes = { action: confirmActionShape.isRequired, discussionTitle: PropTypes.string };

export function DeleteDiscussionDialog({ action, discussionTitle }) {
    const { dialogRef, pending: deleting, error: deleteError, onClose, onConfirm } = action;
    return (
        <div className="fixed inset-0 z-50 bg-gray-600 bg-opacity-50 overflow-y-auto flex items-center justify-center p-4">
            <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description" tabIndex={-1} className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
                <h2 id="delete-dialog-title" className="text-xl font-bold mb-4">Delete discussion?</h2>
                <p id="delete-dialog-description" className="text-gray-700 mb-4">
                    Permanently delete “{discussionTitle}” and all its questions, responses, comments, and snapshots for everyone? This cannot be undone.
                </p>
                {deleteError && <p role="alert" className="text-red-700 mb-4">{deleteError}</p>}
                <div className="flex justify-end gap-3">
                    <button type="button" data-autofocus disabled={deleting} onClick={onClose} className="px-4 py-2 rounded bg-gray-200 disabled:opacity-50">Cancel</button>
                    <button type="button" disabled={deleting} onClick={onConfirm} className="px-4 py-2 rounded bg-red-700 text-white disabled:opacity-50">{deleting ? 'Deleting…' : 'Delete discussion'}</button>
                </div>
            </div>
        </div>
    );
}

DeleteDiscussionDialog.propTypes = { action: confirmActionShape.isRequired, discussionTitle: PropTypes.string };

export function DuplicateDiscussionDialog({ action }) {
    const { dialogRef, newTopicName, setNewTopicName, onClose, onConfirm } = action;
    return (
        <div className="fixed inset-0 z-50 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full flex items-center justify-center">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="duplicate-dialog-title"
                tabIndex={-1}
                className="bg-white p-5 rounded-lg shadow-xl"
            >
                <h2 id="duplicate-dialog-title" className="text-xl font-bold mb-4">Duplicate Discussion</h2>
                <input
                    type="text"
                    aria-label="New topic name"
                    value={newTopicName}
                    onChange={(e) => setNewTopicName(e.target.value)}
                    placeholder="Enter new topic name"
                    className="w-full p-2 border rounded mb-4"
                />
                <div className="flex justify-end">
                    <button
                        onClick={onClose}
                        className="mr-2 px-4 py-2 bg-gray-300 rounded hover:bg-gray-400"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90"
                    >
                        Duplicate
                    </button>
                </div>
            </div>
        </div>
    );
}

DuplicateDiscussionDialog.propTypes = {
    action: PropTypes.shape({
        dialogRef: PropTypes.object.isRequired,
        newTopicName: PropTypes.string.isRequired,
        setNewTopicName: PropTypes.func.isRequired,
        onClose: PropTypes.func.isRequired,
        onConfirm: PropTypes.func.isRequired,
    }).isRequired,
};
