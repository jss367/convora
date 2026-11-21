// Guesses a question's type from its wording, so the composer can preselect the
// type picker while someone types. A handful of ordered phrase rules, not a
// classifier: it is right for common openings and returns null for anything it
// does not recognize, so the caller keeps its default.
import { QuestionTypes } from './questionTypes.mjs';
import { plainPrompt } from './promptEmphasis.mjs';
const { AGREEMENT, YES_NO, NUMERICAL, MULTIPLE_CHOICE, OPEN_ENDED } = QuestionTypes;

const AUXILIARY = '(?:is|are|was|were|do|does|did|will|would|should|can|could|has|have)';
const WH_WORD = '(?:why|how|what|which|who|whose|where|when)';
const CHOICE_SET = 'of (?:these|those|the following)(?: (?:options|choices|alternatives))?';

// First match wins, so the order is the precedence: "how likely" has to be
// claimed as Numerical before the general "how ..." rule calls it Open Ended,
// and every specific phrase comes before the bare Yes/No openers. Patterns see
// one lowercased clause at a time. A `questionOnly` rule applies only to text
// that ends in a question mark.
const RULES = [
    { type: AGREEMENT, pattern: /^(?:(?:do|would) you agree|agree or disagree)\b/ },

    { type: NUMERICAL, pattern: /^(?:(?:in|by|at|for|after|within|over) )?how (?:likely|unlikely|probable|many|much|confident|certain|sure|long|old)\b/ },
    { type: NUMERICAL, pattern: /^(?:(?:in|by) )?(?:what|which) (?:year|percent(?:age)?|%|fraction|proportion|share|number)(?=\W|$)/ },
    { type: NUMERICAL, pattern: /^what(?:'s| is| are| was| were| would be)(?: the| your)? (?:probability|likelihood|odds|chances?|percent(?:age)?|number|fraction|proportion|share)\b/ },
    { type: NUMERICAL, pattern: /^what chance is there (?:that|of)\b/ },
    { type: NUMERICAL, pattern: /^(?:the )?(?:probability|likelihood|odds|chances?) (?:that|of)\b/ },
    { type: NUMERICAL, pattern: /^(?:estimate|guess)\b/ },
    { type: NUMERICAL, pattern: /^rate (?:your|the|this|our|how)\b/ },
    { type: NUMERICAL, pattern: /\bon a scale\b|\bscale (?:of|from) \d/ },

    { type: MULTIPLE_CHOICE, pattern: /^which\b.*\b(?:would|do) you prefer\b/ },
    { type: MULTIPLE_CHOICE, pattern: new RegExp(`^which(?: (?:one|option|${CHOICE_SET}))? (?:would|could)\\b.*\\byou (?:the )?most\\b`) },

    { type: OPEN_ENDED, pattern: /^what(?:'re| are) (?:some|a few|good|other|possible|potential)\b/ },
    { type: OPEN_ENDED, pattern: /^what (?:else )?(?:should|could|can|might) we\b/ },
    { type: OPEN_ENDED, pattern: /^how (?:can|could|might) we\b/ },
    { type: OPEN_ENDED, pattern: /^(?:what|which|any) (?:ideas|suggestions|ways|options|topics|features|questions|names|examples|alternatives)\b/ },
    { type: OPEN_ENDED, pattern: /^(?:ideas|suggestions|ways|options|names|topics|examples|alternatives) (?:for|to|on)\b/ },
    { type: OPEN_ENDED, pattern: /^(?:list|name|suggest) (?:some|a|an|one|two|three|the|your|any|\d+)\b/ },
    { type: OPEN_ENDED, pattern: /^brainstorm\b/ },

    // A question word only counts once the wording is clearly a question: either
    // a verb follows it ("what do ...") or the text ends in a question mark.
    // Otherwise statements such as "When AI arrives, jobs change" would match.
    { type: OPEN_ENDED, pattern: new RegExp(`^${WH_WORD}(?:'s|'re| ${AUXILIARY}\\b)`) },
    { type: OPEN_ENDED, pattern: new RegExp(`^${WH_WORD}\\b`), questionOnly: true },
    { type: OPEN_ENDED, pattern: /^(?:describe|explain|elaborate on|tell (?:us|me))\b/ },

    // The trailing space keeps a half-typed word from matching: "Is" could
    // still become "Issues".
    { type: YES_NO, pattern: new RegExp(`^(?:${AUXILIARY}(?:n't)?|won't|can't)\\s`) },
];

// Returns one of the question type names, or null when nothing matches.
export function guessQuestionType(text) {
    const normalized = plainPrompt(String(text ?? ''))
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, ' ')
        .replace(/, ?if any, /g, ' ')
        // Drop leading quotes, bullets and numbering such as "1. ".
        .replace(/^(?:\d+[.)] )?[^a-z0-9]*/, '');
    if (normalized.trim() === '') {
        return null;
    }
    const isQuestion = /\?["')\]\s]*$/.test(normalized);
    // The asking part is often not first ("By 2030, how likely ...", "If prices
    // rise, will customers leave?"), so look at each clause. Later clauses only
    // count in an actual question, to keep statements with commas out. A
    // leading conjunction is dropped so "..., and why?" still reads as "why".
    const clauses = normalized.split(/[,;:.!?]+ | [-–—]+ /)
        .map(clause => clause.replace(/^(?:and|or|but|so|then) /, ''))
        .filter(clause => clause !== '');
    const candidates = isQuestion ? clauses : clauses.slice(0, 1);
    for (const { type, pattern, questionOnly } of RULES) {
        if (questionOnly && !isQuestion) {
            continue;
        }
        if (candidates.some(clause => pattern.test(clause))) {
            return type;
        }
    }
    return null;
}
