import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { getEffectiveNameMode, NameModes, MAX_CUSTOM_NAME_LENGTH } from './identity';
import { useDiscussionSocket, useDiscussionRoom } from './hooks/useDiscussionRoom';
import { useParticipantIdentity } from './hooks/useParticipantIdentity';
import { useModeratorAccess } from './hooks/useModeratorAccess';
import { slugifyTopic } from './slugs';
import OpinionSnapshots from './OpinionSnapshots';
import OpenEndedQuestion from './questions/OpenEndedQuestion';
import QuestionEditor from './questions/QuestionEditor';
import { AgreementResults, YesNoResults } from './questions/OpinionResults';
import BrainstormQuestion from './questions/BrainstormQuestion';
import NumericalResults from './questions/NumericalResults';
import { clampNumericalValue, sortQuestionsMostRecent } from './questions/questionHelpers.mjs';
import {
    QuestionTypes, QuestionTypeDescriptions, VoteOptions, YesNoOptions,
    EPISTEMIC_REACTIONS, ALL_REACTION_KEYS,
} from './questions/config';

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

const SortOptions = {
    MOST_RECENT: 'Most Recent',
    MOST_AGREEMENT: 'Most Agreement',
    MOST_DISAGREEMENT: 'Most Disagreement',
    MOST_CONTROVERSIAL: 'Most Controversial',
};

