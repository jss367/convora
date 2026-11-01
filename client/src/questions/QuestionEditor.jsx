import PropTypes from 'prop-types';
import React, { useState } from 'react';
import { QuestionTypes, QuestionTypeDescriptions } from './config';

// Inline moderator editor for a question's wording/type, mirroring the fields of
// the "add question" form. Only mounted for questions with no responses yet; the
// server enforces that same rule, so a stale view can't slip an edit through.
const QuestionEditor = ({ question, onSave, onCancel }) => {
    const [text, setText] = useState(question.text);
    const [type, setType] = useState(question.type);
    const [minValue, setMinValue] = useState(question.minValue ?? 0);
    const [maxValue, setMaxValue] = useState(question.maxValue ?? 100);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    const handleSave = () => {
        const trimmed = text.trim();
        if (trimmed === '') {
            setError('Question text cannot be empty.');
            return;
        }
        const updates = { text: trimmed, type };
        if (type === QuestionTypes.NUMERICAL) {
            const min = parseInt(minValue, 10);
            const max = parseInt(maxValue, 10);
            if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max) {
                setError('Minimum value must be less than maximum value.');
                return;
            }
            updates.minValue = min;
            updates.maxValue = max;
        }
        setError(null);
        setSaving(true);
        onSave(question.id, updates, (resp) => {
            setSaving(false);
            if (!resp || !resp.updated) {
                setError(
                    resp && resp.reason === 'has_responses'
                        ? 'This question already has responses and can no longer be edited.'
                        : 'Failed to save changes. Please try again.'
                );
            }
            // On success the parent unmounts this editor; nothing more to do here.
        });
    };

    return (
        <div>
            <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Enter a new question or statement"
                className="w-full p-3 border border-gray-300 rounded-md mb-4 focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <div className="mb-4">
                <label className="block mb-2">Question Type:</label>
                <select
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                >
                    {Object.values(QuestionTypes).map(t => (
                        <option key={t} value={t}>{t}</option>
                    ))}
                </select>
                {QuestionTypeDescriptions[type] && (
                    <p className="mt-2 text-sm text-gray-500">{QuestionTypeDescriptions[type]}</p>
                )}
            </div>
            {type === QuestionTypes.NUMERICAL && (
                <div className="mb-4 flex space-x-4">
                    <div className="flex-1">
                        <label className="block mb-2">Min Value:</label>
                        <input
                            type="number"
                            value={minValue}
                            onChange={(e) => setMinValue(e.target.value)}
                            className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                    </div>
                    <div className="flex-1">
                        <label className="block mb-2">Max Value:</label>
                        <input
                            type="number"
                            value={maxValue}
                            onChange={(e) => setMaxValue(e.target.value)}
                            className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                    </div>
                </div>
            )}
            {error && <div className="text-red-500 mb-3 text-sm">{error}</div>}
            <div className="flex gap-2">
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90 transition duration-300 disabled:opacity-50"
                >
                    {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                    onClick={onCancel}
                    disabled={saving}
                    className="px-4 py-2 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 transition duration-300 disabled:opacity-50"
                >
                    Cancel
                </button>
            </div>
        </div>
    );
};
QuestionEditor.propTypes = {
    question: PropTypes.object.isRequired,
    onSave: PropTypes.func.isRequired,
    onCancel: PropTypes.func.isRequired,
};

export default QuestionEditor;
