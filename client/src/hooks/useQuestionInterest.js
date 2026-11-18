import { useEffect, useRef, useState } from 'react';

const SETTLEMENT_TIMEOUT = 10000;

// One write per question, held through the server ack AND ownership hashing.
// An interrupted write has an unknown outcome: wait for a fresh room snapshot
// before accepting another toggle instead of inverting an old pressed state.
export function useQuestionInterest(socket, { discussionSlug, userId, questions, interestedQuestionIds, interestReady }) {
    const [pending, setPending] = useState(new Set());
    const [blockedSnapshot, setBlockedSnapshot] = useState(null);
    const current = useRef();
    current.current = { discussionSlug, userId, questions, interestedQuestionIds, interestReady };
    const scope = useRef(null);

    useEffect(() => {
        const active = { entries: new Map(), blocked: current.current.questions };
        scope.current = active;
        const isActive = () => scope.current === active
            && current.current.discussionSlug === discussionSlug && current.current.userId === userId;
        setPending(new Set());
        setBlockedSnapshot(active.blocked);
        const publish = () => setPending(new Set(active.entries.keys()));
        const forget = (id, entry) => {
            clearTimeout(entry.timer);
            active.entries.delete(id);
            publish();
        };
        active.reconcile = () => {
            const snapshot = current.current;
            if (!snapshot.interestReady) return;
            for (const [id, entry] of active.entries) {
                if (entry.acked && snapshot.questions !== entry.before
                    && snapshot.interestedQuestionIds.has(id) === entry.desired) forget(id, entry);
            }
        };
        active.interrupted = () => {
            active.blocked = current.current.questions;
            setBlockedSnapshot(active.blocked);
            for (const [id, entry] of active.entries) forget(id, entry);
        };
        active.toggle = id => {
            const snapshot = current.current;
            if (!isActive() || !socket.connected || !userId || !snapshot.interestReady
                || snapshot.questions === active.blocked || active.entries.has(id)) return false;
            // Socket.IO can still report connected after a sleeping tab's
            // heartbeat expires, and even volatile emits would then be buffered.
            if (socket.io?.engine?._hasPingExpired?.()) {
                active.interrupted();
                return false;
            }
            const entry = { desired: !snapshot.interestedQuestionIds.has(id), before: snapshot.questions, acked: false };
            active.entries.set(id, entry);
            publish();
            entry.timer = setTimeout(() => {
                if (!isActive() || active.entries.get(id) !== entry) return;
                active.interrupted();
                if (socket.connected) socket.emit('joinDiscussion', discussionSlug);
            }, SETTLEMENT_TIMEOUT);
            // With the heartbeat checked, volatile delivery also avoids buffering
            // on a nonwritable transport. The watchdog refreshes a dropped send.
            socket.timeout(SETTLEMENT_TIMEOUT).volatile.emit('setQuestionInterest', discussionSlug, id, entry.desired, userId, (error, result) => {
                if (!isActive() || active.entries.get(id) !== entry) return;
                if (error) {
                    active.interrupted();
                    if (socket.connected) socket.emit('joinDiscussion', discussionSlug);
                } else if (!result?.updated) {
                    forget(id, entry);
                } else {
                    entry.acked = true;
                    active.reconcile();
                }
            });
            return true;
        };
        socket.on('disconnect', active.interrupted);
        if (socket.connected && userId) socket.emit('joinDiscussion', discussionSlug);
        return () => {
            scope.current = null;
            socket.off('disconnect', active.interrupted);
            for (const entry of active.entries.values()) clearTimeout(entry.timer);
        };
    }, [socket, discussionSlug, userId]);

    useEffect(() => { scope.current?.reconcile(); }, [questions, interestedQuestionIds, interestReady]);

    const ready = socket.connected && Boolean(userId) && interestReady && questions !== blockedSnapshot;
    return { pending, ready, toggle: id => scope.current?.toggle(id) ?? false };
}
