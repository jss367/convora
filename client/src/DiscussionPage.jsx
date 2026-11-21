import { formatPrompt } from './questions/formatPrompt';
import { plainPrompt } from './questions/promptEmphasis.mjs';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { getEffectiveNameMode, NameModes, MAX_CUSTOM_NAME_LENGTH } from './identity';
import { useDiscussionSocket, useDiscussionRoom, useConnectionLost, usePendingVotes } from './hooks/useDiscussionRoom';
import { useParticipantIdentity } from './hooks/useParticipantIdentity';
import { useQuestionInterest } from './hooks/useQuestionInterest';
import { useModeratorAccess } from './hooks/useModeratorAccess';
import { useModalDialog } from './hooks/useModalDialog';
import { slugifyTopic } from './slugs';
import { forgetDiscussion } from './knownDiscussions';
import OpinionSnapshots from './OpinionSnapshots';
import ModeratorLinkPanel, { moderatorLinkPromptState, useModeratorLinkPrompt } from './ModeratorLinkPanel';
import ModeratorPanel from './ModeratorPanel';
import { downloadForViewer } from './viewer';
import QuestionEditor from './questions/QuestionEditor';
import QuestionTools from './questions/QuestionTools';
import { AgreementResults, YesNoResults, MultipleChoiceResults } from './questions/OpinionResults';
import OpenEndedQuestion from './questions/OpenEndedQuestion';
import NumericalResults from './questions/NumericalResults';
import SpeakingQueue, { useSpeakingQueue } from './questions/SpeakingQueue';
import { clampNumericalValue, getNumericalRange, sortQuestionsMostRecent, sortQuestionsMostInteresting } from './questions/questionHelpers.mjs';
import QuestionComposer, { useQuestionComposer } from './questions/QuestionComposer.jsx';
import {
    QuestionTypes, VoteOptions, YesNoOptions,
    ALL_REACTION_KEYS,
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

const SortOptions = {
    MODERATOR: 'Moderator order',
    MOST_RECENT: 'Most Recent',
    MOST_INTERESTING: 'Most Interesting',
    MOST_AGREEMENT: 'Most Agreement',
    MOST_DISAGREEMENT: 'Most Disagreement',
    MOST_CONTROVERSIAL: 'Most Controversial',
};

const DiscussionPage = () => {
    const { topic } = useParams();
    const navigate = useNavigate();
    const discussionSlug = slugifyTopic(topic);
    const socket = useDiscussionSocket();
    const connectionLost = useConnectionLost(socket);
    const [pendingVotes, sendVote] = usePendingVotes(socket);
    const [discussion, setDiscussion] = useState(null);
    const [questions, setQuestions] = useState([]);
    const [sliderValues, setSliderValues] = useState({});
    const [sortOption, setSortOption] = useState(SortOptions.MODERATOR);
    const [showUnansweredOnly, setShowUnansweredOnly] = useState(false);
    const [editingIdentity, setEditingIdentity] = useState(false);
    const [error, setError] = useState(null);
    const [spotlightError, setSpotlightError] = useState(null);
    const [newTopicName, setNewTopicName] = useState('');
    // Inline moderator rename of the discussion title. titleDraft holds the
    // in-progress edit; editingTitle swaps the <h1> for the editor.
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    // The rename button is replaced by the editor while renaming, so hand
    // focus back to it when the editor closes.
    const renameButtonRef = useRef(null);
    const wasEditingTitle = useRef(false);
    useEffect(() => {
        if (wasEditingTitle.current && !editingTitle) renameButtonRef.current?.focus();
        wasEditingTitle.current = editingTitle;
    }, [editingTitle]);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');
    const [clearTarget, setClearTarget] = useState(null);
    const [clearing, setClearing] = useState(false);
    const [clearError, setClearError] = useState('');
    const [clearedRoom, setClearedRoom] = useState(null);
    const [showDuplicateModal, setShowDuplicateModal] = useState(false);
    const [showShareModal, setShowShareModal] = useState(false);
    const [showActionsMenu, setShowActionsMenu] = useState(false);
    const [showSnapshots, setShowSnapshots] = useState(false);
    // Bumped when the server reports a new opinion snapshot, so an open
    // snapshot panel loads it without anyone choosing Refresh.
    const [snapshotRefreshSignal, setSnapshotRefreshSignal] = useState(0);
    useEffect(() => {
        const refreshSnapshots = () => setSnapshotRefreshSignal(value => value + 1);
        socket.on('snapshotsChanged', refreshSnapshots);
        return () => socket.off('snapshotsChanged', refreshSnapshots);
    }, [socket]);
    const [presence, setPresence] = useState(0);
    const [copied, setCopied] = useState(false);
    const [shortShareUrl, setShortShareUrl] = useState('');
    const [shortCodeDraft, setShortCodeDraft] = useState('');
    const [shortLinkError, setShortLinkError] = useState('');
    const [shortLinkLoading, setShortLinkLoading] = useState(false);
    const [shortLinkCopied, setShortLinkCopied] = useState(false);
    const [discussionState, setDiscussionState] = useState({
        locked: false, moderatorOnly: false, hasModerator: false, theme: DEFAULT_THEME,
        reactionsEnabled: false, reactionsVisible: true, commentsEnabled: false, questionDownvotesEnabled: false,
        reactionKeys: ALL_REACTION_KEYS,
    });
    // Modal panels: Escape closes, focus is kept inside while open and handed
    // back on close. Duplicate is opened from the More menu, whose item is gone
    // by then, so its focus returns to the More button.
    const shareButtonRef = useRef(null);
    const actionsMenuButtonRef = useRef(null);
    const discussionContentRef = useRef(null);
    const duplicateReturnFocusRef = useRef(null);
    const shareDialogRef = useModalDialog(showShareModal, () => setShowShareModal(false), shareButtonRef);
    const deleteDialogRef = useModalDialog(showDeleteModal, () => { if (!deleting) setShowDeleteModal(false); }, actionsMenuButtonRef);
    const duplicateDialogRef = useModalDialog(showDuplicateModal, () => setShowDuplicateModal(false), duplicateReturnFocusRef);
    const [adminLinkCopied, setAdminLinkCopied] = useState(false);
    // Id of the question a moderator is currently editing inline (null when none).
    const [editingQuestionId, setEditingQuestionId] = useState(null);
    const [editingDrafts, setEditingDrafts] = useState({});
    const editingQuestionIdRef = useRef(editingQuestionId);
    editingQuestionIdRef.current = editingQuestionId;
    const closeQuestionEditor = () => { setEditingQuestionId(null); setEditingDrafts({}); };
    // Experimental "opinion groups" view, hidden behind a ?clusters=1 flag so it
    // can be evaluated on a real discussion without exposing it to everyone. Once
    // enabled it's remembered per browser so the link survives navigation.
    const [showClusters, setShowClusters] = useState(false);
    const [participants, setParticipants] = useState([]);
    const [showParticipants, setShowParticipants] = useState(false);
    // This user's own brainstorm ratings/reactions, kept separately from the
    // (aggregate-only, unattributable) broadcast so we can highlight their
    // selections. Only this user mutates it, so optimistic updates are safe; we
    // fetch the authoritative copy once on join to survive reloads.
    const [myBrainstorm, setMyBrainstorm] = useState({ ratings: {}, reactions: {} });

    const closeParticipants = useCallback(() => setShowParticipants(false), []);
    const {
        identity, userId, displayName, effectivePseudonym, pseudonymReserved,
        shufflePending, selfHandle, ownedVoteIds, ownedCommentIds,
        interestedQuestionIds, downvotedQuestionIds, interestReady, isMyVote, handlePseudonymSync, handleRegeneratePseudonym,
        handleSelectNameMode, handleCustomNameChange,
    } = useParticipantIdentity(socket, { topic, discussionSlug, discussionId: discussion?.id, questions });
    const questionInterest = useQuestionInterest(socket, {
        discussionSlug, userId, questions, interestedQuestionIds, downvotedQuestionIds, interestReady,
    });
    const {
        adminToken, setAdminToken, canDemote, setCanDemote,
        handleModeratorGranted, handleModeratorRevoked,
    } = useModeratorAccess(socket, {
        topic, discussionSlug,
        discussionTitle: discussion?.slug === discussionSlug ? discussion.topic : null,
        onRevoked: closeParticipants,
    });

    const moderatorLink = useModeratorLinkPrompt(discussionSlug, adminToken);
    useEffect(() => { setAdminLinkCopied(false); }, [discussionSlug, adminToken]);
    const isAdmin = !!adminToken;
    const showClearModal = isAdmin && clearTarget === discussionSlug;
    const clearDialogRef = useModalDialog(showClearModal, () => { if (!clearing) setClearTarget(null); }, actionsMenuButtonRef);
    const approvalRequired = discussionState.postingMode === 'approval' && !isAdmin;
    const composer = useQuestionComposer({ socket, discussionSlug, adminToken, setError, approvalRequired });
    const { onQuestionsLoaded, onSimilarQuestion } = composer;
    const { locked, moderatorOnly } = discussionState;
    const theme = THEME_KEYS.includes(discussionState.theme) ? discussionState.theme : DEFAULT_THEME;
    // Which epistemic reactions are active for this session (creator-configurable,
    // a subset of the catalog). Falls back to the full catalog until the server's
    // discussionState arrives.
    const activeReactionKeys = discussionState.reactionKeys || ALL_REACTION_KEYS;
    const discussionTitle = discussion?.topic || topic;

    const shareUrl = typeof window !== 'undefined'
        ? `${window.location.origin}/discussion/${discussionSlug}`
        : '';
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
                if (response.status === 410) {
                    if (!cancelled) {
                        navigate('/', { replace: true, state: { discussionDeleted: true } });
                    }
                    return;
                }
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

    const handleSetTheme = (themeKey) => {
        socket.emit('setTheme', discussionSlug, themeKey, adminToken);
    };

    const handleDeleteQuestion = (questionId) => {
        socket.emit('deleteQuestion', discussionSlug, questionId, adminToken);
    };

    // Show one question's results to everyone, including the room display, or go
    // back to showing them only after voting. Only offered while results are
    // shown after voting; with "Always show results" there is nothing to reveal.
    const handleToggleResultsRevealed = (questionId, revealed) => {
        socket.emit('setResultsRevealed', discussionSlug, questionId, !revealed, adminToken);
    };

    const handleTogglePin = (questionId, pinned) => {
        socket.emit('setPinned', discussionSlug, questionId, !pinned, adminToken);
    };

    // Spotlight one question, or clear the spotlight to resume the room's layout.
    const handleShowOnDisplay = (questionId) => {
        setSpotlightError(null);
        socket.emit('setDisplaySettings', discussionSlug, { questionId }, adminToken, result => {
            if (!result?.ok) setSpotlightError({ slug: discussionSlug, questionId, message: result?.message });
        });
    };

    // Show a queued question to everyone and open it for answers.
    const handlePublishQuestion = (questionId) => {
        socket.emit('publishQuestion', discussionSlug, questionId, adminToken);
    };

    const handleToggleInterest = questionInterest.toggle;

    // Save a moderator's edit to a question. The server only accepts it while the
    // question has no responses; on success it broadcasts fresh questions and we
    // close the inline editor, otherwise the editor stays open to show the error.
    const handleEditQuestion = (questionId, updates, onResult) => {
        socket.emit('editQuestion', discussionSlug, questionId, updates, adminToken, (resp) => {
            // Close only the editor this save came from: by the time a slow
            // acknowledgment arrives the moderator may be editing another question.
            if (resp && resp.updated && editingQuestionIdRef.current === questionId) closeQuestionEditor();
            if (typeof onResult === 'function') onResult(resp);
        });
    };

    const handleCopyAdminLink = async () => {
        try {
            await navigator.clipboard.writeText(adminUrl);
            if (!moderatorLink.isCurrent()) return;
            setAdminLinkCopied(true);
            setTimeout(() => {
                if (moderatorLink.isCurrent()) setAdminLinkCopied(false);
            }, 2000);
            moderatorLink.markSaved();
        } catch (err) {
            if (!moderatorLink.isCurrent()) return;
            console.error('Failed to copy admin link:', err);
            // Show the link in a field so it can be copied by hand.
            moderatorLink.showManual();
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
    // new title; the rename button is also disabled until then.
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

    const leaveDeletedDiscussion = useCallback(() => {
        forgetDiscussion(discussionSlug);
        navigate('/', { replace: true, state: { discussionDeleted: true } });
    }, [discussionSlug, navigate]);

    useEffect(() => {
        const onDeleted = ({ slug }) => {
            if (slug === discussionSlug) leaveDeletedDiscussion();
        };
        socket.on('discussionDeleted', onDeleted);
        return () => socket.off('discussionDeleted', onDeleted);
    }, [socket, discussionSlug, leaveDeletedDiscussion]);

    const handleClearResponses = async () => {
        if (!showClearModal || clearing) return;
        setClearing(true);
        setClearError('');
        try {
            const response = await fetch(`/api/discussions/${encodeURIComponent(clearTarget)}/responses`, {
                method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminToken }),
            });
            if (!response.ok) throw new Error((await response.json()).error || 'Could not clear votes and responses.');
            const refreshed = response.status === 204 || (await response.json()).refreshed === true;
            setClearedRoom({ slug: clearTarget, refreshed });
            setClearTarget(null);
        } catch (error) {
            setClearError(error.message || 'Could not confirm that votes and responses were cleared.');
        } finally {
            setClearing(false);
        }
    };

    const handleDeleteDiscussion = async () => {
        if (deleting) return;
        setDeleting(true);
        setDeleteError('');
        try {
            const response = await fetch(`/api/discussions/${encodeURIComponent(discussionSlug)}`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminToken }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Could not delete the discussion.');
            leaveDeletedDiscussion();
        } catch (error) {
            setDeleteError(error.message || 'Could not delete the discussion. Please try again.');
        } finally {
            setDeleting(false);
        }
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
                // The moderator token lets the copy keep this discussion's
                // queued questions; without it they are left out.
                body: JSON.stringify({ originalTopic: discussionSlug, newTopic: newTopicName, adminToken: adminToken || undefined }),
            });

            if (response.ok) {
                const result = await response.json();
                if (result.adminToken && !result.accountLinked) {
                    try {
                        localStorage.setItem(`convora_admin_${result.newSlug}`, result.adminToken);
                    } catch (e) {
                        console.warn('Failed to store admin token:', e);
                    }
                }
                // The route reuses this component. Successful navigation must
                // land on destination content instead of its unrelated More
                // button. A stacked prompt inherits this target if it outlives
                // the Duplicate dialog.
                duplicateReturnFocusRef.current = discussionContentRef.current;
                navigate(`/discussion/${result.newSlug}`, result.adminToken && !result.accountLinked ? { state: moderatorLinkPromptState(result.newSlug) } : undefined);
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
        onQuestionsLoaded();
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
                nextMap.set(q.id, {
                    timestamp: Date.now(),
                    ...prev,
                    ...q,
                    ...(q.type === QuestionTypes.NUMERICAL ? getNumericalRange(q) : {}),
                    votes: q.votes || prev?.votes || [],
                });
            });
            return Array.from(nextMap.values());
        });
    }, [onQuestionsLoaded]);

    useDiscussionRoom(socket, {
        topic, discussionSlug, userId,
        onDiscussion: setDiscussion, onQuestions: handleQuestionsUpdate,
        onPresence: setPresence, onState: setDiscussionState,
        onSimilarQuestion, onBrainstormState: setMyBrainstorm,
        onModeratorGranted: handleModeratorGranted, onModeratorRevoked: handleModeratorRevoked,
        onPseudonymSync: handlePseudonymSync,
        // The server's reason for refusing an action, such as a vote sent just
        // as the discussion was locked. Nothing else would tell the participant.
        onError: payload => { if (typeof payload?.message === 'string') setError(payload.message); },
    });

    const speakingQueue = useSpeakingQueue(socket, discussionSlug, discussion?.slug === discussionSlug && discussionState.handsEnabled, userId, adminToken, displayName);

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

    // The participant list is fetched on request, so after navigation the
    // previous room's would stay on screen with buttons that act on this one.
    useEffect(() => {
        setParticipants([]);
        setShowParticipants(false);
    }, [discussionSlug]);

    // onResult is optional. The server acks a stored vote with { added: true }
    // and free-text limits with { added: false, reason: 'limit' }.
    const handleVote = (questionId, value, onResult) => {
        // Send the name mode too: in pseudonym mode the server persists our
        // reserved handle instead of this possibly-pre-reservation displayName,
        // closing the submit-before-reservation collision window (#57). We send the
        // EFFECTIVE mode so a blank-custom name (shown as the pseudonym) canonicalizes.
        // A vote means "set my answer to this value" and is safe to repeat; undo
        // is the separate handleClearVote. While one is awaiting the server's
        // acknowledgment the question's controls are disabled and a second
        // submission is refused (#72).
        const args = [discussionSlug, questionId, value, userId, displayName, getEffectiveNameMode(identity)];
        const draft = sliderValues[questionId];
        args.push(result => {
            // A refused answer goes back into the draft it was cleared from
            // below, unless the participant has started another since.
            if (!result?.ok && draft !== undefined) {
                setSliderValues(prev => (prev[questionId] === undefined ? { ...prev, [questionId]: draft } : prev));
            }
            if (typeof onResult === 'function') onResult(result);
        });
        const sent = sendVote(questionId, value, 'vote', ...args);
        if (!sent) return;
        setSliderValues(prev => ({ ...prev, [questionId]: undefined }));
    };

    // Explicit undo for Agreement and Yes/No votes.
    const handleClearVote = (questionId) => {
        sendVote(questionId, null, 'clearVote', discussionSlug, questionId, userId);
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

    const handleAddComment = (responseId, body, onResult) => {
        // Pass the name mode so pseudonym-mode comments persist under our reserved
        // handle rather than a pre-reservation local pick (#57); see handleVote.
        socket.timeout(10000).emit('addResponseComment', topic, responseId, body, userId, displayName, getEffectiveNameMode(identity),
            (error, result) => onResult?.(!error && result?.added === true));
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
            case SortOptions.MODERATOR:
                return [...questions].sort((first, second) => first.moderatorOrder - second.moderatorOrder);
            case SortOptions.MOST_RECENT:
                return sortQuestionsMostRecent(questions);
            case SortOptions.MOST_INTERESTING:
                return sortQuestionsMostInteresting(questions);
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
        // undefined when idle; otherwise the value being saved (null = clearing).
        const pendingVote = pendingVotes[question.id];
        const votePending = pendingVote !== undefined;
        // One button per option of a single-choice poll: it sets that option, or
        // explicitly clears it when it is already this participant's vote.
        const renderOptionVoteButton = (option) => {
            const isMine = Boolean(userVote && userVote.value === option);
            const saving = votePending && (pendingVote === option || (pendingVote === null && isMine));
            // The name says which option and question this button is for, and
            // stays the same whether or not it is selected: aria-pressed carries
            // the selection, so the visible "Vote" / "Undo Vote" text is not the
            // only cue. The status text announces a save in progress.
            return (
                <>
                <button
                    onClick={() => (isMine ? handleClearVote(question.id) : handleVote(question.id, option))}
                    disabled={votePending}
                    aria-label={`Vote ${option} on "${plainPrompt(question.text)}"`}
                    aria-pressed={isMine}
                    aria-busy={saving || undefined}
                    className={`px-4 py-2 rounded-md transition duration-300 disabled:opacity-60 disabled:cursor-not-allowed ${isMine
                        ? 'bg-primary text-white hover:bg-opacity-90'
                        : 'bg-secondary text-white hover:bg-opacity-90'
                        }`}
                >
                    {saving ? 'Saving…' : isMine ? 'Undo Vote' : 'Vote'}
                </button>
                <span role="status" className="sr-only">
                    {saving ? `Saving your vote on "${plainPrompt(question.text)}"…` : ''}
                </span>
                </>
            );
        };

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
                                            {option}{question.resultsHidden ? '' : `: ${question.votes ? question.votes.filter(v => v.value === option).length : 0}`}
                                        </span>
                                        {renderOptionVoteButton(option)}
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
                                            {option}{question.resultsHidden ? '' : `: ${question.votes ? question.votes.filter(v => v.value === option).length : 0}`}
                                        </span>
                                        {renderOptionVoteButton(option)}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            case QuestionTypes.MULTIPLE_CHOICE:
                return (
                    <div>
                        <MultipleChoiceResults question={question} />
                        {!locked && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {(question.options || []).map((option) => (
                                    <div key={option} className="flex items-center justify-between gap-3 bg-gray-100 p-3 rounded-md">
                                        <span className="font-medium break-words min-w-0">{option}</span>
                                        {renderOptionVoteButton(option)}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            case QuestionTypes.NUMERICAL: {
                const { minValue, maxValue } = question;

                // sliderValues[id] is undefined until the participant touches the
                // slider or the number box ('' while the box is cleared). Until
                // then we show their saved answer if they have one, and otherwise
                // nothing at all: no midpoint default to anchor on or to submit
                // by accident.
                const draftValue = sliderValues[question.id];
                const inputValue = draftValue !== undefined
                    ? draftValue
                    : (userVote ? Number(userVote.value) : '');
                // What Submit would send: the draft clamped into range and
                // rounded to two decimal places, or null when nothing is selected.
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
                                        aria-label={`Your answer to: ${plainPrompt(question.text)}`}
                                        aria-valuetext={isUnset ? 'No value selected' : String(sliderValue)}
                                        className={`flex-grow min-w-0 ${isUnset ? 'slider-unset' : ''}`}
                                        onChange={(e) => handleSliderChange(question.id, parseInt(e.target.value))}
                                        // A click that lands exactly on the resting
                                        // position fires no change event, so pick the
                                        // value up here too.
                                        onClick={(e) => { if (isUnset) handleSliderChange(question.id, parseInt(e.target.value)); }}
                                    />
                                    <input
                                        // A number input sanitizes a lone minus
                                        // to '', losing it on a controlled render.
                                        // Text preserves intermediate signed input.
                                        type="text"
                                        inputMode="decimal"
                                        value={inputValue}
                                        placeholder="–"
                                        aria-label={`Type your answer to: ${plainPrompt(question.text)}`}
                                        className="w-24 p-2 border border-gray-300 rounded-md text-center focus:outline-none focus:ring-2 focus:ring-primary"
                                        // Keep what is typed as-is so multi-digit
                                        // or decimal entry ("0." on the way to
                                        // "0.5") isn't clamped mid-keystroke; the
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
                                    disabled={votePending || !canSubmit}
                                    className={`mt-4 px-4 py-2 rounded-md transition duration-300 disabled:opacity-50 disabled:cursor-not-allowed ${userVote ? 'bg-primary text-white hover:bg-opacity-90' : 'bg-secondary text-white hover:bg-opacity-90'}`}
                                >
                                    {votePending ? 'Saving…' : userVote ? 'Update Vote' : 'Submit'}
                                </button>
                            </>
                        )}
                    </div>
                );
            }
            case QuestionTypes.OPEN_ENDED: {
                return <OpenEndedQuestion
                    question={question}
                    ownedVoteIds={ownedVoteIds}
                    ownedCommentIds={ownedCommentIds}
                    handleVote={handleVote}
                    pending={votePending}
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

    const sortedAndFilteredQuestions = filterQuestions(sortQuestions(questions.filter(question => !question.queued)));
    // Queued questions reach moderators only (the server sends them to nobody
    // else). Keep the saved agenda order supplied by the server.
    const queuedQuestions = questions.filter(question => question.queued);
    const canArrangePublished = sortOption === SortOptions.MODERATOR && !showUnansweredOnly;
    const swapPublishedQuestions = (earlier, later) => {
        socket.emit('swapPublishedQuestions', discussionSlug, earlier.id, later.id, adminToken);
    };
    const swapQueuedQuestions = (earlier, later) => {
        socket.emit('swapQueuedQuestions', discussionSlug, earlier.id, later.id, adminToken);
    };
    // Pinned questions float to the top, preserving the chosen sort within each
    // group (Array.prototype.sort is stable).
    const orderedQuestions = [...sortedAndFilteredQuestions].sort(
        (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
    );

    return (
        <div
            ref={discussionContentRef}
            role="region"
            aria-label={`Discussion: ${topic}`}
            tabIndex={-1}
            className="max-w-4xl mx-auto mt-10 sm:px-4"
        >
            {isAdmin && editingTitle ? (
                <div className="mb-2 flex flex-col items-center gap-2">
                    <input
                        type="text"
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) handleRenameDiscussion();
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
                // Phones drop the "Discussion:" prefix visually; it stays in the
                // heading's accessible name.
                // The rename button sits beside the heading, not inside it, so it
                // stays out of the heading's accessible name.
                <div className="mb-2 flex items-center justify-center gap-2">
                    <h1 className="min-w-0 text-2xl sm:text-4xl font-bold text-center text-gray-800"><span className="sr-only sm:not-sr-only">Discussion: </span>{discussionTitle}</h1>
                    {isAdmin && (
                        <button
                            type="button"
                            ref={renameButtonRef}
                            onClick={handleStartRename}
                            disabled={!discussion?.topic}
                            aria-label="Rename discussion"
                            title="Rename discussion"
                            className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50"
                        >
                            <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                            </svg>
                        </button>
                    )}
                </div>
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
                    <div className="mt-3 inline-block max-w-full text-left bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-2">
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
                            <span className="whitespace-nowrap">Enter your own name:</span>
                            <input
                                type="text"
                                value={identity.customName}
                                maxLength={MAX_CUSTOM_NAME_LENGTH}
                                placeholder="Your name"
                                onChange={(e) => handleCustomNameChange(e.target.value)}
                                // The name saves as it is typed, so Enter just closes the picker.
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) setEditingIdentity(false);
                                }}
                                className="min-w-0 flex-1 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
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
            {/* On a phone the row is tightened (smaller text and padding, the
                "View" / "Opinion" words visually hidden) so it fits on one line. */}
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm sm:gap-3 sm:text-base">
                <button
                    ref={shareButtonRef}
                    aria-haspopup="dialog"
                    onClick={() => setShowShareModal(true)}
                    className="bg-primary text-white py-2 px-3 sm:px-4 rounded hover:bg-opacity-90 transition duration-300"
                >
                    Share
                </button>
                <Link
                    to={`/discussion/${discussionSlug}/summary`}
                    className="border border-gray-300 text-gray-700 py-2 px-3 sm:px-4 rounded hover:bg-gray-100 transition duration-300"
                >
                    <span className="sr-only sm:not-sr-only">View </span>Summary
                </Link>
                <button
                    type="button"
                    onClick={() => setShowSnapshots(open => !open)}
                    aria-expanded={showSnapshots}
                    aria-controls="opinion-snapshots"
                    className="border border-gray-300 text-gray-700 py-2 px-3 sm:px-4 rounded hover:bg-gray-100 transition duration-300"
                >
                    <span className="sr-only sm:not-sr-only">Opinion </span>Snapshots
                </button>
                {showClusters && (
                    <Link
                        to={`/discussion/${encodeURIComponent(topic)}/clusters`}
                        className="border border-gray-300 text-gray-700 py-2 px-3 sm:px-4 rounded hover:bg-gray-100 transition duration-300"
                    >
                        Opinion Groups
                    </Link>
                )}
                <div className="relative">
                    <button
                        type="button"
                        ref={actionsMenuButtonRef}
                        onClick={() => setShowActionsMenu((open) => !open)}
                        aria-haspopup="true"
                        aria-expanded={showActionsMenu}
                        className="border border-gray-300 text-gray-700 py-2 px-3 sm:px-4 rounded hover:bg-gray-100 transition duration-300"
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
                                className="absolute right-0 sm:left-0 sm:right-auto mt-1 z-20 w-52 bg-white border border-gray-200 rounded shadow-lg py-1"
                            >
                                {/* Open to everyone, so a TV that joined with the
                                    ordinary link can switch itself to the
                                    read-only display. Same tab on purpose: on a
                                    TV you want this page replaced, not a new tab. */}
                                <a
                                    role="menuitem"
                                    href={`/discussion/${encodeURIComponent(discussionSlug)}/display`}
                                    onClick={() => setShowActionsMenu(false)}
                                    title="A read-only page for a shared TV or projector: join QR code, questions and live counts"
                                    className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                                >
                                    Open room display
                                </a>
                                <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        setShowActionsMenu(false);
                                        duplicateReturnFocusRef.current = actionsMenuButtonRef.current;
                                        setShowDuplicateModal(true);
                                    }}
                                    className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                                >
                                    Duplicate Discussion
                                </button>
                                {isAdmin && (
                                    <button type="button" role="menuitem" onClick={() => {
                                        setShowActionsMenu(false); setClearError(''); setClearedRoom(null); setClearTarget(discussionSlug);
                                    }} className="block w-full text-left px-4 py-2 text-sm text-red-700 hover:bg-red-50">
                                        Clear votes and responses
                                    </button>
                                )}
                                {canDemote && (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => { setShowActionsMenu(false); setDeleteError(''); setShowDeleteModal(true); }}
                                        className="block w-full text-left px-4 py-2 text-sm text-red-700 hover:bg-red-50"
                                    >
                                        Delete discussion
                                    </button>
                                )}
                                <a
                                    role="menuitem"
                                    href={`/api/discussions/${encodeURIComponent(discussionSlug)}/export.csv`}
                                    onClick={(e) => { setShowActionsMenu(false); downloadForViewer(e, discussionSlug); }}
                                    className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                                >
                                    Export CSV
                                </a>
                                <a
                                    role="menuitem"
                                    href={`/api/discussions/${encodeURIComponent(discussionSlug)}/export.json`}
                                    onClick={(e) => { setShowActionsMenu(false); downloadForViewer(e, discussionSlug); }}
                                    className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                                >
                                    Export JSON
                                </a>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {showSnapshots && (
                <OpinionSnapshots
                    key={discussionSlug}
                    discussionSlug={discussionSlug}
                    adminToken={adminToken}
                    userId={userId}
                    refreshSignal={snapshotRefreshSignal}
                    display={{
                        layout: discussionState.displayLayout,
                        beforeId: discussionState.displayBeforeSnapshotId ?? undefined,
                        afterId: discussionState.displayAfterSnapshotId ?? undefined,
                    }}
                    onDisplay={isAdmin ? (settings) => socket.emit('setDisplaySettings', discussionSlug, settings, adminToken) : undefined}
                />
            )}

            {clearedRoom?.slug === discussionSlug && <p role="status">{clearedRoom.refreshed
                ? 'Votes and responses cleared. Your questions are still here.'
                : 'Votes and responses were cleared, but the live view did not update. Ask anyone still seeing old responses to reload. Do not clear again.'}</p>}
            {showClearModal && (
                <div className="fixed inset-0 z-50 bg-gray-600 bg-opacity-50 flex items-center justify-center p-4">
                    <div ref={clearDialogRef} role="dialog" aria-modal="true" aria-labelledby="clear-title" aria-describedby="clear-description" tabIndex={-1} className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
                        <h2 id="clear-title" className="text-xl font-bold mb-4">Clear votes and responses?</h2>
                        <p id="clear-description" className="text-gray-700 mb-4">This permanently removes all answers, interest marks, private question notes, raised hands, and response comments, ratings, and reactions from “{discussionTitle}”. Independent-answer questions start collecting privately again. Your questions, settings, saved snapshots, and link stay the same. This cannot be undone.</p>
                        {clearError && <p role="alert" className="text-red-700 mb-4">{clearError}</p>}
                        <div className="flex justify-end gap-2">
                            <button type="button" data-autofocus disabled={clearing} onClick={() => setClearTarget(null)} className="px-4 py-2 rounded bg-gray-200 disabled:opacity-50">Cancel</button>
                            <button type="button" disabled={clearing} onClick={handleClearResponses} className="px-4 py-2 rounded bg-red-700 text-white disabled:opacity-50">{clearing ? 'Clearing…' : 'Clear votes and responses'}</button>
                        </div>
                    </div>
                </div>
            )}

            {showDeleteModal && (
                <div className="fixed inset-0 z-50 bg-gray-600 bg-opacity-50 overflow-y-auto flex items-center justify-center p-4">
                    <div ref={deleteDialogRef} role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title" aria-describedby="delete-dialog-description" tabIndex={-1} className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
                        <h2 id="delete-dialog-title" className="text-xl font-bold mb-4">Delete discussion?</h2>
                        <p id="delete-dialog-description" className="text-gray-700 mb-4">
                            Permanently delete “{discussionTitle}” and all its questions, responses, comments, and snapshots for everyone? This cannot be undone.
                        </p>
                        {deleteError && <p role="alert" className="text-red-700 mb-4">{deleteError}</p>}
                        <div className="flex justify-end gap-3">
                            <button type="button" data-autofocus disabled={deleting} onClick={() => setShowDeleteModal(false)} className="px-4 py-2 rounded bg-gray-200 disabled:opacity-50">Cancel</button>
                            <button type="button" disabled={deleting} onClick={handleDeleteDiscussion} className="px-4 py-2 rounded bg-red-700 text-white disabled:opacity-50">{deleting ? 'Deleting…' : 'Delete discussion'}</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Duplicate Modal */}
            {showDuplicateModal && (
                <div className="fixed inset-0 z-50 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full flex items-center justify-center">
                    <div
                        ref={duplicateDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="duplicate-dialog-title"
                        tabIndex={-1}
                        className="bg-white p-5 rounded-lg shadow-xl"
                    >
                        <h2 id="duplicate-dialog-title" className="text-xl font-bold mb-4">Duplicate Discussion</h2>
                        <input
                            type="text"
                            aria-label="New topic name"
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
                    className="fixed inset-0 z-50 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full flex items-center justify-center"
                    onClick={() => setShowShareModal(false)}
                >
                    <div
                        ref={shareDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="share-dialog-title"
                        tabIndex={-1}
                        className="bg-white p-6 rounded-lg shadow-xl text-center max-w-[95vw] max-h-[95vh] overflow-y-auto"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2 id="share-dialog-title" className="text-2xl font-bold mb-4">Share this discussion</h2>
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
                                data-autofocus
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

            {/* Moderator controls */}
            <div className="mb-6">
                {isAdmin && <ModeratorLinkPanel prompt={moderatorLink} adminUrl={adminUrl} onCopy={handleCopyAdminLink} />}
                {isAdmin ? (
                    <ModeratorPanel
                        discussionSlug={discussionSlug}
                        state={discussionState}
                        theme={theme}
                        themes={THEMES}
                        activeReactionKeys={activeReactionKeys}
                        onSetLocked={(on) => socket.emit('setLocked', discussionSlug, on, adminToken)}
                        onSetPostingMode={(mode) => discussionState.postingMode
                            ? socket.emit('setPostingMode', discussionSlug, mode, adminToken)
                            : socket.emit('setModeratorOnly', discussionSlug, mode === 'moderator_only', adminToken)}
                        onSetListed={(on) => socket.emit('setListed', discussionSlug, on, adminToken)}
                        onSetResultsVisibility={(value) => socket.emit('setResultsVisibility', discussionSlug, value, adminToken)}
                        onSetDisplaySettings={(settings) => socket.emit('setDisplaySettings', discussionSlug, settings, adminToken)}
                        onSetTheme={handleSetTheme}
                        onSetFlags={handleSetDiscussionFlags}
                        onSetReactionKeys={handleSetReactionKeys}
                        linkPrompt={moderatorLink}
                        linkCopied={adminLinkCopied}
                        onCopyLink={handleCopyAdminLink}
                        showParticipants={showParticipants}
                        onToggleParticipants={handleToggleParticipants}
                    >
                        {/* Participant management: promote a participant to
                            moderator. Only people who have voted or responded
                            appear here — the server can't name silent viewers. */}
                        <div className="bg-white border border-indigo-100 rounded-md p-4 text-sm">
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
                    </ModeratorPanel>
                ) : !discussionState.hasModerator ? (
                    <button
                        onClick={handleClaimModerator}
                        className="text-sm text-gray-600 underline hover:text-gray-800"
                    >
                        Become moderator
                    </button>
                ) : null}
            </div>

            {/* Locked banner */}
            {locked && (
                <div className="mb-6 bg-amber-50 border border-amber-200 text-amber-800 rounded-md p-3 text-center">
                    🔒 This discussion is locked. Voting and new statements are closed.
                </div>
            )}

            {/* Near-duplicate prompt */}
            <QuestionComposer composer={composer} questionCount={questions.length}
                locked={locked} moderatorOnly={moderatorOnly} isAdmin={isAdmin} approvalRequired={approvalRequired} />
            {error && <div className="text-red-500 mb-4">{error}</div>}
            {connectionLost && (
                <div
                    role="status"
                    className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-gray-900 px-4 py-2 text-sm text-white shadow-lg"
                >
                    Connection lost. Reconnecting…
                </div>
            )}
            {/* The moderator's queue: questions written ahead of time and not
                published yet. */}
            {isAdmin && queuedQuestions.length > 0 && (
                <section
                    aria-labelledby="queued-questions-heading"
                    className="mb-8 rounded-lg border border-dashed border-indigo-300 bg-indigo-50 p-4"
                >
                    <h2 id="queued-questions-heading" className="text-lg font-semibold text-indigo-900">
                        Queued questions ({queuedQuestions.length})
                    </h2>
                    <p className="mb-3 text-sm text-indigo-800">
                        Only moderators see these drafts and suggestions. Reorder them to plan the agenda, publish any question to open it for answers, or delete it to discard it.
                    </p>
                    <ol className="space-y-3">
                        {queuedQuestions.map((question, index) => (
                            <li key={question.id} className="rounded-md border border-indigo-100 bg-white p-4" data-testid="queued-question">
                                {question.suggested && <p className="text-xs font-medium text-indigo-700">Participant suggestion</p>}
                                {editingQuestionId === question.id ? (
                                    <QuestionEditor
                                        question={question}
                            draft={editingDrafts[question.id]}
                            onDraftChange={draft => setEditingDrafts(current => ({ ...current, [question.id]: draft }))}
                                        onSave={handleEditQuestion}
                                        onCancel={closeQuestionEditor}
                                    />
                                ) : (
                                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                                        <div className="min-w-0 flex-1 basis-64">
                                            <h3 className="font-semibold break-words">{formatPrompt(question.text)}</h3>
                                            <p className="text-sm text-gray-500 break-words">
                                                Type: {question.type}
                                                {question.type === QuestionTypes.NUMERICAL && ` (${question.minValue} to ${question.maxValue})`}
                                                {question.type === QuestionTypes.MULTIPLE_CHOICE && ` (${(question.options || []).join(' · ')})`}
                                            </p>
                                        </div>
                                        <div className="flex flex-wrap gap-2 ml-auto">
                                            <button
                                                disabled={index === 0}
                                                aria-label={`Move up: ${question.text}`}
                                                onClick={() => swapQueuedQuestions(queuedQuestions[index - 1], question)}
                                                className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-50"
                                            >Move up</button>
                                            <button
                                                disabled={index === queuedQuestions.length - 1}
                                                aria-label={`Move down: ${question.text}`}
                                                onClick={() => swapQueuedQuestions(question, queuedQuestions[index + 1])}
                                                className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-50"
                                            >Move down</button>
                                            <button
                                                onClick={() => handlePublishQuestion(question.id)}
                                                disabled={locked}
                                                title={locked ? 'Unlock the discussion to publish questions' : 'Show this question to everyone and open it for answers'}
                                                className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {question.suggested ? 'Approve and publish' : 'Publish'}
                                            </button>
                                            <button
                                                onClick={() => setEditingQuestionId(question.id)}
                                                className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                                            >
                                                Edit
                                            </button>
                                            <button
                                                onClick={() => handleDeleteQuestion(question.id)}
                                                className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50"
                                            >
                                                Delete
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </li>
                        ))}
                    </ol>
                </section>
            )}
            {/* Sorting and filtering controls */}
            <div className="mb-6 flex justify-between items-center">
                <select
                    value={sortOption}
                    aria-label="Sort submitted questions"
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
                    Show only questions I haven’t answered
                </label>
            </div>

            {/* Questions list */}
            {isAdmin && orderedQuestions.length > 1 && (
                <p className="mb-3 text-sm text-gray-600">{canArrangePublished
                    ? 'Use Move up or Move down to change the order participants see. Pinned questions stay first.'
                    : 'To rearrange questions, choose Moderator order and turn off the unanswered filter.'}</p>
            )}
            {orderedQuestions.map((question, index) => {
                const previous = orderedQuestions[index - 1];
                const next = orderedQuestions[index + 1];
                // A question can only be edited before anyone has responded — once
                // it has votes, its wording is locked in (matches the server guard).
                const hasResponses = (question.votes?.length || 0) > 0;
                const isEditing = editingQuestionId === question.id;
                const questionVotes = [{ name: 'Upvote', symbol: '▲', direction: true, pressed: interestedQuestionIds.has(question.id), count: question.interestCount || 0 }];
                if (discussionState.questionDownvotesEnabled) questionVotes.push({ name: 'Downvote', symbol: '▼', direction: 'down', pressed: downvotedQuestionIds.has(question.id), count: question.downvoteCount || 0 });
                const interestPending = questionInterest.pending.has(question.id);
                const hiddenOnDisplay = discussionState.displayHiddenQuestionIds?.includes(question.id);
                // Whether the room display is showing this question on its own: its
                // live results, or its before-and-after comparison.
                const onDisplay = ['focus', 'compare'].includes(discussionState.displayLayout)
                    && discussionState.displayQuestionId === question.id;
                const returnLabel = {
                    all: 'Back to all questions',
                    focus: 'Resume automatic selection',
                    compare: 'Back to full comparison',
                }[discussionState.displayBaseLayout || discussionState.displayLayout];
                return (
                <div key={question.id} data-question-id={question.id} className="bg-white shadow-lg rounded-lg p-6 mb-6">
                    {isEditing ? (
                        <QuestionEditor
                            question={question}
                            draft={editingDrafts[question.id]}
                            onDraftChange={draft => setEditingDrafts(current => ({ ...current, [question.id]: draft }))}
                            onSave={handleEditQuestion}
                            onCancel={closeQuestionEditor}
                        />
                    ) : (
                    <>
                    {/* On a narrow screen the moderator's buttons wrap below the
                        title instead of squeezing it into a thin column. */}
                    <div className="flex flex-wrap justify-between items-start gap-x-4 gap-y-2 mb-4">
                        <div className="flex items-start gap-3 min-w-0 flex-1 basis-64">
                            <div className="shrink-0 flex flex-col gap-1">
                            {questionVotes.map(({ name, symbol, direction, pressed, count }) => <button
                                key={name}
                                type="button"
                                onClick={() => handleToggleInterest(question.id, direction)}
                                disabled={locked || !questionInterest.ready || interestPending}
                                aria-busy={interestPending}
                                aria-pressed={pressed}
                                aria-label={`${name} "${plainPrompt(question.text)}"`}
                                aria-describedby={`${name}-count-${question.id}`}
                                className={`flex flex-col items-center px-2 py-1 rounded-md border transition duration-200 ${pressed
                                    ? 'bg-primary text-white border-primary'
                                    : 'bg-white text-gray-600 border-gray-300 hover:border-primary'} ${locked ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                                <span aria-hidden="true" className="leading-none">{symbol}</span>
                                <span id={`${name}-count-${question.id}`} className="text-xs font-semibold">
                                    {count}<span className="sr-only"> {name.toLowerCase()}{count === 1 ? '' : 's'}</span>
                                </span>
                            </button>)}
                            </div>
                            <h2 className="text-xl font-semibold min-w-0 break-words">
                                {question.pinned && <span className="mr-1" title="Pinned">📌</span>}
                                {formatPrompt(question.text)}
                            </h2>
                        </div>
                        {isAdmin && (
                            <div className="flex flex-wrap justify-end gap-2 ml-auto max-w-full">
                                {canArrangePublished && [['up', previous], ['down', next]].map(([direction, neighbor]) => (
                                    <button key={direction} disabled={!neighbor || neighbor.pinned !== question.pinned}
                                        aria-label={`Move ${direction}: ${question.text}`}
                                        onClick={() => direction === 'up' ? swapPublishedQuestions(neighbor, question) : swapPublishedQuestions(question, neighbor)}
                                        className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-50"
                                    >Move {direction}</button>
                                ))}
                                {!hasResponses && (
                                    <button
                                        onClick={() => setEditingQuestionId(question.id)}
                                        className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                                    >
                                        Edit
                                    </button>
                                )}
                                {question.independentAnswers && !question.queued && !question.resultsRevealed && (
                                    <button onClick={() => handleToggleResultsRevealed(question.id, false)}
                                        className="text-xs px-2 py-1 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50">
                                        Reveal answers
                                    </button>
                                )}
                                {discussionState.resultsVisibility !== 'always'
                                    && [QuestionTypes.AGREEMENT, QuestionTypes.YES_NO, QuestionTypes.MULTIPLE_CHOICE, QuestionTypes.NUMERICAL].includes(question.type) && (
                                    <button
                                        onClick={() => handleToggleResultsRevealed(question.id, question.resultsRevealed)}
                                        aria-pressed={question.resultsRevealed === true}
                                        title={question.resultsRevealed
                                            ? 'Go back to showing results only to people who have voted'
                                            : 'Show the results to everyone now, including on the room display. The first time, a “before” snapshot of the room’s answers is saved.'}
                                        className="text-xs px-2 py-1 rounded border border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                                    >
                                        {question.resultsRevealed ? 'Hide results' : 'Show results'}
                                    </button>
                                )}
                                {!hiddenOnDisplay && <button
                                    onClick={() => handleShowOnDisplay(onDisplay ? null : question.id)}
                                    title={onDisplay ? returnLabel : 'Show this question on its own on the room display'}
                                    className={`text-xs px-2 py-1 rounded border border-indigo-300 ${onDisplay
                                        ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                                        : 'text-indigo-700 hover:bg-indigo-50'}`}
                                >
                                    {onDisplay ? returnLabel : 'Show on display'}
                                </button>}
                                {spotlightError?.slug === discussionSlug && spotlightError.questionId === question.id && (
                                    <span role="alert" className="text-sm text-red-700">{spotlightError.message}</span>
                                )}
                                <button
                                    onClick={() => socket.emit('setQuestionHiddenOnDisplay', discussionSlug, question.id, !hiddenOnDisplay, adminToken)}
                                    title={hiddenOnDisplay ? 'Include this question on the room display again' : 'Hide this question on the room display only. Participants can still answer it.'}
                                    className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                                >
                                    {hiddenOnDisplay ? 'Restore to display' : 'Hide from display'}
                                </button>
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
                    <QuestionTools question={question} socket={socket} slug={discussionSlug} token={adminToken}
                        vote={question.votes?.find(vote => isMyVote(question, vote))} locked={locked}
                        disabled={!interestReady || !userId || connectionLost || pendingVotes[question.id] !== undefined} />
                    {discussionState.handsEnabled && <SpeakingQueue queue={speakingQueue} questionId={question.id} moderator={isAdmin}
                        locked={!!locked || connectionLost} name={displayName} />}
                    </>
                    )}
                </div>
                );
            })}
        </div>
    );
};

export default DiscussionPage;
