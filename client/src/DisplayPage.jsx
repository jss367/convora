import PropTypes from 'prop-types';
import { QRCodeSVG } from 'qrcode.react';
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useConnectionLost, useDiscussionSocket } from './hooks/useDiscussionRoom';
import NumericalResults from './questions/NumericalResults';
import { AgreementResults, YesNoResults } from './questions/OpinionResults';
import { EPISTEMIC_REACTIONS, QuestionTypes } from './questions/config';
import { slugifyTopic } from './slugs';

// The read-only room display: what a moderator puts on a shared TV or projector
// while everyone votes on their phones. It joins the discussion as a display,
// not as a participant, so it is never counted and cannot vote, and it never
// reads this browser's participant identity or moderator token. The server
// decides what it may see: with results shown after voting, tallied questions
// arrive with only their response count (see displayView in server.js).

const THEME_KEYS = ['indigo', 'orange', 'emerald', 'rose', 'slate'];
const TALLIED_TYPES = [QuestionTypes.AGREEMENT, QuestionTypes.YES_NO, QuestionTypes.NUMERICAL];
// Written responses beyond this many are summarized, so one busy question cannot
// push the rest off the screen.
const MAX_WRITTEN_RESPONSES = 8;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

const responseCountOf = question => (question.resultsHidden
    ? Number(question.responseCount) || 0
    : (question.votes || []).length);

// The results components are sized for a phone held at arm's length; scale them
// up so they read from across a room.
const LargeResults = ({ children }) => <div style={{ zoom: 1.6 }}>{children}</div>;
LargeResults.propTypes = { children: PropTypes.node.isRequired };

const TalliedResults = ({ question }) => {
    const count = responseCountOf(question);
    if (question.resultsHidden) {
        return (
            <div data-testid="display-results-hidden">
                <p className="text-3xl font-semibold text-gray-800">{plural(count, 'response', 'responses')}</p>
                <p className="mt-1 text-lg text-gray-500">Results are shown to each person after they vote</p>
            </div>
        );
    }
    let results;
    if (question.type === QuestionTypes.AGREEMENT) results = <AgreementResults question={question} />;
    else if (question.type === QuestionTypes.YES_NO) results = <YesNoResults question={question} />;
    else {
        const minValue = parseInt(question.minValue ?? question.min_value) || 0;
        const maxValue = parseInt(question.maxValue ?? question.max_value) || 100;
        results = <NumericalResults question={question} minValue={minValue} maxValue={maxValue} />;
    }
    return (
        <div>
            <p className="mb-2 text-3xl font-semibold text-gray-800">{plural(count, 'response', 'responses')}</p>
            <LargeResults>{results}</LargeResults>
        </div>
    );
};
TalliedResults.propTypes = { question: PropTypes.object.isRequired };

