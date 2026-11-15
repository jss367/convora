import { useEffect } from 'react';

// Keeps the screen from dimming or sleeping while the page is open, the way a
// video player does. Nobody touches a room display, so without this a TV or
// laptop turns its screen off partway through a discussion.
//
// The browser releases the lock whenever the tab is hidden, so it is requested
// again each time the page becomes visible. Browsers without the Screen Wake
// Lock API, or that refuse the request (low battery, insecure origin), just
// keep their normal sleep behaviour.
export default function useScreenWakeLock() {
    useEffect(() => {
        if (typeof navigator === 'undefined' || !navigator.wakeLock) return undefined;
        let lock = null;
        let active = true;

        const request = async () => {
            if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
            try {
                const next = await navigator.wakeLock.request('screen');
                if (active) lock = next;
                else next.release().catch(() => {});
            } catch {
                // Refused; the screen sleeps as it normally would.
            }
        };

        request();
        document.addEventListener('visibilitychange', request);
        return () => {
            active = false;
            document.removeEventListener('visibilitychange', request);
            if (lock && !lock.released) lock.release().catch(() => {});
        };
    }, []);
}
