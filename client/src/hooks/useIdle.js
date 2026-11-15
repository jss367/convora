import { useEffect, useState } from 'react';

const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'wheel'];

// True once nobody has moved the mouse, touched the screen or pressed a key for
// `delayMs`. The room display uses it to hide its controls and the cursor, the
// way a video player does, so the shared screen shows only the discussion.
export default function useIdle(delayMs) {
    const [idle, setIdle] = useState(false);

    useEffect(() => {
        let timer = null;
        const wake = () => {
            setIdle(false);
            clearTimeout(timer);
            timer = setTimeout(() => setIdle(true), delayMs);
        };
        wake();
        for (const event of ACTIVITY_EVENTS) window.addEventListener(event, wake, { passive: true });
        return () => {
            clearTimeout(timer);
            for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, wake);
        };
    }, [delayMs]);

    return idle;
}
