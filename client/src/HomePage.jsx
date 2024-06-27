import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from './firebase';
import { doc, setDoc } from 'firebase/firestore';

const HomePage = () => {
    const [newDiscussion, setNewDiscussion] = useState('');
    const navigate = useNavigate();

    const handleCreateDiscussion = async () => {
        if (newDiscussion.trim() !== '') {
            const discussionId = newDiscussion.toLowerCase().replace(/\s+/g, '-');
            await setDoc(doc(db, 'discussions', discussionId), {
                title: newDiscussion,
                createdAt: new Date()
            });
            navigate(`/${discussionId}`);
        }
    };

    return (
        <div className="max-w-2xl mx-auto mt-10">
            <h2 className="text-3xl font-bold mb-6 text-center text-gray-800">Create a New Discussion</h2>
            <div className="bg-white shadow-md rounded-lg p-6">
                <input
                    type="text"
                    value={newDiscussion}
                    onChange={(e) => setNewDiscussion(e.target.value)}
                    placeholder="Enter discussion topic"
                    className="w-full p-3 border border-gray-300 rounded-md mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                    onClick={handleCreateDiscussion}
                    className="w-full bg-primary text-white py-3 rounded-md hover:bg-opacity-90 transition"
                >
                    Create Discussion
                </button>
            </div>
        </div>
    );
};

export default HomePage;
