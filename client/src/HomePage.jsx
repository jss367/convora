import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getKnownDiscussions, reconcileKnownDiscussions, rememberDiscussion } from './knownDiscussions';
import { moderatorLinkPromptState } from './ModeratorLinkPanel';

const HomePage = () => {
    // Discussions are unlisted, so this is only what this browser created or
    // opened (see knownDiscussions.js), never a server-wide list.
    const [discussions, setDiscussions] = useState(getKnownDiscussions);
    const [newDiscussion, setNewDiscussion] = useState('');
    // True while a create request is in flight, so a repeated Enter or a
    // double click can't create the discussion twice.
    const creatingRef = useRef(false);
    const navigate = useNavigate();

    useEffect(() => {
        const slugs = getKnownDiscussions().map(discussion => discussion.slug);
        if (slugs.length === 0) return undefined;

        let cancelled = false;
        // Refresh titles and drop remembered discussions that no longer exist.
        // If the request fails, keep showing what the browser remembers.
        const refreshDiscussions = async () => {
            try {
                const response = await fetch(`/api/discussions?slugs=${slugs.join(',')}`);
                if (!response.ok) {
                    throw new Error('Failed to fetch discussions');
                }
                const found = await response.json();
                if (!cancelled && Array.isArray(found)) {
                    setDiscussions(reconcileKnownDiscussions(slugs, found));
                }
            } catch (error) {
                console.error('Error fetching discussions:', error);
            }
        };

        refreshDiscussions();
        return () => {
            cancelled = true;
        };
    }, []);

    const handleCreateDiscussion = async (event) => {
        // Submitted from the form (Enter or the Create button); stop the
        // browser's native submit from reloading the page.
        event?.preventDefault();
        const topic = newDiscussion.trim();
        if (topic !== '' && !creatingRef.current) {
            creatingRef.current = true;
            try {
                const response = await fetch('/api/discussions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ topic }),
                });
                if (!response.ok) {
                    throw new Error('Failed to create discussion');
                }
                const discussion = await response.json();
                // The creator is the moderator: the server hands back an admin
                // token when this request established the discussion. Persist it
                // under the canonical slug key DiscussionPage reads on mount.
                if (discussion && discussion.adminToken) {
                    try {
                        localStorage.setItem(`convora_admin_${discussion.slug}`, discussion.adminToken);
                    } catch (e) {
                        console.warn('Failed to store admin token:', e);
                    }
                }
                rememberDiscussion(discussion);
                // Only the creator gets a token back; prompt them to save the link.
                navigate(`/discussion/${discussion.slug}`, discussion?.adminToken
                    ? { state: moderatorLinkPromptState(discussion.slug) } : undefined);
            } catch (error) {
                console.error('Error creating discussion:', error);
            } finally {
                creatingRef.current = false;
            }
        }
    };

    // Entries seeded from a stored moderator token have no title until the
    // server confirms them.
    const listedDiscussions = discussions.filter(discussion => discussion.topic);

    return (
        <div className="max-w-4xl mx-auto mt-10">
            <h1 className="text-4xl font-bold mb-8 text-center text-gray-800">Convora Discussions</h1>

            <div className="mb-8">
                <h2 className="text-xl font-bold mb-4">Create a New Discussion</h2>
                <form onSubmit={handleCreateDiscussion} className="flex space-x-2">
                    <input
                        type="text"
                        value={newDiscussion}
                        onChange={(e) => setNewDiscussion(e.target.value)}
                        placeholder="Enter discussion topic"
                        className="flex-grow p-2 border rounded"
                    />
                    <button type="submit" className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90 transition duration-300">Create</button>
                </form>
            </div>

            <h2 className="text-2xl font-bold mb-4">Your Discussions</h2>
            {listedDiscussions.length === 0 ? (
                <p className="text-gray-600">
                    Discussions you create or open in this browser will appear here.
                    Discussions are unlisted: only people with the link can find them.
                </p>
            ) : (
                <div className="grid gap-6">
                    {listedDiscussions.map(discussion => (
                        <Link
                            key={discussion.slug}
                            to={`/discussion/${discussion.slug}`}
                            className="bg-white shadow-lg rounded-lg p-6 hover:shadow-xl transition duration-300"
                        >
                            <h2 className="text-xl font-semibold mb-2">{discussion.topic}</h2>
                            {discussion.created_at && (
                                <p className="text-gray-600">Created: {new Date(discussion.created_at).toLocaleString()}</p>
                            )}
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
};

export default HomePage;
