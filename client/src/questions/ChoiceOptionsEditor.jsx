import PropTypes from 'prop-types';
import React, { useEffect, useRef } from 'react';
import { MULTIPLE_CHOICE_LIMITS } from './config';

// The answer options of a Multiple Choice question being written or edited: one
// text box per option, a Remove button on each while more than the minimum
// remain, and Add option until the maximum. Used by the Add Question form and
// the moderator's QuestionEditor. Validation happens on submit
// (validateChoiceOptions), which drops empty boxes, so a spare one never has to
// be cleaned up.
//
// Keyboard: Enter in a filled box moves to the next one, adding it if needed,
// so a list can be typed without the mouse. Enter in an empty box is left
// alone (in the Add Question form it submits). Backspace in an empty spare box
// removes it and returns to the one before.
const ChoiceOptionsEditor = ({ options, onChange }) => {
    const { MIN_OPTIONS, MAX_OPTIONS, MAX_OPTION_LENGTH } = MULTIPLE_CHOICE_LIMITS;
    const inputRefs = useRef([]);
    // The box to focus once a change to the list has rendered.
    const pendingFocus = useRef(null);
    // The key whose press just moved focus to another box. While it is still
    // held, its repeats arrive in that box and must not act on it.
    const heldKey = useRef(null);

    useEffect(() => {
        if (pendingFocus.current === null) return;
        inputRefs.current[pendingFocus.current]?.focus();
        pendingFocus.current = null;
    }, [options.length]);

    const setOption = (index, value) => onChange(options.map((option, i) => (i === index ? value : option)));
    const removeOption = (index) => onChange(options.filter((_, i) => i !== index));
    const addOption = () => {
        pendingFocus.current = options.length;
        onChange([...options, '']);
    };

    const handleKeyDown = (event, index) => {
        // Enter that confirms an IME composition is not a command.
        if (event.nativeEvent.isComposing) return;
        if (!event.repeat) {
            heldKey.current = null;
        } else if (event.key === heldKey.current || event.key === 'Enter') {
            // A held Enter never adds, moves or submits a second time, and a
            // held Backspace that removed a row does not eat the row before it.
            event.preventDefault();
            return;
        }
        const empty = options[index].trim() === '';
        if (event.key === 'Enter' && !empty) {
            const isLast = index === options.length - 1;
            // A full list has nowhere further to go; let Enter do its default.
            if (isLast && options.length >= MAX_OPTIONS) return;
            event.preventDefault();
            heldKey.current = event.key;
            if (isLast) addOption();
            else inputRefs.current[index + 1]?.focus();
        } else if (event.key === 'Backspace' && options[index] === '' && options.length > MIN_OPTIONS) {
            // Holding Backspace to clear a box must not also eat the row.
            if (event.repeat) return;
            event.preventDefault();
            heldKey.current = event.key;
            pendingFocus.current = Math.max(index - 1, 0);
            removeOption(index);
        }
    };

    return (
        <fieldset className="mb-4">
            <legend className="block mb-2">Answer options:</legend>
            <div className="space-y-2">
                {options.map((option, index) => (
                    <div key={index} className="flex gap-2">
                        <input
                            ref={(element) => { inputRefs.current[index] = element; }}
                            type="text"
                            value={option}
                            maxLength={MAX_OPTION_LENGTH}
                            onChange={(e) => setOption(index, e.target.value)}
                            onKeyDown={(e) => handleKeyDown(e, index)}
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
                    onClick={addOption}
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