const DiscussionPage = () => {
    const { topic } = useParams();
    const navigate = useNavigate();
    const discussionSlug = slugifyTopic(topic);
    const socket = useDiscussionSocket();
    const [discussion, setDiscussion] = useState(null);
    const [questions, setQuestions] = useState([]);
    const [newQuestion, setNewQuestion] = useState('');
    const [questionType, setQuestionType] = useState(QuestionTypes.AGREEMENT);
    const [minValue, setMinValue] = useState(0);
    const [maxValue, setMaxValue] = useState(100);
    const [sliderValues, setSliderValues] = useState({});
    const [sortOption, setSortOption] = useState(SortOptions.MOST_RECENT);
    const [showUnansweredOnly, setShowUnansweredOnly] = useState(false);
    const [editingIdentity, setEditingIdentity] = useState(false);
    const [error, setError] = useState(null);
    const [newTopicName, setNewTopicName] = useState('');
    // Inline moderator rename of the discussion title. titleDraft holds the
    // in-progress edit; editingTitle swaps the <h1> for the editor.
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    const [showDuplicateModal, setShowDuplicateModal] = useState(false);
    const [showShareModal, setShowShareModal] = useState(false);
    const [showActionsMenu, setShowActionsMenu] = useState(false);
    const [showSnapshots, setShowSnapshots] = useState(false);
    const [presence, setPresence] = useState(0);
    const [copied, setCopied] = useState(false);
    const [shortShareUrl, setShortShareUrl] = useState('');
    const [shortCodeDraft, setShortCodeDraft] = useState('');
    const [shortLinkError, setShortLinkError] = useState('');
    const [shortLinkLoading, setShortLinkLoading] = useState(false);
    const [shortLinkCopied, setShortLinkCopied] = useState(false);
    const [discussionState, setDiscussionState] = useState({
        locked: false, moderatorOnly: false, hasModerator: false, theme: DEFAULT_THEME,
        reactionsEnabled: false, reactionsVisible: true, commentsEnabled: false,
        reactionKeys: ALL_REACTION_KEYS,
    });
    const [similarPrompt, setSimilarPrompt] = useState(null);
    const questionPendingRef = useRef(false);
    const [adminLinkCopied, setAdminLinkCopied] = useState(false);
    // Id of the question a moderator is currently editing inline (null when none).
    const [editingQuestionId, setEditingQuestionId] = useState(null);
    // Experimental "opinion groups" view, hidden behind a ?clusters=1 flag so it
    // can be evaluated on a real discussion without exposing it to everyone. Once
    // enabled it's remembered per browser so the link survives navigation.
    const [showClusters, setShowClusters] = useState(false);
    const [participants, setParticipants] = useState([]);
    const [showParticipants, setShowParticipants] = useState(false);
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

    const closeParticipants = useCallback(() => setShowParticipants(false), []);
    const {
        identity, userId, displayName, effectivePseudonym, pseudonymReserved,
        shufflePending, selfHandle, ownedVoteIds, upvotedVoteIds, ownedCommentIds,
        isMyVote, handlePseudonymSync, handleRegeneratePseudonym,
        handleSelectNameMode, handleCustomNameChange,
    } = useParticipantIdentity(socket, { topic, discussionSlug, discussionId: discussion?.id, questions });
    const {
        adminToken, setAdminToken, canDemote, setCanDemote,
        handleModeratorGranted, handleModeratorRevoked,
    } = useModeratorAccess(socket, {
        topic, discussionSlug,
        discussionTitle: discussion?.slug === discussionSlug ? discussion.topic : null,
        onRevoked: closeParticipants,
    });

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
    const shortUrlPrefix = typeof window !== 'undefined' ? `${window.location.origin}/s/` : '/s/';

    useEffect(() => {
        setShortShareUrl(
            typeof window !== 'undefined' && discussion?.short_code
                ? `${window.location.origin}/s/${discussion.short_code}`
                : ''
        );
        setShortCodeDraft(discussion?.short_code || '');
        setShortLinkError('');
        setShortLinkCopied(false);
    }, [discussionSlug, discussion?.short_code]);

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

    const saveShortLink = async (requestedCode) => {
        if (!adminToken || shortLinkLoading) return;
        setShortLinkLoading(true);
        setShortLinkError('');
        try {
            const response = await fetch(`/api/discussions/${encodeURIComponent(discussionSlug)}/short-link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminToken, ...(requestedCode ? { shortCode: requestedCode } : {}) }),
            });
            if (!response.ok) {
                if (response.status === 409) {
                    setShortLinkError('That short link is already taken.');
                    return;
                }
                if (response.status === 400) {
                    setShortLinkError('Use 2-40 letters, numbers, or hyphens.');
                    return;
                }
                throw new Error('Failed to save short link');
            }
            const data = await response.json();
            const nextShortUrl = `${window.location.origin}${data.shortPath}`;
            setShortShareUrl(nextShortUrl);
            setShortCodeDraft(data.shortCode);
            try {
                await navigator.clipboard.writeText(nextShortUrl);
                setShortLinkCopied(true);
                setTimeout(() => setShortLinkCopied(false), 2000);
            } catch (copyErr) {
                console.error('Failed to copy generated short link:', copyErr);
                setError('Short link generated, but could not copy it automatically.');
            }
        } catch (err) {
            console.error('Failed to save short link:', err);
            setError('Could not save the short link.');
        } finally {
            setShortLinkLoading(false);
        }
    };

    const handleGenerateShortLink = async () => {
        await saveShortLink();
    };

    const handleSaveCustomShortLink = async () => {
        await saveShortLink(shortCodeDraft);
    };

    const handleCopyShortLink = async () => {
        if (!shortShareUrl) return;
        try {
            await navigator.clipboard.writeText(shortShareUrl);
            setShortLinkCopied(true);
            setTimeout(() => setShortLinkCopied(false), 2000);
        } catch (err) {
            console.error('Failed to copy short link:', err);
            setError('Could not copy the short link. You can select and copy it manually.');
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

    // Open the inline title editor, seeding it with the loaded discussion's
    // actual title. Guard until the discussion has loaded so we never seed the
    // editor from the route slug (or a previous room) and then save THAT as the
    // new title; the Rename button is also disabled until then.
    const handleStartRename = () => {
        if (!discussion?.topic) return;
        setTitleDraft(discussion.topic);
        setEditingTitle(true);
    };

    // Persist a renamed discussion. Only the display title changes server-side;
    // the slug (and thus this page's URL and everyone's room) stays put, so the
    // ack is the only thing we wait on before closing the editor. The new title
    // arrives for everyone — us included — over the broadcast 'discussion' event.
    const handleRenameDiscussion = () => {
        const trimmed = titleDraft.trim();
        if (!trimmed) {
            setError('Discussion name cannot be empty.');
            return;
        }
        socket.emit('setTopic', discussionSlug, trimmed, adminToken, (resp) => {
            if (resp && resp.updated) {
                setEditingTitle(false);
            } else if (resp && resp.reason === 'not_authorized') {
                setError('You are no longer a moderator of this discussion.');
            } else if (resp && resp.reason === 'duplicate') {
                // Keep the editor open so the moderator can correct the name.
                setError('A discussion with that name already exists. Choose a different name.');
            } else {
                setError('Could not rename the discussion. Try again.');
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
            });
            return Array.from(nextMap.values());
        });
    }, []);

    useDiscussionRoom(socket, {
        topic, discussionSlug, userId,
        onDiscussion: setDiscussion, onQuestions: handleQuestionsUpdate,
        onPresence: setPresence, onState: setDiscussionState,
        onSimilarQuestion: setSimilarPrompt, onBrainstormState: setMyBrainstorm,
        onModeratorGranted: handleModeratorGranted, onModeratorRevoked: handleModeratorRevoked,
        onPseudonymSync: handlePseudonymSync,
    });

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

    // The rename editor is scoped to one discussion. This component is reused
    // across /discussion/:topic routes (only the param changes), so close any
    // open editor and clear its draft when the slug changes — otherwise a draft
    // seeded in one room could be saved into another the next time it's opened.
    useEffect(() => {
        setEditingTitle(false);
        setTitleDraft('');
    }, [discussionSlug]);

    const handleAddQuestion = (event) => {
        // Submitted from the form (Enter or the Add Question button); stop the
        // browser's native submit from reloading the page.
        event?.preventDefault();
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
        }

        submitQuestion(question, false);
    };

    // Emits a question to the server. When force is false the server may reply
    // with a 'similarQuestion' event instead of adding it; when true it adds
    // regardless of near-duplicates. The form is reset only once the server acks
    // that the question was actually added, so a near-duplicate bounce (or an
    // error) leaves the user's draft intact for them to edit or re-post.
    const submitQuestion = (question, force) => {
        if (questionPendingRef.current) return;
        questionPendingRef.current = true;
        try {
            setError(null);
            socket.timeout(10000).emit('addQuestion', discussionSlug, question, force, adminToken, (err, resp) => {
                questionPendingRef.current = false;
                if (err) {
                    setError('Could not confirm the question was added. Check the discussion before trying again.');
                    return;
                }
                if (resp && resp.added) {
                    setNewQuestion(current => current.trim() === question.text ? '' : current);
                    setQuestionType(QuestionTypes.AGREEMENT);
                    setMinValue(0);
                    setMaxValue(100);
                } else if (resp && resp.reason === 'moderator_only') {
                    setError('Only the moderator can add questions right now.');
                }
            });
        } catch (error) {
            questionPendingRef.current = false;
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
                return sortQuestionsMostRecent(questions);
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
            console.error('Invalid question object');
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
                const minValue = parseInt(question.minValue || question.min_value) || 0;
                const maxValue = parseInt(question.maxValue || question.max_value) || 100;

                // sliderValues[id] is undefined until the participant touches the
                // slider or the number box ('' while the box is cleared). Until
                // then we show their saved answer if they have one, and otherwise
                // nothing at all: no midpoint default to anchor on or to submit
                // by accident.
                const draftValue = sliderValues[question.id];
                const inputValue = draftValue !== undefined
                    ? draftValue
                    : (userVote ? parseInt(userVote.value) : '');
                // What Submit would send: the draft clamped into range, or null
                // when nothing is selected.
                const sliderValue = clampNumericalValue(inputValue, minValue, maxValue);
                const isUnset = sliderValue === null;
                const canSubmit = draftValue !== undefined && !isUnset
                    && (!userVote || sliderValue !== Number(userVote.value));

                return (
                    <div className="mt-4">
                        <NumericalResults question={question} minValue={minValue} maxValue={maxValue} />
                        {!locked && (
                            <>
                                <div className="flex items-center gap-3">
                                    <input
                                        type="range"
                                        min={minValue}
                                        max={maxValue}
                                        value={isUnset ? minValue : sliderValue}
                                        aria-label={`Your answer to: ${question.text}`}
                                        aria-valuetext={isUnset ? 'No value selected' : String(sliderValue)}
                                        className={`flex-grow min-w-0 ${isUnset ? 'slider-unset' : ''}`}
                                        onChange={(e) => handleSliderChange(question.id, parseInt(e.target.value))}
                                        // A click that lands exactly on the resting
                                        // position fires no change event, so pick the
                                        // value up here too.
                                        onClick={(e) => { if (isUnset) handleSliderChange(question.id, parseInt(e.target.value)); }}
                                    />
                                    <input
                                        type="number"
                                        min={minValue}
                                        max={maxValue}
                                        step={1}
                                        inputMode="numeric"
                                        value={inputValue}
                                        placeholder="–"
                                        aria-label={`Type your answer to: ${question.text}`}
                                        className="w-24 p-2 border border-gray-300 rounded-md text-center focus:outline-none focus:ring-2 focus:ring-primary"
                                        // Keep what is typed as-is so multi-digit
                                        // entry isn't clamped mid-keystroke; the
                                        // slider and Submit use the clamped value,
                                        // and blur snaps the box to it.
                                        onChange={(e) => handleSliderChange(question.id, e.target.value)}
                                        onBlur={() => { if (draftValue !== undefined && !isUnset && draftValue !== sliderValue) handleSliderChange(question.id, sliderValue); }}
                                    />
                                </div>
                                <div className="flex justify-between mt-2">
                                    <span>{minValue}</span>
                                    <span className={isUnset ? 'text-sm text-gray-500' : ''}>
                                        {isUnset ? 'Move the slider or type a number' : sliderValue}
                                    </span>
                                    <span>{maxValue}</span>
                                </div>
                                <button
                                    onClick={() => handleVote(question.id, sliderValue)}
                                    disabled={!canSubmit}
                                    className={`mt-4 px-4 py-2 rounded-md transition duration-300 disabled:opacity-50 disabled:cursor-not-allowed ${userVote ? 'bg-primary text-white hover:bg-opacity-90' : 'bg-secondary text-white hover:bg-opacity-90'}`}
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
            {isAdmin && editingTitle ? (
                <div className="mb-2 flex flex-col items-center gap-2">
                    <input
                        type="text"
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRenameDiscussion();
                            if (e.key === 'Escape') setEditingTitle(false);
                        }}
                        autoFocus
                        maxLength={200}
                        placeholder="Discussion name"
                        aria-label="Discussion name"
                        className="w-full max-w-xl p-2 border rounded text-3xl font-bold text-center text-gray-800"
                    />
                    <div className="flex gap-2">
                        <button
                            onClick={handleRenameDiscussion}
                            className="px-3 py-1 rounded bg-primary text-white hover:bg-opacity-90"
                        >
                            Save
                        </button>
                        <button
                            onClick={() => setEditingTitle(false)}
                            className="px-3 py-1 rounded bg-gray-300 hover:bg-gray-400"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            ) : (
                <h1 className="text-4xl font-bold mb-2 text-center text-gray-800">Discussion: {discussionTitle}</h1>
            )}

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
                <button
                    type="button"
                    onClick={() => setShowSnapshots(open => !open)}
                    aria-expanded={showSnapshots}
                    aria-controls="opinion-snapshots"
                    className="border border-gray-300 text-gray-700 py-2 px-4 rounded hover:bg-gray-100 transition duration-300"
                >
                    Opinion Snapshots
                </button>
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

            {showSnapshots && <OpinionSnapshots key={discussionSlug} discussionSlug={discussionSlug} adminToken={adminToken} />}

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
                        {isAdmin && (
                            <div className="mb-4 max-w-2xl mx-auto rounded-md border border-indigo-100 bg-indigo-50 p-3 text-left">
                                <div className="mb-2 flex items-center justify-between gap-3">
                                    <p className="text-sm font-semibold text-indigo-800">Short link</p>
                                    <button
                                        type="button"
                                        onClick={handleGenerateShortLink}
                                        disabled={shortLinkLoading}
                                        className="shrink-0 px-3 py-1.5 rounded bg-white border border-indigo-300 text-indigo-700 text-sm hover:bg-indigo-100 disabled:opacity-60"
                                    >
                                        {shortLinkLoading ? 'Saving…' : 'Generate'}
                                    </button>
                                </div>
                                <div className="space-y-2">
                                    <div className="flex items-center gap-0">
                                        <span
                                            className="max-w-[55%] shrink-0 truncate rounded-l border border-r-0 border-gray-300 bg-white px-2 py-2 text-sm text-gray-500"
                                            title={shortUrlPrefix}
                                        >
                                            {shortUrlPrefix}
                                        </span>
                                        <input
                                            type="text"
                                            value={shortCodeDraft}
                                            onChange={(e) => {
                                                const next = e.target.value
                                                    .toLowerCase()
                                                    .replace(/^https?:\/\/[^/]+\/?/i, '')
                                                    .replace(/^s\//i, '')
                                                    .replace(/^\/+/, '');
                                                setShortCodeDraft(next);
                                                setShortLinkError('');
                                            }}
                                            placeholder="ai"
                                            onFocus={(e) => e.target.select()}
                                            className="flex-1 min-w-0 p-2 border text-sm bg-white"
                                        />
                                        <button
                                            type="button"
                                            onClick={handleSaveCustomShortLink}
                                            disabled={shortLinkLoading || !shortCodeDraft.trim()}
                                            className="shrink-0 px-3 py-2 bg-indigo-600 text-white rounded-r hover:bg-indigo-700 whitespace-nowrap text-sm disabled:opacity-60"
                                        >
                                            Save
                                        </button>
                                    </div>
                                    {shortLinkError && (
                                        <p className="text-sm text-red-600">{shortLinkError}</p>
                                    )}
                                    {shortShareUrl ? (
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="text"
                                                readOnly
                                                value={shortShareUrl}
                                                onFocus={(e) => e.target.select()}
                                                className="flex-1 min-w-0 p-2 border rounded text-sm bg-white"
                                            />
                                            <button
                                                type="button"
                                                onClick={handleCopyShortLink}
                                                className="shrink-0 px-3 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 whitespace-nowrap text-sm"
                                            >
                                                {shortLinkCopied ? 'Copied!' : 'Copy'}
                                            </button>
                                        </div>
                                    ) : (
                                        <p className="text-sm text-indigo-700">Create a shorter join URL for messages, slides, and room displays.</p>
                                    )}
                                </div>
                            </div>
                        )}
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
                            onClick={handleStartRename}
                            disabled={editingTitle || !discussion?.topic}
                            className="px-3 py-1 rounded bg-white border border-indigo-300 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                            title="Change the discussion's name"
                        >
                            Rename discussion
                        </button>
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
            <form onSubmit={handleAddQuestion} className="bg-white shadow-lg rounded-lg p-6 mb-8">
                <input
                    type="text"
                    value={newQuestion}
                    onChange={(e) => setNewQuestion(e.target.value)}
                    // Holding Enter auto-repeats; submit once per key press.
                    onKeyDown={(e) => { if (e.key === 'Enter' && e.repeat) e.preventDefault(); }}
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
                    type="submit"
                    className="w-full bg-primary text-white py-3 rounded-md hover:bg-opacity-90 transition duration-300"
                >
                    Add Question
                </button>
            </form>
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

export default DiscussionPage;
