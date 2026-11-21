import React, { useId, useState } from 'react';
import PropTypes from 'prop-types';
import { ModeratorLinkUnsavedMark } from './ModeratorLinkPanel';
import { EPISTEMIC_REACTIONS } from './questions/config';

// The moderator's controls for a discussion, grouped by what they affect.
// Settings that are either on or off are switches whose label never changes,
// so the label always names the setting and the switch shows its state.
// The whole panel collapses to a one-line summary of the settings that matter
// most, so it does not push the questions down the page once a session is set up.

// Whether the panel is open is a preference of this browser, not of one
// discussion. With nothing stored it starts closed on a phone, where the open
// panel fills the first screen.
const OPEN_KEY = 'convora_moderator_panel_open';

function readInitialOpen() {
    try {
        const stored = localStorage.getItem(OPEN_KEY);
        if (stored === 'true' || stored === 'false') return stored === 'true';
    } catch {
        // Storage can be unavailable; fall back to the screen-size default.
    }
    return typeof window === 'undefined' || !window.matchMedia
        || !window.matchMedia('(max-width: 639px)').matches;
}

const BUTTON_CLASS = 'px-3 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100';
const SELECT_CLASS = 'min-w-0 px-2 py-1 rounded bg-white border border-indigo-300 text-indigo-700';

function Group({ title, children }) {
    const titleId = useId();
    return (
        <div role="group" aria-labelledby={titleId} className="min-w-0 rounded-md border border-indigo-100 bg-white p-3">
            <div id={titleId} className="mb-3 text-xs font-semibold uppercase tracking-wide text-indigo-700">{title}</div>
            <div className="space-y-3">{children}</div>
        </div>
    );
}

Group.propTypes = {
    title: PropTypes.string.isRequired,
    children: PropTypes.node,
};

function Switch({ label, hint, checked, onChange }) {
    const id = useId();
    const hintId = `${id}-hint`;
    return (
        <div className="flex items-start gap-3">
            <button
                type="button"
                role="switch"
                id={id}
                aria-checked={checked}
                aria-describedby={hint ? hintId : undefined}
                onClick={() => onChange(!checked)}
                className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${
                    checked ? 'bg-indigo-600' : 'bg-gray-300'
                }`}
            >
                <span
                    aria-hidden="true"
                    className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                        checked ? 'translate-x-5' : ''
                    }`}
                />
            </button>
            <div className="min-w-0">
                <label htmlFor={id} className="cursor-pointer font-medium text-gray-800">{label}</label>
                {hint && <p id={hintId} className="text-xs text-gray-500">{hint}</p>}
            </div>
        </div>
    );
}

Switch.propTypes = {
    label: PropTypes.string.isRequired,
    hint: PropTypes.string,
    checked: PropTypes.bool.isRequired,
    onChange: PropTypes.func.isRequired,
};

function SelectSetting({ label, title, value, onChange, options }) {
    return (
        <label className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="font-medium text-gray-800">{label}</span>
            <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} title={title} className={SELECT_CLASS}>
                {options.map(([optionValue, optionLabel]) => (
                    <option key={optionValue} value={optionValue}>{optionLabel}</option>
                ))}
            </select>
        </label>
    );
}

SelectSetting.propTypes = {
    label: PropTypes.string.isRequired,
    title: PropTypes.string,
    value: PropTypes.string.isRequired,
    onChange: PropTypes.func.isRequired,
    options: PropTypes.arrayOf(PropTypes.arrayOf(PropTypes.string)).isRequired,
};

