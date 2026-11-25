import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { downloadForViewer } from '../viewer';

// Discussion actions. Share is the one frequently-used action, so it stays a
// solid primary button. View Summary / Opinion Groups are view-oriented and
// get a quieter ghost style. The rare, one-off actions (duplicate, exports)
// live in a "More" overflow menu so they don't compete for attention with the
// things people actually reach for during a session.
// On a phone the row is tightened (smaller text and padding, the "View" /
// "Opinion" words visually hidden) so it fits on one line.
export default function DiscussionToolbar({
    topic, discussionSlug, isAdmin, canDemote, showClusters, showSnapshots,
    shareButtonRef, actionsMenuButtonRef,
    onShare, onToggleSnapshots, onDuplicate, onClear, onDelete,
}) {
    const [showActionsMenu, setShowActionsMenu] = useState(false);
    return (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm sm:gap-3 sm:text-base">
            <button
                ref={shareButtonRef}
                aria-haspopup="dialog"
                onClick={onShare}
                className="bg-primary text-white py-2 px-3 sm:px-4 rounded hover:bg-opacity-90 transition duration-300"
            >
                Share
            </button>
            <Link
                to={`/discussion/${discussionSlug}/summary`}
                className="border border-gray-300 text-gray-700 py-2 px-3 sm:px-4 rounded hover:bg-gray-100 transition duration-300"
            >
                <span className="sr-only sm:not-sr-only">View </span>Summary
            </Link>
            <button
                type="button"
                onClick={onToggleSnapshots}
                aria-expanded={showSnapshots}
                aria-controls="opinion-snapshots"
                className="border border-gray-300 text-gray-700 py-2 px-3 sm:px-4 rounded hover:bg-gray-100 transition duration-300"
            >
                <span className="sr-only sm:not-sr-only">Opinion </span>Snapshots
            </button>
            {showClusters && (
                <Link
                    to={`/discussion/${encodeURIComponent(topic)}/clusters`}
                    className="border border-gray-300 text-gray-700 py-2 px-3 sm:px-4 rounded hover:bg-gray-100 transition duration-300"
                >
                    Opinion Groups
                </Link>
            )}
            <div className="relative">
                <button
                    type="button"
                    ref={actionsMenuButtonRef}
                    onClick={() => setShowActionsMenu((open) => !open)}
                    aria-haspopup="true"
                    aria-expanded={showActionsMenu}
                    className="border border-gray-300 text-gray-700 py-2 px-3 sm:px-4 rounded hover:bg-gray-100 transition duration-300"
                >
                    More ▾
                </button>
                {showActionsMenu && (
                    <>
                        {/* Invisible backdrop closes the menu on any outside click,
                            matching how the modals handle dismissal. */}
                        <div
                            className="fixed inset-0 z-10"
                            onClick={() => setShowActionsMenu(false)}
                        />
                        <div
                            role="menu"
                            className="absolute right-0 sm:left-0 sm:right-auto mt-1 z-20 w-52 bg-white border border-gray-200 rounded shadow-lg py-1"
                        >
                            {/* Open to everyone, so a TV that joined with the
                                ordinary link can switch itself to the
                                read-only display. Same tab on purpose: on a
                                TV you want this page replaced, not a new tab. */}
                            <a
                                role="menuitem"
                                href={`/discussion/${encodeURIComponent(discussionSlug)}/display`}
                                onClick={() => setShowActionsMenu(false)}
                                title="A read-only page for a shared TV or projector: join QR code, questions and live counts"
                                className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                            >
                                Open room display
                            </a>
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                    setShowActionsMenu(false);
                                    onDuplicate();
                                }}
                                className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                            >
                                Duplicate Discussion
                            </button>
                            {isAdmin && (
                                <button type="button" role="menuitem" onClick={() => {
                                    setShowActionsMenu(false); onClear();
                                }} className="block w-full text-left px-4 py-2 text-sm text-red-700 hover:bg-red-50">
                                    Clear votes and responses
                                </button>
                            )}
                            {canDemote && (
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { setShowActionsMenu(false); onDelete(); }}
                                    className="block w-full text-left px-4 py-2 text-sm text-red-700 hover:bg-red-50"
                                >
                                    Delete discussion
                                </button>
                            )}
                            <a
                                role="menuitem"
                                href={`/api/discussions/${encodeURIComponent(discussionSlug)}/export.csv`}
                                onClick={(e) => { setShowActionsMenu(false); downloadForViewer(e, discussionSlug); }}
                                className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                            >
                                Export CSV
                            </a>
                            <a
                                role="menuitem"
                                href={`/api/discussions/${encodeURIComponent(discussionSlug)}/export.json`}
                                onClick={(e) => { setShowActionsMenu(false); downloadForViewer(e, discussionSlug); }}
                                className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                            >
                                Export JSON
                            </a>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

DiscussionToolbar.propTypes = {
    topic: PropTypes.string.isRequired,
    discussionSlug: PropTypes.string.isRequired,
    isAdmin: PropTypes.bool.isRequired,
    canDemote: PropTypes.bool.isRequired,
    showClusters: PropTypes.bool.isRequired,
    showSnapshots: PropTypes.bool.isRequired,
    shareButtonRef: PropTypes.object.isRequired,
    actionsMenuButtonRef: PropTypes.object.isRequired,
    onShare: PropTypes.func.isRequired,
    onToggleSnapshots: PropTypes.func.isRequired,
    onDuplicate: PropTypes.func.isRequired,
    onClear: PropTypes.func.isRequired,
    onDelete: PropTypes.func.isRequired,
};
