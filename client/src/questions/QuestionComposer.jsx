import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import PropTypes from 'prop-types';
import { useModalDialog } from '../hooks/useModalDialog';
import QuestionTextBox from '../QuestionTextBox';
import ChoiceOptionsEditor from './ChoiceOptionsEditor';
import { QuestionToolSettings } from './QuestionTools';
import ResponseSettings from './ResponseSettings';
import IndependentAnswerSetting from './IndependentAnswerSetting';
import { QuestionTypes, QuestionTypeDescriptions } from './config';
import { guessQuestionType } from './guessQuestionType.mjs';
import { composerReducer, createQuestionSubmission, initialComposerState, isComposerCollapsed } from './composerLifecycle.mjs';

export function useQuestionComposer({ socket, discussionSlug, adminToken, setError, approvalRequired }) {
    const [state, dispatch] = useReducer(composerReducer, undefined, initialComposerState);
    const [send] = useState(() => createQuestionSubmission(dispatch, setError));
    const onQuestionsLoaded = useCallback(() => dispatch({ type: 'questionsLoaded' }), []);
    const onSimilarQuestion = prompt => dispatch({ type: 'similarPrompt', prompt });
    const dismissSimilarPrompt = () => onSimilarQuestion(null);
    const similarDialogRef = useModalDialog(Boolean(state.similarPrompt), dismissSimilarPrompt);
    useEffect(() => { dispatch({ type: 'roomChanged' }); }, [discussionSlug]);
    return {
        state, dispatch, onQuestionsLoaded, onSimilarQuestion, similarDialogRef, dismissSimilarPrompt,
        submit: (force = false) => send(state, { socket, discussionSlug, adminToken, approvalRequired }, force),
    };
}

