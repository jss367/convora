// Stance helpers for the Opinion Groups page. Kept free of React so the
// label/tally logic can be tested directly from Node.

// Map a mean agreement score (-2..2) to a human-readable leaning. Always
// returns a text label so the view stays readable without relying on color.
export function leaning(mean) {
    if (mean >= 1.2) return { label: 'Strongly agrees', tone: 'text-green-700', dot: 'bg-green-600' };
    if (mean >= 0.3) return { label: 'Agrees', tone: 'text-green-600', dot: 'bg-green-400' };
    if (mean > -0.3) return { label: 'Mixed / unsure', tone: 'text-gray-600', dot: 'bg-gray-400' };
    if (mean > -1.2) return { label: 'Disagrees', tone: 'text-red-600', dot: 'bg-red-400' };
    return { label: 'Strongly disagrees', tone: 'text-red-700', dot: 'bg-red-600' };
}

// Split a group's votes on one statement into the five real answer buckets,
// ordered from strongest disagreement to strongest agreement, leaving out the
// empty ones. The server's `agree` and `disagree` totals include the strong
// votes, so the plain buckets are what remains after taking those out.
export function stanceBuckets({ agree = 0, unsure = 0, disagree = 0, stronglyAgree = 0, stronglyDisagree = 0 }) {
    return [
        { key: 'stronglyDisagree', label: 'Strongly disagree', count: stronglyDisagree, bar: 'bg-red-600' },
        { key: 'disagree', label: 'Disagree', count: disagree - stronglyDisagree, bar: 'bg-red-400' },
        { key: 'unsure', label: 'Unsure', count: unsure, bar: 'bg-gray-400' },
        { key: 'agree', label: 'Agree', count: agree - stronglyAgree, bar: 'bg-green-400' },
        { key: 'stronglyAgree', label: 'Strongly agree', count: stronglyAgree, bar: 'bg-green-600' },
    ].filter(bucket => bucket.count > 0);
}
