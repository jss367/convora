// How this browser identifies itself to the REST endpoints that return question
// results (summary, opinion groups, snapshots, exports). When a discussion shows
// results only after voting, the server uses these to decide which questions'
// results this viewer may see; a request without them is treated as a
// participant who has answered nothing.

import { getIdentity } from './identity';

export const RESULTS_HIDDEN_HINT = 'Results appear after you vote';

// Header values must be plain visible ASCII or fetch() throws.
const isHeaderSafe = value => typeof value === 'string' && /^[\x21-\x7e]+$/.test(value);

// Sent as headers, never in the URL: the participant id is the secret that owns
// this browser's votes, and URLs end up in logs and history.
export function viewerHeaders(discussionSlug) {
    const headers = {};
    try {
        const userId = getIdentity()?.userId;
        if (isHeaderSafe(userId)) headers['X-Convora-User'] = userId;
        const token = localStorage.getItem(`convora_admin_${discussionSlug}`);
        if (isHeaderSafe(token)) headers['X-Convora-Moderator'] = token;
    } catch (e) {
        console.warn('Failed to read viewer identity:', e);
    }
    return headers;
}

// Click handler for an export link. A plain link cannot carry the headers above,
// so fetch the file with them and hand the result to the browser as a download.
// If that fails the link is followed normally, which exports what an anonymous
// viewer may see.
export async function downloadForViewer(event, discussionSlug) {
    const href = event.currentTarget.href;
    event.preventDefault();
    try {
        const response = await fetch(href, { headers: viewerHeaders(discussionSlug) });
        if (!response.ok) throw new Error(`Export failed with status ${response.status}`);
        const disposition = response.headers.get('Content-Disposition') || '';
        const filename = /filename="([^"]+)"/.exec(disposition)?.[1] || href.split('/').pop();
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
        console.warn('Falling back to a plain export download:', e);
        window.location.assign(href);
    }
}
