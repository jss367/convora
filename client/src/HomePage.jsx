import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'https://convora-e40a9ae358dc.herokuapp.com/';

const HomePage = () => {
    const [discussions, setDiscussions] = useState([]);
    const [newDiscussion, setNewDiscussion] = useState('');
    const navigate = useNavigate();

    useEffect(() => {
        const fetchDiscussions = async () => {
            try {
                const response = await fetch('/api/discussions');
                if (!response.ok) {
                    throw new Error('Failed to fetch discussions');
                }
                const data = await response.json();
                setDiscussions(data);
            } catch (error) {
                console.error('Error fetching discussions:', error);
            }
        };

        fetchDiscussions();

        const socket = io(SOCKET_URL);
        socket.on('newDiscussion', (newDiscussion) => {
            setDiscussions(prevDiscussions => [newDiscussion, ...prevDiscussions]);
        });

        return () => {
            socket.disconnect();
        };
    }, []);

    const handleCreateDiscussion = async () => {
        if (newDiscussion.trim() !== '') {
            const discussionId = newDiscussion.toLowerCase().replace(/\s+/g, '-');
            try {
                const response = await fetch('/api/discussions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ topic: newDiscussion }),
                });
                if (!response.ok) {
                    throw new Error('Failed to create discussion');
                }
                navigate(`/discussion/${discussionId}`);
            } catch (error) {
                console.error('Error creating discussion:', error);
            }
        }
    };

    return (
        <div className="max-w-4xl mx-auto mt-10">
            <h1 className="text-4xl font-bold mb-8 text-center text-gray-800">Convora Discussions</h1>

            <div className="mb-8">
                <h2 className="text-xl font-bold mb-4">Create a New Discussion</h2>
                <div className="flex space-x-2">
                    <input
                        type="text"
                        value={newDiscussion}
                        onChange={(e) => setNewDiscussion(e.target.value)}
                        placeholder="Enter discussion topic"
                        className="flex-grow p-2 border rounded"
                    />
                    <button onClick={handleCreateDiscussion} className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition duration-300">Create</button>
                </div>
            </div>

            <h2 className="text-2xl font-bold mb-4">Existing Discussions</h2>
            <div className="grid gap-6">
                {discussions.map(discussion => (
                    <Link
                        key={discussion.id}
                        to={`/discussion/${discussion.topic}`}
                        className="bg-white shadow-lg rounded-lg p-6 hover:shadow-xl transition duration-300"
                    >
                        <h2 className="text-xl font-semibold mb-2">{discussion.topic}</h2>
                        <p className="text-gray-600">Created: {new Date(discussion.created_at).toLocaleString()}</p>
                    </Link>
                ))}
            </div>
        </div>
    );
};

export default HomePage;
