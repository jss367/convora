import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountRequest, getAccount, sessionChanged } from './account';
import { storedModeratorKeys } from './knownDiscussions';

export function AccountNav() {
    const [enabled, setEnabled] = useState(false);
    useEffect(() => {
        getAccount().then(data => setEnabled(!!data.clientId)).catch(() => {});
        const changed = event => {
            if (event.key === 'convora_session_changed') window.location.reload();
        };
        window.addEventListener('storage', changed);
        return () => window.removeEventListener('storage', changed);
    }, []);
    return enabled && <Link to="/account" className="text-white underline">My discussions</Link>;
}

export default function AccountPage() {
    const [account, setAccount] = useState(null);
    const [rooms, setRooms] = useState(null);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const button = useRef(null);

    useEffect(() => {
        let active = true;
        async function load() {
            const info = await getAccount();
            if (!active) return;
            setAccount(info);
            if (info.signedIn) {
                const list = await accountRequest('/discussions');
                if (active) setRooms(list);
            }
        }
        load().catch(() => { if (active) setMessage('Could not load your account. Reload to try again.'); });
        return () => { active = false; };
    }, []);

    useEffect(() => {
        if (!account?.clientId || account.signedIn) return;
        let active = true;
        const render = () => {
            if (!active || !button.current) return;
            const google = window.google.accounts.id;
            google.initialize({
                client_id: account.clientId,
                callback: async ({ credential }) => {
                    if (!active) return;
                    try {
                        await accountRequest('/login', { credential });
                        sessionChanged();
                    } catch { setMessage('Sign-in failed. Please try again.'); }
                },
            });
            google.renderButton(button.current, { theme: 'outline', size: 'large' });
        };
        const script = document.createElement('script');
        if (window.google?.accounts?.id) render();
        else {
            script.src = 'https://accounts.google.com/gsi/client';
            script.onload = render;
            script.onerror = () => setMessage('Could not load Google sign-in. Reload to try again.');
            document.head.appendChild(script);
        }
        return () => { active = false; script.remove(); };
    }, [account]);

    async function link() {
        setBusy(true);
        try {
            const proofs = storedModeratorKeys().map(slug => ({
                slug, token: localStorage.getItem('convora_admin_' + slug),
            })).filter(d => d.token);
            let linked = 0;
            for (let i = 0; i < proofs.length; i += 100) {
                const result = await accountRequest('/link', { discussions: proofs.slice(i, i + 100) });
                linked += result.linked;
            }
            setRooms(await accountRequest('/discussions'));
            setMessage(linked ? `Linked ${linked} discussion${linked === 1 ? '' : 's'}.` : 'No new creator links found in this browser.');
        } catch { setMessage('Could not finish linking your discussions. Try again.'); }
        finally { setBusy(false); }
    }

    async function logout() {
        try {
            await accountRequest('/logout', {});
            sessionChanged();
        } catch { setMessage('Could not sign out. Try again.'); }
    }

    return <section className="mx-auto mt-10 max-w-2xl space-y-5">
        <h1 className="text-3xl font-bold">My discussions</h1>
        {account && !account.signedIn && <>
            <p>{account.clientId ? 'Sign in to moderate your discussions across devices. You can also keep using Convora without an account.' : 'Account sign-in is unavailable on this site.'}</p>
            <div ref={button} />
        </>}
        {account?.signedIn && <>
            <div className="flex items-center justify-between">
                <span>{account.email || 'Signed in with Google'}</span>
                <button className="text-primary underline" onClick={logout}>Sign out</button>
            </div>
            <p>New discussions appear here automatically. Link discussions you already moderate from this browser using their saved creator links.</p>
            <button className="rounded bg-primary px-4 py-2 text-white" disabled={busy} onClick={link}>{busy ? 'Linking…' : 'Link my discussions'}</button>
            {rooms?.length === 0 && <p>No discussions linked yet.</p>}
            <ul className="space-y-2">{rooms?.map(room => <li key={room.slug}>
                <Link className="text-primary underline" to={'/discussion/' + room.slug}>{room.topic}</Link>
            </li>)}</ul>
        </>}
        <p role="status">{message || (!account || (account.signedIn && rooms === null) ? 'Loading…' : '')}</p>
    </section>;
}
