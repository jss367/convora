import PropTypes from 'prop-types';
import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import io from 'socket.io-client';

const VERSION = '0.1.7';
console.log('Convora version:', VERSION);

const QuestionTypes = {
    AGREEMENT: 'Agreement',
    NUMERICAL: 'Numerical',
    // MULTIPLE_CHOICE: 'Multiple Choice',
    // CHECKBOX: 'Checkbox',
    // RANKING: 'Ranking',
    OPEN_ENDED: 'Open Ended'
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

console.log('Environment SOCKET_URL:', process.env.REACT_APP_SOCKET_URL);

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'https://convora-e40a9ae358dc.herokuapp.com/';
// Environmental variables are not being passed, so hard-code it here.

const socket = io(SOCKET_URL);

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
    const [optionsText, setOptionsText] = useState('');
    const [error, setError] = useState(null);

    useEffect(() => {
        setUserId(Math.random().toString(36).substr(2, 9));
    }, []);

    const handleQuestionsUpdate = useCallback((updatedQuestions) => {
        console.log('Received updated questions:', updatedQuestions);
        setQuestions(prevQuestions => {
            const questionMap = new Map(prevQuestions.map(q => [q.id, q]));
            updatedQuestions.forEach(q => {
                if (questionMap.has(q.id)) {
                    // Merge the new question data with the existing data,
                    // ensuring we keep the votes array
                    questionMap.set(q.id, {
                        ...questionMap.get(q.id),
                        ...q,
                        votes: q.votes || questionMap.get(q.id).votes || []
                    });
                } else {
                    questionMap.set(q.id, { ...q, timestamp: Date.now(), votes: q.votes || [] });
                }
            });
            return Array.from(questionMap.values());
        });
    }, []);

    useEffect(() => {
        console.log('Current topic:', topic);
        socket.emit('joinDiscussion', topic);
        socket.on('questions', handleQuestionsUpdate);
        return () => {
            socket.off('questions', handleQuestionsUpdate);
        };
    }, [topic, handleQuestionsUpdate]);

    const handleAddQuestion = () => {
        console.log('Inside handleAddQuestion');

        // Check if question text is empty
        if (newQuestion.trim() === '') {
            console.error('Failed to add question: Question text is empty.');
            // You might want to set an error state here to display to the user
            setError('Question text cannot be empty.');
            return;
        }

        let question = {
            text: newQuestion.trim(),
            type: questionType,
            timestamp: Date.now(),
        };

        // Handle numerical questions
        if (questionType === QuestionTypes.NUMERICAL) {
            if (minValue >= maxValue) {
                console.error('Failed to add question: Min value must be less than max value.');
                setError('Minimum value must be less than maximum value.');
                return;
            }
            question.minValue = parseInt(minValue);
            question.maxValue = parseInt(maxValue);
            console.log('Adding numerical question with min:', question.minValue, 'max:', question.maxValue);
        }

        // Handle questions with options
        if ([QuestionTypes.MULTIPLE_CHOICE, QuestionTypes.CHECKBOX, QuestionTypes.RANKING].includes(questionType)) {
            const options = optionsText.split('\n').filter(option => option.trim() !== '');
            if (options.length < 2) {
                console.error('Failed to add question: Not enough options provided.');
                setError('Please provide at least two options.');
                return;
            }
            question.options = options;
        }

        console.log('Adding question:', question);

        try {
            socket.emit('addQuestion', topic, question);

            // Reset form
            setNewQuestion('');
            setQuestionType(QuestionTypes.AGREEMENT);
            setMinValue(0);
            setMaxValue(100);
            setOptionsText('');
            // Clear any previous errors
            setError(null);
        } catch (error) {
            console.error('Error emitting addQuestion event:', error);
            setError('Failed to add question. Please try again.');
        }
    };

    const handleVote = (questionId, value) => {
        console.log('Voting:', questionId, value);
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
        const userVote = question.votes ? question.votes.find(v => v.userId === userId) : null;

        if (!question || typeof question !== 'object') {
            console.error('Invalid question object:', question);
            return null;
        }

        switch (question.type) {
            case QuestionTypes.AGREEMENT:
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
            case QuestionTypes.NUMERICAL: {
                const minValue = parseInt(question.minValue) || 0;
                const maxValue = parseInt(question.maxValue) || 100;
                const defaultValue = Math.floor((minValue + maxValue) / 2);
                console.log("Question min:", minValue, "max:", maxValue, "default:", defaultValue);
                const sliderValue = sliderValues[question.id] !== undefined
                    ? sliderValues[question.id]
                    : (userVote
                        ? parseInt(userVote.value)
                        : defaultValue);
                return (
                    <div className="mt-4">
                        <input
                            type="range"
                            min={minValue}
                            max={maxValue}
                            value={sliderValue}
                            className="w-full"
                            onChange={(e) => handleSliderChange(question.id, parseInt(e.target.value))}
                        />
                        <div className="flex justify-between mt-2">
                            <span>{minValue}</span>
                            <span>{sliderValue}</span>
                            <span>{maxValue}</span>
                        </div>
                        <button
                            onClick={() => handleVote(question.id, sliderValue)}
                            className={`mt-4 px-4 py-2 rounded-md transition duration-300 ${userVote ? 'bg-primary text-white hover:bg-opacity-90' : 'bg-secondary text-white hover:bg-opacity-90'}`}
                        >
                            {userVote ? 'Update Vote' : 'Submit'}
                        </button>
                    </div>
                );
            }
            case QuestionTypes.MULTIPLE_CHOICE: {
                if (!Array.isArray(question.options)) {
                    console.error('Invalid options for multiple choice question:', question);
                    return null;
                }
                return (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {question.options.map((option) => (
                            <button
                                key={option}
                                onClick={() => handleVote(question.id, option)}
                                className={`p-2 rounded-md transition duration-300 ${userVote && userVote.value === option
                                    ? 'bg-primary text-white'
                                    : 'bg-secondary text-white hover:bg-opacity-90'
                                    }`}
                            >
                                {option}
                            </button>
                        ))}
                    </div>
                );
            }
            case QuestionTypes.CHECKBOX: {
                if (optionsText.length === 0) {
                    console.error('Invalid or missing options for checkbox question:', question);
                    return <p>Error: This question has no options.</p>;
                }
                return (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {optionsText.map((option) => (
                            <label key={option} className="flex items-center space-x-2">
                                <input
                                    type="checkbox"
                                    checked={userVote && Array.isArray(userVote.value) && userVote.value.includes(option)}
                                    onChange={() => {
                                        const newValue = userVote && Array.isArray(userVote.value)
                                            ? userVote.value.includes(option)
                                                ? userVote.value.filter(v => v !== option)
                                                : [...userVote.value, option]
                                            : [option];
                                        handleVote(question.id, newValue);
                                    }}
                                />
                                <span>{option}</span>
                            </label>
                        ))}
                    </div>
                );
            }

            case QuestionTypes.RANKING: {
                if (!Array.isArray(question.options)) {
                    console.error('Invalid options for ranking question:', question);
                    return null;
                }
                const [rankingOrder, setRankingOrder] = useState(userVote ? userVote.value : question.options);

                useEffect(() => {
                    if (userVote && Array.isArray(userVote.value)) {
                        setRankingOrder(userVote.value);
                    }
                }, [userVote]);

                return (
                    <div>
                        {rankingOrder.map((option, index) => (
                            <div key={option} className="flex items-center space-x-2 mb-2">
                                <span>{index + 1}.</span>
                                <span>{option}</span>
                                <button
                                    onClick={() => {
                                        const newOrder = [...rankingOrder];
                                        if (index > 0) {
                                            [newOrder[index], newOrder[index - 1]] = [newOrder[index - 1], newOrder[index]];
                                            setRankingOrder(newOrder);
                                            handleVote(question.id, newOrder);
                                        }
                                    }}
                                    className="p-1 bg-secondary text-white rounded"
                                    disabled={index === 0}
                                >
                                    ▲
                                </button>
                                <button
                                    onClick={() => {
                                        const newOrder = [...rankingOrder];
                                        if (index < rankingOrder.length - 1) {
                                            [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
                                            setRankingOrder(newOrder);
                                            handleVote(question.id, newOrder);
                                        }
                                    }}
                                    className="p-1 bg-secondary text-white rounded"
                                    disabled={index === rankingOrder.length - 1}
                                >
                                    ▼
                                </button>
                            </div>
                        ))}
                    </div>
                );
            }
            case QuestionTypes.OPEN_ENDED: {
                return <OpenEndedQuestion question={question} userVote={userVote} handleVote={handleVote} />;
            }

            default:
                console.warn('Unknown question type:', question.type);
                return null;
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
                {[QuestionTypes.MULTIPLE_CHOICE, QuestionTypes.CHECKBOX, QuestionTypes.RANKING].includes(questionType) && (
                    <div className="mb-4">
                        <label className="block mb-2">Options (one per line):</label>
                        <textarea
                            value={optionsText}
                            onChange={(e) => setOptionsText(e.target.value)}
                            className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                            rows="4"
                        />
                    </div>
                )}
                <button
                    onClick={handleAddQuestion}
                    className="w-full bg-primary text-white py-3 rounded-md hover:bg-opacity-90 transition duration-300"
                >
                    Add Question
                </button>
                {error && <div className="text-red-500 mt-2">{error}</div>}
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
const OpenEndedQuestion = ({ question, userVote, handleVote }) => {
    const [response, setResponse] = useState(userVote ? userVote.value : '');

    useEffect(() => {
        setResponse(userVote ? userVote.value : '');
    }, [userVote]);

    return (
        <div>
            <textarea
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                className="w-full p-2 border rounded mb-2"
                rows="4"
                placeholder="Enter your response here"
            />
            <button
                onClick={() => {
                    console.log('Submitting open-ended response:', response);
                    handleVote(question.id, response);
                }}
                className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90 transition duration-300 mb-4"
            >
                {userVote ? 'Update Response' : 'Submit Response'}
            </button>

            {question.votes && question.votes.length > 0 && (
                <div className="mt-4">
                    <h3 className="font-semibold mb-2">All Responses:</h3>
                    <ul className="list-disc pl-5">
                        {question.votes.map((vote, index) => (
                            <li key={index} className="mb-2">
                                {vote.value}
                                {vote.userId === userVote?.userId && " (Your response)"}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
};

OpenEndedQuestion.propTypes = {
    question: PropTypes.shape({
        id: PropTypes.string.isRequired,
        votes: PropTypes.arrayOf(PropTypes.shape({
            userId: PropTypes.string.isRequired,
            value: PropTypes.string.isRequired
        }))
    }).isRequired,
    userVote: PropTypes.shape({
        userId: PropTypes.string.isRequired,
        value: PropTypes.string
    }),
    handleVote: PropTypes.func.isRequired
};
export default DiscussionPage;
