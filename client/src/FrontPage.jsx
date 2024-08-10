import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import io from 'socket.io-client';

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'https://convora-e40a9ae358dc.herokuapp.com/';

const HomePage = () => {
    const [discussions, setDiscussions] = useState([]);

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

    return (
        <div className="max-w-4xl mx-auto mt-10">
            <h1 className="text-4xl font-bold mb-8 text-center text-gray-800">Convora Discussions</h1>
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
