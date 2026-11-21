import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';

export function useSpeakingQueue(socket, slug, enabled, userId, token, name) {
    const [view, setView] = useState(null);
    const refreshRef = useRef(null);
    useEffect(() => {
        setView(null);
        if (!enabled || !userId) return;
        let revision = 0;
        const refresh = () => {
            if (!socket.connected) return;
            const request = ++revision;
            socket.timeout(8000).emit('readSpeakingQueue', slug, userId, token, (error, result) => {
                if (request !== revision) return;
                setView({ slug, token, userId, entries: !error && result?.ok ? result.entries : null });
            });
        };
        const changed = room => { if (room === slug) refresh(); };
        refreshRef.current = refresh;
        socket.on('speakingQueueChanged', changed);
        socket.on('discussionState', refresh);
        refresh();
        return () => {
            ++revision;
            refreshRef.current = null;
            socket.off('speakingQueueChanged', changed);
            socket.off('discussionState', refresh);
        };
    }, [socket, slug, enabled, userId, token]);
    const entries = view?.slug === slug && view.token === token && view.userId === userId ? view.entries : undefined;
    return { entries, refresh: () => refreshRef.current?.(), change(action, questionId, entryId, finish) {
        if (!socket.connected) return finish(false);
        socket.timeout(8000).emit('changeSpeakingQueue', slug, { action, questionId, entryId, token, name, userId }, (error, result) => {
            refreshRef.current?.();
            finish(!error && result?.ok);
        });
    } };
}

export default function SpeakingQueue({ queue, questionId, moderator, locked, name }) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState(false);
    const entries = queue.entries?.filter(entry => entry.questionId === questionId) || [];
    const raised = entries.some(entry => entry.mine);
    const act = (action, id) => {
        setPending(true);
        setError(false);
        queue.change(action, questionId, id, ok => { setPending(false); setError(!ok); });
    };
    const disabled = locked || !queue.entries || pending;
    return <section aria-label="Speaking queue" className="mt-4 border-t pt-3 text-sm">
        <button type="button" aria-pressed={raised} disabled={disabled} onClick={() => act(raised ? 'lower' : 'raise')}
            className="rounded border px-3 py-1 text-primary disabled:opacity-50">{raised ? 'Lower hand' : 'Raise hand to speak'}</button>
        <span className="ml-2 text-gray-600">{raised ? 'Your hand is raised.' : `Only moderators see you in the queue, as ${name || 'Anonymous'}.`}</span>
        {moderator && <div className="mt-2"><strong>Speaking queue</strong>
            {entries.length ? <ol className="list-decimal pl-6">{entries.map(entry => <li key={entry.id} className="py-1">
                {entry.name} <button type="button" disabled={disabled} onClick={() => act('done', entry.id)}
                    aria-label={`Mark ${entry.name} as called on`} className="ml-2 text-primary underline">Called on</button>
            </li>)}</ol> : queue.entries && <span className="ml-2 text-gray-600">No hands raised.</span>}</div>}
        {(error || queue.entries === null) && <p role="alert">Couldn’t update the speaking queue. <button type="button" className="underline" onClick={() => { setError(false); queue.refresh(); }}>Refresh queue</button></p>}
    </section>;
}

SpeakingQueue.propTypes = {
    queue: PropTypes.shape({ entries: PropTypes.arrayOf(PropTypes.object), change: PropTypes.func.isRequired, refresh: PropTypes.func.isRequired }).isRequired,
    questionId: PropTypes.number.isRequired, moderator: PropTypes.bool.isRequired, locked: PropTypes.bool.isRequired, name: PropTypes.string,
};
