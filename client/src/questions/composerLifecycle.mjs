import { QuestionTypes, MULTIPLE_CHOICE_LIMITS } from './questionTypes.mjs';
import { guessQuestionType } from './guessQuestionType.mjs';
import { validateNumericalRange, validateChoiceOptions } from './questionHelpers.mjs';

const emptyDraft = () => ({
    text: '', type: QuestionTypes.AGREEMENT, minValue: 0, maxValue: 100, options: ['', ''], typeChosen: false,
});

export const initialComposerState = () => ({
    draft: emptyDraft(), queueNewQuestions: false, open: false, questionsLoaded: false, similarPrompt: null,
});

export const isComposerCollapsed = (state, questionCount) => !state.open && !(state.questionsLoaded && questionCount === 0);

export function composerReducer(state, action) {
    const { draft } = state;
    switch (action.type) {
        case 'roomChanged':
            return { ...state, open: false, questionsLoaded: false, suggestionSent: false };
        case 'questionsLoaded':
            return state.questionsLoaded ? state : { ...state, questionsLoaded: true };
        case 'open':
            return state.open ? state : { ...state, open: true };
        case 'similarPrompt':
            return { ...state, similarPrompt: action.prompt };
        case 'text':
            return { ...state, suggestionSent: false, draft: {
                ...draft, text: action.text,
                queued: action.text.trim() !== '' && (draft.queued || (action.isAdmin && state.queueNewQuestions)),
                type: draft.typeChosen ? draft.type : guessQuestionType(action.text) ?? QuestionTypes.AGREEMENT,
            } };
        case 'chooseSetting':
            return { ...state, draft: { ...draft, [action.field]: action.value, typeChosen: true } };
        case 'options':
            return { ...state, draft: { ...draft, options: action.options } };
        case 'queue':
            return { ...state, queueNewQuestions: action.queued, draft: { ...draft, queued: action.queued } };
        case 'added':
            return draft === action.submittedDraft && matchesQuestion(draft, action.question)
                ? { ...state, draft: emptyDraft(), suggestionSent: action.suggested === true } : state;
        default:
            throw new Error(`Unknown question composer action: ${action.type}`);
    }
}

function matchesQuestion(draft, question) {
    if (draft.text.trim() !== question.text || draft.type !== question.type) return false;
    switch (question.type) {
        case QuestionTypes.NUMERICAL:
            return draft.minValue !== '' && draft.maxValue !== ''
                && Number(draft.minValue) === question.minValue && Number(draft.maxValue) === question.maxValue;
        case QuestionTypes.MULTIPLE_CHOICE: {
            const { options } = validateChoiceOptions(draft.options, MULTIPLE_CHOICE_LIMITS);
            return options?.length === question.options.length && options.every((value, index) => value === question.options[index]);
        }
        case QuestionTypes.OPEN_ENDED:
            if ((draft.independentAnswers === true) !== (question.independentAnswers === true)) return false;
            return (Number(draft.maxResponses) || null) === (Number(question.maxResponses) || null)
                && (draft.showAttribution !== false) === (question.showAttribution !== false);
        default:
            return true;
    }
}

function prepareQuestion({ draft, queueNewQuestions }, isAdmin) {
    const text = draft.text.trim();
    if (!text) return { error: 'Question text cannot be empty.' };
    const question = {
        text, type: draft.type, timestamp: Date.now(), maxResponses: draft.maxResponses, showAttribution: draft.showAttribution,
    };
    if (draft.type === QuestionTypes.OPEN_ENDED && draft.independentAnswers) {
        if (!isAdmin) return { error: 'Moderator access is required to collect independent answers.' };
        question.independentAnswers = true;
    }
    if (draft.type === QuestionTypes.NUMERICAL) {
        const range = validateNumericalRange(draft.minValue, draft.maxValue);
        if (range.error) return range;
        Object.assign(question, range);
    }
    if (draft.type === QuestionTypes.MULTIPLE_CHOICE) {
        const choices = validateChoiceOptions(draft.options, MULTIPLE_CHOICE_LIMITS);
        if (choices.error) return choices;
        question.options = choices.options;
    }
    if (isAdmin && draft.tools) question.tools = draft.tools;
    if (draft.queued && !isAdmin) {
        return { error: 'This draft is private to the moderator queue. Moderator access is required to submit it.' };
    }
    if (draft.queued || (isAdmin && queueNewQuestions)) question.queued = true;
    return { question };
}

export function createQuestionSubmission(dispatch, setError) {
    let pending = false;
    return (state, { socket, discussionSlug, adminToken, approvalRequired }, force = false) => {
        if (force && !state.similarPrompt) return;
        const { question, error } = force ? state.similarPrompt : prepareQuestion(state, !!adminToken);
        if (force) dispatch({ type: 'similarPrompt', prompt: null });
        if (error) return setError(error);
        if (pending) return;
        pending = true;
        try {
            setError(null);
            const payload = approvalRequired ? { ...question, queued: true } : question;
            socket.timeout(10000).emit('addQuestion', discussionSlug, payload, force, adminToken, (err, response) => {
                pending = false;
                if (err) {
                    setError('Could not confirm the question was added. Check the discussion before trying again.');
                } else if (response?.added) {
                    dispatch({ type: 'added', submittedDraft: state.draft, question, suggested: response.suggested });
                } else if (response?.reason === 'moderator_only') {
                    setError('Only the moderator can add questions right now.');
                } else if (response?.reason === 'not_authorized') {
                    setError(question.tools?.length ? 'Moderator access is required to enable private participant tools.' : 'Only a moderator can add a question to the queue.');
                } else if (response?.reason === 'locked') {
                    setError('This discussion is locked, so new questions are closed.');
                } else if (response?.reason !== 'similar') {
                    setError('Could not add the question. Please try again.');
                }
            });
        } catch (err) {
            pending = false;
            console.error('Error emitting addQuestion event:', err);
            setError('Failed to add question. Please try again.');
        }
    };
}
