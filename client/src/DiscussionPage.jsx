import PropTypes from 'prop-types';
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import io from 'socket.io-client';
import { getIdentity, regeneratePseudonym } from './identity';

const VERSION = '0.1.8';
console.log('Convora version:', VERSION);

const QuestionTypes = {
    AGREEMENT: 'Agreement',
    NUMERICAL: 'Numerical',
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

// Display order for the agreement divergence bar: disagreement (left, red) to
// agreement (right, green). Full literal class names so Tailwind keeps them.
const AGREEMENT_SCALE = [
    { key: VoteOptions.STRONGLY_DISAGREE, label: 'Strongly Disagree', bar: 'bg-red-600', dot: 'bg-red-600' },
    { key: VoteOptions.DISAGREE, label: 'Disagree', bar: 'bg-red-400', dot: 'bg-red-400' },
    { key: VoteOptions.UNSURE, label: 'Unsure', bar: 'bg-gray-400', dot: 'bg-gray-400' },
    { key: VoteOptions.AGREE, label: 'Agree', bar: 'bg-green-400', dot: 'bg-green-400' },
    { key: VoteOptions.STRONGLY_AGREE, label: 'Strongly Agree', bar: 'bg-green-600', dot: 'bg-green-600' },
];

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'https://convora-e40a9ae358dc.herokuapp.com/';
console.log('Environment SOCKET_URL:', SOCKET_URL);

const socket = io(SOCKET_URL);

const DiscussionPage = () => {
    const { topic } = useParams();
    const navigate = useNavigate();
    const [questions, setQuestions] = useState([]);
    const [newQuestion, setNewQuestion] = useState('');
    const [questionType, setQuestionType] = useState(QuestionTypes.AGREEMENT);
    const [minValue, setMinValue] = useState(0);
    const [maxValue, setMaxValue] = useState(100);
    const [sliderValues, setSliderValues] = useState({});
    const [sortOption, setSortOption] = useState(SortOptions.MOST_RECENT);
    const [showUnansweredOnly, setShowUnansweredOnly] = useState(false);
    const [userId, setUserId] = useState(null);
    const [pseudonym, setPseudonym] = useState('');
    const [error, setError] = useState(null);
    const [newTopicName, setNewTopicName] = useState('');
    const [showDuplicateModal, setShowDuplicateModal] = useState(false);

    useEffect(() => {
        const identity = getIdentity();
        setUserId(identity.userId);
        setPseudonym(identity.pseudonym);
    }, []);

    const handleRegeneratePseudonym = () => {
        const updated = regeneratePseudonym();
        setPseudonym(updated.pseudonym);
    };

    const handleDuplicateDiscussion = async () => {
        if (newTopicName.trim() === '') {
            setError('New topic name cannot be empty.');
            return;
        }

        try {
            // Remove any trailing slash from SOCKET_URL and ensure a single leading slash
            const baseUrl = SOCKET_URL.replace(/\/$/, '').replace(/^\/+/, '/');
            const response = await fetch(`${baseUrl}/api/duplicate-discussion`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ originalTopic: topic, newTopic: newTopicName }),
            });

            if (response.ok) {
                const result = await response.json();
                navigate(`/discussion/${result.newTopic}`);
            } else {
                const errorData = await response.json();
                setError(`Failed to duplicate discussion: ${errorData.error}`);
            }
        } catch (error) {
            console.error('Error duplicating discussion:', error);
            setError('An error occurred while duplicating the discussion.');
        }

        setShowDuplicateModal(false);
        setNewTopicName('');
    };

    const handleQuestionsUpdate = useCallback((updatedQuestions) => {
        console.log('Received updated questions:', updatedQuestions);
        setQuestions(prevQuestions => {
            const questionMap = new Map(prevQuestions.map(q => [q.id, q]));
            updatedQuestions.forEach(q => {
                if (questionMap.has(q.id)) {
                    // Merge the new question data with the existing data,
                    // ensuring we keep the votes array and handle numerical values
                    questionMap.set(q.id, {
                        ...questionMap.get(q.id),
                        ...q,
                        minValue: q.type === QuestionTypes.NUMERICAL ? parseInt(q.minValue) : undefined,
                        maxValue: q.type === QuestionTypes.NUMERICAL ? parseInt(q.maxValue) : undefined,
                        votes: q.votes || questionMap.get(q.id).votes || []
                    });
                } else {
                    questionMap.set(q.id, {
                        ...q,
                        timestamp: Date.now(),
                        votes: q.votes || [],
                        minValue: q.type === QuestionTypes.NUMERICAL ? parseInt(q.minValue) : undefined,
                        maxValue: q.type === QuestionTypes.NUMERICAL ? parseInt(q.maxValue) : undefined
                    });
                }
                console.log('Updated question:', questionMap.get(q.id));
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

        console.log('Adding question:', question);

        try {
            socket.emit('addQuestion', topic, question);

            // Reset form
            setNewQuestion('');
            setQuestionType(QuestionTypes.AGREEMENT);
            setMinValue(0);
            setMaxValue(100);
            // Clear any previous errors
            setError(null);
        } catch (error) {
            console.error('Error emitting addQuestion event:', error);
            setError('Failed to add question. Please try again.');
        }
    };

    const handleVote = (questionId, value) => {
        console.log('Voting:', questionId, value);
        socket.emit('vote', topic, questionId, value, userId, pseudonym);
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
                    <div>
                        <AgreementResults question={question} />
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
                    </div>
                );
            case QuestionTypes.NUMERICAL: {
                // console.log("Question:", question)
                const minValue = parseInt(question.minValue || question.min_value) || 0;
                const maxValue = parseInt(question.maxValue || question.max_value) || 100;
                const defaultValue = Math.floor((minValue + maxValue) / 2);
                // console.log("Question:", question.id, "min:", minValue, "max:", maxValue, "default:", defaultValue);

                const sliderValue = sliderValues[question.id] !== undefined
                    ? sliderValues[question.id]
                    : (userVote
                        ? parseInt(userVote.value)
                        : defaultValue);

                return (
                    <div className="mt-4">
                        <NumericalResults question={question} minValue={minValue} maxValue={maxValue} />
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
            <h1 className="text-4xl font-bold mb-2 text-center text-gray-800">Discussion: {topic}</h1>

            {/* Participant identity */}
            <div className="mb-8 text-center text-sm text-gray-600">
                You are <span className="font-semibold text-gray-800">{pseudonym || '…'}</span>
                <button
                    onClick={handleRegeneratePseudonym}
                    className="ml-2 text-primary hover:underline"
                    title="Get a new pseudonym"
                >
                    (change)
                </button>
            </div>

            {/* Duplicate Discussion Button */}
            <button
                onClick={() => setShowDuplicateModal(true)}
                className="mb-4 bg-blue-500 text-white py-2 px-4 rounded hover:bg-blue-600 transition duration-300"
            >
                Duplicate Discussion
            </button>

            {/* Duplicate Modal */}
            {showDuplicateModal && (
                <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full flex items-center justify-center">
                    <div className="bg-white p-5 rounded-lg shadow-xl">
                        <h2 className="text-xl font-bold mb-4">Duplicate Discussion</h2>
                        <input
                            type="text"
                            value={newTopicName}
                            onChange={(e) => setNewTopicName(e.target.value)}
                            placeholder="Enter new topic name"
                            className="w-full p-2 border rounded mb-4"
                        />
                        <div className="flex justify-end">
                            <button
                                onClick={() => setShowDuplicateModal(false)}
                                className="mr-2 px-4 py-2 bg-gray-300 rounded hover:bg-gray-400"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleDuplicateDiscussion}
                                className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
                            >
                                Duplicate
                            </button>
                        </div>
                    </div>
                </div>
            )}
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
                    <ul className="space-y-2">
                        {question.votes.map((vote, index) => {
                            const isYou = vote.userId === userVote?.userId;
                            return (
                                <li key={index} className="bg-gray-50 rounded-md p-3">
                                    <div className="text-xs font-semibold text-gray-500 mb-1">
                                        {vote.pseudonym || 'Anonymous'}
                                        {isYou && ' (you)'}
                                    </div>
                                    <div className="text-gray-800 whitespace-pre-wrap">{vote.value}</div>
                                </li>
                            );
                        })}
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
            value: PropTypes.string.isRequired,
            pseudonym: PropTypes.string
        }))
    }).isRequired,
    userVote: PropTypes.shape({
        userId: PropTypes.string.isRequired,
        value: PropTypes.string
    }),
    handleVote: PropTypes.func.isRequired
};

