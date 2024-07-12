import React, { useState } from 'react';
import { useParams } from 'react-router-dom';

const QuestionTypes = {
    AGREEMENT: 'Agreement',
    NUMERICAL: 'Numerical',
};

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
    const [questionType, setQuestionType] = useState(QuestionTypes.AGREEMENT);
    const [minValue, setMinValue] = useState(0);
    const [maxValue, setMaxValue] = useState(100);
    const [sliderValues, setSliderValues] = useState({});

    const handleAddQuestion = () => {
        if (newQuestion.trim() !== '') {
            setQuestions([
                ...questions,
                {
                    id: Date.now(),
                    text: newQuestion,
                    type: questionType,
                    votes: questionType === QuestionTypes.AGREEMENT
                        ? Object.fromEntries(Object.values(VoteOptions).map(option => [option, 0]))
                        : [],
                    minValue: questionType === QuestionTypes.NUMERICAL ? minValue : null,
                    maxValue: questionType === QuestionTypes.NUMERICAL ? maxValue : null,
                },
            ]);
            setNewQuestion('');
            setQuestionType(QuestionTypes.AGREEMENT);
            setMinValue(0);
            setMaxValue(100);
        }
    };

    const handleVote = (questionId, value) => {
        setQuestions(questions.map(q => {
            if (q.id === questionId) {
                if (q.type === QuestionTypes.AGREEMENT) {
                    return { ...q, votes: { ...q.votes, [value]: q.votes[value] + 1 } };
                } else {
                    return { ...q, votes: [...q.votes, value] };
                }
            }
            return q;
        }));
        // Reset the slider value after submission
        setSliderValues(prev => ({ ...prev, [questionId]: undefined }));
    };

    const handleSliderChange = (questionId, value) => {
        setSliderValues(prev => ({ ...prev, [questionId]: value }));
    };

    const renderVotingMechanism = (question) => {
        if (question.type === QuestionTypes.AGREEMENT) {
            return (
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
            );
        } else {
            const sliderValue = sliderValues[question.id] !== undefined ? sliderValues[question.id] : Math.floor((question.maxValue + question.minValue) / 2);
            return (
                <div className="mt-4">
                    <input
                        type="range"
                        min={question.minValue}
                        max={question.maxValue}
                        value={sliderValue}
                        className="w-full"
                        onChange={(e) => handleSliderChange(question.id, parseInt(e.target.value))}
                    />
                    <div className="flex justify-between mt-2">
                        <span>{question.minValue}</span>
                        <span>{sliderValue}</span>
                        <span>{question.maxValue}</span>
                    </div>
                    <button
                        onClick={() => handleVote(question.id, sliderValue)}
                        className="mt-4 bg-secondary text-white px-4 py-2 rounded-md hover:bg-opacity-90 transition duration-300"
                    >
                        Submit
                    </button>
                    {question.votes.length > 0 && (
                        <div className="mt-4">
                            <h3 className="font-semibold">Responses:</h3>
                            <ul className="list-disc pl-5">
                                {question.votes.map((vote, index) => (
                                    <li key={index}>{vote}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            );
        }
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
                <div className="mb-4">
                    <label className="block mb-2">Question Type:</label>
                    <select
                        value={questionType}
                        onChange={(e) => setQuestionType(e.target.value)}
                        className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                        {Object.values(QuestionTypes).map(type => (
                            <option key={type} value={type}>{type}</option>
                        ))}
                    </select>
                </div>
                {questionType === QuestionTypes.NUMERICAL && (
                    <div className="mb-4 flex space-x-4">
                        <div className="flex-1">
                            <label className="block mb-2">Min Value:</label>
                            <input
                                type="number"
                                value={minValue}
                                onChange={(e) => setMinValue(parseInt(e.target.value))}
                                className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                        </div>
                        <div className="flex-1">
                            <label className="block mb-2">Max Value:</label>
                            <input
                                type="number"
                                value={maxValue}
                                onChange={(e) => setMaxValue(parseInt(e.target.value))}
                                className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                        </div>
                    </div>
                )}
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
                    <p className="mb-4">Type: {question.type}</p>
                    {renderVotingMechanism(question)}
                </div>
            ))}
        </div>
    );
};

export default DiscussionPage;
