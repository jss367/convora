import ResponseSettings from './ResponseSettings';
import IndependentAnswerSetting from './IndependentAnswerSetting';
import PropTypes from 'prop-types';
import React, { useState } from 'react';
import { MULTIPLE_CHOICE_LIMITS, QuestionTypes, QuestionTypeDescriptions } from './config';
import ChoiceOptionsEditor from './ChoiceOptionsEditor';
import { QuestionToolSettings } from './QuestionTools';
import { validateChoiceOptions, validateNumericalRange } from './questionHelpers.mjs';
import QuestionTextBox from '../QuestionTextBox';

// Inline moderator editor for a question's wording/type, mirroring the fields of
// the "add question" form. Only mounted for questions with no responses yet; the
// server enforces that same rule, so a stale view can't slip an edit through.
const QuestionEditor = ({ question, onSave, onCancel, draft, onDraftChange }) => {
    const [localDraft, setLocalDraft] = useState(() => ({
        text: question.text, type: question.type, minValue: question.minValue ?? 0, maxValue: question.maxValue ?? 100,
        settings: { maxResponses: question.maxResponses, showAttribution: question.showAttribution },
        options: Array.isArray(question.options) && question.options.length >= MULTIPLE_CHOICE_LIMITS.MIN_OPTIONS
            ? question.options : ['', ''],
    }));
    const currentDraft = draft || localDraft;
    const independentAnswers = currentDraft.independentAnswers ?? question.independentAnswers ?? false;
    const { text, type, minValue, maxValue, settings, options } = currentDraft;
    const update = (key, value) => {
        const next = { ...currentDraft, [key]: typeof value === 'function' ? value(currentDraft[key]) : value };
        if (onDraftChange) onDraftChange(next); else setLocalDraft(next);
    };
    const setText = value => update('text', value);
    const setType = value => update('type', value);
    const setMinValue = value => update('minValue', value);
    const setMaxValue = value => update('maxValue', value);
    const setSettings = value => update('settings', value);
    const setOptions = value => update('options', value);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    const handleSave = () => {
        const trimmed = text.trim();
        if (trimmed === '') {
            setError('Question text cannot be empty.');
            return;
        }
        const updates = { text: trimmed, type, ...settings, tools: currentDraft.tools ?? question.tools ?? [] };
        if (type === QuestionTypes.OPEN_ENDED) updates.independentAnswers = independentAnswers;
        if (type === QuestionTypes.NUMERICAL) {
            const range = validateNumericalRange(minValue, maxValue);
            if (range.error) {
                setError(range.error);
                return;
            }
            Object.assign(updates, range);
        }
        if (type === QuestionTypes.MULTIPLE_CHOICE) {
            const result = validateChoiceOptions(options, MULTIPLE_CHOICE_LIMITS);
            if (result.error) {
                setError(result.error);
                return;
            }
            updates.options = result.options;
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
            <QuestionTextBox
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
            {type === QuestionTypes.OPEN_ENDED && <ResponseSettings {...settings} onChange={(key, value) => setSettings(prev => ({ ...prev, [key]: value }))} />}
            <QuestionToolSettings type={type} tools={currentDraft.tools ?? question.tools} onChange={tools => update('tools', tools)} />
            {type === QuestionTypes.OPEN_ENDED && <IndependentAnswerSetting checked={independentAnswers} onChange={value => update('independentAnswers', value)} />}
            {type === QuestionTypes.MULTIPLE_CHOICE && (
                <ChoiceOptionsEditor options={options} onChange={setOptions} />
            )}
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
    draft: PropTypes.object,
    onDraftChange: PropTypes.func,
    onSave: PropTypes.func.isRequired,
    onCancel: PropTypes.func.isRequired,
};

export default QuestionEditor;
