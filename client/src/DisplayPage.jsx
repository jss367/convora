import { formatPrompt } from './questions/formatPrompt';
import { sortDisplayQuestions } from './display/sortDisplayQuestions.mjs';
import { getNumericalRange } from './questions/questionHelpers.mjs';
import PropTypes from 'prop-types';
import { QRCodeSVG } from 'qrcode.react';
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useConnectionLost, useDiscussionSocket } from './hooks/useDiscussionRoom';
import useFullscreen from './hooks/useFullscreen';
import useIdle from './hooks/useIdle';
import useScreenWakeLock from './hooks/useScreenWakeLock';
import {
    AgreementChart, MultipleChoiceChart, NumericalChart, ResponseCountOnly, YesNoChart,
} from './display/DisplayCharts';
import DisplayComparison from './display/DisplayComparison';
import { EPISTEMIC_REACTIONS, QuestionTypes } from './questions/config';
import { slugifyTopic } from './slugs';

// The read-only room display: what a moderator puts on a shared TV or projector
// while everyone votes on their phones. It joins the discussion as a display,
// not as a participant, so it is never counted and cannot vote, and it never
// reads this browser's participant identity or moderator token. The server
// decides what it may see: with results shown after voting, tallied questions
// arrive with only their response count (see displayView in server.js).

const THEME_KEYS = ['indigo', 'orange', 'emerald', 'rose', 'slate'];
const TALLIED_TYPES = [QuestionTypes.AGREEMENT, QuestionTypes.YES_NO, QuestionTypes.MULTIPLE_CHOICE, QuestionTypes.NUMERICAL];
// Written responses beyond this many are summarized, so one busy question cannot
// push the rest off the screen.
const MAX_WRITTEN_RESPONSES = 8;
const MAX_FOCUS_WRITTEN_RESPONSES = 10;
const QR_MODES = ['full', 'corner', 'hidden'];
// Nobody is at the screen to press a button, so a failed load retries itself.
const RETRY_DELAY_MS = 5000;
const DISPLAY_SYNC_INTERVAL_MS = 30_000;
// The full-screen button and the cursor fade out after this long without the
// mouse moving, so the shared screen shows only the discussion.
const CONTROLS_IDLE_MS = 3000;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const responseCountOf = question => (question.resultsHidden
    ? Number(question.responseCount) || 0
    : (question.votes || []).length);

const TalliedResults = ({ question, focus }) => {
    if (question.resultsHidden) {
        // A Multiple Choice question's options are part of the question, not its
        // results, so the room can read them while the tallies stay hidden.
        const options = question.type === QuestionTypes.MULTIPLE_CHOICE ? question.options : undefined;
        return <ResponseCountOnly count={responseCountOf(question)} options={options} focus={focus} />;
    }
    if (question.type === QuestionTypes.AGREEMENT) return <AgreementChart question={question} focus={focus} />;
    if (question.type === QuestionTypes.YES_NO) return <YesNoChart question={question} focus={focus} />;
    if (question.type === QuestionTypes.MULTIPLE_CHOICE) return <MultipleChoiceChart question={question} focus={focus} />;
    const { minValue, maxValue } = getNumericalRange(question);
    return <NumericalChart question={question} minValue={minValue} maxValue={maxValue} focus={focus} />;
};
TalliedResults.propTypes = { question: PropTypes.object.isRequired, focus: PropTypes.bool };

const sortedResponses = question => [...(question.votes || [])]
    .sort((a, b) => a.id - b.id);

