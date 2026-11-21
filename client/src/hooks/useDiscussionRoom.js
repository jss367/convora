import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import { rememberDiscussion } from '../knownDiscussions';
import { trackPendingVotes } from './pendingVotes.mjs';

// Same-origin by default; split-origin deployments can provide the socket URL.
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || undefined;

export function useDiscussionSocket() {
    const [socket] = useState(() => io(SOCKET_URL, { autoConnect: false }));
    useEffect(() => {
        socket.connect();
        return () => socket.disconnect();
    }, [socket]);
    return socket;
}

// True while the page cannot reach the server: the socket dropped or failed to
// connect, or the browser reports being offline (which it knows well before the
// socket's heartbeat times out). The initial connection attempt is not a loss.
export function useConnectionLost(socket) {
    const [socketDown, setSocketDown] = useState(false);
    const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
    useEffect(() => {
        const up = () => setSocketDown(false);
        const down = reason => {
            // Our own disconnect() on unmount is not a lost connection.
            if (reason !== 'io client disconnect') setSocketDown(true);
        };
        const goOffline = () => setOffline(true);
        const goOnline = () => setOffline(false);
        socket.on('connect', up);
        socket.on('disconnect', down);
        socket.on('connect_error', down);
        window.addEventListener('offline', goOffline);
        window.addEventListener('online', goOnline);
        return () => {
            socket.off('connect', up);
            socket.off('disconnect', down);
            socket.off('connect_error', down);
            window.removeEventListener('offline', goOffline);
            window.removeEventListener('online', goOnline);
        };
    }, [socket]);
    return socketDown || offline;
}

// Tracks answers that were emitted but not yet acknowledged, one per question,
// so their controls can show a saving state and refuse a second tap. Emits made
// while disconnected are buffered by Socket.IO and stay pending until the
// replayed emit is acknowledged.
const NO_PENDING_VOTES = {};
export function usePendingVotes(socket) {
    // questionId -> the value being saved (null while clearing the vote).
    const [pendingVotes, setPendingVotes] = useState(NO_PENDING_VOTES);
    const tracker = useRef(null);

    useLayoutEffect(() => {
        const current = trackPendingVotes(socket, setPendingVotes);
        tracker.current = current;
        setPendingVotes(NO_PENDING_VOTES);
        return () => {
            tracker.current = null;
            current.dispose();
        };
    }, [socket]);

    // Emits `event` with an acknowledgment callback appended. Returns false,
    // without emitting, when this question already has an answer in flight.
    const sendVote = useCallback((...args) => tracker.current?.sendVote(...args) ?? false, []);

    return [pendingVotes, sendVote];
}

// Subscribe once per room. Callback changes (for example creator verification)
// must not leave/rejoin the room or add duplicate listeners.
export function useDiscussionRoom(socket, handlers) {
    const { topic, discussionSlug, userId, onBrainstormState } = handlers;
    const current = useRef(handlers);
    current.current = handlers;

    useEffect(() => {
        if (topic !== discussionSlug) return undefined;
        const events = {
            discussion: 'onDiscussion', questions: 'onQuestions', presence: 'onPresence',
            discussionState: 'onState', similarQuestion: 'onSimilarQuestion',
            moderatorGranted: 'onModeratorGranted', moderatorRevoked: 'onModeratorRevoked',
            pseudonymSync: 'onPseudonymSync', error: 'onError',
        };
        const listeners = Object.entries(events).map(([event, callback]) => {
            const listener = payload => {
                if (current.current.discussionSlug !== discussionSlug) return;
                // Discussions are unlisted, so the home page can only show the
                // ones this browser has opened. The payload is null when the
                // discussion does not exist; rememberDiscussion ignores that.
                if (event === 'discussion' && payload?.slug === discussionSlug) rememberDiscussion(payload);
                current.current[callback](payload);
            };
            socket.on(event, listener);
            return [event, listener];
        });
        const join = () => socket.emit('joinDiscussion', discussionSlug);
        socket.on('connect', join);
        if (socket.connected) join();
        return () => {
            if (socket.connected) socket.emit('leaveDiscussion', discussionSlug);
            socket.off('connect', join);
            for (const [event, listener] of listeners) socket.off(event, listener);
        };
    }, [socket, topic, discussionSlug]);

    useEffect(() => {
        if (!userId || topic !== discussionSlug) return undefined;
        const identify = () => socket.emit('identify', discussionSlug, userId);
        socket.on('connect', identify);
        if (socket.connected) identify();
        return () => socket.off('connect', identify);
    }, [socket, topic, discussionSlug, userId]);

    useEffect(() => {
        if (!userId || topic !== discussionSlug) return undefined;
        let cancelled = false;
        const restore = () => {
            socket.emit('getBrainstormState', discussionSlug, userId, state => {
                if (cancelled || !state) return;
                onBrainstormState({ ratings: state.ratings || {}, reactions: state.reactions || {} });
            });
        };
        socket.on('connect', restore);
        if (socket.connected) restore();
        return () => { cancelled = true; socket.off('connect', restore); };
    }, [socket, topic, discussionSlug, userId, onBrainstormState]);
}
