import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import PropTypes from 'prop-types';

// Moderator rights live in a token in this browser's localStorage, so the
// moderator link is the only way back in from another device or after site
// data is cleared. This file owns the prompt to save that link: a one-time
// panel shown to the creator right after creating a discussion, and a small
// reminder that stays until the link has been copied once in this browser.

const SAVED_KEY_PREFIX = 'convora_modlink_saved_';

// Router state a creation flow passes to navigate() so the discussion page
// shows the panel once. It names the slug so it can only apply to that page.
export const moderatorLinkPromptState = slug => ({ moderatorLinkPrompt: slug });

// Storage can be unavailable (private mode, blocked site data); then the
// reminder just falls back to in-memory state for this page view.
function readSaved(slug) {
    try {
        return localStorage.getItem(`${SAVED_KEY_PREFIX}${slug}`) === '1';
    } catch {
        return false;
    }
}

function writeSaved(slug) {
    try {
        localStorage.setItem(`${SAVED_KEY_PREFIX}${slug}`, '1');
    } catch (error) {
        console.warn('Failed to remember that the moderator link was saved:', error);
    }
}

export function useModeratorLinkPrompt(discussionSlug) {
    const location = useLocation();
    const navigate = useNavigate();
    // mode is 'created' (the one-time panel) or 'manual' (copying failed, so
    // the link is shown for the moderator to copy by hand).
    const [panel, setPanel] = useState({ slug: null, mode: null });
    const [savedSlug, setSavedSlug] = useState(null);
    const toolbarButtonRef = useRef(null);

    // Consume the creation flag: open the panel and strip the flag from the
    // history entry so a reload or back/forward does not show it again.
    useEffect(() => {
        if (!discussionSlug || location.state?.moderatorLinkPrompt !== discussionSlug) return;
        setPanel({ slug: discussionSlug, mode: 'created' });
        navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
    }, [discussionSlug, location, navigate]);

    const markSaved = useCallback(() => {
        writeSaved(discussionSlug);
        setSavedSlug(discussionSlug);
    }, [discussionSlug]);
    const showManual = useCallback(() => {
        setPanel({ slug: discussionSlug, mode: 'manual' });
    }, [discussionSlug]);
    const dismiss = useCallback(() => {
        setPanel({ slug: null, mode: null });
        toolbarButtonRef.current?.focus();
    }, []);

    return {
        mode: panel.slug === discussionSlug ? panel.mode : null,
        saved: savedSlug === discussionSlug || readSaved(discussionSlug),
        markSaved, showManual, dismiss, toolbarButtonRef,
    };
}

// The reminder shown inside the toolbar's "Copy moderator link" button.
export function ModeratorLinkUnsavedMark() {
    return (
        <span
            className="ml-2 inline-flex items-center gap-1 text-xs text-amber-700"
            title="Copy and keep this link to manage the discussion from another device"
        >
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-amber-500" />
            not saved yet
        </span>
    );
}

const ModeratorLinkPanel = ({ prompt, adminUrl, onCopy }) => {
    const { mode, saved, markSaved, dismiss } = prompt;
    const titleId = useId();
    const copyButtonRef = useRef(null);
    const linkFieldRef = useRef(null);
    const open = !!mode && !!adminUrl;

    // Move focus into the panel when it appears. When copying failed, land on
    // the link with it selected so one Ctrl/Cmd+C finishes the job.
    useEffect(() => {
        if (!open) return;
        if (mode === 'manual') {
            linkFieldRef.current?.focus();
            linkFieldRef.current?.select();
        } else {
            copyButtonRef.current?.focus();
        }
    }, [open, mode]);

    if (!open) return null;

    return (
        <section
            aria-labelledby={titleId}
            onKeyDown={(e) => { if (e.key === 'Escape') dismiss(); }}
            className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
            <h2 id={titleId} className="mb-1 text-base font-semibold">Save your moderator link</h2>
            <p className="mb-3">
                You&apos;ll need it to manage this discussion from another device or after clearing
                this browser&apos;s data. Keep it private: anyone with this link becomes a moderator.
            </p>
            {mode === 'manual' && (
                <div className="mb-3">
                    <label>
                        <span className="mb-1 block font-medium">
                            Your browser did not allow copying. Copy the link below yourself:
                        </span>
                        <input
                            ref={linkFieldRef}
                            type="text"
                            readOnly
                            value={adminUrl}
                            onFocus={(e) => e.target.select()}
                            onCopy={markSaved}
                            className="w-full min-w-0 rounded border border-amber-300 bg-white p-2 text-sm text-gray-800"
                        />
                    </label>
                </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
                <button
                    ref={copyButtonRef}
                    type="button"
                    onClick={onCopy}
                    className="rounded bg-primary px-4 py-2 text-white hover:bg-opacity-90"
                >
                    {mode === 'manual' ? 'Try copying again' : 'Copy moderator link'}
                </button>
                <button
                    type="button"
                    onClick={dismiss}
                    className="rounded border border-amber-300 bg-white px-4 py-2 hover:bg-amber-100"
                >
                    {saved ? 'Done' : 'Dismiss'}
                </button>
                <span role="status" className="font-medium">
                    {saved ? 'Moderator link copied. Keep it somewhere safe.' : ''}
                </span>
            </div>
        </section>
    );
};

ModeratorLinkPanel.propTypes = {
    prompt: PropTypes.shape({
        mode: PropTypes.oneOf(['created', 'manual']),
        saved: PropTypes.bool.isRequired,
        markSaved: PropTypes.func.isRequired,
        dismiss: PropTypes.func.isRequired,
    }).isRequired,
    adminUrl: PropTypes.string.isRequired,
    onCopy: PropTypes.func.isRequired,
};

export default ModeratorLinkPanel;
