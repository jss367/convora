import { getQuestionSortTime } from '../questions/questionHelpers.mjs';

// Sort only the display's public payload: hidden answers must never affect
// question order and indirectly reveal how people voted.
export function sortDisplayQuestions(questions, sort = 'oldest', pinnedFirst = true) {
    const score = question => {
        if (sort === 'interesting') return Number(question.interestCount) || 0;
        if (question.resultsHidden || !['Agreement', 'Yes/No'].includes(question.type)) return 0;
        const votes = question.votes || [];
        const agree = votes.filter(v => ['Strongly Agree', 'Agree', 'Yes'].includes(v.value)).length;
        const disagree = votes.filter(v => ['Strongly Disagree', 'Disagree', 'No'].includes(v.value)).length;
        if (sort === 'agreement') return agree;
        if (sort === 'disagreement') return disagree;
        if (sort === 'controversial') return Math.min(agree, disagree);
        return 0;
    };
    return [...questions].sort((a, b) => {
        if (pinnedFirst && Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        const chronological = getQuestionSortTime(a) - getQuestionSortTime(b) || a.id - b.id;
        if (sort === 'oldest') return chronological;
        return score(b) - score(a) || -chronological;
    });
}
