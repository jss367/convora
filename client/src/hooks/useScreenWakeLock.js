import { useEffect } from 'react';
import keepAwakeMp4 from '../assets/keep-awake.mp4';
import keepAwakeWebm from '../assets/keep-awake.webm';

// Keeps the screen from dimming or sleeping while the page is open, the way a
// video player does. Nobody touches a room display, so without this a TV or
// laptop turns its screen off partway through a discussion.
//
// Two things are done together, because neither works everywhere:
// - The Screen Wake Lock API, where the browser has it and allows it (HTTPS,
//   enough battery). The browser releases the lock whenever the tab is hidden,
//   so it is requested again each time the page becomes visible.
// - A tiny muted video playing on a loop. Smart TVs can ignore the wake lock,
//   or have a browser without it, but they do not start a screen saver or go
//   to sleep while a video plays.
export default function useScreenWakeLock() {
    useEffect(() => {
        if (typeof navigator === 'undefined' || typeof document === 'undefined') return undefined;
        let lock = null;
        let active = true;
        // Only one request at a time: every lock the browser grants stays held
        // until released, so a second overlapping request would leave one we
        // never release.
        let requesting = false;
        // A visibility change that arrived while a request was pending. The
        // pending request may be refused or its lock dropped because of it, so
        // it is handled once the request settles. A refusal with no skipped
        // event (low battery, say) is not retried, so this cannot loop.
        let missed = false;

        const video = document.createElement('video');
        video.muted = true;
        video.loop = true;
        video.setAttribute('muted', '');
        video.setAttribute('playsinline', '');
        video.setAttribute('aria-hidden', 'true');
        video.setAttribute('data-testid', 'keep-awake-video');
        // Kept on screen (but invisible): some browsers pause videos that are
        // off screen or not in the document.
        Object.assign(video.style, {
            position: 'fixed', left: '0', bottom: '0', width: '1px', height: '1px',
            opacity: '0.01', pointerEvents: 'none',
        });
        // H.264 first for TVs' hardware decoders; WebM for browsers without
        // H.264, such as open-source Chromium builds.
        [[keepAwakeMp4, 'video/mp4'], [keepAwakeWebm, 'video/webm']].forEach(([src, type]) => {
            const source = document.createElement('source');
            source.src = src;
            source.type = type;
            video.appendChild(source);
        });
        document.body.appendChild(video);

        const playVideo = () => {
            const playing = video.play();
            // Refused autoplay leaves the screen to sleep as it normally would.
            if (playing && playing.catch) playing.catch(() => {});
        };

        const requestLock = async () => {
            if (!navigator.wakeLock) return;
            if (requesting) {
                missed = true;
                return;
            }
            if (lock && !lock.released) return;
            requesting = true;
            missed = false;
            try {
                const granted = await navigator.wakeLock.request('screen');
                if (active) lock = granted;
                else granted.release().catch(() => {});
            } catch {
                // Refused; the video still keeps the screen on.
            } finally {
                requesting = false;
            }
            // The tab was shown again while the request was pending. Whether the
            // request was granted (and the lock dropped by the hide) or refused
            // because the tab was hidden, ask again.
            if (active && missed && document.visibilityState === 'visible') requestLock();
        };

        // The browser drops the lock while the tab is hidden; the video is
        // paused then too, so a hidden display never keeps the screen on. Both
        // are resumed when it is shown.
        const onVisible = () => {
            if (document.visibilityState !== 'visible') {
                video.pause();
                return;
            }
            playVideo();
            requestLock();
        };

        onVisible();
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            active = false;
            document.removeEventListener('visibilitychange', onVisible);
            if (lock && !lock.released) lock.release().catch(() => {});
            video.pause();
            video.remove();
        };
    }, []);
}
