import React, { useState } from 'react';
import { useParams } from 'react-router-dom';

const VoteOptions = {
    STRONGLY_AGREE: 'Strongly Agree',
    AGREE: 'Agree',
    UNSURE: 'Unsure',
    DISAGREE: 'Disagree',
    STRONGLY_DISAGREE: 'Strongly Disagree',
};

const DiscussionPage = () => {
    const { discussionId } = useParams();
    const [questions, setQuestions] = useState([]);
    const [newQuestion, setNewQuestion] = useState('');

    const handleAddQuestion = () => {
        if (newQuestion.trim() !== '') {
            setQuestions([
                ...questions,
                {
                    id: Date.now(),
                    text: newQuestion,
                    votes: Object.fromEntries(Object.values(VoteOptions).map(option => [option, 0])),
                },
            ]);
            setNewQuestion('');
        }
    };

    const handleVote = (questionId, option) => {
        setQuestions(questions.map(q =>
            q.id === questionId ? { ...q, votes: { ...q.votes, [option]: q.votes[option] + 1 } } : q
        ));
    };

    return (
        <div className="max-w-4xl mx-auto mt-10 px-4">
            <h1 className="text-4xl font-bold mb-8 text-center text-gray-800">Discussion: {discussionId}</h1>
            <div className="bg-white shadow-lg rounded-lg p-6 mb-8">
                <input
                    type="text"
                    value={newQuestion}
                    onChange={(e) => setNewQuestion(e.target.value)}
                    placeholder="Enter a new question or statement"
                    className="w-full p-3 border border-gray-300 rounded-md mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                    onClick={handleAddQuestion}
                    className="w-full bg-primary text-white py-3 rounded-md hover:bg-opacity-90 transition duration-300"
                >
                    Add Question
                </button>
            </div>
            {questions.map((question) => (
                <div key={question.id} className="bg-white shadow-lg rounded-lg p-6 mb-6">
                    <h2 className="text-xl font-semibold mb-4">{question.text}</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {Object.entries(question.votes).map(([option, count]) => (
                            <div key={option} className="flex items-center justify-between bg-gray-100 p-3 rounded-md">
                                <span className="font-medium">{option}: {count}</span>
                                <button
                                    onClick={() => handleVote(question.id, option)}
                                    className="bg-secondary text-white px-4 py-2 rounded-md hover:bg-opacity-90 transition duration-300"
                                >
                                    Vote
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
};

export default DiscussionPage;
