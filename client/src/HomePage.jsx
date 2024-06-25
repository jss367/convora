import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const HomePage = () => {
    const [newDiscussion, setNewDiscussion] = useState('');
    const navigate = useNavigate();

    const handleCreateDiscussion = () => {
        if (newDiscussion.trim() !== '') {
            const discussionId = newDiscussion.toLowerCase().replace(/\s+/g, '-');
            navigate(`/${discussionId}`);
        }
    };

    return (
        <div className="max-w-md mx-auto">
            <h2 className="text-xl font-bold mb-4">Create a New Discussion</h2>
            <div className="flex space-x-2">
                <input
                    type="text"
                    value={newDiscussion}
                    onChange={(e) => setNewDiscussion(e.target.value)}
                    placeholder="Enter discussion topic"
                    className="flex-grow p-2 border rounded"
                />
                <button onClick={handleCreateDiscussion} className="px-4 py-2 bg-blue-500 text-white rounded">Create</button>
            </div>
        </div>
    );
};

export default HomePage;
