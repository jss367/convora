import { useCallback, useEffect, useState } from 'react';

// Lets the room display fill the whole screen without the browser's tabs,
// toolbar, bookmarks and extensions, which otherwise show on the TV when a
// laptop is mirrored or AirPlayed to it. Older Safari only has the prefixed
// API. Browsers without either (iPhone Safari) report it as unsupported, and
// the page hides its button.

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

const isSupported = () => typeof document !== 'undefined'
    && Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled);

export default function useFullscreen() {
    const [supported] = useState(isSupported);
    const [active, setActive] = useState(() => typeof document !== 'undefined' && Boolean(fullscreenElement()));

    useEffect(() => {
        if (!supported) return undefined;
        // Pressing Escape leaves full screen without going through toggle.
        const update = () => setActive(Boolean(fullscreenElement()));
        document.addEventListener('fullscreenchange', update);
        document.addEventListener('webkitfullscreenchange', update);
        return () => {
            document.removeEventListener('fullscreenchange', update);
            document.removeEventListener('webkitfullscreenchange', update);
        };
    }, [supported]);

    const toggle = useCallback(() => {
        const root = document.documentElement;
        const call = fullscreenElement()
            ? (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)
            : (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root);
        // Refused (for example, not started by a click); the page stays as it is.
        Promise.resolve(call).catch(() => {});
    }, []);

    return { supported, active, toggle };
}
