export const QuestionTypes = {
    AGREEMENT: 'Agreement',
    YES_NO: 'Yes/No',
    MULTIPLE_CHOICE: 'Multiple Choice',
    NUMERICAL: 'Numerical',
    OPEN_ENDED: 'Open Ended'
};

export const questionTypeFilterOptions = [['all', 'All types'], ...Object.values(QuestionTypes).map(type => [type, type])];

// Bounds on a Multiple Choice question's options. Mirror the
// MULTIPLE_CHOICE_* constants in question-data.js, which enforces them.
export const MULTIPLE_CHOICE_LIMITS = {
    MIN_OPTIONS: 2,
    MAX_OPTIONS: 6,
    MAX_OPTION_LENGTH: 100,
};
