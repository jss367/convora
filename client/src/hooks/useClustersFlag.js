import { useEffect, useState } from 'react';

// Experimental "opinion groups" view, hidden behind a ?clusters=1 flag so it
// can be evaluated on a real discussion without exposing it to everyone. Once
// enabled it's remembered per browser so the link survives navigation.
export function useClustersFlag(topic) {
    const [showClusters, setShowClusters] = useState(false);

    useEffect(() => {
        const key = 'convora_show_clusters';
        try {
            const params = new URLSearchParams(window.location.search);
            if (params.get('clusters') === '1') {
                localStorage.setItem(key, '1');
                setShowClusters(true);
                return;
            }
            setShowClusters(localStorage.getItem(key) === '1');
        } catch (e) {
            console.warn('Failed to read clusters flag:', e);
        }
    }, [topic]);

    return showClusters;
}
