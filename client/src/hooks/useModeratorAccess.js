import { useCallback, useEffect, useRef, useState } from 'react';

// Moderator credentials and creator authority are verified again on reconnect.
export function useModeratorAccess(socket, { topic, discussionSlug, discussionTitle, onRevoked }) {
    const [access, setAccess] = useState({ slug: null, token: null, canDemote: false });
    const accessRef = useRef(access);
    const activeSlug = useRef(discussionSlug);
    activeSlug.current = discussionSlug;
    // A route change invalidates the previous room's authority immediately,
    // before passive effects adopt credentials for the new room.
    const adminToken = access.slug === discussionSlug ? access.token : null;
    const canDemote = access.slug === discussionSlug && access.canDemote;
    const setAdminToken = useCallback(token => {
        if (activeSlug.current !== discussionSlug) return;
        const previous = accessRef.current;
        const next = {
            slug: discussionSlug, token,
            canDemote: previous.slug === discussionSlug && previous.token === token && previous.canDemote,
        };
        accessRef.current = next;
        setAccess(next);
    }, [discussionSlug]);
    const setCanDemote = useCallback(value => {
        if (activeSlug.current !== discussionSlug || accessRef.current.slug !== discussionSlug) return;
        const next = { ...accessRef.current, canDemote: value === true };
        accessRef.current = next;
        setAccess(next);
    }, [discussionSlug]);
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
    }, [discussionTitle, discussionSlug, topic, setAdminToken]);

    // Validate any adopted moderator token with the server. A token revoked
    // while this user was offline (so they never got moderatorRevoked) would
    // otherwise keep rendering a dead moderator UI; here we drop it once the
    // server confirms it no longer grants moderation. We only clear on a
    // definitive isModerator:false — never on a transient error. Re-run on
    // reconnect too (like the identify effect), so a demotion missed during a
    // disconnect is caught when Socket.IO reconnects rather than lingering
    // until a reload.
    useEffect(() => {
        if (!adminToken || topic !== discussionSlug) return;
        let cancelled = false;
        const isCurrent = () => activeSlug.current === discussionSlug
            && accessRef.current.slug === discussionSlug && accessRef.current.token === adminToken;
        const verify = () => {
            // Remember which token this check is about. A re-promotion can deliver
            // a fresh token (handleModeratorGranted) while this check is in flight;
            // only clear if the token we verified is still the current one, so a
            // stale "not a moderator" ack can't wipe the newly adopted token the
            // server pushed only once.
            const checked = adminToken;
            if (!isCurrent()) return;
            socket.emit('checkModerator', discussionSlug, checked, (resp) => {
                if (cancelled || !resp || !resp.ok) return;
                if (!isCurrent()) return;
                if (resp.isModerator === false) {
                    try {
                        const key = `convora_admin_${discussionSlug}`;
                        if (localStorage.getItem(key) === checked) localStorage.removeItem(key);
                    } catch (e) {
                        console.warn('Failed to clear admin token:', e);
                    }
                    setAdminToken(null);
                    onRevoked();
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
    }, [socket, topic, discussionSlug, adminToken, setAdminToken, setCanDemote, onRevoked]);

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
    }, [discussionSlug, canDemote, setAdminToken]);

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
    }, [discussionSlug, canDemote, setAdminToken, onRevoked]);

    return { adminToken, setAdminToken, canDemote, setCanDemote, handleModeratorGranted, handleModeratorRevoked };
}
