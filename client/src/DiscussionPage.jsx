import PropTypes from 'prop-types';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import io from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import {
    getIdentity,
    setNameMode,
    setCustomName,
    getDisplayName,
    getEffectiveNameMode,
    ownerToken,
    participantHandle,
    NameModes,
    MAX_CUSTOM_NAME_LENGTH,
} from './identity';
import { slugifyTopic } from './slugs';

const VERSION = '0.1.8';
console.log('Convora version:', VERSION);

// Color themes a moderator can apply to a discussion. Keys and the palettes
// they map to are defined in client/src/index.css ([data-theme] blocks) and
// validated server-side (ALLOWED_THEMES in server.js); `swatch` is only the
// picker dot color and mirrors each theme's primary. Keep all three in sync.
const THEMES = [
    { key: 'indigo', label: 'Indigo', swatch: '#4F46E5' },
    { key: 'orange', label: 'Orange', swatch: '#FF3C00' },
    { key: 'emerald', label: 'Emerald', swatch: '#059669' },
    { key: 'rose', label: 'Rose', swatch: '#E11D48' },
    { key: 'slate', label: 'Slate', swatch: '#475569' },
];
const THEME_KEYS = THEMES.map((t) => t.key);
const DEFAULT_THEME = 'indigo';

// The floating "Scan to join" QR the moderator can pop up. It starts large so
// it's readable across a room and can be drag-resized by the moderator to fit
// whatever screen they're presenting on.
const MIN_JOIN_QR_SIZE = 140;
const DEFAULT_JOIN_QR_SIZE = 300;

// Largest square the QR panel can grow to without overflowing the viewport
// (leaves a margin for the panel's padding/caption and screen edges).
const maxJoinQrSize = () => {
    if (typeof window === 'undefined') return DEFAULT_JOIN_QR_SIZE;
    return Math.max(MIN_JOIN_QR_SIZE, Math.min(window.innerWidth, window.innerHeight) - 120);
};

// Clamp a QR size to the range the current viewport can accommodate.
const clampJoinQrSize = (size) => Math.min(maxJoinQrSize(), Math.max(MIN_JOIN_QR_SIZE, size));

const QuestionTypes = {
    AGREEMENT: 'Agreement',
    YES_NO: 'Yes/No',
    NUMERICAL: 'Numerical',
    OPEN_ENDED: 'Open Ended',
    BRAINSTORM: 'Brainstorm'
};

// Shown under the type picker so creators understand what each type does.
const QuestionTypeDescriptions = {
    [QuestionTypes.AGREEMENT]: 'Each participant picks one option on the five-point scale from Strongly Agree to Strongly Disagree.',
    [QuestionTypes.YES_NO]: 'Each participant picks a simple Yes or No — a binary alternative to the five-point agreement scale.',
    [QuestionTypes.NUMERICAL]: 'Each participant submits a single number on a slider between your min and max.',
    [QuestionTypes.OPEN_ENDED]: 'Each participant gives one free-text response, which they can edit later. One answer per person.',
    [QuestionTypes.BRAINSTORM]: 'Each participant can add as many separate ideas as they want, and remove their own. Many answers per person.'
};

const VoteOptions = {
    STRONGLY_AGREE: 'Strongly Agree',
    AGREE: 'Agree',
    UNSURE: 'Unsure',
    DISAGREE: 'Disagree',
    STRONGLY_DISAGREE: 'Strongly Disagree',
};

// The two choices for a Yes/No question. Listed Yes-first so the green/red
// divergence bar reads left-to-right the same way the agreement bar does.
const YesNoOptions = {
    YES: 'Yes',
    NO: 'No',
};

const SortOptions = {
    MOST_RECENT: 'Most Recent',
    MOST_AGREEMENT: 'Most Agreement',
    MOST_DISAGREEMENT: 'Most Disagreement',
    MOST_CONTROVERSIAL: 'Most Controversial',
};

// Display order for the agreement divergence bar: disagreement (left, red) to
// agreement (right, green). Full literal class names so Tailwind keeps them.
const AGREEMENT_SCALE = [
    { key: VoteOptions.STRONGLY_DISAGREE, label: 'Strongly Disagree', bar: 'bg-red-600', dot: 'bg-red-600' },
    { key: VoteOptions.DISAGREE, label: 'Disagree', bar: 'bg-red-400', dot: 'bg-red-400' },
    { key: VoteOptions.UNSURE, label: 'Unsure', bar: 'bg-gray-400', dot: 'bg-gray-400' },
    { key: VoteOptions.AGREE, label: 'Agree', bar: 'bg-green-400', dot: 'bg-green-400' },
    { key: VoteOptions.STRONGLY_AGREE, label: 'Strongly Agree', bar: 'bg-green-600', dot: 'bg-green-600' },
];

// Short labels for the compact per-idea agreement picker on brainstorm ideas.
const AGREEMENT_SHORT = {
    [VoteOptions.STRONGLY_DISAGREE]: 'SD',
    [VoteOptions.DISAGREE]: 'D',
    [VoteOptions.UNSURE]: 'U',
    [VoteOptions.AGREE]: 'A',
    [VoteOptions.STRONGLY_AGREE]: 'SA',
};

// Curated epistemic reactions for brainstorm ideas (LessWrong-flavoured): a
// small, fixed set of high-signal tags, not free-form emoji. Keys must match the
// server's allowed set; labels/emoji are display-only.
const EPISTEMIC_REACTIONS = [
    { key: 'changed-mind', label: 'Changed my mind', emoji: '🔁' },
    { key: 'crux', label: 'Crux', emoji: '🎯' },
    { key: 'follows', label: 'Follows', emoji: '✅' },
    { key: 'citation-needed', label: 'Citation needed', emoji: '📚' },
    { key: 'key-insight', label: 'Key insight', emoji: '💡' },
];

// All catalog keys, used as the fallback active set before the server's
// discussionState (which carries the discussion's chosen subset) arrives.
const ALL_REACTION_KEYS = EPISTEMIC_REACTIONS.map(r => r.key);

// In production the client is served by the same server it talks to, so we
// default to a same-origin connection. Set VITE_SOCKET_URL only when the
// client runs on a different origin than the API (e.g. `vite` dev server).
// Use import.meta.env (Vite's mechanism) rather than process.env: `process` is
// not defined in the browser, so an unreplaced process.env.* reference throws
// at module load and blanks the page.
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || undefined;

const socket = io(SOCKET_URL);

