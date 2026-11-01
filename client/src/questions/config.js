export const QuestionTypes = {
    AGREEMENT: 'Agreement',
    YES_NO: 'Yes/No',
    NUMERICAL: 'Numerical',
    OPEN_ENDED: 'Open Ended',
    BRAINSTORM: 'Brainstorm'
};

// Shown under the type picker so creators understand what each type does.
export const QuestionTypeDescriptions = {
    [QuestionTypes.AGREEMENT]: 'Each participant picks one option on the five-point scale from Strongly Agree to Strongly Disagree.',
    [QuestionTypes.YES_NO]: 'Each participant picks a simple Yes or No — a binary alternative to the five-point agreement scale.',
    [QuestionTypes.NUMERICAL]: 'Each participant submits a single number on a slider between your min and max.',
    [QuestionTypes.OPEN_ENDED]: 'Each participant gives one free-text response, which they can edit later. One answer per person.',
    [QuestionTypes.BRAINSTORM]: 'Each participant can add as many separate ideas as they want, and remove their own. Many answers per person.'
};

export const VoteOptions = {
    STRONGLY_AGREE: 'Strongly Agree',
    AGREE: 'Agree',
    UNSURE: 'Unsure',
    DISAGREE: 'Disagree',
    STRONGLY_DISAGREE: 'Strongly Disagree',
};

// The two choices for a Yes/No question. Listed Yes-first so the green/red
// divergence bar reads left-to-right the same way the agreement bar does.
export const YesNoOptions = {
    YES: 'Yes',
    NO: 'No',
};

// Display order for the agreement divergence bar: disagreement (left, red) to
// agreement (right, green). Full literal class names so Tailwind keeps them.
export const AGREEMENT_SCALE = [
    { key: VoteOptions.STRONGLY_DISAGREE, label: 'Strongly Disagree', bar: 'bg-red-600', dot: 'bg-red-600' },
    { key: VoteOptions.DISAGREE, label: 'Disagree', bar: 'bg-red-400', dot: 'bg-red-400' },
    { key: VoteOptions.UNSURE, label: 'Unsure', bar: 'bg-gray-400', dot: 'bg-gray-400' },
    { key: VoteOptions.AGREE, label: 'Agree', bar: 'bg-green-400', dot: 'bg-green-400' },
    { key: VoteOptions.STRONGLY_AGREE, label: 'Strongly Agree', bar: 'bg-green-600', dot: 'bg-green-600' },
];

// Short labels for the compact per-idea agreement picker on brainstorm ideas.
export const AGREEMENT_SHORT = {
    [VoteOptions.STRONGLY_DISAGREE]: 'SD',
    [VoteOptions.DISAGREE]: 'D',
    [VoteOptions.UNSURE]: 'U',
    [VoteOptions.AGREE]: 'A',
    [VoteOptions.STRONGLY_AGREE]: 'SA',
};

// Curated epistemic reactions for brainstorm ideas (LessWrong-flavored): a
// small, fixed set of high-signal tags, not free-form emoji. Keys must match the
// server's allowed set; labels/emoji are display-only.
export const EPISTEMIC_REACTIONS = [
    { key: 'changed-mind', label: 'Changed my mind', emoji: '🔁' },
    { key: 'crux', label: 'Crux', emoji: '🎯' },
    { key: 'follows', label: 'Follows', emoji: '✅' },
    { key: 'citation-needed', label: 'Citation needed', emoji: '📚' },
    { key: 'key-insight', label: 'Key insight', emoji: '💡' },
];

// All catalog keys, used as the fallback active set before the server's
// discussionState (which carries the discussion's chosen subset) arrives.
export const ALL_REACTION_KEYS = EPISTEMIC_REACTIONS.map(r => r.key);
