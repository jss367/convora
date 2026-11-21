// Pure helpers for the discussion page, kept free of React so the Node test
// suite can import them directly (hence the explicit .mjs extension).

// Sort key for "Most Recent". The server's created_at is the source of truth:
// it is the same for every participant, whereas the client-side `timestamp` is
// just when this browser first received the question, which is identical for
// every question present at page load. The client timestamp is only a fallback
// for a question that has no usable created_at yet.
export function getQuestionSortTime(question) {
    const createdAt = Date.parse(question?.created_at);
    if (!Number.isNaN(createdAt)) {
        return createdAt;
    }
    const timestamp = Number(question?.timestamp);
    return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortQuestionsMostRecent(questions) {
    return [...questions].sort((a, b) => getQuestionSortTime(b) - getQuestionSortTime(a));
}

// "Most Interesting": the questions most participants marked as interesting
// come first. Questions with the same count keep the "Most Recent" order.
export function sortQuestionsMostInteresting(questions) {
    return sortQuestionsMostRecent(questions)
        .sort((a, b) => (Number(b?.interestCount) || 0) - (Number(a?.interestCount) || 0));
}

// Older snapshots may use database field names or omit numerical bounds.
export function getNumericalRange(question) {
    const min = Number.parseInt(question.minValue ?? question.min_value, 10);
    const max = Number.parseInt(question.maxValue ?? question.max_value, 10);
    return {
        minValue: Number.isNaN(min) ? 0 : min,
        maxValue: Number.isNaN(max) ? 100 : max,
    };
}

export function validateNumericalRange(rawMin, rawMax) {
    const minValue = Number(String(rawMin).trim() || NaN);
    const maxValue = Number(String(rawMax).trim() || NaN);
    if (!Number.isInteger(minValue) || !Number.isInteger(maxValue)
        || Math.min(minValue, maxValue) < -2147483648 || Math.max(minValue, maxValue) > 2147483647) {
        return { error: 'Enter whole numbers between -2147483648 and 2147483647 for both bounds.' };
    }
    if (minValue >= maxValue) return { error: 'Minimum value must be less than maximum value.' };
    return { minValue, maxValue };
}

// Numerical answers keep at most this many decimal places, enough for a
// probability such as 0.5% on a 0 to 100 scale. Mirrors NUMERICAL_DECIMALS in
// question-data.js, which rounds what the server stores.
export const NUMERICAL_DECIMALS = 2;

// Turns a slider/number-input value into a number within [min, max], rounded to
// NUMERICAL_DECIMALS places. A decimal comma is read as a decimal point, since
// many phone keypads offer only a comma. Returns null when there is no usable
// number (untouched, cleared, or mid-typing input such as "-"), which callers
// treat as "nothing selected".
export function clampNumericalValue(raw, min, max) {
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
        return null;
    }
    const parsed = Number(typeof raw === 'string' ? raw.trim().replace(/^(-?\d*),(\d+)$/, '$1.$2') : raw);
    if (!Number.isFinite(parsed)) {
        return null;
    }
    const shift = (value, places) => {
        const [coefficient, exponent = 0] = String(value).split('e');
        return Number(`${coefficient}e${Number(exponent) + places}`);
    };
    // `+ 0` turns a rounded -0 into 0; exponent shifts preserve decimal ties.
    const rounded = shift(Math.round(shift(parsed, NUMERICAL_DECIMALS)), -NUMERICAL_DECIMALS) + 0;
    return Math.min(max, Math.max(min, rounded));
}

// A stored Numerical answer as a number, or NaN when it is not one.
export function parseNumericalVote(value) {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string' || value.trim() === '') return NaN;
    return Number(value);
}

// A statistic of numerical answers (an average, a median, a change) for
// display: one decimal place, or two when the number is small enough that one
// would hide the difference between, say, 0.25 and 0.34.
export function formatNumerical(value) {
    const number = Number(value);
    if (value === null || value === undefined || !Number.isFinite(number)) return '—';
    const rounded = Number(number.toFixed(Math.abs(number) < 10 ? NUMERICAL_DECIMALS : 1));
    return (rounded + 0).toLocaleString('en-US', { maximumFractionDigits: NUMERICAL_DECIMALS });
}

// Which of `binCount` histogram bins a numerical answer falls in. A short
// whole-number range (0 to 5, 1 to 10) has one bin per whole number, so an
// answer goes to the nearest one; a longer range is cut into equal bins, the
// last of which includes the maximum.
export function numericalBinIndex(value, minValue, maxValue, binCount) {
    const range = Math.max(maxValue - minValue, 1);
    const clamped = Math.min(Math.max(value, minValue), maxValue);
    const index = binCount === range + 1
        ? Math.round(clamped - minValue)
        : Math.floor(((clamped - minValue) / range) * binCount);
    return Math.min(binCount - 1, Math.max(0, index));
}

// Checks a Multiple Choice question's options the way the server does
// (normalizeChoiceOptions in question-data.js): empty options are dropped,
// leaving 2 to 6 options of at most 100 characters, none repeated ignoring
// case and spacing. Returns
// { options } with each option trimmed, or { error } with a message to show.
// The limits are passed in so this file stays free of the React-side config.
export function validateChoiceOptions(rawOptions, { MIN_OPTIONS, MAX_OPTIONS, MAX_OPTION_LENGTH }) {
    const options = (Array.isArray(rawOptions) ? rawOptions : [])
        .map(option => String(option ?? '').trim().replace(/\s+/g, ' '))
        .filter(option => option !== '');
    if (options.length < MIN_OPTIONS) {
        return { error: `Fill in at least ${MIN_OPTIONS} answer options.` };
    }
    if (options.length > MAX_OPTIONS) {
        return { error: `A multiple choice question needs ${MIN_OPTIONS} to ${MAX_OPTIONS} answer options.` };
    }
    if (options.some(option => option.length > MAX_OPTION_LENGTH)) {
        return { error: `Keep each answer option to ${MAX_OPTION_LENGTH} characters or fewer.` };
    }
    if (new Set(options.map(option => option.toLowerCase())).size !== options.length) {
        return { error: 'Each answer option must be different.' };
    }
    return { options };
}