// Open Ended responses are shown as participants see them. Ratings and reactions appear only
// when the moderator has revealed them; the server sends them only then.
const WrittenResponses = ({ question, reactionKeys, focus }) => {
    const votes = sortedResponses(question);
    const showReactions = question.reactionsEnabled && question.reactionsVisible;
    const shown = votes.slice(0, focus ? MAX_FOCUS_WRITTEN_RESPONSES : MAX_WRITTEN_RESPONSES);
    if (votes.length === 0) {
        return <p className={`${focus ? 'text-4xl' : 'text-2xl'} text-gray-500`}>No responses yet</p>;
    }
    return (
        <div>
            <ul className={focus ? 'grid grid-cols-1 gap-4 xl:grid-cols-2' : 'space-y-3'}>
                {shown.map(vote => {
                    const net = (vote.qualityUp || 0) - (vote.qualityDown || 0);
                    const reactions = showReactions
                        ? EPISTEMIC_REACTIONS.filter(r => reactionKeys.includes(r.key) && (vote.reactionCounts || {})[r.key] > 0)
                        : [];
                    return (
                        <li
                            key={vote.id}
                            className={`rounded-lg border-l-8 border-primary bg-gray-50 px-5 py-4 text-gray-900 ${focus ? 'text-4xl' : 'text-2xl'}`}
                        >
                            {question.showAttribution !== false && <div className="text-sm text-gray-500">{vote.pseudonym || 'Anonymous'}</div>}
                            <div className="flex items-start gap-4">
                                {showReactions && (
                                    <span className="shrink-0 font-bold tabular-nums text-gray-600">{net > 0 ? `+${net}` : net}</span>
                                )}
                                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-snug">{vote.value}</span>
                                {!question.reactionsEnabled && vote.upvotes > 0 && (
                                    <span className="shrink-0 font-bold tabular-nums text-gray-600" aria-label={`${vote.upvotes} legacy upvote${vote.upvotes === 1 ? '' : 's'}`}>▲ {vote.upvotes}</span>
                                )}
                            </div>
                            {(reactions.length > 0 || (vote.comments || []).length > 0) && (
                                <div className={`mt-2 flex flex-wrap gap-4 text-gray-600 ${focus ? 'text-2xl' : 'text-lg'}`}>
                                    {reactions.map(r => (
                                        <span key={r.key}>{r.emoji} {r.label} {vote.reactionCounts[r.key]}</span>
                                    ))}
                                    {(vote.comments || []).length > 0 && (
                                        <span>💬 {plural(vote.comments.length, 'comment', 'comments')}</span>
                                    )}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
            {votes.length > shown.length && (
                <p className={`mt-3 text-gray-500 ${focus ? 'text-2xl' : 'text-lg'}`}>and {votes.length - shown.length} more</p>
            )}
        </div>
    );
};
WrittenResponses.propTypes = {
    question: PropTypes.object.isRequired,
    reactionKeys: PropTypes.arrayOf(PropTypes.string).isRequired,
    focus: PropTypes.bool,
};

const countLabel = question => {
    if (TALLIED_TYPES.includes(question.type)) return plural(responseCountOf(question), 'response', 'responses');
    const count = (question.votes || []).length;
    return plural(count, 'response', 'responses');
};

const QuestionCard = ({ question, reactionKeys, focus }) => (
    <article
        className={`flex flex-col rounded-2xl bg-white shadow-lg ring-1 ring-black/5 ${focus ? 'p-10' : 'p-7'}`}
        data-testid="display-question"
    >
        <header className={`flex items-start justify-between gap-6 ${focus ? 'mb-8' : 'mb-5'}`}>
            <h2 className={`font-bold leading-tight text-gray-900 ${focus ? 'text-6xl' : 'text-3xl'}`}>
                {question.pinned && <span aria-label="Pinned" className="mr-3">📌</span>}
                {formatPrompt(question.text)}
            </h2>
            {/* With results withheld, the count is the whole chart below. */}
            {!question.resultsHidden && (
                <span className={`shrink-0 rounded-full bg-gray-100 font-semibold tabular-nums text-gray-700 ${focus ? 'px-5 py-2 text-3xl' : 'px-4 py-1 text-xl'}`}>
                    {countLabel(question)}
                </span>
            )}
        </header>
        {TALLIED_TYPES.includes(question.type)
            ? <TalliedResults question={question} focus={focus} />
            : question.resultsHidden ? <p>Collecting independent answers. Waiting for the moderator to reveal responses.</p>
                : <WrittenResponses question={question} reactionKeys={reactionKeys} focus={focus} />}
    </article>
);
QuestionCard.propTypes = {
    question: PropTypes.object.isRequired,
    reactionKeys: PropTypes.arrayOf(PropTypes.string).isRequired,
    focus: PropTypes.bool,
};

// The one-question view shows the question the moderator chose with "Show on
// display". When they chose none (or it was deleted), it shows the first pinned
// question (the server sends pinned questions first), otherwise the newest.
const focusQuestionOf = (questions, chosenId) => questions.find(q => q.id === chosenId)
    || questions.find(q => q.pinned)
    || questions[questions.length - 1];

// The two snapshots the before-and-after view compares: the ones the moderator
// chose, otherwise the first snapshot and the latest one. `after` is null when
// there is no later snapshot to compare with.
const comparisonOf = (snapshots, beforeId, afterId) => {
    const before = snapshots.find(snapshot => snapshot.id === beforeId) || snapshots[0];
    if (!before) return { before: null, after: null };
    const after = snapshots.find(snapshot => snapshot.id === afterId) || snapshots[snapshots.length - 1];
    return { before, after: after.id > before.id ? after : null };
};

// The saved opinion snapshots, loaded only while the display is comparing them.
// The display asks as an anonymous viewer, so with results shown after voting
// the server sends a snapshot's results only for questions the moderator has
// shown to everyone. `reloadKey` changes when that set might have changed.
// Returns null while loading, or { snapshots } / { failed: true }.
const useSnapshots = (socket, discussionSlug, enabled, reloadKey) => {
    const visibilityContext = JSON.stringify([discussionSlug, reloadKey]);
    const [result, setResult] = useState(null);
    const [version, setVersion] = useState(0);
    useEffect(() => {
        const reload = () => setVersion(value => value + 1);
        socket.on('snapshotsChanged', reload);
        // A reconnect may have missed a snapshot saved while the screen was offline.
        socket.on('connect', reload);
        return () => {
            socket.off('snapshotsChanged', reload);
            socket.off('connect', reload);
        };
    }, [socket]);
    useEffect(() => {
        if (!enabled) {
            setResult(null);
            return undefined;
        }
        const controller = new AbortController();
        let retry = null;
        fetch(`/api/discussions/${encodeURIComponent(discussionSlug)}/snapshots`, { signal: controller.signal })
            .then(async response => {
                if (!response.ok) throw new Error(`Snapshots failed with status ${response.status}`);
                const { snapshots } = await response.json();
                if (!controller.signal.aborted) setResult({ visibilityContext, snapshots: Array.isArray(snapshots) ? snapshots : [] });
            })
            .catch(() => {
                if (controller.signal.aborted) return;
                // Keep a list already on screen; nobody is there to retry by hand.
                setResult(current => current?.visibilityContext === visibilityContext && current.snapshots ? current : { visibilityContext, failed: true });
                retry = setTimeout(() => setVersion(value => value + 1), RETRY_DELAY_MS);
            });
        return () => {
            controller.abort();
            clearTimeout(retry);
        };
    }, [discussionSlug, enabled, reloadKey, version]);
    return enabled && result?.visibilityContext === visibilityContext ? result : null;
};

const JoinCard = ({ linkUrl, linkText, title, compact }) => (
    <div
        className={compact
            ? 'flex items-center gap-4 rounded-xl bg-white py-2 pl-2 pr-5 text-left'
            : 'flex flex-col items-center rounded-2xl bg-white p-8 text-center shadow-lg ring-1 ring-black/5'}
        data-testid="display-join"
    >
        <div role="img" aria-label={`QR code to join ${title}`}>
            <QRCodeSVG value={linkUrl} size={compact ? 120 : 340} includeMargin={!compact} />
        </div>
        <div className={compact ? 'text-left' : ''}>
            <p className={`font-semibold uppercase tracking-wide text-gray-500 ${compact ? 'text-base' : 'mt-4 text-xl'}`}>Scan to join</p>
            <p
                className={`break-all font-bold text-gray-900 ${compact ? 'max-w-[16rem] text-xl' : 'mt-2 text-3xl'}`}
                data-testid="display-join-link"
            >
                {linkText}
            </p>
        </div>
    </div>
);
JoinCard.propTypes = {
    linkUrl: PropTypes.string.isRequired,
    linkText: PropTypes.string.isRequired,
    title: PropTypes.string.isRequired,
    compact: PropTypes.bool,
};

// The only control on the display. It hides the browser's tabs, toolbar and
// bookmarks, which otherwise show on a TV when a laptop is mirrored to it. It
// fades rather than unmounting, so the header does not shift when it hides.
const FullscreenButton = ({ hidden }) => {
    const { supported, active, toggle } = useFullscreen();
    if (!supported) return null;
    return (
        <button
            type="button"
            onClick={toggle}
            className={`rounded-lg border-2 border-white/70 px-4 py-1 text-xl font-semibold text-white transition-opacity duration-500 hover:bg-white/15 focus-visible:opacity-100 ${hidden ? 'pointer-events-none opacity-0' : 'opacity-100'}`}
        >
            {active ? 'Exit full screen' : 'Full screen'}
        </button>
    );
};
FullscreenButton.propTypes = { hidden: PropTypes.bool.isRequired };

const DisplayPage = () => {
    const { topic } = useParams();
    const discussionSlug = slugifyTopic(topic);
    const socket = useDiscussionSocket();
    const connectionLost = useConnectionLost(socket);
    // Nobody touches the shared screen, so keep it from going to sleep.
    useScreenWakeLock();
    const idle = useIdle(CONTROLS_IDLE_MS);
    // undefined while loading, null when the discussion does not exist.
    const [discussion, setDiscussion] = useState(undefined);
    // null until the server has sent the questions at least once.
    const [questions, setQuestions] = useState(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [presence, setPresence] = useState(0);
    const [state, setState] = useState({});

    useEffect(() => {
        setDiscussion(undefined);
        setQuestions(null);
        setLoadFailed(false);
        // Only another discussion's settings are stale. A reconnect or a retry
        // keeps the ones on screen until the server sends them again.
        setState({});
        let retry = null;
        const join = () => {
            clearTimeout(retry);
            retry = null;
            if (socket.connected) socket.emit('joinDisplay', discussionSlug);
        };
        const syncVisibleDisplay = () => {
            if (document.visibilityState === 'visible') join();
        };
        const restorePage = event => { if (event.persisted) syncVisibleDisplay(); };
        const handlers = {
            discussion: payload => { if (!payload || payload.slug === discussionSlug) setDiscussion(payload); },
            questions: payload => {
                setQuestions(Array.isArray(payload) ? payload : []);
                setLoadFailed(false);
            },
            presence: setPresence,
            discussionState: payload => setState(payload || {}),
            // The server could not load this discussion's questions. The socket
            // is still connected, so nothing else would ask again.
            error: () => {
                setLoadFailed(true);
                if (!retry) retry = setTimeout(join, RETRY_DELAY_MS);
            },
        };
        for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
        socket.on('connect', join);
        if (socket.connected) join();
        const syncTimer = setInterval(syncVisibleDisplay, DISPLAY_SYNC_INTERVAL_MS);
        document.addEventListener('visibilitychange', syncVisibleDisplay);
        window.addEventListener('pageshow', restorePage);
        return () => {
            clearInterval(syncTimer);
            document.removeEventListener('visibilitychange', syncVisibleDisplay);
            window.removeEventListener('pageshow', restorePage);
            clearTimeout(retry);
            if (socket.connected) socket.emit('leaveDisplay', discussionSlug);
            socket.off('connect', join);
            for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
        };
    }, [socket, discussionSlug]);

    const theme = THEME_KEYS.includes(state.theme) ? state.theme : 'indigo';
    useEffect(() => {
        const root = document.documentElement;
        root.setAttribute('data-theme', theme);
        return () => root.removeAttribute('data-theme');
    }, [theme]);

    const title = discussion?.topic || topic;
    useEffect(() => {
        const previous = document.title;
        document.title = `${title} · Room display`;
        return () => { document.title = previous; };
    }, [title]);

    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const joinUrl = `${origin}/discussion/${discussionSlug}`;
    // A short link makes a sparser QR code and is easier to type from the screen.
    const shortUrl = discussion?.short_code ? `${origin}/s/${discussion.short_code}` : '';
    const linkUrl = shortUrl || joinUrl;
    const linkText = linkUrl.replace(/^https?:\/\//, '');
    const reactionKeys = state.reactionKeys || EPISTEMIC_REACTIONS.map(r => r.key);

    // Which questions' results this screen may see decides what the server
    // sends of each snapshot, so reload them when that changes.
    const snapshotReloadKey = `${state.resultsVisibility}|${(questions || []).map(q => `${q.id}${q.resultsHidden ? 'h' : ''}`).join(',')}`;
    const snapshotResult = useSnapshots(socket, discussionSlug, state.displayLayout === 'compare' && discussion != null, snapshotReloadKey);

    if (discussion === null) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-gray-100 p-8">
                <p className="text-3xl text-gray-700">Discussion not found</p>
            </main>
        );
    }

    const qrMode = discussion?.slug === discussionSlug && QR_MODES.includes(state.displayQr) ? state.displayQr : 'hidden';
    const focus = state.displayLayout === 'focus';
    const compare = state.displayLayout === 'compare';
    const ready = discussion !== undefined && questions !== null && state.displayHiddenQuestionIds !== undefined;
    const hiddenIds = new Set(state.displayHiddenQuestionIds);
    const visibleQuestions = (questions || []).filter(question => !hiddenIds.has(question.id));

    let body;
    if (loadFailed && questions === null) {
        body = <p className="text-3xl text-red-600" role="alert">Couldn’t load the questions. Trying again…</p>;
    } else if (!ready) {
        body = <p className="text-3xl text-gray-500">Loading…</p>;
    } else if (compare) {
        const { before, after } = comparisonOf(snapshotResult?.snapshots || [], state.displayBeforeSnapshotId, state.displayAfterSnapshotId);
        if (snapshotResult?.failed) {
            body = <p className="text-3xl text-red-600" role="alert">Couldn’t load the snapshots. Trying again…</p>;
        } else if (!snapshotResult) {
            body = <p className="text-3xl text-gray-500">Loading…</p>;
        } else if (!before) {
            body = <p className="text-4xl text-gray-500">No opinion snapshots saved yet</p>;
        } else {
            body = (
                <DisplayComparison
                    before={before}
                    after={after}
                    questionId={state.displayQuestionId ?? undefined}
                    hiddenIds={hiddenIds}
                    wide={qrMode !== 'full'}
                />
            );
        }
    } else if (visibleQuestions.length === 0) {
        body = <p className="text-4xl text-gray-500">{questions.length ? 'No questions on display' : 'No questions yet'}</p>;
    } else if (focus) {
        body = <QuestionCard question={focusQuestionOf(visibleQuestions, state.displayQuestionId)} reactionKeys={reactionKeys} focus />;
    } else {
        body = (
            <ol className={`grid grid-cols-1 gap-8 ${qrMode === 'full' ? '2xl:grid-cols-2' : 'xl:grid-cols-2'}`}>
                {sortDisplayQuestions(visibleQuestions, state.displaySort, state.displayPinnedFirst).map(question => (
                    <li key={question.id} className="contents">
                        <QuestionCard question={question} reactionKeys={reactionKeys} />
                    </li>
                ))}
            </ol>
        );
    }

    return (
        <main className={`flex flex-col bg-gray-100 ${qrMode === 'corner' ? 'h-dvh overflow-y-auto' : 'min-h-screen'} ${idle ? 'cursor-none' : ''}`} aria-label="Room display">
            {/* The right-hand group holds the full-screen button; it wraps below
                the title on narrow screens. */}
            <header
                className="flex shrink-0 flex-wrap items-center justify-between gap-x-10 gap-y-3 bg-primary px-8 py-6 text-white shadow-md lg:px-12"
                data-testid="display-header"
            >
                <h1 className="min-w-0 text-4xl font-bold leading-tight lg:text-5xl">{title}</h1>
                <div className="flex flex-wrap items-center gap-x-8 gap-y-2 text-2xl font-semibold">
                    {state.locked && <span>🔒 Voting is closed</span>}
                    {connectionLost && <span className="rounded-full bg-white px-4 py-1 text-red-700">Reconnecting…</span>}
                    <span role="status" className="tabular-nums">{plural(presence, 'person', 'people')} here now</span>
                    <FullscreenButton hidden={idle} />
                        </div>
            </header>
            <div className={`flex flex-1 flex-col gap-10 p-8 lg:flex-row lg:items-start lg:p-12 ${qrMode === 'corner' ? 'min-h-48 overflow-y-auto' : ''}`}>
                {qrMode === 'full' && (
                    <aside className="shrink-0 lg:sticky lg:top-12 lg:w-[26rem]">
                        <JoinCard linkUrl={linkUrl} linkText={linkText} title={title} />
                    </aside>
                )}
                <section className="min-w-0 flex-1" aria-label="Questions">{body}</section>
            </div>
            {qrMode === 'corner' && (
                <footer className="flex shrink-0 px-8 pb-8 lg:px-12 lg:pb-12" data-testid="display-footer">
                    {/* Keep the bottom-left QR code in the page flow so it cannot cover questions. */}
                    <JoinCard linkUrl={linkUrl} linkText={linkText} title={title} compact />
                </footer>
            )}
        </main>
    );
};

export default DisplayPage;
