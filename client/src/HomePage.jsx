import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input, Button } from '@/components/ui/input';

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
                <Input
                    type="text"
                    value={newDiscussion}
                    onChange={(e) => setNewDiscussion(e.target.value)}
                    placeholder="Enter discussion topic"
                    className="flex-grow"
                />
                <Button onClick={handleCreateDiscussion}>Create</Button>
            </div>
        </div>
    );
};

export default HomePage;
