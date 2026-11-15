// Question parsing and validation shared by transport and reporting.
function parseOptions(options) {
  if (Array.isArray(options)) {
    return options;
  }
  if (typeof options === 'string') {
    try {
      const parsed = JSON.parse(options);
      return Array.isArray(parsed) ? parsed : [options];
    } catch (e) {
      console.warn('Failed to parse options as JSON, falling back to comma-separated string');
      return options.split(',').map(opt => opt.trim());
    }
  }
  if (options === null || options === undefined) {
    return [];
  }
  console.warn('Unexpected options type:', typeof options);
  return [String(options)];
}

const AGREEMENT_OPTIONS = [
  'Strongly Disagree',
  'Disagree',
  'Unsure',
  'Agree',
  'Strongly Agree',
];

// Yes/No questions are a binary opinion type: Yes reads as agreement, No as
// disagreement, so they feed the same consensus/divisive analysis as the
// five-point agreement scale.
const YES_NO_OPTIONS = ['No', 'Yes'];

function parseStoredVoteValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
}

function getQuestionRange(question) {
  const min = Number.parseInt(question.min_value, 10);
  const max = Number.parseInt(question.max_value, 10);
  return {
    minValue: Number.isNaN(min) ? 0 : min,
    maxValue: Number.isNaN(max) ? 100 : max,
  };
}

// The question types a discussion supports. Mirrors QuestionTypes in
// client/src/questions/config.js — used to validate creates/edits server-side.
const VALID_QUESTION_TYPES = new Set(['Agreement', 'Yes/No', 'Multiple Choice', 'Numerical', 'Open Ended', 'Brainstorm']);

// A Multiple Choice question carries its own answer options, set by whoever
// writes it. Participants pick exactly one. Mirrors MULTIPLE_CHOICE_LIMITS in
// client/src/questions/config.js.
const MULTIPLE_CHOICE_MIN_OPTIONS = 2;
const MULTIPLE_CHOICE_MAX_OPTIONS = 6;
const MULTIPLE_CHOICE_MAX_OPTION_LENGTH = 100;

// Trimmed options, or null when the list is not a valid set of choices: too few
// or too many, an empty or overlong option, or two options that differ only in
// case or spacing (participants could not tell them apart).
function normalizeChoiceOptions(options) {
  if (!Array.isArray(options)) return null;
  const normalized = options.map(option => (typeof option === 'string' ? option.trim().replace(/\s+/g, ' ') : ''));
  if (normalized.length < MULTIPLE_CHOICE_MIN_OPTIONS || normalized.length > MULTIPLE_CHOICE_MAX_OPTIONS) return null;
  if (normalized.some(option => !option || option.length > MULTIPLE_CHOICE_MAX_OPTION_LENGTH)) return null;
  if (new Set(normalized.map(option => option.toLowerCase())).size !== normalized.length) return null;
  return normalized;
}

// The answers a single-choice question accepts, or null for types that are not
// single-choice. Agreement and Yes/No have fixed options; Multiple Choice uses
// the question's stored ones.
function choiceOptionsFor(question) {
  if (question.type === 'Agreement') return AGREEMENT_OPTIONS;
  if (question.type === 'Yes/No') return YES_NO_OPTIONS;
  if (question.type === 'Multiple Choice') {
    return parseOptions(question.options).filter(option => typeof option === 'string');
  }
  return null;
}

function parseIntegerInput(value) {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number(value);
  }
  return NaN;
}

function normalizeQuestionPayload(question) {
  if (!question || typeof question !== 'object') {
    return null;
  }

  const text = String(question.text ?? '').trim();
  const type = question.type;
  if (!text || !VALID_QUESTION_TYPES.has(type)) {
    return null;
  }

  let minValue = null;
  let maxValue = null;
  if (type === 'Numerical') {
    minValue = parseIntegerInput(question.minValue);
    maxValue = parseIntegerInput(question.maxValue);
    if (!Number.isInteger(minValue) || !Number.isInteger(maxValue) || minValue >= maxValue) {
      return null;
    }
  }

  // Only Multiple Choice questions store options; other types ignore any sent.
  let options = [];
  if (type === 'Multiple Choice') {
    options = normalizeChoiceOptions(question.options);
    if (!options) return null;
  }

  return {
    text,
    type,
    minValue,
    maxValue,
    options,
  };
}

module.exports = {
  AGREEMENT_OPTIONS, YES_NO_OPTIONS, parseOptions, parseStoredVoteValue,
  getQuestionRange, normalizeQuestionPayload, normalizeChoiceOptions, choiceOptionsFor,
  MULTIPLE_CHOICE_MIN_OPTIONS, MULTIPLE_CHOICE_MAX_OPTIONS, MULTIPLE_CHOICE_MAX_OPTION_LENGTH,
};
