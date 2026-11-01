import { useCallback, useEffect, useRef, useState } from 'react';

// Moderator credentials and creator authority are verified again on reconnect.
export function useModeratorAccess(socket, { topic, discussionSlug, discussionTitle, onRevoked }) {
    const [adminToken, setAdminToken] = useState(null);
    // Mirror of adminToken readable inside async callbacks, so an in-flight
    // checkModerator ack can tell whether the token it verified is still current.
    const adminTokenRef = useRef(adminToken);
    useEffect(() => { adminTokenRef.current = adminToken; }, [adminToken]);
    // Whether this viewer is the creator (only the creator may remove moderators).
    const [canDemote, setCanDemote] = useState(false);
    // Adopt the moderator token for this topic: an ?admin=<token> URL param
    // (shared admin link) takes precedence and is then persisted and stripped
    // from the URL; otherwise fall back to a previously stored token.
    useEffect(() => {
        if (topic !== discussionSlug) return;
        const storageKey = `convora_admin_${discussionSlug}`;
        try {
            const params = new URLSearchParams(window.location.search);
            const fromUrl = params.get('admin');
            if (fromUrl) {
                localStorage.setItem(storageKey, fromUrl);
                setAdminToken(fromUrl);
                params.delete('admin');
                const query = params.toString();
                window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
                return;
            }

            const legacyKeys = [
                `convora_admin_${topic}`,
                discussionTitle ? `convora_admin_${discussionTitle}` : null,
            ].filter(key => key && key !== storageKey);
            const storedToken = localStorage.getItem(storageKey)
                || legacyKeys.map(key => localStorage.getItem(key)).find(Boolean)
                || null;
            if (storedToken) {
                localStorage.setItem(storageKey, storedToken);
            }
            setAdminToken(storedToken);
        } catch (e) {
            console.warn('Failed to read admin token:', e);
        }
    }, [discussionTitle, discussionSlug, topic]);

    // Validate any adopted moderator token with the server. A token revoked
    // while this user was offline (so they never got moderatorRevoked) would
    // otherwise keep rendering a dead moderator UI; here we drop it once the
    // server confirms it no longer grants moderation. We only clear on a
    // definitive isModerator:false — never on a transient error. Re-run on
    // reconnect too (like the identify effect), so a demotion missed during a
    // disconnect is caught when Socket.IO reconnects rather than lingering
    // until a reload.
    useEffect(() => {
        if (!adminToken) return;
        let cancelled = false;
        const verify = () => {
            // Remember which token this check is about. A re-promotion can deliver
            // a fresh token (handleModeratorGranted) while this check is in flight;
            // only clear if the token we verified is still the current one, so a
            // stale "not a moderator" ack can't wipe the newly adopted token the
            // server pushed only once.
            const checked = adminToken;
            socket.emit('checkModerator', discussionSlug, checked, (resp) => {
                if (cancelled || !resp || !resp.ok) return;
                if (adminTokenRef.current !== checked) return;
                if (resp.isModerator === false) {
                    try {
                        localStorage.removeItem(`convora_admin_${discussionSlug}`);
                    } catch (e) {
                        console.warn('Failed to clear admin token:', e);
                    }
                    setAdminToken(null);
                    return;
                }
                // Initialize canDemote from the token itself, not from opening the
                // participant panel. Without this, a creator who never opened the
                // panel keeps canDemote=false, and a moderatorGranted push (e.g. an
                // admin-link holder promotes the creator's row) would overwrite the
                // real creator token with a weaker per-user grant — locking the
                // creator out of removing moderators after a reload.
                setCanDemote(resp.isCreator === true);
            });
        };
        verify();
        socket.on('connect', verify);
        return () => { cancelled = true; socket.off('connect', verify); };
    }, [socket, discussionSlug, adminToken]);

    // Reset the creator flag whenever the discussion changes. This component is
    // reused (not remounted) when navigating between /discussion/:topic routes —
    // React Router keeps the same instance and only the topic param changes — so
    // canDemote would otherwise carry over from a previous discussion. The verify
    // effect above only updates canDemote when adminToken is set, so navigating to
    // a discussion with no/invalid token would leave a stale canDemote=true; that
    // would make handleModeratorGranted drop a legitimate one-time grant if this
    // user is promoted in the new discussion. Clearing here lets verify() (or a
    // participant-list response) re-establish the correct value for the new topic.
    useEffect(() => {
        setCanDemote(false);
    }, [discussionSlug]);

    // Adopt a moderator token the server pushes to us when this user is promoted.
    // Persist it under the same per-slug key the create/share flows use so the
    // controls light up immediately and survive reloads.
    //
    // Skip adoption only when WE are the creator (canDemote): the creator
    // authenticates with the discussion's admin_token, and if they click "Make
    // moderator" on their own participant row, the per-user grant pushed back
    // would otherwise replace that admin_token — downgrading them so
    // verifyCreator no longer recognizes them. Everyone else adopts the grant,
    // overwriting any token they already hold — important because a re-promoted
    // user may still have a stale, revoked token in localStorage that the
    // checkModerator load check hasn't cleared yet; the fresh push is
    // authoritative and must win, or they'd be left with no usable token.
    const handleModeratorGranted = useCallback(({ token }) => {
        if (!token || canDemote) return;
        try {
            localStorage.setItem(`convora_admin_${discussionSlug}`, token);
        } catch (e) {
            console.warn('Failed to store admin token:', e);
        }
        setAdminToken(token);
    }, [discussionSlug, canDemote]);

    // A moderator we were granted was revoked: drop the stored token so the
    // controls disappear. (That token is already invalid server-side.)
    //
    // Skip this when WE are the creator (canDemote): our credential is the
    // discussion's admin_token, not a per-user grant. If the creator self-promotes
    // (creating a dangling per-user grant on their own row) and then removes it,
    // the server emits moderatorRevoked to their socket too — but only the
    // per-user grant was deleted; the admin_token is still valid, so clearing it
    // would wrongly strip the creator's controls after a reload.
    const handleModeratorRevoked = useCallback(() => {
        if (canDemote) return;
        try {
            localStorage.removeItem(`convora_admin_${discussionSlug}`);
        } catch (e) {
            console.warn('Failed to clear admin token:', e);
        }
        setAdminToken(null);
        onRevoked();
    }, [discussionSlug, canDemote, onRevoked]);

    return { adminToken, setAdminToken, canDemote, setCanDemote, handleModeratorGranted, handleModeratorRevoked };
}
