import PropTypes from 'prop-types';
import React from 'react';
import { MULTIPLE_CHOICE_LIMITS } from './config';

// The answer options of a Multiple Choice question being written or edited: one
// text box per option, a Remove button on each while more than the minimum
// remain, and Add option until the maximum. Used by the Add Question form and
// the moderator's QuestionEditor. Validation happens on submit
// (validateChoiceOptions), so a half-typed list is never blocked mid-edit.
const ChoiceOptionsEditor = ({ options, onChange }) => {
    const { MIN_OPTIONS, MAX_OPTIONS, MAX_OPTION_LENGTH } = MULTIPLE_CHOICE_LIMITS;
    const setOption = (index, value) => onChange(options.map((option, i) => (i === index ? value : option)));
    const removeOption = (index) => onChange(options.filter((_, i) => i !== index));

    return (
        <fieldset className="mb-4">
            <legend className="block mb-2">Answer options:</legend>
            <div className="space-y-2">
                {options.map((option, index) => (
                    <div key={index} className="flex gap-2">
                        <input
                            type="text"
                            value={option}
                            maxLength={MAX_OPTION_LENGTH}
                            onChange={(e) => setOption(index, e.target.value)}
                            placeholder={`Option ${index + 1}`}
                            aria-label={`Answer option ${index + 1}`}
                            className="flex-1 min-w-0 p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        {options.length > MIN_OPTIONS && (
                            <button
                                type="button"
                                onClick={() => removeOption(index)}
                                aria-label={`Remove answer option ${index + 1}`}
                                className="px-3 rounded-md border border-gray-300 text-gray-600 hover:bg-gray-100 transition duration-300"
                            >
                                Remove
                            </button>
                        )}
                    </div>
                ))}
            </div>
            {options.length < MAX_OPTIONS ? (
                <button
                    type="button"
                    onClick={() => onChange([...options, ''])}
                    className="mt-2 text-sm text-primary hover:underline"
                >
                    + Add option
                </button>
            ) : (
                <p className="mt-2 text-sm text-gray-500">Up to {MAX_OPTIONS} options.</p>
            )}
        </fieldset>
    );
};

ChoiceOptionsEditor.propTypes = {
    options: PropTypes.arrayOf(PropTypes.string).isRequired,
    onChange: PropTypes.func.isRequired,
};

export default ChoiceOptionsEditor;
