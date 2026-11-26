const { parseStoredVoteValue } = require('./question-data');

function sanitizeFilename(value) {
  return String(value || 'discussion')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'discussion';
}

function escapeCsv(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const stringValue = Array.isArray(value) ? JSON.stringify(value)
    : value instanceof Date ? value.toISOString() : String(value);
  // Neutralize text a spreadsheet would run as a formula, including text that
  // starts with a tab or line break before one. A number is not a formula, and
  // quoting it would turn a negative answer into text.
  const neutralizedValue = typeof value !== 'number' && /^[=+\-@\t\r\n]/.test(stringValue) ? `'${stringValue}` : stringValue;
  return `"${neutralizedValue.replace(/"/g, '""')}"`;
}

// Stands in for the responses of a question whose results the person exporting
// may not see yet, so the row is not mistaken for a question with no responses.
const TEXT_VALUE_TYPES = new Set(['Multiple Choice', 'Open Ended', 'Brainstorm']);

const RESULTS_HIDDEN_NOTE = '(results hidden until you vote)';

// The CSV of the responses in `questions`, one row per response and one row
// for each question without any.
function responsesCsv(discussion, questions) {
  const headers = [
    'discussion_topic',
    'question_id',
    'question_text',
    'question_type',
    'question_created_at',
    'response_id',
    'respondent',
    'response_value',
    'response_created_at',
  ];
  const rows = questions.flatMap(question => {
    const votes = question.votes || [];
    if (votes.length === 0) {
      return [[
        discussion.topic,
        question.id,
        question.text,
        question.type,
        question.created_at,
        '',
        '',
        question.resultsHidden ? (question.independentAnswers ? '(answers hidden until moderator reveal)' : RESULTS_HIDDEN_NOTE) : '',
        '',
      ]];
    }

    return votes.map(vote => [
      discussion.topic,
      question.id,
      question.text,
      question.type,
      question.created_at,
      vote.id,
      vote.pseudonym || 'Anonymous',
      // Written answers are exported as typed. Parsing them as JSON would turn
      // an answer like "null" into an empty cell.
      TEXT_VALUE_TYPES.has(question.type) ? vote.value : parseStoredVoteValue(vote.value),
      vote.created_at,
    ]);
  });

  const csv = [
    headers.map(escapeCsv).join(','),
    ...rows.map(row => row.map(escapeCsv).join(',')),
  ].join('\n');
  return csv;
}

module.exports = { sanitizeFilename, escapeCsv, responsesCsv };
