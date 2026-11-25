import { useEffect, useRef, useState } from 'react';
import { useModalDialog } from './useModalDialog';

// The links a discussion can be shared by: the join link and its QR code, the
// optional short link a moderator can generate or customize, and the private
// moderator link. Also owns the Share dialog's open state.
export function useShareLinks({ discussionSlug, shortCode, adminToken, moderatorLink, setError }) {
    const [showShareModal, setShowShareModal] = useState(false);
    const [copied, setCopied] = useState(false);
    const [shortShareUrl, setShortShareUrl] = useState('');
    const [shortCodeDraft, setShortCodeDraft] = useState('');
    const [shortLinkError, setShortLinkError] = useState('');
    const [shortLinkLoading, setShortLinkLoading] = useState(false);
    const [shortLinkCopied, setShortLinkCopied] = useState(false);
    const [adminLinkCopied, setAdminLinkCopied] = useState(false);
    // Escape closes the Share dialog, focus is kept inside while open and
    // handed back to the Share button on close.
    const shareButtonRef = useRef(null);
    const shareDialogRef = useModalDialog(showShareModal, () => setShowShareModal(false), shareButtonRef);

    useEffect(() => { setAdminLinkCopied(false); }, [discussionSlug, adminToken]);

    const shareUrl = typeof window !== 'undefined'
        ? `${window.location.origin}/discussion/${discussionSlug}`
        : '';
    const adminUrl = typeof window !== 'undefined' && adminToken
        ? `${window.location.origin}/discussion/${discussionSlug}?admin=${adminToken}`
        : '';
    const shortUrlPrefix = typeof window !== 'undefined' ? `${window.location.origin}/s/` : '/s/';

    useEffect(() => {
        setShortShareUrl(
            typeof window !== 'undefined' && shortCode
                ? `${window.location.origin}/s/${shortCode}`
                : ''
        );
        setShortCodeDraft(shortCode || '');
        setShortLinkError('');
        setShortLinkCopied(false);
    }, [discussionSlug, shortCode]);

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

    // Typing or pasting a full short URL keeps only its code.
    const handleShortCodeDraftChange = (value) => {
        const next = value
            .toLowerCase()
            .replace(/^https?:\/\/[^/]+\/?/i, '')
            .replace(/^s\//i, '')
            .replace(/^\/+/, '');
        setShortCodeDraft(next);
        setShortLinkError('');
    };

    return {
        showShareModal, setShowShareModal, shareButtonRef, shareDialogRef,
        shareUrl, adminUrl, shortUrlPrefix, copied,
        shortShareUrl, shortCodeDraft, shortLinkError, shortLinkLoading, shortLinkCopied, adminLinkCopied,
        handleCopyLink, handleCopyAdminLink, handleGenerateShortLink, handleSaveCustomShortLink,
        handleCopyShortLink, handleShortCodeDraftChange,
    };
}
