import React from 'react';
import PropTypes from 'prop-types';
import { QRCodeSVG } from 'qrcode.react';

// The Share dialog: a QR code and the join link for everyone, plus the short
// link editor for moderators. Takes the state and handlers of useShareLinks.
export default function ShareDialog({ share, isAdmin }) {
    const {
        setShowShareModal, shareDialogRef, shareUrl, shortUrlPrefix, copied,
        shortShareUrl, shortCodeDraft, shortLinkError, shortLinkLoading, shortLinkCopied,
        handleCopyLink, handleGenerateShortLink, handleSaveCustomShortLink, handleCopyShortLink,
        handleShortCodeDraftChange,
    } = share;
    return (
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
                                    onChange={(e) => handleShortCodeDraftChange(e.target.value)}
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
    );
}

ShareDialog.propTypes = {
    share: PropTypes.shape({
        setShowShareModal: PropTypes.func.isRequired,
        shareDialogRef: PropTypes.object.isRequired,
        shareUrl: PropTypes.string.isRequired,
        shortUrlPrefix: PropTypes.string.isRequired,
        copied: PropTypes.bool.isRequired,
        shortShareUrl: PropTypes.string.isRequired,
        shortCodeDraft: PropTypes.string.isRequired,
        shortLinkError: PropTypes.string.isRequired,
        shortLinkLoading: PropTypes.bool.isRequired,
        shortLinkCopied: PropTypes.bool.isRequired,
        handleCopyLink: PropTypes.func.isRequired,
        handleGenerateShortLink: PropTypes.func.isRequired,
        handleSaveCustomShortLink: PropTypes.func.isRequired,
        handleCopyShortLink: PropTypes.func.isRequired,
        handleShortCodeDraftChange: PropTypes.func.isRequired,
    }).isRequired,
    isAdmin: PropTypes.bool.isRequired,
};
