import { useEffect, useRef, useState } from 'react';

const SETTLEMENT_TIMEOUT = 10000;

// One write per question, held through the server ack AND ownership hashing.
// An interrupted write has an unknown outcome. Recovery first waits behind it
// on the server; an arbitrary new questions array cannot prove it committed.
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
        active.recover = (id, entry) => {
            if (!isActive() || !socket.connected || entry.recovering) return;
            entry.acked = false;
            entry.recovering = true;
            const generation = entry.generation = (entry.generation || 0) + 1;
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => {
                if (!isActive() || active.entries.get(id) !== entry) return;
                entry.recovering = false;
                active.recover(id, entry);
            }, SETTLEMENT_TIMEOUT);
            socket.timeout(SETTLEMENT_TIMEOUT).volatile.emit('getQuestionInterestState', discussionSlug, id, userId, (error, result) => {
                if (!isActive() || active.entries.get(id) !== entry || entry.generation !== generation) return;
                if (error) return;
                if (result?.error === 'not_found') {
                    forget(id, entry);
                    return;
                }
                if (typeof result?.interested !== 'boolean') return;
                entry.recovering = false;
                entry.acked = true;
                entry.desired = result.interested;
                entry.before = current.current.questions;
                // Only now is the original write known to be settled. Keep the
                // control pending until ownership agrees with this recovery read.
                socket.emit('joinDiscussion', discussionSlug);
            });
        };
        active.interrupted = () => {
            active.blocked = current.current.questions;
            setBlockedSnapshot(active.blocked);
            for (const entry of active.entries.values()) {
                clearTimeout(entry.timer);
                entry.acked = false;
                entry.recovering = false;
                entry.generation = (entry.generation || 0) + 1;
            }
        };
        const recoverPending = () => {
            for (const [id, entry] of active.entries) active.recover(id, entry);
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
            const entry = { desired: !snapshot.interestedQuestionIds.has(id), before: snapshot.questions, acked: false, generation: 0 };
            active.entries.set(id, entry);
            publish();
            entry.timer = setTimeout(() => {
                if (!isActive() || active.entries.get(id) !== entry) return;
                active.recover(id, entry);
            }, SETTLEMENT_TIMEOUT);
            // With the heartbeat checked, volatile delivery also avoids buffering
            // on a nonwritable transport. The watchdog refreshes a dropped send.
            socket.timeout(SETTLEMENT_TIMEOUT).volatile.emit('setQuestionInterest', discussionSlug, id, entry.desired, userId, (error, result) => {
                if (!isActive() || active.entries.get(id) !== entry || entry.generation !== 0) return;
                if (error) {
                    active.recover(id, entry);
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
        socket.on('connect', recoverPending);
        if (socket.connected && userId) socket.emit('joinDiscussion', discussionSlug);
        return () => {
            scope.current = null;
            socket.off('disconnect', active.interrupted);
            socket.off('connect', recoverPending);
            for (const entry of active.entries.values()) clearTimeout(entry.timer);
        };
    }, [socket, discussionSlug, userId]);

    useEffect(() => { scope.current?.reconcile(); }, [questions, interestedQuestionIds, interestReady]);

    const ready = socket.connected && Boolean(userId) && interestReady && questions !== blockedSnapshot;
    return { pending, ready, toggle: id => scope.current?.toggle(id) ?? false };
}
