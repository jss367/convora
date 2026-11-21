export function trackPendingVotes(socket, onChange) {
    const inFlight = new Map();
    let active = true;

    const publish = () => onChange(Object.fromEntries(
        Array.from(inFlight, ([id, entry]) => [id, entry.value])
    ));

    // connected can still be true after a sleeping tab's heartbeat expires;
    // Socket.IO buffers that emit until reconnect. Track actual sends so a
    // disconnect never unlocks controls for an answer still in the buffer.
    const markSent = (event, topic, questionId) => {
        if (event !== 'vote' && event !== 'clearVote') return;
        const entry = inFlight.get(questionId);
        if (entry) entry.sent = true;
    };
    const dropSent = () => {
        const before = inFlight.size;
        for (const [id, entry] of inFlight) {
            if (entry.sent) inFlight.delete(id);
        }
        if (inFlight.size !== before) publish();
    };
    socket.onAnyOutgoing(markSent);
    socket.on('disconnect', dropSent);

    function sendVote(questionId, value, event, ...args) {
        if (!active || inFlight.has(questionId)) return false;
        const onResult = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
        const entry = { value, sent: false };
        inFlight.set(questionId, entry);
        publish();
        socket.emit(event, ...args, result => {
            if (inFlight.get(questionId) !== entry) return;
            inFlight.delete(questionId);
            publish();
            if (onResult) onResult(result);
        });
        return true;
    }

    function dispose() {
        active = false;
        socket.offAnyOutgoing(markSent);
        socket.off('disconnect', dropSent);
        inFlight.clear();
    }

    return { sendVote, dispose };
}