// Open Ended and Brainstorm responses are the discussion itself, so they are
// shown as participants see them. Brainstorm ratings and reactions appear only
// when the moderator has revealed them; the server sends them only then.
const WrittenResponses = ({ question, reactionKeys }) => {
    const votes = [...(question.votes || [])]
        .sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0) || a.id - b.id);
    const isBrainstorm = question.type === QuestionTypes.BRAINSTORM;
    const showReactions = isBrainstorm && question.reactionsEnabled && question.reactionsVisible;
    const shown = votes.slice(0, MAX_WRITTEN_RESPONSES);
    return (
        <div>
            <p className="mb-3 text-3xl font-semibold text-gray-800">
                {plural(votes.length, isBrainstorm ? 'idea' : 'response', isBrainstorm ? 'ideas' : 'responses')}
            </p>
            {shown.length > 0 && (
                <ul className="space-y-2">
                    {shown.map(vote => {
                        const net = (vote.qualityUp || 0) - (vote.qualityDown || 0);
                        const reactions = showReactions
                            ? EPISTEMIC_REACTIONS.filter(r => reactionKeys.includes(r.key) && (vote.reactionCounts || {})[r.key] > 0)
                            : [];
                        return (
                            <li key={vote.id} className="rounded-md bg-gray-50 px-4 py-3 text-2xl text-gray-800">
                                <div className="flex items-start gap-3">
                                    {showReactions && (
                                        <span className="shrink-0 font-semibold text-gray-600">{net > 0 ? `+${net}` : net}</span>
                                    )}
                                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{vote.value}</span>
                                    {!isBrainstorm && vote.upvotes > 0 && (
                                        <span className="shrink-0 font-semibold text-gray-600">▲ {vote.upvotes}</span>
                                    )}
                                </div>
                                {(reactions.length > 0 || (vote.comments || []).length > 0) && (
                                    <div className="mt-1 flex flex-wrap gap-3 text-lg text-gray-600">
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
            )}
            {votes.length > shown.length && (
                <p className="mt-2 text-lg text-gray-500">and {votes.length - shown.length} more</p>
            )}
        </div>
    );
};
WrittenResponses.propTypes = {
    question: PropTypes.object.isRequired,
    reactionKeys: PropTypes.arrayOf(PropTypes.string).isRequired,
};

const DisplayPage = () => {
    const { topic } = useParams();
    const discussionSlug = slugifyTopic(topic);
    const socket = useDiscussionSocket();
    const connectionLost = useConnectionLost(socket);
    // undefined while loading, null when the discussion does not exist.
    const [discussion, setDiscussion] = useState(undefined);
    const [questions, setQuestions] = useState([]);
    const [presence, setPresence] = useState(0);
    const [state, setState] = useState({});

    useEffect(() => {
        setDiscussion(undefined);
        setQuestions([]);
        const handlers = {
            discussion: payload => { if (!payload || payload.slug === discussionSlug) setDiscussion(payload); },
            questions: payload => setQuestions(Array.isArray(payload) ? payload : []),
            presence: setPresence,
            discussionState: payload => setState(payload || {}),
        };
        for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
        const join = () => socket.emit('joinDisplay', discussionSlug);
        socket.on('connect', join);
        if (socket.connected) join();
        return () => {
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

    if (discussion === null) {
        return (
            <main className="flex min-h-screen items-center justify-center bg-gray-100 p-8">
                <p className="text-3xl text-gray-700">Discussion not found</p>
            </main>
        );
    }

    return (
        <main className="min-h-screen bg-gray-100 p-6 lg:p-10" aria-label="Room display">
            <div className="flex flex-col gap-8 lg:flex-row lg:items-start">
                <aside className="flex shrink-0 flex-col items-center rounded-xl bg-white p-6 text-center shadow-lg lg:sticky lg:top-10 lg:w-[26rem]">
                    <h1 className="text-4xl font-bold text-primary">{title}</h1>
                    <div className="mt-6" role="img" aria-label={`QR code to join ${title}`}>
                        <QRCodeSVG value={linkUrl} size={320} includeMargin />
                    </div>
                    <p className="mt-3 text-xl font-semibold uppercase tracking-wide text-gray-500">Scan to join</p>
                    <p className="mt-2 break-all text-2xl font-semibold text-gray-800" data-testid="display-join-link">{linkText}</p>
                    <p className="mt-6 text-3xl font-semibold text-gray-800" role="status">
                        {plural(presence, 'person', 'people')} here now
                    </p>
                    {state.locked && <p className="mt-3 text-xl text-amber-700">🔒 Voting is closed</p>}
                    {connectionLost && <p className="mt-3 text-xl text-red-600">Reconnecting…</p>}
                </aside>

                <section className="min-w-0 flex-1" aria-label="Questions">
                    {discussion === undefined ? (
                        <p className="text-2xl text-gray-500">Loading…</p>
                    ) : questions.length === 0 ? (
                        <p className="text-3xl text-gray-500">No questions yet</p>
                    ) : (
                        <ol className="grid grid-cols-1 gap-6 2xl:grid-cols-2">
                            {questions.map(question => (
                                <li key={question.id} className="rounded-xl bg-white p-6 shadow-lg" data-testid="display-question">
                                    <h2 className="mb-4 text-3xl font-bold text-gray-900">
                                        {question.pinned && <span aria-label="Pinned" className="mr-2">📌</span>}
                                        {question.text}
                                    </h2>
                                    {TALLIED_TYPES.includes(question.type)
                                        ? <TalliedResults question={question} />
                                        : <WrittenResponses question={question} reactionKeys={reactionKeys} />}
                                </li>
                            ))}
                        </ol>
                    )}
                </section>
            </div>
        </main>
    );
};

export default DisplayPage;