const DiscussionPage = () => {
    const { topic } = useParams();
    const navigate = useNavigate();
    const discussionSlug = slugifyTopic(topic);
    // Always-current slug, so async socket acks fired in one discussion can tell
    // they've come back after the user navigated to a different one and bail out
    // instead of writing the old room's handle into the new room's state.
    const discussionSlugRef = useRef(discussionSlug);
    discussionSlugRef.current = discussionSlug;
    const [discussion, setDiscussion] = useState(null);
    const [questions, setQuestions] = useState([]);
    const [newQuestion, setNewQuestion] = useState('');
    const [questionType, setQuestionType] = useState(QuestionTypes.AGREEMENT);
    const [minValue, setMinValue] = useState(0);
    const [maxValue, setMaxValue] = useState(100);
    const [sliderValues, setSliderValues] = useState({});
    const [sortOption, setSortOption] = useState(SortOptions.MOST_RECENT);
    const [showUnansweredOnly, setShowUnansweredOnly] = useState(false);
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
    const [editingIdentity, setEditingIdentity] = useState(false);
    const [error, setError] = useState(null);
    const [newTopicName, setNewTopicName] = useState('');
    const [showDuplicateModal, setShowDuplicateModal] = useState(false);
    const [showShareModal, setShowShareModal] = useState(false);
    const [showActionsMenu, setShowActionsMenu] = useState(false);
    const [presence, setPresence] = useState(0);
    const [copied, setCopied] = useState(false);
    const [adminToken, setAdminToken] = useState(null);
    // Mirror of adminToken readable inside async callbacks, so an in-flight
    // checkModerator ack can tell whether the token it verified is still current.
    const adminTokenRef = useRef(adminToken);
    useEffect(() => { adminTokenRef.current = adminToken; }, [adminToken]);
    const [discussionState, setDiscussionState] = useState({
        locked: false, moderatorOnly: false, hasModerator: false, theme: DEFAULT_THEME,
        reactionsEnabled: false, reactionsVisible: true, commentsEnabled: false,
        reactionKeys: ALL_REACTION_KEYS,
    });
    const [similarPrompt, setSimilarPrompt] = useState(null);
    const [adminLinkCopied, setAdminLinkCopied] = useState(false);
    // Id of the question a moderator is currently editing inline (null when none).
    const [editingQuestionId, setEditingQuestionId] = useState(null);
    // Experimental "opinion groups" view, hidden behind a ?clusters=1 flag so it
    // can be evaluated on a real discussion without exposing it to everyone. Once
    // enabled it's remembered per browser so the link survives navigation.
    const [showClusters, setShowClusters] = useState(false);
    const [participants, setParticipants] = useState([]);
    const [showParticipants, setShowParticipants] = useState(false);
    // Whether this viewer is the creator (only the creator may remove moderators).
    const [canDemote, setCanDemote] = useState(false);
    // This browser's own participant handle, so we can hide promote/remove on our
    // own row (acting on yourself tangles the creator's admin_token with a grant).
    const [selfHandle, setSelfHandle] = useState(null);
    const [showJoinQr, setShowJoinQr] = useState(false);
    const [joinQrSize, setJoinQrSize] = useState(DEFAULT_JOIN_QR_SIZE);
    // Holds the in-flight resize drag (start pointer + start size + latest size)
    // so the move/end handlers don't depend on stale render-time closures.
    const joinQrDragRef = useRef(null);
    // This user's own brainstorm ratings/reactions, kept separately from the
    // (aggregate-only, unattributable) broadcast so we can highlight their
    // selections. Only this user mutates it, so optimistic updates are safe; we
    // fetch the authoritative copy once on join to survive reloads.
    const [myBrainstorm, setMyBrainstorm] = useState({ ratings: {}, reactions: {} });

    const isAdmin = !!adminToken;
    const { locked, moderatorOnly } = discussionState;
    const theme = THEME_KEYS.includes(discussionState.theme) ? discussionState.theme : DEFAULT_THEME;
    // Which epistemic reactions are active for this session (creator-configurable,
    // a subset of the catalog). Falls back to the full catalog until the server's
    // discussionState arrives.
    const activeReactionKeys = discussionState.reactionKeys || ALL_REACTION_KEYS;
    const discussionTitle = discussion?.topic || topic;

    const joinUrl = typeof window !== 'undefined'
        ? `${window.location.origin}/discussion/${discussionSlug}`
        : '';
    const shareUrl = joinUrl;
    const adminUrl = typeof window !== 'undefined' && adminToken
        ? `${window.location.origin}/discussion/${discussionSlug}?admin=${adminToken}`
        : '';

    const handleCopyLink = async () => {
        try {
            await navigator.clipboard.writeText(shareUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy link:', err);
            setError('Could not copy the link. You can select and copy it manually.');
        }
    };

    useEffect(() => {
        // getIdentity() persists a stable userId (so vote de-duplication survives
        // reloads) together with the chosen display name, both in localStorage.
        setIdentity(getIdentity());
    }, []);

    useEffect(() => {
        if (topic === discussionSlug) return undefined;

        let cancelled = false;
        const search = typeof window !== 'undefined' ? window.location.search : '';
        const fallback = `/discussion/${discussionSlug}${search}`;

        const resolveRoute = async () => {
            try {
                const response = await fetch(`/api/discussions/resolve/${encodeURIComponent(topic)}`);
                if (response.ok) {
                    const data = await response.json();
                    if (!cancelled && data?.slug) {
                        navigate(`/discussion/${data.slug}${search}`, { replace: true });
                        return;
                    }
                }
            } catch (error) {
                console.warn('Failed to resolve discussion route:', error);
            }

            if (!cancelled) {
                navigate(fallback, { replace: true });
            }
        };

        resolveRoute();
        return () => {
            cancelled = true;
        };
    }, [topic, discussionSlug, navigate]);

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
                discussion?.topic ? `convora_admin_${discussion.topic}` : null,
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
    }, [discussion?.topic, discussionSlug, topic]);

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
    }, [discussionSlug, adminToken]);

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

    useEffect(() => {
        try {
            setShowJoinQr(localStorage.getItem(`convora_show_join_qr_${discussionSlug}`) === 'true');
            const storedSize = parseInt(localStorage.getItem(`convora_join_qr_size_${discussionSlug}`), 10);
            setJoinQrSize(clampJoinQrSize(Number.isFinite(storedSize) ? storedSize : DEFAULT_JOIN_QR_SIZE));
        } catch (e) {
            console.warn('Failed to read QR visibility:', e);
            setShowJoinQr(false);
            setJoinQrSize(clampJoinQrSize(DEFAULT_JOIN_QR_SIZE));
        }
    }, [discussionSlug]);

    const handleToggleJoinQr = () => {
        setShowJoinQr(prev => {
            const next = !prev;
            try {
                localStorage.setItem(`convora_show_join_qr_${discussionSlug}`, String(next));
            } catch (e) {
                console.warn('Failed to store QR visibility:', e);
            }
            return next;
        });
    };

    const handleJoinQrResizeStart = (e) => {
        e.preventDefault();
        e.stopPropagation();
        joinQrDragRef.current = { startX: e.clientX, startY: e.clientY, startSize: joinQrSize, latest: joinQrSize };
        try {
            e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
            // setPointerCapture isn't critical; drag still works via the bound handlers.
        }
    };

    const handleJoinQrResizeMove = (e) => {
        const drag = joinQrDragRef.current;
        if (!drag) return;
        // Panel is anchored bottom-left, so dragging the handle right (+x) or up
        // (-y) grows it; average the two axes so the corner tracks the pointer.
        const delta = ((e.clientX - drag.startX) - (e.clientY - drag.startY)) / 2;
        const next = Math.round(clampJoinQrSize(drag.startSize + delta));
        drag.latest = next;
        setJoinQrSize(next);
    };

    const persistJoinQrSize = (size) => {
        try {
            localStorage.setItem(`convora_join_qr_size_${discussionSlug}`, String(size));
        } catch (err) {
            console.warn('Failed to store QR size:', err);
        }
    };

    const handleJoinQrResizeEnd = (e) => {
        const drag = joinQrDragRef.current;
        if (!drag) return;
        joinQrDragRef.current = null;
        try {
            e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
            // Ignore — capture may not have been set.
        }
        persistJoinQrSize(drag.latest);
    };

    // Keyboard support for the resize handle so the advertised slider role is
    // actually operable for keyboard/assistive-tech users (arrows step, Home/End jump).
    const handleJoinQrResizeKeyDown = (e) => {
        const step = 20;
        let next;
        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowUp':
                next = joinQrSize + step;
                break;
            case 'ArrowLeft':
            case 'ArrowDown':
                next = joinQrSize - step;
                break;
            case 'Home':
                next = MIN_JOIN_QR_SIZE;
                break;
            case 'End':
                next = maxJoinQrSize();
                break;
            default:
                return;
        }
        e.preventDefault();
        next = Math.round(clampJoinQrSize(next));
        setJoinQrSize(next);
        persistJoinQrSize(next);
    };

    // Re-clamp the open QR panel when the viewport shrinks (moving the browser
    // between displays, rotating a tablet) so the fixed bottom-left panel and its
    // resize handle can't drift off-screen. clampJoinQrSize bounds to
    // [MIN, maxJoinQrSize()], so this only ever shrinks — it never auto-grows the
    // moderator's chosen size on a larger viewport.
    useEffect(() => {
        if (!showJoinQr) return;
        const handleResize = () => {
            setJoinQrSize(prev => {
                const next = clampJoinQrSize(prev);
                if (next !== prev) persistJoinQrSize(next);
                return next;
            });
        };
        // Clamp immediately on becoming visible: if the viewport shrank while the
        // panel was hidden, the stored size would otherwise render off-screen
        // until the next resize event fires.
        handleResize();
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [showJoinQr, discussionSlug]);

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

    const handleClaimModerator = () => {
        socket.emit('claimModerator', discussionSlug, (resp) => {
            if (resp && resp.success) {
                try {
                    localStorage.setItem(`convora_admin_${discussionSlug}`, resp.token);
                } catch (e) {
                    console.warn('Failed to store admin token:', e);
                }
                setAdminToken(resp.token);
            } else {
                setError('This discussion already has a moderator.');
            }
        });
    };

    const handleToggleLock = () => {
        socket.emit('setLocked', discussionSlug, !locked, adminToken);
    };

    const handleToggleModeratorOnly = () => {
        socket.emit('setModeratorOnly', discussionSlug, !moderatorOnly, adminToken);
    };

    const handleSetTheme = (themeKey) => {
        socket.emit('setTheme', discussionSlug, themeKey, adminToken);
    };

    const handleDeleteQuestion = (questionId) => {
        socket.emit('deleteQuestion', discussionSlug, questionId, adminToken);
    };

    const handleTogglePin = (questionId, pinned) => {
        socket.emit('setPinned', discussionSlug, questionId, !pinned, adminToken);
    };

    // Save a moderator's edit to a question. The server only accepts it while the
    // question has no responses; on success it broadcasts fresh questions and we
    // close the inline editor, otherwise the editor stays open to show the error.
    const handleEditQuestion = (questionId, updates, onResult) => {
        socket.emit('editQuestion', discussionSlug, questionId, updates, adminToken, (resp) => {
            if (resp && resp.updated) setEditingQuestionId(null);
            if (typeof onResult === 'function') onResult(resp);
        });
    };

    const handleCopyAdminLink = async () => {
        try {
            await navigator.clipboard.writeText(adminUrl);
            setAdminLinkCopied(true);
            setTimeout(() => setAdminLinkCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy admin link:', err);
            setError('Could not copy the moderator link.');
        }
    };

    // Pull the participant list (moderator-only). The server returns opaque
    // handles + pseudonyms, never raw user ids.
    const refreshParticipants = useCallback(() => {
        if (!adminToken) return;
        socket.emit('listParticipants', discussionSlug, adminToken, (resp) => {
            if (resp && resp.success) {
                setParticipants(resp.participants);
                setCanDemote(!!resp.canDemote);
            } else if (resp && resp.error === 'not_authorized') {
                setError('You are no longer a moderator of this discussion.');
            }
        });
    }, [discussionSlug, adminToken]);

    const handleToggleParticipants = () => {
        const next = !showParticipants;
        setShowParticipants(next);
        if (next) refreshParticipants();
    };

    // Promote a participant to moderator. The server delivers them their own
    // token live and returns the refreshed list.
    const handlePromoteParticipant = (participantId) => {
        socket.emit('promoteModerator', discussionSlug, adminToken, participantId, (resp) => {
            if (resp && resp.success) {
                setParticipants(resp.participants);
                setCanDemote(!!resp.canDemote);
            } else if (resp && resp.error === 'participant_offline') {
                setError('That participant needs to have the discussion open to be made a moderator. Ask them to open it, then try again.');
            } else {
                setError('Could not promote that participant. Try refreshing the list.');
            }
        });
    };

    // Remove a participant's moderator status. Creator-only; the server pushes a
    // moderatorRevoked event to that user so their controls disappear live.
    const handleDemoteParticipant = (participantId) => {
        socket.emit('demoteModerator', discussionSlug, adminToken, participantId, (resp) => {
            if (resp && resp.success) {
                setParticipants(resp.participants);
                setCanDemote(!!resp.canDemote);
            } else if (resp && resp.error === 'not_authorized') {
                setError('Only the discussion creator can remove a moderator.');
            } else {
                setError('Could not remove that moderator. Try refreshing the list.');
            }
        });
    };

    const handleDuplicateDiscussion = async () => {
        if (newTopicName.trim() === '') {
            setError('New topic name cannot be empty.');
            return;
        }

        try {
            const response = await fetch('/api/duplicate-discussion', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ originalTopic: discussionSlug, newTopic: newTopicName }),
            });

            if (response.ok) {
                const result = await response.json();
                if (result.adminToken) {
                    try {
                        localStorage.setItem(`convora_admin_${result.newSlug}`, result.adminToken);
                    } catch (e) {
                        console.warn('Failed to store admin token:', e);
                    }
                }
                navigate(`/discussion/${result.newSlug}`);
            } else {
                const errorData = await response.json();
                setError(`Failed to duplicate discussion: ${errorData.error}`);
            }
        } catch (error) {
            console.error('Error duplicating discussion:', error);
            setError('An error occurred while duplicating the discussion.');
        }

        setShowDuplicateModal(false);
        setNewTopicName('');
    };

    const handleQuestionsUpdate = useCallback((updatedQuestions) => {
        console.log('Received updated questions:', updatedQuestions);
        setQuestions(prevQuestions => {
            // The server always emits a full snapshot of the discussion's
            // questions, so we rebuild the list from the incoming set. Building
            // a fresh map (rather than merging into the previous one) prunes any
            // question the moderator deleted — ids absent from the snapshot drop
            // out instead of lingering as visible/votable stale entries.
            const prevMap = new Map(prevQuestions.map(q => [q.id, q]));
            const nextMap = new Map();
            updatedQuestions.forEach(q => {
                const prev = prevMap.get(q.id);
                if (prev) {
                    // Merge the new question data with the existing data,
                    // ensuring we keep the votes array and handle numerical values
                    nextMap.set(q.id, {
                        ...prev,
                        ...q,
                        minValue: q.type === QuestionTypes.NUMERICAL ? parseInt(q.minValue) : undefined,
                        maxValue: q.type === QuestionTypes.NUMERICAL ? parseInt(q.maxValue) : undefined,
                        votes: q.votes || prev.votes || []
                    });
                } else {
                    nextMap.set(q.id, {
                        ...q,
                        timestamp: Date.now(),
                        votes: q.votes || [],
                        minValue: q.type === QuestionTypes.NUMERICAL ? parseInt(q.minValue) : undefined,
                        maxValue: q.type === QuestionTypes.NUMERICAL ? parseInt(q.maxValue) : undefined
                    });
                }
                console.log('Updated question:', nextMap.get(q.id));
            });
            return Array.from(nextMap.values());
        });
    }, []);

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
        setShowParticipants(false);
    }, [discussionSlug, canDemote]);

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

    useEffect(() => {
        if (topic !== discussionSlug) return undefined;
        console.log('Current topic:', discussionSlug);
        socket.emit('joinDiscussion', discussionSlug);
        socket.on('discussion', setDiscussion);
        socket.on('questions', handleQuestionsUpdate);
        socket.on('presence', setPresence);
        socket.on('discussionState', setDiscussionState);
        socket.on('similarQuestion', setSimilarPrompt);
        socket.on('moderatorGranted', handleModeratorGranted);
        socket.on('pseudonymSync', handlePseudonymSync);
        socket.on('moderatorRevoked', handleModeratorRevoked);
        return () => {
            // Leave the room so the server stops counting this client toward the
            // discussion's presence once the page unmounts (e.g. navigating home).
            socket.emit('leaveDiscussion', discussionSlug);
            socket.off('discussion', setDiscussion);
            socket.off('questions', handleQuestionsUpdate);
            socket.off('presence', setPresence);
            socket.off('discussionState', setDiscussionState);
            socket.off('similarQuestion', setSimilarPrompt);
            socket.off('moderatorGranted', handleModeratorGranted);
            socket.off('pseudonymSync', handlePseudonymSync);
            socket.off('moderatorRevoked', handleModeratorRevoked);
        };
    }, [topic, discussionSlug, handleQuestionsUpdate, handleModeratorGranted, handlePseudonymSync, handleModeratorRevoked]);

    // Mirror the discussion's chosen theme onto <html data-theme="..."> so the
    // CSS-variable palette (index.css) recolors every primary/secondary class,
    // including the app-wide header that lives outside this page. Cleared on
    // unmount so navigating away (e.g. back to the home page) returns to the
    // default look rather than leaving another discussion's colors stuck on.
    useEffect(() => {
        const root = document.documentElement;
        root.setAttribute('data-theme', theme);
        return () => root.removeAttribute('data-theme');
    }, [theme]);

    // Tell the server which persistent user this socket is, so it can route
    // moderator grants to us. Re-sent after any reconnect so a promoted user
    // doesn't silently lose their controls on a network blip.
    useEffect(() => {
        if (!userId || topic !== discussionSlug) return undefined;
        const identify = () => socket.emit('identify', discussionSlug, userId);
        identify();
        socket.on('connect', identify);
        return () => socket.off('connect', identify);
    }, [topic, discussionSlug, userId]);

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
        if (!identity || !userId || topic !== discussionSlug || !discussion?.id) return undefined;
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
    }, [identity, userId, topic, discussionSlug, discussion?.id, pseudonymReserved, assignedPseudonym]);

    // Restore this user's own brainstorm ratings/reactions on join/reload. The
    // server only ever returns the requesting user's own selections.
    useEffect(() => {
        if (!userId) return;
        socket.emit('getBrainstormState', topic, userId, (state) => {
            if (state) {
                setMyBrainstorm({ ratings: state.ratings || {}, reactions: state.reactions || {} });
            }
        });
    }, [topic, userId]);

    const handleAddQuestion = () => {
        console.log('Inside handleAddQuestion');

        // Check if question text is empty
        if (newQuestion.trim() === '') {
            console.error('Failed to add question: Question text is empty.');
            // You might want to set an error state here to display to the user
            setError('Question text cannot be empty.');
            return;
        }

        let question = {
            text: newQuestion.trim(),
            type: questionType,
            timestamp: Date.now(),
        };

        // Handle numerical questions
        if (questionType === QuestionTypes.NUMERICAL) {
            if (minValue >= maxValue) {
                console.error('Failed to add question: Min value must be less than max value.');
                setError('Minimum value must be less than maximum value.');
                return;
            }
            question.minValue = parseInt(minValue);
            question.maxValue = parseInt(maxValue);
            console.log('Adding numerical question with min:', question.minValue, 'max:', question.maxValue);
        }

        console.log('Adding question:', question);
        submitQuestion(question, false);
    };

    // Emits a question to the server. When force is false the server may reply
    // with a 'similarQuestion' event instead of adding it; when true it adds
    // regardless of near-duplicates. The form is reset only once the server acks
    // that the question was actually added, so a near-duplicate bounce (or an
    // error) leaves the user's draft intact for them to edit or re-post.
    const submitQuestion = (question, force) => {
        try {
            setError(null);
            socket.emit('addQuestion', discussionSlug, question, force, adminToken, (resp) => {
                if (resp && resp.added) {
                    setNewQuestion('');
                    setQuestionType(QuestionTypes.AGREEMENT);
                    setMinValue(0);
                    setMaxValue(100);
                } else if (resp && resp.reason === 'moderator_only') {
                    setError('Only the moderator can add questions right now.');
                }
            });
        } catch (error) {
            console.error('Error emitting addQuestion event:', error);
            setError('Failed to add question. Please try again.');
        }
    };

    const handlePostAnyway = () => {
        if (similarPrompt) {
            submitQuestion(similarPrompt.question, true);
            setSimilarPrompt(null);
        }
    };

    const handleVote = (questionId, value) => {
        console.log('Voting:', questionId, value);
        // Send the name mode too: in pseudonym mode the server persists our
        // reserved handle instead of this possibly-pre-reservation displayName,
        // closing the submit-before-reservation collision window (#57). We send the
        // EFFECTIVE mode so a blank-custom name (shown as the pseudonym) canonicalizes.
        socket.emit('vote', discussionSlug, questionId, value, userId, displayName, getEffectiveNameMode(identity));
        setSliderValues(prev => ({ ...prev, [questionId]: undefined }));
    };

    // Brainstorm answers are individual rows, so they're removed by vote id
    // (a participant can only delete their own).
    const handleDeleteVote = (questionId, voteId) => {
        console.log('Deleting vote:', questionId, voteId);
        socket.emit('deleteVote', discussionSlug, voteId, userId);
    };

    // Moderator-only: remove any participant's response/idea, regardless of
    // owner (spam control). The server re-checks the admin token.
    const handleModeratorDeleteVote = (questionId, voteId) => {
        socket.emit('moderatorDeleteVote', discussionSlug, voteId, adminToken);
    };

    const handleSliderChange = (questionId, value) => {
        setSliderValues(prev => ({ ...prev, [questionId]: value }));
    };

    const handleResponseVote = (responseId) => {
        socket.emit('toggleResponseVote', discussionSlug, responseId, userId);
    };

    // Set/clear one axis of this user's rating on a brainstorm idea. Toggles off
    // when the same value is re-selected. Updates local "mine" state optimistically
    // (no other actor can change this user's own rating) and tells the server.
    const handleSetRating = (responseId, axis, value) => {
        const current = myBrainstorm.ratings[responseId]?.[axis] ?? null;
        const next = current === value ? null : value;
        setMyBrainstorm(prev => {
            const ratings = { ...prev.ratings, [responseId]: { ...prev.ratings[responseId], [axis]: next } };
            return { ...prev, ratings };
        });
        socket.emit('setResponseRating', topic, responseId, axis, next, userId);
    };

    const handleToggleReaction = (responseId, reaction) => {
        setMyBrainstorm(prev => {
            const set = new Set(prev.reactions[responseId] || []);
            if (set.has(reaction)) set.delete(reaction); else set.add(reaction);
            return { ...prev, reactions: { ...prev.reactions, [responseId]: [...set] } };
        });
        socket.emit('toggleResponseReaction', topic, responseId, reaction, userId);
    };

    const handleAddComment = (responseId, body) => {
        // Pass the name mode so pseudonym-mode comments persist under our reserved
        // handle rather than a pre-reservation local pick (#57); see handleVote.
        socket.emit('addResponseComment', topic, responseId, body, userId, displayName, getEffectiveNameMode(identity));
    };

    const handleDeleteComment = (commentId) => {
        socket.emit('deleteResponseComment', topic, commentId, userId);
    };

    // Moderator-only: remove any participant's comment, regardless of owner.
    const handleModeratorDeleteComment = (commentId) => {
        socket.emit('moderatorDeleteResponseComment', topic, commentId, adminToken);
    };

    const handleSetDiscussionFlags = (flags) => {
        socket.emit('setDiscussionFlags', topic, flags, adminToken);
    };

    // Set the active epistemic reactions for the whole session. The server
    // re-broadcasts discussionState, so we don't update local state optimistically.
    const handleSetReactionKeys = (keys) => {
        socket.emit('setReactionKeys', topic, keys, adminToken);
    };

    const sortQuestions = (questions) => {
        switch (sortOption) {
            case SortOptions.MOST_RECENT:
                return [...questions].sort((a, b) => getQuestionSortTime(b) - getQuestionSortTime(a));
            case SortOptions.MOST_AGREEMENT:
                return [...questions].sort((a, b) => getAgreementCount(b) - getAgreementCount(a));
            case SortOptions.MOST_DISAGREEMENT:
                return [...questions].sort((a, b) => getDisagreementCount(b) - getDisagreementCount(a));
            case SortOptions.MOST_CONTROVERSIAL:
                return [...questions].sort((a, b) => getControversyScore(b) - getControversyScore(a));
            default:
                return questions;
        }
    };

    // Only Agreement and Yes/No are opinion prompts; the agreement sorts ignore
    // other types so an Open Ended / Brainstorm answer that happens to read
    // "Yes", "No", "Agree", etc. can't mis-rank a non-opinion question.
    const isOpinionQuestion = (question) =>
        question?.type === QuestionTypes.AGREEMENT || question?.type === QuestionTypes.YES_NO;

    // Yes/No votes count toward the same agreement/disagreement sorts as the
    // five-point scale: Yes reads as agreement, No as disagreement.
    const getAgreementCount = (question) => {
        if (!isOpinionQuestion(question)) return 0;
        return (question.votes || []).filter(v => v.value === VoteOptions.STRONGLY_AGREE || v.value === VoteOptions.AGREE || v.value === YesNoOptions.YES).length;
    };

    const getDisagreementCount = (question) => {
        if (!isOpinionQuestion(question)) return 0;
        return (question.votes || []).filter(v => v.value === VoteOptions.STRONGLY_DISAGREE || v.value === VoteOptions.DISAGREE || v.value === YesNoOptions.NO).length;
    };

    const getControversyScore = (question) => {
        const agreementCount = getAgreementCount(question);
        const disagreementCount = getDisagreementCount(question);
        return Math.min(agreementCount, disagreementCount);
    };

    const getQuestionSortTime = (question) => {
        if (question.timestamp) {
            return question.timestamp;
        }
        const createdAt = Date.parse(question.created_at);
        return Number.isNaN(createdAt) ? 0 : createdAt;
    };

    const filterQuestions = (questions) => {
        if (!showUnansweredOnly) {
            return questions;
        }
        return questions.filter(question =>
            !question.votes || !question.votes.some(vote => isMyVote(question, vote))
        );
    };

    const renderVotingMechanism = (question) => {
        const userVote = question.votes ? question.votes.find(v => isMyVote(question, v)) : null;

        if (!question || typeof question !== 'object') {
            console.error('Invalid question object:', question);
            return null;
        }

        switch (question.type) {
            case QuestionTypes.AGREEMENT:
                return (
                    <div>
                        <AgreementResults question={question} />
                        {!locked && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {Object.values(VoteOptions).map((option) => (
                                    <div key={option} className="flex items-center justify-between bg-gray-100 p-3 rounded-md">
                                        <span className="font-medium">
                                            {option}: {question.votes ? question.votes.filter(v => v.value === option).length : 0}
                                        </span>
                                        <button
                                            onClick={() => handleVote(question.id, option)}
                                            className={`px-4 py-2 rounded-md transition duration-300 ${userVote && userVote.value === option
                                                ? 'bg-primary text-white hover:bg-opacity-90'
                                                : 'bg-secondary text-white hover:bg-opacity-90'
                                                }`}
                                        >
                                            {userVote && userVote.value === option ? 'Undo Vote' : 'Vote'}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            case QuestionTypes.YES_NO:
                return (
                    <div>
                        <YesNoResults question={question} />
                        {!locked && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {Object.values(YesNoOptions).map((option) => (
                                    <div key={option} className="flex items-center justify-between bg-gray-100 p-3 rounded-md">
                                        <span className="font-medium">
                                            {option}: {question.votes ? question.votes.filter(v => v.value === option).length : 0}
                                        </span>
                                        <button
                                            onClick={() => handleVote(question.id, option)}
                                            className={`px-4 py-2 rounded-md transition duration-300 ${userVote && userVote.value === option
                                                ? 'bg-primary text-white hover:bg-opacity-90'
                                                : 'bg-secondary text-white hover:bg-opacity-90'
                                                }`}
                                        >
                                            {userVote && userVote.value === option ? 'Undo Vote' : 'Vote'}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            case QuestionTypes.NUMERICAL: {
                // console.log("Question:", question)
                const minValue = parseInt(question.minValue || question.min_value) || 0;
                const maxValue = parseInt(question.maxValue || question.max_value) || 100;
                const defaultValue = Math.floor((minValue + maxValue) / 2);
                // console.log("Question:", question.id, "min:", minValue, "max:", maxValue, "default:", defaultValue);

                const sliderValue = sliderValues[question.id] !== undefined
                    ? sliderValues[question.id]
                    : (userVote
                        ? parseInt(userVote.value)
                        : defaultValue);

                return (
                    <div className="mt-4">
                        <NumericalResults question={question} minValue={minValue} maxValue={maxValue} />
                        {!locked && (
                            <>
                                <input
                                    type="range"
                                    min={minValue}
                                    max={maxValue}
                                    value={sliderValue}
                                    className="w-full"
                                    onChange={(e) => handleSliderChange(question.id, parseInt(e.target.value))}
                                />
                                <div className="flex justify-between mt-2">
                                    <span>{minValue}</span>
                                    <span>{sliderValue}</span>
                                    <span>{maxValue}</span>
                                </div>
                                <button
                                    onClick={() => handleVote(question.id, sliderValue)}
                                    className={`mt-4 px-4 py-2 rounded-md transition duration-300 ${userVote ? 'bg-primary text-white hover:bg-opacity-90' : 'bg-secondary text-white hover:bg-opacity-90'}`}
                                >
                                    {userVote ? 'Update Vote' : 'Submit'}
                                </button>
                            </>
                        )}
                    </div>
                );
            }
            case QuestionTypes.OPEN_ENDED: {
                return <OpenEndedQuestion question={question} userVote={userVote} handleVote={handleVote} ownedVoteIds={ownedVoteIds} upvotedVoteIds={upvotedVoteIds} handleResponseVote={handleResponseVote} locked={locked} isAdmin={isAdmin} onModeratorDeleteVote={handleModeratorDeleteVote} />;
            }
            case QuestionTypes.BRAINSTORM: {
                return <BrainstormQuestion
                    question={question}
                    ownedVoteIds={ownedVoteIds}
                    ownedCommentIds={ownedCommentIds}
                    handleVote={handleVote}
                    handleDeleteVote={handleDeleteVote}
                    locked={locked}
                    isAdmin={isAdmin}
                    myBrainstorm={myBrainstorm}
                    activeReactionKeys={activeReactionKeys}
                    onSetRating={handleSetRating}
                    onToggleReaction={handleToggleReaction}
                    onAddComment={handleAddComment}
                    onDeleteComment={handleDeleteComment}
                    onModeratorDeleteVote={handleModeratorDeleteVote}
                    onModeratorDeleteComment={handleModeratorDeleteComment}
                />;
            }

            default:
                console.warn('Unknown question type:', question.type);
                return null;
        }
    };

    const sortedAndFilteredQuestions = filterQuestions(sortQuestions(questions));
    // Pinned questions float to the top, preserving the chosen sort within each
    // group (Array.prototype.sort is stable).
    const orderedQuestions = [...sortedAndFilteredQuestions].sort(
        (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
    );

    return (
        <div className="max-w-4xl mx-auto mt-10 px-4">
            <h1 className="text-4xl font-bold mb-2 text-center text-gray-800">Discussion: {discussionTitle}</h1>

            {/* Participant identity + live presence */}
            <div className="mb-8 text-center text-sm text-gray-600">
                <div>
                    You are <span className="font-semibold text-gray-800">{displayName || '…'}</span>
                    <button
                        onClick={() => setEditingIdentity(v => !v)}
                        className="ml-2 text-primary hover:underline"
                        title="Choose how you appear to others"
                    >
                        (change)
                    </button>
                    <span className="mx-2 text-gray-300">·</span>
                    <span className="inline-flex items-center">
                        <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5" />
                        {presence} {presence === 1 ? 'person' : 'people'} here now
                    </span>
                </div>

                {editingIdentity && identity && (
                    <div className="mt-3 inline-block text-left bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-2">
                        <p className="text-xs text-gray-500 mb-1">How would you like to appear?</p>

                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="radio"
                                name="nameMode"
                                checked={identity.mode === NameModes.PSEUDONYM}
                                onChange={() => handleSelectNameMode(NameModes.PSEUDONYM)}
                            />
                            <span>
                                Pseudonym:{' '}
                                <span className="font-semibold text-gray-800">{effectivePseudonym}</span>
                            </span>
                            <button
                                type="button"
                                onClick={handleRegeneratePseudonym}
                                disabled={!pseudonymReserved || shufflePending}
                                className="text-primary hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-default"
                                title="Get a new pseudonym"
                            >
                                (shuffle)
                            </button>
                        </label>

                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="radio"
                                name="nameMode"
                                checked={identity.mode === NameModes.ANONYMOUS}
                                onChange={() => handleSelectNameMode(NameModes.ANONYMOUS)}
                            />
                            <span>Completely anonymous</span>
                        </label>

                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="radio"
                                name="nameMode"
                                checked={identity.mode === NameModes.CUSTOM}
                                onChange={() => handleSelectNameMode(NameModes.CUSTOM)}
                            />
                            <span>Enter your own name:</span>
                            <input
                                type="text"
                                value={identity.customName}
                                maxLength={MAX_CUSTOM_NAME_LENGTH}
                                placeholder="Your name"
                                onChange={(e) => handleCustomNameChange(e.target.value)}
                                className="border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                            />
                        </label>

                        <div className="pt-1">
                            <button
                                type="button"
                                onClick={() => setEditingIdentity(false)}
                                className="text-primary hover:underline"
                            >
                                Done
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Discussion actions. Share is the one frequently-used action, so it
                stays a solid primary button. View Summary / Opinion Groups are
                view-oriented and get a quieter ghost style. The rare, one-off
                actions (duplicate, exports) live in a "More" overflow menu so they
                don't compete for attention with the things people actually reach
                for during a session. */}
            <div className="mb-4 flex flex-wrap items-center gap-3">
                <button
                    onClick={() => setShowShareModal(true)}
                    className="bg-primary text-white py-2 px-4 rounded hover:bg-opacity-90 transition duration-300"
                >
                    Share
                </button>
                <Link
                    to={`/discussion/${discussionSlug}/summary`}
                    className="border border-gray-300 text-gray-700 py-2 px-4 rounded hover:bg-gray-100 transition duration-300"
                >
                    View Summary
                </Link>
                {showClusters && (
                    <Link
                        to={`/discussion/${encodeURIComponent(topic)}/clusters`}
                        className="border border-gray-300 text-gray-700 py-2 px-4 rounded hover:bg-gray-100 transition duration-300"
                    >
                        Opinion Groups
                    </Link>
                )}
                <div className="relative">
                    <button
                        type="button"
                        onClick={() => setShowActionsMenu((open) => !open)}
                        aria-haspopup="true"
                        aria-expanded={showActionsMenu}
                        className="border border-gray-300 text-gray-700 py-2 px-4 rounded hover:bg-gray-100 transition duration-300"
                    >
                        More ▾
                    </button>
                    {showActionsMenu && (
                        <>
                            {/* Invisible backdrop closes the menu on any outside click,
                                matching how the modals below handle dismissal. */}
                            <div
                                className="fixed inset-0 z-10"
                                onClick={() => setShowActionsMenu(false)}
                            />
                            <div
                                role="menu"
                                className="absolute left-0 mt-1 z-20 w-52 bg-white border border-gray-200 rounded shadow-lg py-1"
                            >
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        setShowActionsMenu(false);
                                        setShowDuplicateModal(true);
                                    }}
                                    className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                                >
                                    Duplicate Discussion
                                </button>
                                <a
                                    role="menuitem"
                                    href={`/api/discussions/${encodeURIComponent(discussionSlug)}/export.csv`}
                                    onClick={() => setShowActionsMenu(false)}
                                    className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                                >
                                    Export CSV
                                </a>
                                <a
                                    role="menuitem"
                                    href={`/api/discussions/${encodeURIComponent(discussionSlug)}/export.json`}
                                    onClick={() => setShowActionsMenu(false)}
                                    className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                                >
                                    Export JSON
                                </a>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Duplicate Modal */}
            {showDuplicateModal && (
                <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full flex items-center justify-center">
                    <div className="bg-white p-5 rounded-lg shadow-xl">
                        <h2 className="text-xl font-bold mb-4">Duplicate Discussion</h2>
                        <input
                            type="text"
                            value={newTopicName}
                            onChange={(e) => setNewTopicName(e.target.value)}
                            placeholder="Enter new topic name"
                            className="w-full p-2 border rounded mb-4"
                        />
                        <div className="flex justify-end">
                            <button
                                onClick={() => setShowDuplicateModal(false)}
                                className="mr-2 px-4 py-2 bg-gray-300 rounded hover:bg-gray-400"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleDuplicateDiscussion}
                                className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90"
                            >
                                Duplicate
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Share Modal */}
            {showShareModal && (
                <div
                    className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full flex items-center justify-center"
                    onClick={() => setShowShareModal(false)}
                >
                    <div className="bg-white p-6 rounded-lg shadow-xl text-center max-w-[95vw] max-h-[95vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                        <h2 className="text-2xl font-bold mb-4">Share this discussion</h2>
                        <div className="flex justify-center mb-4">
                            <QRCodeSVG
                                value={shareUrl}
                                size={1024}
                                includeMargin
                                className="w-auto h-auto max-w-full"
                                style={{ width: 'min(80vw, 70vh)', height: 'min(80vw, 70vh)' }}
                            />
                        </div>
                        <p className="text-base text-gray-500 mb-2">Scan to join, or copy the link:</p>
                        <div className="flex items-center gap-2 mb-4 max-w-2xl mx-auto w-full">
                            <input
                                type="text"
                                readOnly
                                value={shareUrl}
                                onFocus={(e) => e.target.select()}
                                className="flex-1 min-w-0 p-2 border rounded text-sm bg-gray-50"
                            />
                            <button
                                onClick={handleCopyLink}
                                className="shrink-0 px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90 whitespace-nowrap"
                            >
                                {copied ? 'Copied!' : 'Copy'}
                            </button>
                        </div>
                        <button
                            onClick={() => setShowShareModal(false)}
                            className="px-4 py-2 bg-gray-300 rounded hover:bg-gray-400"
                        >
                            Close
                        </button>
                    </div>
                </div>
            )}

            {/* Moderator bar */}
            <div className="mb-6">
                {isAdmin ? (
                    <div className="flex flex-wrap items-center gap-3 bg-indigo-50 border border-indigo-100 rounded-md p-3 text-sm">
                        <span className="font-semibold text-indigo-800">You&apos;re the moderator</span>
                        <button
                            onClick={handleToggleLock}
                            className="px-3 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                        >
                            {locked ? 'Unlock discussion' : 'Lock discussion'}
                        </button>
                        <button
                            onClick={handleToggleModeratorOnly}
                            className="px-3 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                            title={moderatorOnly
                                ? 'Anyone can add questions'
                                : 'Only you can add questions; everyone can still vote'}
                        >
                            {moderatorOnly ? 'Open questions to everyone' : 'Only I can add questions'}
                        </button>
                        <button
                            onClick={handleCopyAdminLink}
                            className="px-3 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                            title="Anyone with this link becomes a moderator"
                        >
                            {adminLinkCopied ? 'Link copied!' : 'Copy moderator link'}
                        </button>
                        <button
                            onClick={handleToggleParticipants}
                            className="px-3 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                        >
                            {showParticipants ? 'Hide participants' : 'Manage participants'}
                        </button>
                        <button
                            onClick={handleToggleJoinQr}
                            className="px-3 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                        >
                            {showJoinQr ? 'Hide join QR' : 'Show join QR'}
                        </button>
                        {/* Color theme picker: clicking a swatch recolors the
                            discussion for everyone in the room. */}
                        <div className="flex items-center gap-1.5 pl-1" role="group" aria-label="Color theme">
                            <span className="font-medium text-indigo-800">Theme</span>
                            {THEMES.map((t) => (
                                <button
                                    key={t.key}
                                    type="button"
                                    onClick={() => handleSetTheme(t.key)}
                                    title={t.label}
                                    aria-label={`${t.label} theme`}
                                    aria-pressed={theme === t.key}
                                    className={`h-6 w-6 rounded-full border border-white shadow-sm transition ${
                                        theme === t.key
                                            ? 'ring-2 ring-offset-1 ring-gray-700'
                                            : 'hover:scale-110'
                                    }`}
                                    style={{ backgroundColor: t.swatch }}
                                />
                            ))}
                        </div>
                        {/* Discussion-wide brainstorm phasing: these apply to
                            every brainstorm prompt at once (read silently, then
                            open reactions, then open comments). */}
                        <span className="w-px self-stretch bg-indigo-200" aria-hidden="true" />
                        <span className="text-indigo-700">Brainstorms:</span>
                        <button
                            onClick={() => handleSetDiscussionFlags({ reactions_enabled: !discussionState.reactionsEnabled })}
                            className="px-3 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                        >
                            {discussionState.reactionsEnabled ? 'Disable reactions' : 'Enable reactions'}
                        </button>
                        {discussionState.reactionsEnabled && (
                            <button
                                onClick={() => handleSetDiscussionFlags({ reactions_visible: !discussionState.reactionsVisible })}
                                className="px-3 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                            >
                                {discussionState.reactionsVisible ? 'Hide reactions' : 'Show reactions'}
                            </button>
                        )}
                        <button
                            onClick={() => handleSetDiscussionFlags({ comments_enabled: !discussionState.commentsEnabled })}
                            className="px-3 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                        >
                            {discussionState.commentsEnabled ? 'Disable comments' : 'Enable comments'}
                        </button>
                        {/* Creator-configurable reaction set (whole session): which
                            epistemic reactions participants may use. Discussion-wide,
                            so it lives here alongside the other brainstorm toggles. */}
                        {discussionState.reactionsEnabled && (
                            <div className="w-full flex flex-wrap items-center gap-1 mt-1 border-t border-indigo-200 pt-2 text-xs">
                                <span className="text-indigo-700">Reaction set (whole session):</span>
                                {EPISTEMIC_REACTIONS.map(r => {
                                    const on = activeReactionKeys.includes(r.key);
                                    return (
                                        <button
                                            key={r.key}
                                            type="button"
                                            // Toggling rebuilds the active list in catalog order; the
                                            // last remaining reaction can't be removed (the server
                                            // ignores an empty set, so guard the UI to match).
                                            onClick={() => {
                                                const next = on
                                                    ? activeReactionKeys.filter(k => k !== r.key)
                                                    : EPISTEMIC_REACTIONS.map(c => c.key)
                                                        .filter(k => k === r.key || activeReactionKeys.includes(k));
                                                if (next.length === 0) return;
                                                handleSetReactionKeys(next);
                                            }}
                                            title={on ? `Hide "${r.label}"` : `Show "${r.label}"`}
                                            className={`px-2 py-0.5 rounded-full border ${on
                                                ? 'bg-indigo-100 border-indigo-400 text-indigo-800'
                                                : 'bg-white border-gray-300 text-gray-400 line-through'}`}
                                        >
                                            <span className="mr-1">{r.emoji}</span>{r.label}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                ) : !discussionState.hasModerator ? (
                    <button
                        onClick={handleClaimModerator}
                        className="text-sm text-gray-600 underline hover:text-gray-800"
                    >
                        Become moderator
                    </button>
                ) : null}
            </div>

            {/* Participant management (moderator-only): promote a participant to
                moderator. Only people who have voted or responded appear here —
                the server can't name silent viewers. */}
            {isAdmin && showParticipants && (
                <div className="mb-6 bg-white border border-indigo-100 rounded-md p-4 text-sm">
                    <div className="flex items-center justify-between mb-3">
                        <span className="font-semibold text-gray-700">Participants</span>
                        <button
                            onClick={refreshParticipants}
                            className="text-xs text-indigo-600 underline hover:text-indigo-800"
                        >
                            Refresh
                        </button>
                    </div>
                    {participants.length === 0 ? (
                        <p className="text-gray-500">
                            No participants yet. People show up here once they vote or post a response.
                        </p>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {participants.map((participant) => (
                                <li key={participant.id} className="flex items-center justify-between py-2">
                                    <span className="text-gray-800">
                                        {participant.pseudonym}
                                        {participant.id === selfHandle && (
                                            <span className="text-gray-400"> (you)</span>
                                        )}
                                    </span>
                                    {/* Never offer promote/remove on your own row: self-promote or
                                        self-remove tangles the creator's admin_token with a per-user
                                        grant. Show only the Moderator badge if applicable. */}
                                    {participant.id === selfHandle ? (
                                        participant.isModerator ? (
                                            <span className="text-xs font-medium text-indigo-700 bg-indigo-50 px-2 py-1 rounded">
                                                Moderator
                                            </span>
                                        ) : null
                                    ) : participant.isModerator ? (
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs font-medium text-indigo-700 bg-indigo-50 px-2 py-1 rounded">
                                                Moderator
                                            </span>
                                            {canDemote && (
                                                <button
                                                    onClick={() => handleDemoteParticipant(participant.id)}
                                                    className="text-xs px-2 py-1 rounded bg-white border border-red-300 text-red-600 hover:bg-red-50"
                                                >
                                                    Remove
                                                </button>
                                            )}
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => handlePromoteParticipant(participant.id)}
                                            className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700"
                                        >
                                            Make moderator
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {/* Locked banner */}
            {locked && (
                <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-md p-3 text-center">
                    🔒 This discussion is locked. Voting and new statements are closed.
                </div>
            )}

            {isAdmin && showJoinQr && (
                <div
                    className="fixed bottom-4 left-4 z-40 rounded-md border border-gray-200 bg-white p-3 text-center shadow-xl"
                    style={{ width: joinQrSize + 24 }}
                >
                    <div className="flex justify-center">
                        <QRCodeSVG value={joinUrl} size={joinQrSize} includeMargin />
                    </div>
                    <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Scan to join</div>
                    <div className="mt-1 truncate text-sm font-semibold text-gray-800" title={discussionTitle}>{discussionTitle}</div>
                    {/* Drag this corner to resize the QR for the room/screen. */}
                    <div
                        onPointerDown={handleJoinQrResizeStart}
                        onPointerMove={handleJoinQrResizeMove}
                        onPointerUp={handleJoinQrResizeEnd}
                        onPointerCancel={handleJoinQrResizeEnd}
                        onKeyDown={handleJoinQrResizeKeyDown}
                        tabIndex={0}
                        role="slider"
                        aria-label="Resize join QR code"
                        aria-valuemin={MIN_JOIN_QR_SIZE}
                        aria-valuemax={maxJoinQrSize()}
                        aria-valuenow={joinQrSize}
                        title="Drag to resize"
                        className="absolute -right-2 -top-2 flex h-7 w-7 cursor-nesw-resize touch-none items-center justify-center rounded-full border border-gray-300 bg-white text-gray-400 shadow hover:text-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    >
                        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2 2 14" />
                            <path d="M14 8v6H8" />
                            <path d="M2 8V2h6" />
                        </svg>
                    </div>
                </div>
            )}

            {/* Near-duplicate prompt */}
            {similarPrompt && (
                <div
                    className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full flex items-center justify-center"
                    onClick={() => setSimilarPrompt(null)}
                >
                    <div className="bg-white p-6 rounded-lg shadow-xl max-w-md" onClick={(e) => e.stopPropagation()}>
                        <h2 className="text-xl font-bold mb-3">A similar statement already exists</h2>
                        <p className="text-sm text-gray-600 mb-2">Someone already posted:</p>
                        <blockquote className="border-l-4 border-primary pl-3 italic text-gray-800 mb-4">
                            {similarPrompt.candidate}
                        </blockquote>
                        <p className="text-sm text-gray-600 mb-4">
                            Consider voting on the existing one to keep the discussion focused — or post yours anyway if it&apos;s meaningfully different.
                        </p>
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => setSimilarPrompt(null)}
                                className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90"
                            >
                                Use existing
                            </button>
                            <button
                                onClick={handlePostAnyway}
                                className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
                            >
                                Post anyway
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* When the moderator has restricted question-asking, let participants
                know why they can't add one (voting stays open). Hidden from the
                moderator, who keeps the form and the toggle. */}
            {!locked && moderatorOnly && !isAdmin && (
                <div className="mb-8 bg-indigo-50 border border-indigo-200 text-indigo-800 rounded-md p-3 text-center">
                    Only the moderator can add questions right now. You can still vote on the ones below.
                </div>
            )}

            {!locked && (!moderatorOnly || isAdmin) && (
            <div className="bg-white shadow-lg rounded-lg p-6 mb-8">
                <input
                    type="text"
                    value={newQuestion}
                    onChange={(e) => setNewQuestion(e.target.value)}
                    placeholder="Enter a new question or statement"
                    className="w-full p-3 border border-gray-300 rounded-md mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <div className="mb-4">
                    <label className="block mb-2">Question Type:</label>
                    <select
                        value={questionType}
                        onChange={(e) => setQuestionType(e.target.value)}
                        className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                        {Object.values(QuestionTypes).map(type => (
                            <option key={type} value={type}>{type}</option>
                        ))}
                    </select>
                    {QuestionTypeDescriptions[questionType] && (
                        <p className="mt-2 text-sm text-gray-500">{QuestionTypeDescriptions[questionType]}</p>
                    )}
                </div>
                {questionType === QuestionTypes.NUMERICAL && (
                    <div className="mb-4 flex space-x-4">
                        <div className="flex-1">
                            <label className="block mb-2">Min Value:</label>
                            <input
                                type="number"
                                value={minValue}
                                onChange={(e) => setMinValue(parseInt(e.target.value))}
                                className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                        </div>
                        <div className="flex-1">
                            <label className="block mb-2">Max Value:</label>
                            <input
                                type="number"
                                value={maxValue}
                                onChange={(e) => setMaxValue(parseInt(e.target.value))}
                                className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                        </div>
                    </div>
                )}
                <button
                    onClick={handleAddQuestion}
                    className="w-full bg-primary text-white py-3 rounded-md hover:bg-opacity-90 transition duration-300"
                >
                    Add Question
                </button>
            </div>
            )}
            {error && <div className="text-red-500 mb-4">{error}</div>}
            {/* Sorting and filtering controls */}
            <div className="mb-6 flex justify-between items-center">
                <select
                    value={sortOption}
                    onChange={(e) => setSortOption(e.target.value)}
                    className="p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                >
                    {Object.values(SortOptions).map(option => (
                        <option key={option} value={option}>{option}</option>
                    ))}
                </select>
                <label className="flex items-center">
                    <input
                        type="checkbox"
                        checked={showUnansweredOnly}
                        onChange={(e) => setShowUnansweredOnly(e.target.checked)}
                        className="mr-2"
                    />
                    Show unanswered only
                </label>
            </div>

            {/* Questions list */}
            {orderedQuestions.map((question) => {
                // A question can only be edited before anyone has responded — once
                // it has votes, its wording is locked in (matches the server guard).
                const hasResponses = (question.votes?.length || 0) > 0;
                const isEditing = editingQuestionId === question.id;
                return (
                <div key={question.id} className="bg-white shadow-lg rounded-lg p-6 mb-6">
                    {isEditing ? (
                        <QuestionEditor
                            question={question}
                            onSave={handleEditQuestion}
                            onCancel={() => setEditingQuestionId(null)}
                        />
                    ) : (
                    <>
                    <div className="flex justify-between items-start mb-4">
                        <h2 className="text-xl font-semibold">
                            {question.pinned && <span className="mr-1" title="Pinned">📌</span>}
                            {question.text}
                        </h2>
                        {isAdmin && (
                            <div className="flex gap-2 ml-4 shrink-0">
                                {!hasResponses && (
                                    <button
                                        onClick={() => setEditingQuestionId(question.id)}
                                        className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                                    >
                                        Edit
                                    </button>
                                )}
                                <button
                                    onClick={() => handleTogglePin(question.id, question.pinned)}
                                    className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                                >
                                    {question.pinned ? 'Unpin' : 'Pin'}
                                </button>
                                <button
                                    onClick={() => handleDeleteQuestion(question.id)}
                                    className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50"
                                >
                                    Delete
                                </button>
                            </div>
                        )}
                    </div>
                    <p className="mb-4 text-sm text-gray-500">Type: {question.type}</p>
                    {renderVotingMechanism(question)}
                    </>
                    )}
                </div>
                );
            })}
        </div>
    );
};

// Inline moderator editor for a question's wording/type, mirroring the fields of
// the "add question" form. Only mounted for questions with no responses yet; the
// server enforces that same rule, so a stale view can't slip an edit through.
const QuestionEditor = ({ question, onSave, onCancel }) => {
    const [text, setText] = useState(question.text);
    const [type, setType] = useState(question.type);
    const [minValue, setMinValue] = useState(question.minValue ?? 0);
    const [maxValue, setMaxValue] = useState(question.maxValue ?? 100);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    const handleSave = () => {
        const trimmed = text.trim();
        if (trimmed === '') {
            setError('Question text cannot be empty.');
            return;
        }
        const updates = { text: trimmed, type };
        if (type === QuestionTypes.NUMERICAL) {
            const min = parseInt(minValue, 10);
            const max = parseInt(maxValue, 10);
            if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max) {
                setError('Minimum value must be less than maximum value.');
                return;
            }
            updates.minValue = min;
            updates.maxValue = max;
        }
        setError(null);
        setSaving(true);
        onSave(question.id, updates, (resp) => {
            setSaving(false);
            if (!resp || !resp.updated) {
                setError(
                    resp && resp.reason === 'has_responses'
                        ? 'This question already has responses and can no longer be edited.'
                        : 'Failed to save changes. Please try again.'
                );
            }
            // On success the parent unmounts this editor; nothing more to do here.
        });
    };

    return (
        <div>
            <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Enter a new question or statement"
                className="w-full p-3 border border-gray-300 rounded-md mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <div className="mb-4">
                <label className="block mb-2">Question Type:</label>
                <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                >
                    {Object.values(QuestionTypes).map(t => (
                        <option key={t} value={t}>{t}</option>
                    ))}
                </select>
                {QuestionTypeDescriptions[type] && (
                    <p className="mt-2 text-sm text-gray-500">{QuestionTypeDescriptions[type]}</p>
                )}
            </div>
            {type === QuestionTypes.NUMERICAL && (
                <div className="mb-4 flex space-x-4">
                    <div className="flex-1">
                        <label className="block mb-2">Min Value:</label>
                        <input
                            type="number"
                            value={minValue}
                            onChange={(e) => setMinValue(e.target.value)}
                            className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                    </div>
                    <div className="flex-1">
                        <label className="block mb-2">Max Value:</label>
                        <input
                            type="number"
                            value={maxValue}
                            onChange={(e) => setMaxValue(e.target.value)}
                            className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                    </div>
                </div>
            )}
            {error && <div className="text-red-500 mb-3 text-sm">{error}</div>}
            <div className="flex gap-2">
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90 transition duration-300 disabled:opacity-50"
                >
                    {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                    onClick={onCancel}
                    disabled={saving}
                    className="px-4 py-2 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 transition duration-300 disabled:opacity-50"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
};
QuestionEditor.propTypes = {
    question: PropTypes.object.isRequired,
    onSave: PropTypes.func.isRequired,
    onCancel: PropTypes.func.isRequired,
};

const OpenEndedQuestion = ({ question, userVote, handleVote, ownedVoteIds, upvotedVoteIds, handleResponseVote, locked, isAdmin, onModeratorDeleteVote }) => {
    const [response, setResponse] = useState(userVote ? userVote.value : '');

    useEffect(() => {
        setResponse(userVote ? userVote.value : '');
    }, [userVote]);

    // Most-upvoted responses first; ties keep submission order (vote id).
    const sortedResponses = [...(question.votes || [])].sort(
        (a, b) => (b.upvotes || 0) - (a.upvotes || 0) || a.id - b.id
    );

    return (
        <div>
            {!locked && (
                <>
                    <textarea
                        value={response}
                        onChange={(e) => setResponse(e.target.value)}
                        className="w-full p-2 border rounded mb-2"
                        rows="4"
                        placeholder="Enter your response here"
                    />
                    <button
                        onClick={() => {
                            const trimmed = response.trim();
                            if (trimmed === '') {
                                return;
                            }
                            console.log('Submitting open-ended response:', trimmed);
                            handleVote(question.id, trimmed);
                        }}
                        disabled={response.trim() === ''}
                        className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90 transition duration-300 mb-4 disabled:opacity-50"
                    >
                        {userVote ? 'Update Response' : 'Submit Response'}
                    </button>
                </>
            )}

            {question.votes && question.votes.length > 0 && (
                <div className="mt-4">
                    <h3 className="font-semibold mb-2">All Responses:</h3>
                    <ul className="space-y-2">
                        {sortedResponses.map((vote) => {
                            // Ownership is matched via the per-response token
                            // (the server no longer sends raw user ids); the
                            // parent precomputes the set of ids we own/upvoted.
                            const isOwnResponse = ownedVoteIds.has(vote.id);
                            const isYou = isOwnResponse;
                            const upvotes = vote.upvotes || 0;
                            const hasUpvoted = upvotedVoteIds.has(vote.id);
                            return (
                                <li key={vote.id} className="bg-gray-50 rounded-md p-3 flex items-start gap-3">
                                    <button
                                        onClick={() => handleResponseVote(vote.id)}
                                        disabled={isOwnResponse || locked}
                                        title={isOwnResponse ? "You can't upvote your own response" : 'Upvote'}
                                        className={`flex flex-col items-center justify-center px-2 py-1 rounded-md border transition duration-200 ${hasUpvoted
                                            ? 'bg-primary text-white border-primary'
                                            : 'bg-white text-gray-600 border-gray-300 hover:border-primary'
                                            } ${(isOwnResponse || locked) ? 'opacity-40 cursor-not-allowed' : ''}`}
                                    >
                                        <span className="leading-none">▲</span>
                                        <span className="text-xs font-semibold">{upvotes}</span>
                                    </button>
                                    <div className="flex-1">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="text-xs font-semibold text-gray-500 mb-1">
                                                {vote.pseudonym || 'Anonymous'}
                                                {isYou && ' (you)'}
                                            </div>
                                            {isAdmin && (
                                                <button
                                                    onClick={() => onModeratorDeleteVote(question.id, vote.id)}
                                                    title="Remove this response (moderator)"
                                                    className="text-xs text-red-500 hover:text-red-700 shrink-0"
                                                >
                                                    Remove
                                                </button>
                                            )}
                                        </div>
                                        <div className="text-gray-800 whitespace-pre-wrap">{vote.value}</div>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </div>
    );
};

OpenEndedQuestion.propTypes = {
    question: PropTypes.shape({
        id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
        votes: PropTypes.arrayOf(PropTypes.shape({
            ownerToken: PropTypes.string,
            value: PropTypes.string.isRequired,
            pseudonym: PropTypes.string,
            upvotes: PropTypes.number,
            upvoterTokens: PropTypes.array
        }))
    }).isRequired,
    userVote: PropTypes.shape({
        ownerToken: PropTypes.string,
        value: PropTypes.string
    }),
    handleVote: PropTypes.func.isRequired,
    ownedVoteIds: PropTypes.instanceOf(Set).isRequired,
    upvotedVoteIds: PropTypes.instanceOf(Set).isRequired,
    handleResponseVote: PropTypes.func.isRequired,
    locked: PropTypes.bool,
    isAdmin: PropTypes.bool,
    onModeratorDeleteVote: PropTypes.func
};

// Stacked divergence bar + summary for an Agreement question. Shows at a glance
// how opinion splits, and labels the statement as consensus or divisive.
const AgreementResults = ({ question }) => {
    const votes = question.votes || [];
    const total = votes.length;

    const counts = AGREEMENT_SCALE.map(seg => ({
        ...seg,
        count: votes.filter(v => v.value === seg.key).length,
    }));

    if (total === 0) {
        return <p className="text-sm text-gray-500 mb-4">No votes yet — be the first to weigh in.</p>;
    }

    const agreeCount = counts.filter(c => c.key === VoteOptions.AGREE || c.key === VoteOptions.STRONGLY_AGREE)
        .reduce((sum, c) => sum + c.count, 0);
    const disagreeCount = counts.filter(c => c.key === VoteOptions.DISAGREE || c.key === VoteOptions.STRONGLY_DISAGREE)
        .reduce((sum, c) => sum + c.count, 0);
    const agreePct = Math.round((agreeCount / total) * 100);
    const disagreePct = Math.round((disagreeCount / total) * 100);

    // Divisive when the room is split roughly evenly between agree and disagree;
    // consensus when one side clearly dominates.
    const decided = agreeCount + disagreeCount;
    let badge = null;
    if (decided >= 2) {
        const split = Math.min(agreeCount, disagreeCount) / decided; // 0..0.5
        if (split >= 0.4) {
            badge = <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-800">Divisive</span>;
        } else if (split <= 0.15) {
            badge = <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">Consensus</span>;
        }
    }

    return (
        <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">
                    {total} {total === 1 ? 'vote' : 'votes'} · {agreePct}% agree · {disagreePct}% disagree
                </span>
                {badge}
            </div>
            <div className="flex w-full h-4 rounded-full overflow-hidden bg-gray-200">
                {counts.map(seg => seg.count > 0 && (
                    <div
                        key={seg.key}
                        className={seg.bar}
                        style={{ width: `${(seg.count / total) * 100}%` }}
                        title={`${seg.label}: ${seg.count}`}
                    />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {counts.map(seg => (
                    <span key={seg.key} className="flex items-center text-xs text-gray-600">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full mr-1 ${seg.dot}`} />
                        {seg.label}: {seg.count}
                    </span>
                ))}
            </div>
        </div>
    );
};

AgreementResults.propTypes = {
    question: PropTypes.shape({
        votes: PropTypes.array,
    }).isRequired,
};

// Stacked divergence bar + summary for a Yes/No question — the binary sibling of
// AgreementResults. Yes is green, No is red, mirroring the agreement scale.
const YesNoResults = ({ question }) => {
    const votes = question.votes || [];
    const total = votes.length;

    if (total === 0) {
        return <p className="text-sm text-gray-500 mb-4">No votes yet — be the first to weigh in.</p>;
    }

    const yesCount = votes.filter(v => v.value === YesNoOptions.YES).length;
    const noCount = votes.filter(v => v.value === YesNoOptions.NO).length;
    const yesPct = Math.round((yesCount / total) * 100);
    const noPct = Math.round((noCount / total) * 100);

    // Divisive when the room is split roughly evenly; consensus when one side
    // clearly dominates. Mirrors the thresholds used for agreement questions.
    let badge = null;
    if (total >= 2) {
        const split = Math.min(yesCount, noCount) / total; // 0..0.5
        if (split >= 0.4) {
            badge = <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-800">Divisive</span>;
        } else if (split <= 0.15) {
            badge = <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">Consensus</span>;
        }
    }

    const segments = [
        { key: YesNoOptions.NO, label: 'No', count: noCount, bar: 'bg-red-500', dot: 'bg-red-500' },
        { key: YesNoOptions.YES, label: 'Yes', count: yesCount, bar: 'bg-green-500', dot: 'bg-green-500' },
    ];

    return (
        <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">
                    {total} {total === 1 ? 'vote' : 'votes'} · {yesPct}% yes · {noPct}% no
                </span>
                {badge}
            </div>
            <div className="flex w-full h-4 rounded-full overflow-hidden bg-gray-200">
                {segments.map(seg => seg.count > 0 && (
                    <div
                        key={seg.key}
                        className={seg.bar}
                        style={{ width: `${(seg.count / total) * 100}%` }}
                        title={`${seg.label}: ${seg.count}`}
                    />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {segments.map(seg => (
                    <span key={seg.key} className="flex items-center text-xs text-gray-600">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full mr-1 ${seg.dot}`} />
                        {seg.label}: {seg.count}
                    </span>
                ))}
            </div>
        </div>
    );
};

YesNoResults.propTypes = {
    question: PropTypes.shape({
        votes: PropTypes.array,
    }).isRequired,
};

// Compact agreement-distribution bar for a single brainstorm idea. Shows how the
// room splits without naming anyone — the whole point of the agreement axis.
const AgreementMiniBar = ({ counts }) => {
    const total = AGREEMENT_SCALE.reduce((sum, seg) => sum + (counts[seg.key] || 0), 0);
    if (total === 0) {
        return <p className="text-xs text-gray-400 mt-1">No agreement votes yet.</p>;
    }
    return (
        <div className="mt-1">
            <div className="flex w-full h-2 rounded-full overflow-hidden bg-gray-200">
                {AGREEMENT_SCALE.map(seg => (counts[seg.key] || 0) > 0 && (
                    <div
                        key={seg.key}
                        className={seg.bar}
                        style={{ width: `${((counts[seg.key] || 0) / total) * 100}%` }}
                        title={`${seg.label}: ${counts[seg.key]}`}
                    />
                ))}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{total} agreement {total === 1 ? 'vote' : 'votes'}</div>
        </div>
    );
};

AgreementMiniBar.propTypes = {
    counts: PropTypes.object,
};

// A single brainstorm idea, with optional two-axis rating (quality up/down +
// agreement scale), epistemic reactions, and a comment thread — each shown only
// when the moderator has enabled/revealed it. Rating and reaction counts are
// aggregates; only this user's own selections (myRating/myReactions) are known
// to the client, so nothing reveals who voted which way.
const BrainstormIdea = ({
    vote, isOwn, isAdmin, ownedCommentIds, reactionsActive, activeReactionKeys, commentsEnabled, locked,
    myRating, myReactions, onDeleteVote, onModeratorDelete, onSetRating, onToggleReaction,
    onAddComment, onDeleteComment, onModeratorDeleteComment,
}) => {
    const [comment, setComment] = useState('');
    const net = (vote.qualityUp || 0) - (vote.qualityDown || 0);
    const comments = vote.comments || [];
    // You can't rate/react to your own idea (the server rejects it too), so
    // disable those controls on own ideas — but commenting on your own idea is
    // fine. Counts/histogram stay visible read-only either way.
    const ratingDisabled = locked || isOwn;

    const submitComment = () => {
        const trimmed = comment.trim();
        if (trimmed === '') return;
        onAddComment(vote.id, trimmed);
        setComment('');
    };

    return (
        <li className="bg-gray-50 rounded-md p-3">
            <div className="flex items-start gap-3">
                {reactionsActive && (
                    <div className="flex flex-col items-center shrink-0 select-none">
                        <button
                            type="button"
                            onClick={() => onSetRating(vote.id, 'quality', 1)}
                            disabled={ratingDisabled}
                            title="Worth considering"
                            className={`leading-none text-lg ${myRating.quality === 1 ? 'text-primary' : 'text-gray-400 hover:text-gray-600'} ${ratingDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >▲</button>
                        <span className="text-xs font-semibold text-gray-700">{net > 0 ? `+${net}` : net}</span>
                        <button
                            type="button"
                            onClick={() => onSetRating(vote.id, 'quality', -1)}
                            disabled={ratingDisabled}
                            title="Not worth considering"
                            className={`leading-none text-lg ${myRating.quality === -1 ? 'text-red-500' : 'text-gray-400 hover:text-gray-600'} ${ratingDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >▼</button>
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                        <span className="text-gray-800 whitespace-pre-wrap">
                            {vote.value}
                            {isOwn && <span className="text-xs text-gray-500"> (You)</span>}
                        </span>
                        {(isOwn || isAdmin) && (
                            <button
                                onClick={isOwn ? onDeleteVote : onModeratorDelete}
                                title={isOwn ? undefined : 'Remove this idea (moderator)'}
                                className="ml-2 text-sm text-red-500 hover:text-red-700 shrink-0"
                            >
                                {isOwn ? 'Delete' : 'Remove'}
                            </button>
                        )}
                    </div>

                    {reactionsActive && (
                        <div className="mt-2">
                            <div className="flex flex-wrap gap-1">
                                {AGREEMENT_SCALE.map(seg => (
                                    <button
                                        key={seg.key}
                                        type="button"
                                        onClick={() => onSetRating(vote.id, 'agreement', seg.key)}
                                        disabled={ratingDisabled}
                                        title={seg.label}
                                        className={`px-2 py-0.5 text-xs rounded border ${myRating.agreement === seg.key
                                            ? 'bg-primary text-white border-primary'
                                            : 'bg-white text-gray-600 border-gray-300 hover:border-primary'} ${ratingDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    >
                                        {AGREEMENT_SHORT[seg.key]}
                                    </button>
                                ))}
                            </div>
                            <AgreementMiniBar counts={vote.agreementCounts || {}} />
                        </div>
                    )}

                    {reactionsActive && (
                        <div className="flex flex-wrap gap-1 mt-2">
                            {EPISTEMIC_REACTIONS.filter(r => activeReactionKeys.includes(r.key)).map(r => {
                                const count = (vote.reactionCounts || {})[r.key] || 0;
                                const active = myReactions.includes(r.key);
                                return (
                                    <button
                                        key={r.key}
                                        type="button"
                                        onClick={() => onToggleReaction(vote.id, r.key)}
                                        disabled={ratingDisabled}
                                        title={r.label}
                                        className={`px-2 py-0.5 text-xs rounded-full border ${active
                                            ? 'bg-indigo-100 border-indigo-400 text-indigo-800'
                                            : 'bg-white border-gray-300 text-gray-600 hover:border-indigo-300'} ${ratingDisabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    >
                                        <span className="mr-1">{r.emoji}</span>{r.label}
                                        {count > 0 && <span className="ml-1 font-semibold">{count}</span>}
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {commentsEnabled && (
                        <div className="mt-3 border-t border-gray-200 pt-2">
                            {comments.length > 0 && (
                                <ul className="space-y-1 mb-2">
                                    {comments.map(c => (
                                        <li key={c.id} className="text-sm flex items-start justify-between gap-2">
                                            <span>
                                                <span className="font-semibold text-gray-600">{c.pseudonym || 'Anonymous'}:</span>{' '}
                                                <span className="text-gray-800 whitespace-pre-wrap">{c.body}</span>
                                            </span>
                                            {(ownedCommentIds.has(c.id) || isAdmin) && (
                                                <button
                                                    onClick={() => (ownedCommentIds.has(c.id) ? onDeleteComment(c.id) : onModeratorDeleteComment(c.id))}
                                                    title={ownedCommentIds.has(c.id) ? undefined : 'Remove this comment (moderator)'}
                                                    className="text-xs text-red-500 hover:text-red-700 shrink-0"
                                                >
                                                    {ownedCommentIds.has(c.id) ? 'Delete' : 'Remove'}
                                                </button>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {!locked && (
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={comment}
                                        onChange={(e) => setComment(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') submitComment(); }}
                                        placeholder="Add a comment"
                                        className="flex-1 min-w-0 p-1.5 border rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                    />
                                    <button
                                        onClick={submitComment}
                                        disabled={comment.trim() === ''}
                                        className="shrink-0 px-3 py-1 text-sm bg-primary text-white rounded hover:bg-opacity-90 disabled:opacity-50"
                                    >
                                        Post
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </li>
    );
};

BrainstormIdea.propTypes = {
    vote: PropTypes.shape({
        id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
        value: PropTypes.string.isRequired,
        ownerToken: PropTypes.string,
        qualityUp: PropTypes.number,
        qualityDown: PropTypes.number,
        agreementCounts: PropTypes.object,
        reactionCounts: PropTypes.object,
        comments: PropTypes.array,
    }).isRequired,
    isOwn: PropTypes.bool,
    isAdmin: PropTypes.bool,
    ownedCommentIds: PropTypes.instanceOf(Set).isRequired,
    reactionsActive: PropTypes.bool,
    commentsEnabled: PropTypes.bool,
    activeReactionKeys: PropTypes.array.isRequired,
    locked: PropTypes.bool,
    myRating: PropTypes.object,
    myReactions: PropTypes.array,
    onDeleteVote: PropTypes.func.isRequired,
    onModeratorDelete: PropTypes.func,
    onSetRating: PropTypes.func.isRequired,
    onToggleReaction: PropTypes.func.isRequired,
    onAddComment: PropTypes.func.isRequired,
    onDeleteComment: PropTypes.func.isRequired,
    onModeratorDeleteComment: PropTypes.func,
};

// participant add any number of separate ideas and delete their own. The
// moderator can layer reactions (two-axis ratings + epistemic reactions) and
// comments on top, revealing them when the room shifts from generating ideas to
// evaluating them.
const BrainstormQuestion = ({
    question, ownedVoteIds, ownedCommentIds, handleVote, handleDeleteVote, locked, isAdmin, myBrainstorm,
    activeReactionKeys, onSetRating, onToggleReaction, onAddComment, onDeleteComment,
    onModeratorDeleteVote, onModeratorDeleteComment,
}) => {
    const [idea, setIdea] = useState('');
    const votes = question.votes || [];
    // Whether reactions/comments are available is set discussion-wide by the
    // moderator (see the moderator bar in DiscussionPage); each question carries
    // the resolved flags via getQuestions.
    const reactionsEnabled = question.reactionsEnabled;
    const reactionsVisible = question.reactionsVisible;
    const commentsEnabled = question.commentsEnabled;
    const reactionsActive = reactionsEnabled && reactionsVisible;

    const submitIdea = () => {
        if (idea.trim() === '') {
            return;
        }
        console.log('Submitting brainstorm idea:', idea);
        handleVote(question.id, idea.trim());
        setIdea('');
    };

    return (
        <div>
            {!locked && (
                <>
                    <textarea
                        value={idea}
                        onChange={(e) => setIdea(e.target.value)}
                        className="w-full p-2 border rounded mb-2"
                        rows="3"
                        placeholder="Add an idea (you can add as many as you like)"
                    />
                    <button
                        onClick={submitIdea}
                        disabled={idea.trim() === ''}
                        className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90 transition duration-300 mb-4 disabled:opacity-50"
                    >
                        Add Idea
                    </button>
                </>
            )}

            {reactionsEnabled && !reactionsVisible && (
                <p className="text-sm text-gray-500 mb-2">
                    Reactions are hidden for now — the moderator will open them up for the discussion.
                </p>
            )}

            {votes.length > 0 && (
                <div className="mt-4">
                    <h3 className="font-semibold mb-2">All Ideas ({votes.length}):</h3>
                    <ul className="space-y-2">
                        {votes.map((vote) => (
                            <BrainstormIdea
                                key={vote.id}
                                vote={vote}
                                // Ownership is matched via the per-response token
                                // (the server no longer sends raw user ids); the
                                // parent precomputes the sets of ids we own.
                                isOwn={ownedVoteIds.has(vote.id)}
                                isAdmin={isAdmin}
                                ownedCommentIds={ownedCommentIds}
                                reactionsActive={reactionsActive}
                                activeReactionKeys={activeReactionKeys}
                                commentsEnabled={commentsEnabled}
                                locked={locked}
                                myRating={myBrainstorm.ratings[vote.id] || {}}
                                myReactions={myBrainstorm.reactions[vote.id] || []}
                                onDeleteVote={() => handleDeleteVote(question.id, vote.id)}
                                onModeratorDelete={() => onModeratorDeleteVote(question.id, vote.id)}
                                onSetRating={onSetRating}
                                onToggleReaction={onToggleReaction}
                                onAddComment={onAddComment}
                                onDeleteComment={onDeleteComment}
                                onModeratorDeleteComment={onModeratorDeleteComment}
                            />
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};

// Summary stats + histogram for a Numerical question.
const NumericalResults = ({ question, minValue, maxValue }) => {
    const values = (question.votes || [])
        .map(v => parseInt(v.value))
        .filter(n => !Number.isNaN(n));
    const total = values.length;

    if (total === 0) {
        return <p className="text-sm text-gray-500 mb-2">No responses yet — drag the slider to add yours.</p>;
    }

    const average = values.reduce((sum, n) => sum + n, 0) / total;
    const range = Math.max(maxValue - minValue, 1);

    // Bucket values into up to 10 bins across the [min, max] range.
    const binCount = Math.min(10, range + 1);
    const bins = new Array(binCount).fill(0);
    values.forEach(n => {
        const clamped = Math.min(Math.max(n, minValue), maxValue);
        let idx = Math.floor(((clamped - minValue) / range) * binCount);
        if (idx >= binCount) idx = binCount - 1; // include the max edge
        bins[idx] += 1;
    });
    const tallestBin = Math.max(...bins);

    // Up to three integer y-axis ticks (top, middle, baseline) positioned
    // proportionally so they line up with the bar heights.
    const yTicks = tallestBin <= 1
        ? [1, 0]
        : [...new Set([tallestBin, Math.round(tallestBin / 2), 0])].sort((a, b) => b - a);

    return (
        <div className="mb-2">
            <div className="text-sm text-gray-600 mb-2">
                {total} {total === 1 ? 'response' : 'responses'} · average <span className="font-semibold">{average.toFixed(1)}</span>
            </div>
            <div className="flex gap-1">
                {/* Y-axis count labels. Each is anchored by its bottom edge at the
                    tick's proportional height, then nudged vertically so it stays
                    inside the box: the top tick hangs down from the top line, the
                    baseline tick sits on the bottom, and middle ticks are centered. */}
                <div className="relative w-6 h-16 text-[10px] leading-none text-gray-400">
                    {yTicks.map((t, idx) => {
                        const nudge = idx === 0 ? 'translate-y-full' : t === 0 ? '' : 'translate-y-1/2';
                        return (
                            <span
                                key={t}
                                className={`absolute right-0 ${nudge}`}
                                style={{ bottom: `${(t / tallestBin) * 100}%` }}
                            >
                                {t}
                            </span>
                        );
                    })}
                </div>
                <div className="flex items-end gap-1 h-16 flex-1">
                    {bins.map((count, i) => (
                        <div
                            key={i}
                            className="flex-1 bg-primary rounded-t"
                            style={{ height: tallestBin > 0 ? `${(count / tallestBin) * 100}%` : '0%' }}
                            title={`${count} ${count === 1 ? 'response' : 'responses'}`}
                        />
                    ))}
                </div>
            </div>
            {/* X-axis min/max labels, offset to align with the bars */}
            <div className="ml-7 flex justify-between text-[10px] text-gray-400 mt-1">
                <span>{minValue}</span>
                <span>{maxValue}</span>
            </div>
        </div>
    );
};

NumericalResults.propTypes = {
    question: PropTypes.shape({
        votes: PropTypes.array,
    }).isRequired,
    minValue: PropTypes.number.isRequired,
    maxValue: PropTypes.number.isRequired,
};

BrainstormQuestion.propTypes = {
    question: PropTypes.shape({
        id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
        reactionsEnabled: PropTypes.bool,
        reactionsVisible: PropTypes.bool,
        commentsEnabled: PropTypes.bool,
        votes: PropTypes.arrayOf(PropTypes.shape({
            id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
            ownerToken: PropTypes.string,
            value: PropTypes.string.isRequired
        }))
    }).isRequired,
    ownedVoteIds: PropTypes.instanceOf(Set).isRequired,
    ownedCommentIds: PropTypes.instanceOf(Set).isRequired,
    handleVote: PropTypes.func.isRequired,
    handleDeleteVote: PropTypes.func.isRequired,
    locked: PropTypes.bool,
    isAdmin: PropTypes.bool,
    myBrainstorm: PropTypes.shape({
        ratings: PropTypes.object,
        reactions: PropTypes.object,
    }).isRequired,
    activeReactionKeys: PropTypes.array.isRequired,
    onSetRating: PropTypes.func.isRequired,
    onToggleReaction: PropTypes.func.isRequired,
    onAddComment: PropTypes.func.isRequired,
    onDeleteComment: PropTypes.func.isRequired,
    onModeratorDeleteVote: PropTypes.func,
    onModeratorDeleteComment: PropTypes.func,
};

export default DiscussionPage;
