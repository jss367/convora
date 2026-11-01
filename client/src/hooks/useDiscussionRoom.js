import { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';

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
            pseudonymSync: 'onPseudonymSync',
        };
        const listeners = Object.entries(events).map(([event, callback]) => {
            const listener = payload => {
                if (current.current.discussionSlug === discussionSlug) current.current[callback](payload);
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
