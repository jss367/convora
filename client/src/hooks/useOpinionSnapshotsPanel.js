import { useEffect, useState } from 'react';

// Whether the opinion snapshots panel is open, and a counter that is bumped
// when the server reports a new opinion snapshot, so an open snapshot panel
// loads it without anyone choosing Refresh.
export function useOpinionSnapshotsPanel(socket) {
    const [showSnapshots, setShowSnapshots] = useState(false);
    const [snapshotRefreshSignal, setSnapshotRefreshSignal] = useState(0);
    useEffect(() => {
        const refreshSnapshots = () => setSnapshotRefreshSignal(value => value + 1);
        socket.on('snapshotsChanged', refreshSnapshots);
        return () => socket.off('snapshotsChanged', refreshSnapshots);
    }, [socket]);

    return { showSnapshots, setShowSnapshots, snapshotRefreshSignal };
}
