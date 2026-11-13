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

// Turns a slider/number-input value into a whole number within [min, max].
// Returns null when there is no usable number (untouched, cleared, or
// mid-typing input such as "-"), which callers treat as "nothing selected".
export function clampNumericalValue(raw, min, max) {
    if (raw === null || raw === undefined || raw === '') {
        return null;
    }
    const parsed = Math.trunc(Number(raw));
    if (!Number.isFinite(parsed)) {
        return null;
    }
    return Math.min(max, Math.max(min, parsed));
}
