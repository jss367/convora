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
const VALID_QUESTION_TYPES = new Set(['Agreement', 'Yes/No', 'Numerical', 'Open Ended', 'Brainstorm']);

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

  return {
    text,
    type,
    minValue,
    maxValue,
    options: Array.isArray(question.options) ? question.options : [],
  };
}

module.exports = {
  AGREEMENT_OPTIONS, YES_NO_OPTIONS, parseOptions, parseStoredVoteValue,
  getQuestionRange, normalizeQuestionPayload,
};