const ModeratorPanel = ({
    discussionSlug, state, theme, themes, activeReactionKeys,
    onSetLocked, onSetPostingMode, onSetListed, onSetResultsVisibility,
    onSetDisplaySettings, onSetTheme, onSetFlags, onSetReactionKeys,
    linkPrompt, linkCopied, onCopyLink,
    showJoinQr, onToggleJoinQr,
    showParticipants, onToggleParticipants, children,
}) => {
    const [open, setOpen] = useState(readInitialOpen);
    const bodyId = useId();
    const participantsId = useId();
    const resultsAlways = state.resultsVisibility === 'always';

    const toggleOpen = () => {
        const next = !open;
        setOpen(next);
        try {
            localStorage.setItem(OPEN_KEY, String(next));
        } catch (error) {
            console.warn('Failed to remember the moderator panel state:', error);
        }
    };

    const summary = [
        state.locked ? 'Locked' : 'Open',
        state.listed ? 'Listed' : 'Unlisted',
        resultsAlways ? 'Results always shown' : 'Results after voting',
        state.moderatorOnly ? 'Only moderators add questions' : null,
        state.postingMode === 'approval' ? 'Questions need approval' : null,
    ].filter(Boolean).join(' · ');

    return (
        <div className="rounded-md border border-indigo-100 bg-indigo-50 text-sm">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
                <span className="font-semibold text-indigo-800">You&apos;re the moderator</span>
                {open ? (
                    // Clicking a swatch recolors the discussion for everyone in the room.
                    <div className="flex items-center gap-1.5" role="group" aria-label="Color theme">
                        <span className="font-medium text-indigo-800">Theme</span>
                        {themes.map((t) => (
                            <button
                                key={t.key}
                                type="button"
                                onClick={() => onSetTheme(t.key)}
                                title={t.label}
                                aria-label={`${t.label} theme`}
                                aria-pressed={theme === t.key}
                                className={`h-6 w-6 rounded-full border border-white shadow-sm transition ${
                                    theme === t.key ? 'ring-2 ring-offset-1 ring-gray-700' : 'hover:scale-110'
                                }`}
                                style={{ backgroundColor: t.swatch }}
                            />
                        ))}
                    </div>
                ) : (
                    <span className="text-indigo-700">
                        {summary}
                        {!linkPrompt.saved && (
                            <span className="ml-1 whitespace-nowrap">
                                · Moderator link
                                <ModeratorLinkUnsavedMark />
                            </span>
                        )}
                    </span>
                )}
                {/* While the panel is closed this button stands in for "Copy
                    moderator link" as the place focus returns to when the
                    save-your-link prompt is dismissed. */}
                <button
                    type="button"
                    ref={open ? undefined : linkPrompt.toolbarButtonRef}
                    onClick={toggleOpen}
                    aria-expanded={open}
                    aria-controls={open ? bodyId : undefined}
                    className={`ml-auto ${BUTTON_CLASS}`}
                >
                    {open ? 'Hide controls' : 'Show controls'}
                    <span aria-hidden="true" className="ml-1.5">{open ? '▴' : '▾'}</span>
                </button>
            </div>

            {open && (
                <div id={bodyId} className="grid gap-3 p-3 pt-0 sm:grid-cols-2">
                    <Group title="Access">
                        <Switch
                            label="Locked"
                            hint="Closes voting and new questions"
                            checked={!!state.locked}
                            onChange={onSetLocked}
                        />
                        <SelectSetting
                            label="Question posting"
                            title="Who can add questions. Everyone can still vote when the room is unlocked."
                            value={state.postingMode ?? (state.moderatorOnly ? 'moderator_only' : 'open')}
                            onChange={onSetPostingMode}
                            options={[
                                ['open', 'Everyone can post'],
                                ...(state.postingMode ? [['approval', 'Participants suggest for approval']] : []),
                                ['moderator_only', 'Only moderators add questions'],
                            ]}
                        />
                        <Switch
                            label="Hand raising"
                            hint="Let people join a private speaking queue for each question. Turning this off clears the queues."
                            checked={!!state.handsEnabled}
                            onChange={(on) => onSetFlags({ hands_enabled: on })}
                        />
                        <Switch
                            label="Allow question downvotes"
                            checked={!!state.questionDownvotesEnabled}
                            onChange={(on) => onSetFlags({ question_downvotes_enabled: on })}
                        />
                        <Switch
                            label="Listed publicly"
                            hint="Anyone can find this discussion on the Convora home page"
                            checked={state.listed === true}
                            onChange={onSetListed}
                        />
                        <SelectSetting
                            label="Results shown"
                            title="When participants see the results of agreement, yes/no and numerical questions. Moderators always see them."
                            value={resultsAlways ? 'always' : 'after_vote'}
                            onChange={onSetResultsVisibility}
                            options={[['after_vote', 'After voting'], ['always', 'Always']]}
                        />
                    </Group>

                    <Group title="Display controls">
                        <p className="text-xs text-gray-500">Changes apply live to the shared display.</p>
                        {/* A read-only page for the room's shared screen. It carries
                            no moderator token, so projecting it shows only what
                            the results setting lets everyone see. */}
                        <a
                            href={`/discussion/${encodeURIComponent(discussionSlug)}/display`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`inline-block ${BUTTON_CLASS}`}
                            title="A read-only page for a shared TV or projector: join QR code, questions and live counts"
                        >
                            Open room display
                            <span aria-hidden="true" className="ml-1.5">↗</span>
                        </a>
                        <p className="text-xs text-gray-500">
                            Mac → TV: In Control Center → Screen Mirroring, select your TV and choose Extended Display.
                            Open the room display in its own window and drag it onto the TV; keep moderating on your laptop.
                            To switch desktops independently, enable “Displays have separate Spaces” in System Settings → Desktop &amp; Dock → Mission Control (log out and back in if prompted).
                        </p>
                        {/* How the room display presents itself. Set here, so
                            nobody has to walk up to the shared screen. */}
                        <SelectSetting
                            label="QR code"
                            title="How the room display shows the join QR code"
                            value={state.displayQr || 'full'}
                            onChange={(qr) => onSetDisplaySettings({ qr })}
                            options={[['full', 'Large'], ['corner', 'Small, in a corner'], ['hidden', 'Hidden']]}
                        />
                        <SelectSetting
                            label="Layout"
                            title="One question shows the question you chose with Show on display. If you chose none, it shows the first pinned question, or the newest one when nothing is pinned. Before and after compares two opinion snapshots: the first and the latest, unless you chose others under Opinion Snapshots"
                            value={state.displayLayout || 'all'}
                            onChange={(layout) => onSetDisplaySettings({ layout })}
                            options={[['all', 'All questions'], ['focus', 'One question'], ['compare', 'Before and after']]}
                        />
                        {(state.displayLayout || 'all') === 'all' && (
                            <>
                                <SelectSetting
                                    label="Sort"
                                    value={state.displaySort || 'oldest'}
                                    onChange={(sort) => onSetDisplaySettings({ sort })}
                                    options={[
                                        ['oldest', 'Oldest first'], ['newest', 'Newest first'],
                                        ['interesting', 'Most interesting'], ['agreement', 'Most agreement'],
                                        ['disagreement', 'Most disagreement'], ['controversial', 'Most controversial'],
                                    ]}
                                />
                                <Switch
                                    label="Pinned questions first"
                                    checked={state.displayPinnedFirst !== false}
                                    onChange={(pinnedFirst) => onSetDisplaySettings({ pinnedFirst })}
                                />
                                <p className="text-xs text-gray-500">Agreement sorts use only results visible on the display.</p>
                            </>
                        )}
                    </Group>

                    <Group title="This page">
                        <Switch
                            label="Join QR on this page"
                            hint="A floating code you can resize, for when you project this page"
                            checked={showJoinQr}
                            onChange={onToggleJoinQr}
                        />
                    </Group>

                    {/* Discussion-wide response feedback: these apply to every
                        Open Ended prompt at once (read silently, then open
                        reactions, then open comments). */}
                    <Group title="Response feedback">
                        <Switch
                            label="Reactions"
                            hint="Participants can react to responses"
                            checked={!!state.reactionsEnabled}
                            onChange={(on) => onSetFlags({ reactions_enabled: on })}
                        />
                        {state.reactionsEnabled && (
                            <Switch
                                label="Reactions open"
                                hint="Turn off to keep reactions hidden until you are ready"
                                checked={!!state.reactionsVisible}
                                onChange={(on) => onSetFlags({ reactions_visible: on })}
                            />
                        )}
                        <Switch
                            label="Comments"
                            hint="Participants can comment on responses"
                            checked={!!state.commentsEnabled}
                            onChange={(on) => onSetFlags({ comments_enabled: on })}
                        />
                        {/* Which epistemic reactions participants may use, for
                            the whole session. */}
                        {state.reactionsEnabled && (
                            <div role="group" aria-label="Reaction set" className="border-t border-indigo-100 pt-3">
                                <div className="mb-1.5 font-medium text-gray-800">Reaction set</div>
                                <div className="flex flex-wrap gap-1 text-xs">
                                    {EPISTEMIC_REACTIONS.map((r) => {
                                        const on = activeReactionKeys.includes(r.key);
                                        return (
                                            <button
                                                key={r.key}
                                                type="button"
                                                aria-pressed={on}
                                                // Toggling rebuilds the active list in catalog order; the
                                                // last remaining reaction can't be removed (the server
                                                // ignores an empty set, so guard the UI to match).
                                                onClick={() => {
                                                    const next = on
                                                        ? activeReactionKeys.filter(k => k !== r.key)
                                                        : EPISTEMIC_REACTIONS.map(c => c.key)
                                                            .filter(k => k === r.key || activeReactionKeys.includes(k));
                                                    if (next.length === 0) return;
                                                    onSetReactionKeys(next);
                                                }}
                                                title={on ? `Hide "${r.label}"` : `Show "${r.label}"`}
                                                className={`px-2 py-0.5 rounded-full border ${on
                                                    ? 'bg-indigo-100 border-indigo-400 text-indigo-800'
                                                    : 'bg-white border-gray-300 text-gray-400 line-through'}`}
                                            >
                                                <span className="mr-1">{r.emoji}</span>{r.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </Group>

                    <Group title="People">
                        <div>
                            <button
                                type="button"
                                ref={linkPrompt.toolbarButtonRef}
                                onClick={onCopyLink}
                                className={BUTTON_CLASS}
                            >
                                {linkCopied ? 'Link copied!' : 'Copy moderator link'}
                                {!linkPrompt.saved && <ModeratorLinkUnsavedMark />}
                            </button>
                            <p className="mt-1 text-xs text-gray-500">Anyone with this link becomes a moderator</p>
                        </div>
                        <button
                            type="button"
                            onClick={onToggleParticipants}
                            aria-expanded={showParticipants}
                            aria-controls={showParticipants ? participantsId : undefined}
                            className={BUTTON_CLASS}
                        >
                            Manage participants
                            <span aria-hidden="true" className="ml-1.5">{showParticipants ? '▴' : '▾'}</span>
                        </button>
                    </Group>

                    {showParticipants && (
                        <div id={participantsId} className="sm:col-span-2">{children}</div>
                    )}
                </div>
            )}
        </div>
    );
};

ModeratorPanel.propTypes = {
    discussionSlug: PropTypes.string.isRequired,
    state: PropTypes.shape({
        locked: PropTypes.bool,
        moderatorOnly: PropTypes.bool,
        postingMode: PropTypes.string,
        listed: PropTypes.bool,
        resultsVisibility: PropTypes.string,
        displayQr: PropTypes.string,
        displayLayout: PropTypes.string,
        displaySort: PropTypes.string,
        displayPinnedFirst: PropTypes.bool,
        displayQuestionId: PropTypes.number,
        reactionsEnabled: PropTypes.bool,
        questionDownvotesEnabled: PropTypes.bool,
        reactionsVisible: PropTypes.bool,
        commentsEnabled: PropTypes.bool,
        handsEnabled: PropTypes.bool,
    }).isRequired,
    theme: PropTypes.string.isRequired,
    themes: PropTypes.arrayOf(PropTypes.shape({
        key: PropTypes.string.isRequired,
        label: PropTypes.string.isRequired,
        swatch: PropTypes.string.isRequired,
    })).isRequired,
    activeReactionKeys: PropTypes.arrayOf(PropTypes.string).isRequired,
    onSetLocked: PropTypes.func.isRequired,
    onSetPostingMode: PropTypes.func.isRequired,
    onSetListed: PropTypes.func.isRequired,
    onSetResultsVisibility: PropTypes.func.isRequired,
    onSetDisplaySettings: PropTypes.func.isRequired,
    onSetTheme: PropTypes.func.isRequired,
    onSetFlags: PropTypes.func.isRequired,
    onSetReactionKeys: PropTypes.func.isRequired,
    linkPrompt: PropTypes.shape({
        saved: PropTypes.bool.isRequired,
        toolbarButtonRef: PropTypes.object.isRequired,
    }).isRequired,
    linkCopied: PropTypes.bool.isRequired,
    onCopyLink: PropTypes.func.isRequired,
    showJoinQr: PropTypes.bool.isRequired,
    onToggleJoinQr: PropTypes.func.isRequired,
    showParticipants: PropTypes.bool.isRequired,
    onToggleParticipants: PropTypes.func.isRequired,
    children: PropTypes.node,
};

export default ModeratorPanel;