// Stacked divergence bar + summary for an Agreement question. Shows at a glance
// how opinion splits, and labels the statement as consensus or divisive.
const AgreementResults = ({ question }) => {
    const votes = question.votes || [];
    const total = votes.length;

    const counts = AGREEMENT_SCALE.map(seg => ({
        ...seg,
        count: votes.filter(v => v.value === seg.key).length,
    }));

    if (total === 0) {
        return <p className="text-sm text-gray-500 mb-4">No votes yet — be the first to weigh in.</p>;
    }

    const agreeCount = counts.filter(c => c.key === VoteOptions.AGREE || c.key === VoteOptions.STRONGLY_AGREE)
        .reduce((sum, c) => sum + c.count, 0);
    const disagreeCount = counts.filter(c => c.key === VoteOptions.DISAGREE || c.key === VoteOptions.STRONGLY_DISAGREE)
        .reduce((sum, c) => sum + c.count, 0);
    const agreePct = Math.round((agreeCount / total) * 100);
    const disagreePct = Math.round((disagreeCount / total) * 100);

    // Divisive when the room is split roughly evenly between agree and disagree;
    // consensus when one side clearly dominates.
    const decided = agreeCount + disagreeCount;
    let badge = null;
    if (decided >= 2) {
        const split = Math.min(agreeCount, disagreeCount) / decided; // 0..0.5
        if (split >= 0.4) {
            badge = <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-800">Divisive</span>;
        } else if (split <= 0.15) {
            badge = <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">Consensus</span>;
        }
    }

    return (
        <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">
                    {total} {total === 1 ? 'vote' : 'votes'} · {agreePct}% agree · {disagreePct}% disagree
                </span>
                {badge}
            </div>
            <div className="flex w-full h-4 rounded-full overflow-hidden bg-gray-200">
                {counts.map(seg => seg.count > 0 && (
                    <div
                        key={seg.key}
                        className={seg.bar}
                        style={{ width: `${(seg.count / total) * 100}%` }}
                        title={`${seg.label}: ${seg.count}`}
                    />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {counts.map(seg => (
                    <span key={seg.key} className="flex items-center text-xs text-gray-600">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full mr-1 ${seg.dot}`} />
                        {seg.label}: {seg.count}
                    </span>
                ))}
            </div>
        </div>
    );
};

AgreementResults.propTypes = {
    question: PropTypes.shape({
        votes: PropTypes.array,
    }).isRequired,
};

// Summary stats + histogram for a Numerical question.
const NumericalResults = ({ question, minValue, maxValue }) => {
    const values = (question.votes || [])
        .map(v => parseInt(v.value))
        .filter(n => !Number.isNaN(n));
    const total = values.length;

    if (total === 0) {
        return <p className="text-sm text-gray-500 mb-2">No responses yet — drag the slider to add yours.</p>;
    }

    const average = values.reduce((sum, n) => sum + n, 0) / total;
    const range = Math.max(maxValue - minValue, 1);

    // Bucket values into up to 10 bins across the [min, max] range.
    const binCount = Math.min(10, range + 1);
    const bins = new Array(binCount).fill(0);
    values.forEach(n => {
        const clamped = Math.min(Math.max(n, minValue), maxValue);
        let idx = Math.floor(((clamped - minValue) / range) * binCount);
        if (idx >= binCount) idx = binCount - 1; // include the max edge
        bins[idx] += 1;
    });
    const tallestBin = Math.max(...bins);

    return (
        <div className="mb-2">
            <div className="text-sm text-gray-600 mb-2">
                {total} {total === 1 ? 'response' : 'responses'} · average <span className="font-semibold">{average.toFixed(1)}</span>
            </div>
            <div className="flex items-end gap-1 h-16">
                {bins.map((count, i) => (
                    <div
                        key={i}
                        className="flex-1 bg-primary rounded-t"
                        style={{ height: tallestBin > 0 ? `${(count / tallestBin) * 100}%` : '0%' }}
                        title={`${count} ${count === 1 ? 'response' : 'responses'}`}
                    />
                ))}
            </div>
        </div>
    );
};

NumericalResults.propTypes = {
    question: PropTypes.shape({
        votes: PropTypes.array,
    }).isRequired,
    minValue: PropTypes.number.isRequired,
    maxValue: PropTypes.number.isRequired,
};

export default DiscussionPage;
