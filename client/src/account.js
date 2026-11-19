export async function accountRequest(path = '', body) {
    const headers = { 'X-Convora-Account': '1' };
    const options = { headers, cache: 'no-store' };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.method = 'POST';
        options.body = JSON.stringify(body);
    }
    const response = await fetch('/api/account' + path, options);
    if (!response.ok) throw new Error('Account request failed');
    return response.status === 204 ? null : response.json();
}

// Sharing this request avoids looking up the session for every result or vote.
let session;
export function getAccount() {
    if (!session) session = accountRequest().catch(error => {
        session = null;
        throw error;
    });
    return session;
}

export async function accountToken(slug) {
    if (!(await getAccount()).signedIn) return null;
    return (await accountRequest('/access/' + encodeURIComponent(slug))).token;
}

export function sessionChanged() {
    try { localStorage.setItem('convora_session_changed', String(Date.now())); } catch { /* storage optional */ }
    window.location.reload();
}
