import React from 'react';
import PropTypes from 'prop-types';
import { plainPrompt } from './promptEmphasis.mjs';
import { AgreementResults, YesNoResults, MultipleChoiceResults } from './OpinionResults';
import OpenEndedQuestion from './OpenEndedQuestion';
import NumericalResults from './NumericalResults';
import { clampNumericalValue } from './questionHelpers.mjs';
import { QuestionTypes, VoteOptions, YesNoOptions } from './config';

// A published question's results and the controls for answering it, by
// question type.
export default function VotingControls({
    question, locked, pendingVotes, sliderValues, isMyVote,
    handleVote, handleClearVote, handleSliderChange, openEnded,
}) {
    const userVote = question.votes ? question.votes.find(v => isMyVote(question, v)) : null;
    // undefined when idle; otherwise the value being saved (null = clearing).
    const pendingVote = pendingVotes[question.id];
    const votePending = pendingVote !== undefined;
    // One button per option of a single-choice poll: it sets that option, or
    // explicitly clears it when it is already this participant's vote.
    const renderOptionVoteButton = (option) => {
        const isMine = Boolean(userVote && userVote.value === option);
        const saving = votePending && (pendingVote === option || (pendingVote === null && isMine));
        // The name says which option and question this button is for, and
        // stays the same whether or not it is selected: aria-pressed carries
        // the selection, so the visible "Vote" / "Undo Vote" text is not the
        // only cue. The status text announces a save in progress.
        return (
            <>
            <button
                onClick={() => (isMine ? handleClearVote(question.id) : handleVote(question.id, option))}
                disabled={votePending}
                aria-label={`Vote ${option} on "${plainPrompt(question.text)}"`}
                aria-pressed={isMine}
                aria-busy={saving || undefined}
                className={`px-4 py-2 rounded-md transition duration-300 disabled:opacity-60 disabled:cursor-not-allowed ${isMine
                    ? 'bg-primary text-white hover:bg-opacity-90'
                    : 'bg-secondary text-white hover:bg-opacity-90'
                    }`}
            >
                {saving ? 'Saving…' : isMine ? 'Undo Vote' : 'Vote'}
            </button>
            <span role="status" className="sr-only">
                {saving ? `Saving your vote on "${plainPrompt(question.text)}"…` : ''}
            </span>
            </>
        );
    };

    if (!question || typeof question !== 'object') {
        console.error('Invalid question object');
        return null;
    }

    switch (question.type) {
        case QuestionTypes.AGREEMENT:
            return (
                <div>
                    <AgreementResults question={question} />
                    {!locked && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {Object.values(VoteOptions).map((option) => (
                                <div key={option} className="flex items-center justify-between bg-gray-100 p-3 rounded-md">
                                    <span className="font-medium">
                                        {option}{question.resultsHidden ? '' : `: ${question.votes ? question.votes.filter(v => v.value === option).length : 0}`}
                                    </span>
                                    {renderOptionVoteButton(option)}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            );
        case QuestionTypes.YES_NO:
            return (
                <div>
                    <YesNoResults question={question} />
                    {!locked && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {Object.values(YesNoOptions).map((option) => (
                                <div key={option} className="flex items-center justify-between bg-gray-100 p-3 rounded-md">
                                    <span className="font-medium">
                                        {option}{question.resultsHidden ? '' : `: ${question.votes ? question.votes.filter(v => v.value === option).length : 0}`}
                                    </span>
                                    {renderOptionVoteButton(option)}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            );
        case QuestionTypes.MULTIPLE_CHOICE:
            return (
                <div>
                    <MultipleChoiceResults question={question} />
                    {!locked && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {(question.options || []).map((option) => (
                                <div key={option} className="flex items-center justify-between gap-3 bg-gray-100 p-3 rounded-md">
                                    <span className="font-medium break-words min-w-0">{option}</span>
                                    {renderOptionVoteButton(option)}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            );
        case QuestionTypes.NUMERICAL: {
            const { minValue, maxValue } = question;

            // sliderValues[id] is undefined until the participant touches the
            // slider or the number box ('' while the box is cleared). Until
            // then we show their saved answer if they have one, and otherwise
            // nothing at all: no midpoint default to anchor on or to submit
            // by accident.
            const draftValue = sliderValues[question.id];
            const inputValue = draftValue !== undefined
                ? draftValue
                : (userVote ? Number(userVote.value) : '');
            // What Submit would send: the draft clamped into range and
            // rounded to two decimal places, or null when nothing is selected.
            const sliderValue = clampNumericalValue(inputValue, minValue, maxValue);
            const isUnset = sliderValue === null;
            const canSubmit = draftValue !== undefined && !isUnset
                && (!userVote || sliderValue !== Number(userVote.value));

            return (
                <div className="mt-4">
                    <NumericalResults question={question} minValue={minValue} maxValue={maxValue} />
                    {!locked && (
                        <>
                            <div className="flex items-center gap-3">
                                <input
                                    type="range"
                                    min={minValue}
                                    max={maxValue}
                                    value={isUnset ? minValue : sliderValue}
                                    aria-label={`Your answer to: ${plainPrompt(question.text)}`}
                                    aria-valuetext={isUnset ? 'No value selected' : String(sliderValue)}
                                    className={`flex-grow min-w-0 ${isUnset ? 'slider-unset' : ''}`}
                                    onChange={(e) => handleSliderChange(question.id, parseInt(e.target.value))}
                                    // A click that lands exactly on the resting
                                    // position fires no change event, so pick the
                                    // value up here too.
                                    onClick={(e) => { if (isUnset) handleSliderChange(question.id, parseInt(e.target.value)); }}
                                />
                                <input
                                    // A number input sanitizes a lone minus
                                    // to '', losing it on a controlled render.
                                    // Text preserves intermediate signed input.
                                    type="text"
                                    inputMode="decimal"
                                    value={inputValue}
                                    placeholder="–"
                                    aria-label={`Type your answer to: ${plainPrompt(question.text)}`}
                                    className="w-24 p-2 border border-gray-300 rounded-md text-center focus:outline-none focus:ring-2 focus:ring-primary"
                                    // Keep what is typed as-is so multi-digit
                                    // or decimal entry ("0." on the way to
                                    // "0.5") isn't clamped mid-keystroke; the
                                    // slider and Submit use the clamped value,
                                    // and blur snaps the box to it.
                                    onChange={(e) => handleSliderChange(question.id, e.target.value)}
                                    onBlur={() => { if (draftValue !== undefined && !isUnset && draftValue !== sliderValue) handleSliderChange(question.id, sliderValue); }}
                                />
                            </div>
                            <div className="flex justify-between mt-2">
                                <span>{minValue}</span>
                                <span className={isUnset ? 'text-sm text-gray-500' : ''}>
                                    {isUnset ? 'Move the slider or type a number' : sliderValue}
                                </span>
                                <span>{maxValue}</span>
                            </div>
                            <button
                                onClick={() => handleVote(question.id, sliderValue)}
                                disabled={votePending || !canSubmit}
                                className={`mt-4 px-4 py-2 rounded-md transition duration-300 disabled:opacity-50 disabled:cursor-not-allowed ${userVote ? 'bg-primary text-white hover:bg-opacity-90' : 'bg-secondary text-white hover:bg-opacity-90'}`}
                            >
                                {votePending ? 'Saving…' : userVote ? 'Update Vote' : 'Submit'}
                            </button>
                        </>
                    )}
                </div>
            );
        }
        case QuestionTypes.OPEN_ENDED: {
            return <OpenEndedQuestion
                question={question}
                handleVote={handleVote}
                pending={votePending}
                locked={locked}
                {...openEnded}
            />;
        }

        default:
            console.warn('Unknown question type:', question.type);
            return null;
    }
}

VotingControls.propTypes = {
    question: PropTypes.object.isRequired,
    locked: PropTypes.bool,
    pendingVotes: PropTypes.object.isRequired,
    sliderValues: PropTypes.object.isRequired,
    isMyVote: PropTypes.func.isRequired,
    handleVote: PropTypes.func.isRequired,
    handleClearVote: PropTypes.func.isRequired,
    handleSliderChange: PropTypes.func.isRequired,
    // The open-ended (brainstorm) props passed through to OpenEndedQuestion
    // besides question, handleVote, pending, and locked.
    openEnded: PropTypes.object,
};
