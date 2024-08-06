import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';

const VERSION = '0.0.4';

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

const SortOptions = {
    MOST_RECENT: 'Most Recent',
    MOST_AGREEMENT: 'Most Agreement',
    MOST_DISAGREEMENT: 'Most Disagreement',
    MOST_CONTROVERSIAL: 'Most Controversial',
};

// const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'https://convora-e40a9ae358dc.herokuapp.com/';
// Environmental variables are not being passed, so hard-code it here.
const SOCKET_URL = 'http://localhost:3001' || 'https://convora-e40a9ae358dc.herokuapp.com/';

const socket = io(SOCKET_URL);
console.log('Environment SOCKET_URL:', process.env.REACT_APP_SOCKET_URL);
console.log('Socket created with URL:', SOCKET_URL);


const DiscussionPage = () => {
    const { topic } = useParams();
    const [questions, setQuestions] = useState([]);
    const [newQuestion, setNewQuestion] = useState('');
    const [questionType, setQuestionType] = useState(QuestionTypes.AGREEMENT);
    const [minValue, setMinValue] = useState(0);
    const [maxValue, setMaxValue] = useState(100);
    const [sliderValues, setSliderValues] = useState({});
    const [sortOption, setSortOption] = useState(SortOptions.MOST_RECENT);
    const [showUnansweredOnly, setShowUnansweredOnly] = useState(false);
    const [userId, setUserId] = useState(null);

    useEffect(() => {
        // Generate a unique user ID for this session
        setUserId(Math.random().toString(36).substr(2, 9));
    }, []);

    const handleQuestionsUpdate = useCallback((updatedQuestions) => {
        console.log('Received updated questions:', updatedQuestions);
        setQuestions(prevQuestions => {
            const questionMap = new Map(prevQuestions.map(q => [q.id, q]));
            updatedQuestions.forEach(q => {
                if (questionMap.has(q.id)) {
                    // Merge the new question data with the existing data,
                    // preserving the timestamp if it exists
                    questionMap.set(q.id, { ...questionMap.get(q.id), ...q });
                } else {
                    // For new questions, add them with the current timestamp
                    questionMap.set(q.id, { ...q, timestamp: Date.now() });
                }
            });
            return Array.from(questionMap.values());
        });
    }, []);

    useEffect(() => {
        console.log('useEffect running');
        console.log('Current topic:', topic);

        socket.emit('joinDiscussion', topic);
        console.log('Emitted joinDiscussion event with topic:', topic);

        socket.on('questions', handleQuestionsUpdate);
        console.log('Set up questions event listener');

        return () => {
            console.log('Leaving discussion:', topic);
            socket.off('questions', handleQuestionsUpdate);
        };
    }, [topic, handleQuestionsUpdate]);

    const handleAddQuestion = () => {
        console.log('handleAddQuestion called');
        console.log('Current topic:', topic);
        console.log('New question:', newQuestion);
        console.log('Question type:', questionType);

        if (newQuestion.trim() !== '') {
            const question = {
                text: newQuestion,
                type: questionType,
                minValue: questionType === QuestionTypes.NUMERICAL ? minValue : null,
                maxValue: questionType === QuestionTypes.NUMERICAL ? maxValue : null,
                timestamp: Date.now(),
            };
            console.log('Emitting addQuestion event with topic:', topic);
            console.log('Question object:', question);
            socket.emit('addQuestion', topic, question);
            setNewQuestion('');
            setQuestionType(QuestionTypes.AGREEMENT);
            setMinValue(0);
            setMaxValue(100);
        } else {
            console.log('New question is empty, not adding');
        }
    };

    const handleVote = (questionId, value) => {
        socket.emit('vote', topic, questionId, value, userId);
        setSliderValues(prev => ({ ...prev, [questionId]: undefined }));
    };

    const handleSliderChange = (questionId, value) => {
        setSliderValues(prev => ({ ...prev, [questionId]: value }));
    };


    const sortQuestions = (questions) => {
        switch (sortOption) {
            case SortOptions.MOST_RECENT:
                return [...questions].sort((a, b) => b.timestamp - a.timestamp);
            case SortOptions.MOST_AGREEMENT:
                return [...questions].sort((a, b) => getAgreementCount(b) - getAgreementCount(a));
            case SortOptions.MOST_DISAGREEMENT:
                return [...questions].sort((a, b) => getDisagreementCount(b) - getDisagreementCount(a));
            case SortOptions.MOST_CONTROVERSIAL:
                return [...questions].sort((a, b) => getControversyScore(b) - getControversyScore(a));
            default:
                return questions;
        }
    };

    const getAgreementCount = (question) => {
        return (question.votes || []).filter(v => v.value === VoteOptions.STRONGLY_AGREE || v.value === VoteOptions.AGREE).length;
    };

    const getDisagreementCount = (question) => {
        return (question.votes || []).filter(v => v.value === VoteOptions.STRONGLY_DISAGREE || v.value === VoteOptions.DISAGREE).length;
    };

    const getControversyScore = (question) => {
        const agreementCount = getAgreementCount(question);
        const disagreementCount = getDisagreementCount(question);
        return Math.min(agreementCount, disagreementCount);
    };

    const filterQuestions = (questions) => {
        if (!showUnansweredOnly) {
            return questions;
        }
        return questions.filter(question =>
            !question.votes || !question.votes.some(vote => vote.userId === userId)
        );
    };


    const renderVotingMechanism = (question) => {
        if (question.type === QuestionTypes.AGREEMENT) {
            const userVote = question.votes.find(v => v.userId === userId);
            return (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {Object.values(VoteOptions).map((option) => (
                        <div key={option} className="flex items-center justify-between bg-gray-100 p-3 rounded-md">
                            <span className="font-medium">
                                {option}: {question.votes ? question.votes.filter(v => v.value === option).length : 0}
                            </span>
                            <button
                                onClick={() => handleVote(question.id, option)}
                                className={`px-4 py-2 rounded-md transition duration-300 ${userVote && userVote.value === option
                                    ? 'bg-primary text-white hover:bg-opacity-90'
                                    : 'bg-secondary text-white hover:bg-opacity-90'
                                    }`}
                            >
                                {userVote && userVote.value === option ? 'Undo Vote' : 'Vote'}
                            </button>
                        </div>
                    ))}
                </div>
            );
        } else {
            const userVote = question.votes.find(v => v.userId === userId);
            const sliderValue = sliderValues[question.id] !== undefined
                ? sliderValues[question.id]
                : (userVote
                    ? userVote.value
                    : Math.floor((question.max_value + question.min_value) / 2));

            return (
                <div className="mt-4">
                    <input
                        type="range"
                        min={question.min_value}
                        max={question.max_value}
                        value={sliderValue}
                        className="w-full"
                        onChange={(e) => handleSliderChange(question.id, parseInt(e.target.value))}
                    />
                    <div className="flex justify-between mt-2">
                        <span>{question.min_value}</span>
                        <span>{sliderValue}</span>
                        <span>{question.max_value}</span>
                    </div>
                    <button
                        onClick={() => handleVote(question.id, sliderValue)}
                        className={`mt-4 px-4 py-2 rounded-md transition duration-300 ${userVote ? 'bg-primary text-white hover:bg-opacity-90' : 'bg-secondary text-white hover:bg-opacity-90'
                            }`}
                    >
                        {userVote ? 'Update Vote' : 'Submit'}
                    </button>
                    {question.votes && question.votes.length > 0 && (
                        <div className="mt-4">
                            <h3 className="font-semibold">Responses:</h3>
                            <ul className="list-disc pl-5">
                                {question.votes.map((vote, index) => (
                                    <li key={index}>{vote.value}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            );
        }
    };

    const sortedAndFilteredQuestions = filterQuestions(sortQuestions(questions));

    return (
        <div className="max-w-4xl mx-auto mt-10 px-4">
            <h1 className="text-4xl font-bold mb-8 text-center text-gray-800">Discussion: {topic}</h1>
            <div className="text-right mb-4 text-gray-500">Version: {VERSION}</div>
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
            {/* Sorting and filtering controls */}
            <div className="mb-6 flex justify-between items-center">
                <select
                    value={sortOption}
                    onChange={(e) => setSortOption(e.target.value)}
                    className="p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                >
                    {Object.values(SortOptions).map(option => (
                        <option key={option} value={option}>{option}</option>
                    ))}
                </select>
                <label className="flex items-center">
                    <input
                        type="checkbox"
                        checked={showUnansweredOnly}
                        onChange={(e) => setShowUnansweredOnly(e.target.checked)}
                        className="mr-2"
                    />
                    Show unanswered only
                </label>
            </div>

            {/* Questions list */}
            {sortedAndFilteredQuestions.map((question) => (
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