export default function QuestionComposer({ composer, questionCount, isAdmin, moderatorOnly, locked, approvalRequired }) {
    const { state, dispatch, submit, similarDialogRef, dismissSimilarPrompt } = composer;
    const { draft: questionDraft, queueNewQuestions, similarPrompt } = state;
    const { text: newQuestion, type: questionType, minValue, maxValue, options: choiceOptions } = questionDraft;
    const questionInputRef = useRef(null);
    const submitButtonRef = useRef(null);
    const chooseQuestionSetting = (field, value) => dispatch({ type: 'chooseSetting', field, value });
    const typeGuessed = !questionDraft.typeChosen && guessQuestionType(newQuestion) !== null;
    const composerCollapsed = isComposerCollapsed(state, questionCount);
    const canAdd = !locked && (!moderatorOnly || isAdmin);

    return (
        <>
            {similarPrompt && (
                <div
                    className="fixed inset-0 z-50 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full flex items-center justify-center"
                    onClick={dismissSimilarPrompt}
                >
                    <div
                        ref={similarDialogRef}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="similar-dialog-title"
                        tabIndex={-1}
                        className="bg-white p-6 rounded-lg shadow-xl max-w-md"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h2 id="similar-dialog-title" className="text-xl font-bold mb-3">A similar statement already exists</h2>
                        <p className="text-sm text-gray-600 mb-2">Someone already posted:</p>
                        <blockquote className="border-l-4 border-primary pl-3 italic text-gray-800 mb-4">
                            {similarPrompt.candidate}
                        </blockquote>
                        <p className="text-sm text-gray-600 mb-4">
                            Consider voting on the existing one to keep the discussion focused — or post yours anyway if it&apos;s meaningfully different.
                        </p>
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={dismissSimilarPrompt}
                                className="px-4 py-2 bg-primary text-white rounded hover:bg-opacity-90"
                            >
                                Use existing
                            </button>
                            <button
                                onClick={() => submit(true)}
                                className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
                            >
                                {approvalRequired ? 'Suggest anyway' : 'Post anyway'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* When the moderator has restricted question-asking, let participants
                know why they can't add one (voting stays open). Hidden from the
                moderator, who keeps the form and the toggle. */}
            {!locked && moderatorOnly && !isAdmin && (
                <div className="mb-8 bg-indigo-50 border border-indigo-200 text-indigo-800 rounded-md p-3 text-center">
                    Only the moderator can add questions right now. You can still vote on the ones below.
                </div>
            )}

            {state.suggestionSent && <p role="status" className="mb-3 text-indigo-800">Suggestion sent to the moderators for review.</p>}
            {canAdd && composerCollapsed && (
                <button
                    type="button"
                    onClick={() => {
                        // Flush so the input is on screen and can take focus
                        // inside this tap (iOS only opens the keyboard then).
                        flushSync(() => dispatch({ type: 'open' }));
                        questionInputRef.current?.focus();
                    }}
                    className="sm:hidden w-full mb-4 py-2 rounded-md border border-primary text-primary font-medium hover:bg-gray-50"
                >
                    {approvalRequired ? '+ Suggest a question' : '+ Add a statement'}
                </button>
            )}
            {canAdd && (
                <form
                    onSubmit={event => { event.preventDefault(); submit(); }}
                    // Using the composer pins it open, so it does not collapse under
                    // someone's hands when the first question arrives.
                    onFocus={() => dispatch({ type: 'open' })}
                    className={`${composerCollapsed ? 'hidden sm:block ' : ''}bg-white shadow-lg rounded-lg p-6 mb-8`}
                >
                    {approvalRequired && <p className="mb-3 text-sm text-indigo-800">Only moderators see your suggestion until they approve and publish it.</p>}
                    <QuestionTextBox
                        ref={questionInputRef}
                        value={newQuestion}
                        onChange={(e) => dispatch({ type: 'text', text: e.target.value, isAdmin })}
                        // Holding Enter auto-repeats; submit once per key press.
                        onKeyDown={(e) => { if (e.key === 'Enter' && e.repeat) e.preventDefault(); }}
                        placeholder="Enter a new question or statement"
                        className="w-full p-3 border border-gray-300 rounded-md mb-1 focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    <p className="mb-4 text-xs text-gray-500">Use *italics* or **bold**.</p>
                    <div className="mb-4">
                        <label className="block mb-2">Question Type:</label>
                        <select
                            value={questionType}
                            onPointerDown={() => chooseQuestionSetting('typeChosen', true)}
                            onKeyDown={(event) => {
                                // Confirming this picker must not submit the question
                                // if the native menu has already consumed its close.
                                if (event.key === 'Enter') event.preventDefault();
                                if (['Enter', ' ', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
                                    chooseQuestionSetting('typeChosen', true);
                                }
                            }}
                            onChange={(e) => chooseQuestionSetting('type', e.target.value)}
                            className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                        >
                            {Object.values(QuestionTypes).map(type => (
                                <option key={type} value={type}>{type}</option>
                            ))}
                        </select>
                        {/* A status, so screen readers hear the type change while
                            the author is still in the text box. */}
                        {typeGuessed && (
                            <p role="status" className="mt-2 text-sm text-primary">
                                Set to {questionType} based on your wording. Pick another type if that is not what you meant.
                            </p>
                        )}
                        {QuestionTypeDescriptions[questionType] && (
                            <p className="mt-2 text-sm text-gray-500">{QuestionTypeDescriptions[questionType]}</p>
                        )}
                    </div>
                    {questionType === QuestionTypes.OPEN_ENDED && <ResponseSettings maxResponses={questionDraft.maxResponses} showAttribution={questionDraft.showAttribution} onChange={chooseQuestionSetting} />}
                    {isAdmin && <QuestionToolSettings type={questionType} tools={questionDraft.tools} onChange={tools => chooseQuestionSetting('tools', tools)} />}
                    {isAdmin && questionType === QuestionTypes.OPEN_ENDED && <IndependentAnswerSetting checked={questionDraft.independentAnswers} onChange={value => chooseQuestionSetting('independentAnswers', value)} />}
                    {questionType === QuestionTypes.MULTIPLE_CHOICE && (
                        <ChoiceOptionsEditor
                            options={choiceOptions}
                            onChange={(options) => dispatch({ type: 'options', options })}
                            onFinish={() => submitButtonRef.current?.focus()}
                        />
                    )}
                    {questionType === QuestionTypes.NUMERICAL && (
                        <div className="mb-4 flex space-x-4">
                            <div className="flex-1">
                                <label className="block mb-2">Min Value:</label>
                                <input
                                    type="number"
                                    value={minValue}
                                    onChange={(e) => chooseQuestionSetting('minValue', e.target.value)}
                                    className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                                />
                            </div>
                            <div className="flex-1">
                                <label className="block mb-2">Max Value:</label>
                                <input
                                    type="number"
                                    value={maxValue}
                                    onChange={(e) => chooseQuestionSetting('maxValue', e.target.value)}
                                    className="w-full p-3 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                                />
                            </div>
                        </div>
                    )}
                    {isAdmin && (
                        <label className="mb-4 flex items-start gap-2 text-sm text-gray-700">
                            <input
                                type="checkbox"
                                checked={queueNewQuestions}
                                onChange={(e) => dispatch({ type: 'queue', queued: e.target.checked })}
                                className="mt-1"
                            />
                            <span>
                                <span className="font-medium">Add to the queue</span>
                                <span className="block text-gray-500">Only moderators see a queued question until you publish it.</span>
                            </span>
                        </label>
                    )}
                    <button
                        type="submit"
                        ref={submitButtonRef}
                        className="w-full bg-primary text-white py-3 rounded-md hover:bg-opacity-90 transition duration-300"
                    >
                        {approvalRequired ? 'Suggest Question' : isAdmin && queueNewQuestions ? 'Add to Queue' : 'Add Question'}
                    </button>
                </form>
            )}
        </>
    );
}
QuestionComposer.propTypes = {
    composer: PropTypes.object.isRequired,
    questionCount: PropTypes.number.isRequired,
    isAdmin: PropTypes.bool.isRequired,
    moderatorOnly: PropTypes.bool.isRequired,
    approvalRequired: PropTypes.bool,
    locked: PropTypes.bool.isRequired,
};
