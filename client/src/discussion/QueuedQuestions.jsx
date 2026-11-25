import React from 'react';
import PropTypes from 'prop-types';
import { formatPrompt } from '../questions/formatPrompt';
import QuestionEditor from '../questions/QuestionEditor';
import { QuestionTypes } from '../questions/config';

// The moderator's queue: questions written ahead of time and participant
// suggestions that are not published yet.
export default function QueuedQuestions({ queuedQuestions, locked, moderation }) {
    const {
        editingQuestionId, setEditingQuestionId, editingDrafts, setEditingDrafts, closeQuestionEditor,
        handleEditQuestion, handlePublishQuestion, handleDeleteQuestion, swapQueuedQuestions,
    } = moderation;
    return (
        <section
            aria-labelledby="queued-questions-heading"
            className="mb-8 rounded-lg border border-dashed border-indigo-300 bg-indigo-50 p-4"
        >
            <h2 id="queued-questions-heading" className="text-lg font-semibold text-indigo-900">
                Queued questions ({queuedQuestions.length})
            </h2>
            <p className="mb-3 text-sm text-indigo-800">
                Only moderators see these drafts and suggestions. Reorder them to plan the agenda, publish any question to open it for answers, or delete it to discard it.
            </p>
            <ol className="space-y-3">
                {queuedQuestions.map((question, index) => (
                    <li key={question.id} className="rounded-md border border-indigo-100 bg-white p-4" data-testid="queued-question">
                        {question.suggested && <p className="text-xs font-medium text-indigo-700">Participant suggestion</p>}
                        {editingQuestionId === question.id ? (
                            <QuestionEditor
                                question={question}
                                draft={editingDrafts[question.id]}
                                onDraftChange={draft => setEditingDrafts(current => ({ ...current, [question.id]: draft }))}
                                onSave={handleEditQuestion}
                                onCancel={closeQuestionEditor}
                            />
                        ) : (
                            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                                <div className="min-w-0 flex-1 basis-64">
                                    <h3 className="font-semibold break-words">{formatPrompt(question.text)}</h3>
                                    <p className="text-sm text-gray-500 break-words">
                                        Type: {question.type}
                                        {question.type === QuestionTypes.NUMERICAL && ` (${question.minValue} to ${question.maxValue})`}
                                        {question.type === QuestionTypes.MULTIPLE_CHOICE && ` (${(question.options || []).join(' · ')})`}
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-2 ml-auto">
                                    <button
                                        disabled={index === 0}
                                        aria-label={`Move up: ${question.text}`}
                                        onClick={() => swapQueuedQuestions(queuedQuestions[index - 1], question)}
                                        className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-50"
                                    >Move up</button>
                                    <button
                                        disabled={index === queuedQuestions.length - 1}
                                        aria-label={`Move down: ${question.text}`}
                                        onClick={() => swapQueuedQuestions(question, queuedQuestions[index + 1])}
                                        className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 disabled:opacity-50"
                                    >Move down</button>
                                    <button
                                        onClick={() => handlePublishQuestion(question.id)}
                                        disabled={locked}
                                        title={locked ? 'Unlock the discussion to publish questions' : 'Show this question to everyone and open it for answers'}
                                        className="text-xs px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {question.suggested ? 'Approve and publish' : 'Publish'}
                                    </button>
                                    <button
                                        onClick={() => setEditingQuestionId(question.id)}
                                        className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-100"
                                    >
                                        Edit
                                    </button>
                                    <button
                                        onClick={() => handleDeleteQuestion(question.id)}
                                        className="text-xs px-2 py-1 rounded border border-red-300 text-red-600 hover:bg-red-50"
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                        )}
                    </li>
                ))}
            </ol>
        </section>
    );
}

QueuedQuestions.propTypes = {
    queuedQuestions: PropTypes.arrayOf(PropTypes.object).isRequired,
    locked: PropTypes.bool,
    moderation: PropTypes.shape({
        editingQuestionId: PropTypes.number,
        setEditingQuestionId: PropTypes.func.isRequired,
        editingDrafts: PropTypes.object.isRequired,
        setEditingDrafts: PropTypes.func.isRequired,
        closeQuestionEditor: PropTypes.func.isRequired,
        handleEditQuestion: PropTypes.func.isRequired,
        handlePublishQuestion: PropTypes.func.isRequired,
        handleDeleteQuestion: PropTypes.func.isRequired,
        swapQueuedQuestions: PropTypes.func.isRequired,
    }).isRequired,
};
