import { useCallback, useEffect, useRef, useState } from 'react';
import {
    getIdentity, getDisplayName, setNameMode, setCustomName, NameModes,
    participantHandle, ownerToken,
} from '../identity';

// Persisted participant identity, room-specific handles, and private ownership.
export function useParticipantIdentity(socket, { topic, discussionSlug, discussionId, questions }) {
    // Always-current slug, so async socket acks fired in one discussion can tell
    // they've come back after the user navigated to a different one and bail out
    // instead of writing the old room's handle into the new room's state.
    const discussionSlugRef = useRef(discussionSlug);
    discussionSlugRef.current = discussionSlug;
    const [selfHandle, setSelfHandle] = useState(null);
    const [identity, setIdentity] = useState(null);
    // Always-current identity, so an async ack fired under one name mode can tell
    // the user has since switched modes/name and avoid clobbering that newer choice.
    const identityRef = useRef(identity);
    identityRef.current = identity;
    // The handle the server reserved for THIS discussion (unique within it). Null
    // until the server responds, before which we show the local pseudonym as a
    // preview. May differ from identity.pseudonym when the local pick collided.
    const [assignedPseudonym, setAssignedPseudonym] = useState(null);
    // Whether assignedPseudonym is an actual server-side reservation (vs. a
    // preview handed back before the discussion row existed). We only stop asking
    // once it's truly reserved — otherwise a shuffle before the first question
    // could leave this user's handle un-inserted and free to collide later.
    const [pseudonymReserved, setPseudonymReserved] = useState(false);
    // A shuffle is in flight. We never allow more than one reservation-mutating
    // request outstanding: the async server handlers can finish out of order, so
    // overlapping shuffles (or a shuffle racing the initial reservation) could
    // leave the client showing a handle the DB never reserved. The ref guards
    // re-entry synchronously (defeats same-render double-clicks); the state just
    // disables the button. Shuffle is only offered once the handle is reserved,
    // so it can never overlap the idempotent initial request.
    const shufflePendingRef = useRef(false);
    const [shufflePending, setShufflePending] = useState(false);
    useEffect(() => {
        // getIdentity() persists a stable userId (so vote de-duplication survives
        // reloads) together with the chosen display name, both in localStorage.
        setIdentity(getIdentity());
    }, []);

    // The stable id used for vote ownership, and the name shown to everyone else
    // (derived from the chosen mode: pseudonym, anonymous, or a typed-in name).
    const userId = identity?.userId || null;
    // The pseudonym actually shown/sent in this discussion: the server-reserved
    // one once we have it, otherwise the local pick as a preview.
    const effectivePseudonym = assignedPseudonym || identity?.pseudonym || '';
    const displayName = identity ? getDisplayName(identity, assignedPseudonym) : '';

    // Compute our own participant handle so the moderator panel can hide the
    // promote/remove controls on our own row.
    useEffect(() => {
        if (!userId) {
            setSelfHandle(null);
            return undefined;
        }
        let cancelled = false;
        participantHandle(userId).then((handle) => {
            if (!cancelled) setSelfHandle(handle);
        });
        return () => { cancelled = true; };
    }, [userId]);

    // The server no longer broadcasts raw user ids — each vote carries a
    // per-response ownership token (sha256(voteId + ':' + userId)) instead, so
    // socket observers can't correlate one browser's responses across prompts,
    // nor group one anonymous participant's separate ideas within a single
    // Brainstorm prompt (each idea is a distinct response with its own token).
    // To recognize our OWN votes we recompute that token per response and keep
    // the ids that match in Sets. The hash is async (Web Crypto), so during the
    // brief gap before the effect populates them a vote simply won't match
    // (treated as not-ours). ownedVoteIds: responses we authored. upvotedVoteIds:
    // responses we've upvoted. Both keyed by the response (vote) id.
    // ownedCommentIds: brainstorm comments we authored. Comments carry the same
    // per-row ownership token (keyed by the comment id) as votes, so we recognize
    // our own the same way — and can show their Delete button — without the
    // server exposing who wrote what.
    const [ownedVoteIds, setOwnedVoteIds] = useState(() => new Set());
    const [upvotedVoteIds, setUpvotedVoteIds] = useState(() => new Set());
    const [ownedCommentIds, setOwnedCommentIds] = useState(() => new Set());
    useEffect(() => {
        if (!userId) {
            setOwnedVoteIds(new Set());
            setUpvotedVoteIds(new Set());
            setOwnedCommentIds(new Set());
            return undefined;
        }
        let cancelled = false;
        const compute = async () => {
            const owned = new Set();
            const upvoted = new Set();
            const ownedComments = new Set();
            const allVotes = (questions || []).flatMap(q =>
                Array.isArray(q.votes) ? q.votes : []
            );
            await Promise.all(allVotes.map(async (vote) => {
                if (vote == null || vote.id === undefined || vote.id === null) return;
                const myToken = await ownerToken(vote.id, userId);
                if (myToken) {
                    if (vote.ownerToken === myToken) owned.add(vote.id);
                    if (Array.isArray(vote.upvoterTokens) && vote.upvoterTokens.includes(myToken)) {
                        upvoted.add(vote.id);
                    }
                }
                await Promise.all((Array.isArray(vote.comments) ? vote.comments : []).map(async (c) => {
                    if (c == null || c.id === undefined || c.id === null) return;
                    // Namespaced to match the server (`comment:<id>`), so a comment
                    // token can never equal a vote token of the same numeric id and
                    // link an author to an otherwise-anonymous idea.
                    const myCommentToken = await ownerToken(`comment:${c.id}`, userId);
                    if (myCommentToken && c.ownerToken === myCommentToken) ownedComments.add(c.id);
                }));
            }));
            if (!cancelled) {
                setOwnedVoteIds(owned);
                setUpvotedVoteIds(upvoted);
                setOwnedCommentIds(ownedComments);
            }
        };
        compute();
        return () => { cancelled = true; };
    }, [userId, questions]);

    // True when `vote` belongs to this browser, matched via its per-response
    // ownership token rather than a raw user id.
    const isMyVote = useCallback((question, vote) => {
        if (!vote || vote.id === undefined || vote.id === null) return false;
        return ownedVoteIds.has(vote.id);
    }, [ownedVoteIds]);

    // Push a changed broadcast name to the server so it retroactively renames
    // this browser's already-submitted responses (otherwise prior responses keep
    // the old name; switching to anonymous wouldn't actually hide them).
    const applyIdentity = (updatedIdentity) => {
        setIdentity(updatedIdentity);
        if (updatedIdentity?.userId) {
            socket.emit('updateDisplayName', discussionSlug, updatedIdentity.userId, getDisplayName(updatedIdentity, assignedPseudonym));
        }
    };

    // Shuffle goes through the server so the new handle is still unique within
    // this discussion. The server reserves it; we adopt it and rename this
    // browser's existing responses (only meaningful in pseudonym mode). Gated on
    // an existing reservation and a not-already-pending shuffle so there is only
    // ever one reservation-mutating request in flight — otherwise out-of-order
    // acks could mark an unreserved handle as reserved.
    const handleRegeneratePseudonym = () => {
        if (!userId || !pseudonymReserved || shufflePendingRef.current) return;
        const slugAtRequest = discussionSlug;
        const prevAssigned = assignedPseudonym;
        shufflePendingRef.current = true;
        setShufflePending(true);
        socket.emit('regeneratePseudonym', discussionSlug, userId, (resp) => {
            // Bail if we've navigated to another discussion since asking, so a
            // late ack can't overwrite the new room's handle with this one's. The
            // slug-change reset already cleared shufflePendingRef, so just return.
            if (discussionSlugRef.current !== slugAtRequest) return;
            shufflePendingRef.current = false;
            setShufflePending(false);
            // The discussion exists (we were already reserved), so a real
            // reservation is expected; ignore anything else defensively.
            if (!resp?.pseudonym || !resp.reserved) return;
            setAssignedPseudonym(resp.pseudonym);
            // Rename existing responses only if the shuffle changes the name we
            // actually show. Compare under the CURRENT identity, not the one
            // captured at click: if the user switched to anonymous/custom while the
            // shuffle was in flight, that newer choice (already pushed via
            // updateDisplayName) must win — so a no-op comparison suppresses this
            // late rename instead of dragging responses back to the pseudonym.
            const liveIdentity = identityRef.current;
            const before = getDisplayName(liveIdentity, prevAssigned);
            const after = getDisplayName(liveIdentity, resp.pseudonym);
            if (after !== before) {
                socket.emit('updateDisplayName', discussionSlug, userId, after);
            }
        });
    };

    const handleSelectNameMode = (mode) => {
        applyIdentity(setNameMode(mode));
    };

    const handleCustomNameChange = (name) => {
        // Switch into custom mode as soon as the participant types so the live
        // preview reflects what they're entering. setCustomName persists the
        // text first; setNameMode then reads it back and flips the mode.
        setCustomName(name);
        applyIdentity(setNameMode(NameModes.CUSTOM));
    };

    // Another tab of ours shuffled, freeing our old handle; adopt the new one so
    // this tab stops submitting under a handle someone else can now claim. The
    // shuffling tab already renamed our existing responses, so we just update the
    // live handle (the server only sends this to our own sockets).
    const handlePseudonymSync = useCallback((payload) => {
        if (!payload?.pseudonym) return;
        // Ignore a sync for a discussion we've since navigated away from — its
        // handle is reserved only in that room and must not be adopted here.
        if (payload.slug && payload.slug !== discussionSlugRef.current) return;
        setAssignedPseudonym(payload.pseudonym);
        setPseudonymReserved(true);
    }, []);

    // A reserved handle belongs to one discussion, so drop it when navigating to
    // another one (the route param changes without remounting) — the effect
    // below then re-reserves a name in the new discussion.
    useEffect(() => {
        setAssignedPseudonym(null);
        setPseudonymReserved(false);
        shufflePendingRef.current = false;
        setShufflePending(false);
    }, [discussionSlug]);

    // Ask the server for a handle that's unique within this discussion. We wait
    // until the discussion exists (so there's a row to reserve against) and our
    // identity has loaded (so we can propose our local pick). Keep asking until
    // the server confirms a real reservation (not just a preview), and if it
    // hands back a different handle because ours was taken, push it to any
    // responses we've already submitted so they stop showing the colliding name.
    useEffect(() => {
        if (!identity || !userId || topic !== discussionSlug || !discussionId) return undefined;
        if (pseudonymReserved) return undefined; // already reserved for this discussion
        let cancelled = false;
        const preferred = assignedPseudonym || identity.pseudonym || '';
        socket.emit('requestPseudonym', discussionSlug, userId, preferred, (resp) => {
            if (cancelled || !resp?.pseudonym) return;
            setAssignedPseudonym(resp.pseudonym);
            if (!resp.reserved) return; // only a preview; the effect will retry
            setPseudonymReserved(true);
            // If the reserved handle changes the name we'd actually show, rename
            // any responses already submitted under the old one. Comparing the
            // derived display name (not just the mode) also covers custom mode
            // with a blank name — which falls back to the pseudonym — while
            // correctly leaving a real custom name or anonymous untouched.
            const before = getDisplayName(identity, preferred);
            const after = getDisplayName(identity, resp.pseudonym);
            if (after !== before) {
                socket.emit('updateDisplayName', discussionSlug, userId, after);
            }
        });
        return () => { cancelled = true; };
    }, [socket, identity, userId, topic, discussionSlug, discussionId, pseudonymReserved, assignedPseudonym]);

    return {
        identity, userId, displayName, effectivePseudonym, pseudonymReserved,
        shufflePending, selfHandle, ownedVoteIds, upvotedVoteIds, ownedCommentIds,
        isMyVote, handlePseudonymSync, handleRegeneratePseudonym,
        handleSelectNameMode, handleCustomNameChange,
    };
}
