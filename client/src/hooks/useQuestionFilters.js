import { useState } from 'react';
import { sortQuestionsMostRecent, sortQuestionsMostInteresting } from '../questions/questionHelpers.mjs';
import { QuestionTypes, VoteOptions, YesNoOptions } from '../questions/config';

export const SortOptions = {
    MODERATOR: 'Moderator order',
    MOST_RECENT: 'Most Recent',
    MOST_INTERESTING: 'Most Interesting',
    MOST_AGREEMENT: 'Most agreed with',
    MOST_DISAGREEMENT: 'Most disagreed with',
    MOST_CONTROVERSIAL: 'Most divisive',
};

// Only Agreement and Yes/No are opinion prompts; the agreement sorts ignore
// other types so an Open Ended / Brainstorm answer that happens to read
// "Yes", "No", "Agree", etc. can't mis-rank a non-opinion question.
const isOpinionQuestion = (question) =>
    question?.type === QuestionTypes.AGREEMENT || question?.type === QuestionTypes.YES_NO;

// Yes/No votes count toward the same agreement/disagreement sorts as the
// five-point scale: Yes reads as agreement, No as disagreement.
const getAgreementCount = (question) => {
    if (!isOpinionQuestion(question)) return 0;
    return (question.votes || []).filter(v => v.value === VoteOptions.STRONGLY_AGREE || v.value === VoteOptions.AGREE || v.value === YesNoOptions.YES).length;
};

const getDisagreementCount = (question) => {
    if (!isOpinionQuestion(question)) return 0;
    return (question.votes || []).filter(v => v.value === VoteOptions.STRONGLY_DISAGREE || v.value === VoteOptions.DISAGREE || v.value === YesNoOptions.NO).length;
};

const getControversyScore = (question) => {
    const agreementCount = getAgreementCount(question);
    const disagreementCount = getDisagreementCount(question);
    return Math.min(agreementCount, disagreementCount);
};

const sortQuestions = (questions, sortOption) => {
    switch (sortOption) {
        case SortOptions.MODERATOR:
            return [...questions].sort((first, second) => first.moderatorOrder - second.moderatorOrder);
        case SortOptions.MOST_RECENT:
            return sortQuestionsMostRecent(questions);
        case SortOptions.MOST_INTERESTING:
            return sortQuestionsMostInteresting(questions);
        case SortOptions.MOST_AGREEMENT:
            return [...questions].sort((a, b) => getAgreementCount(b) - getAgreementCount(a));
        case SortOptions.MOST_DISAGREEMENT:
            return [...questions].sort((a, b) => getDisagreementCount(b) - getDisagreementCount(a));
        case SortOptions.MOST_CONTROVERSIAL:
            return [...questions].sort((a, b) => getControversyScore(b) - getControversyScore(a));
        default:
            return questions;
    }
};

// The participant's chosen sort order and filters for the published
// questions, and the lists they produce.
export function useQuestionFilters(questions, isMyVote) {
    const [sortOption, setSortOption] = useState(SortOptions.MODERATOR);
    const [showUnansweredOnly, setShowUnansweredOnly] = useState(false);
    const [questionTypeFilter, setQuestionTypeFilter] = useState('all');

    const filtersActive = questionTypeFilter !== 'all' || showUnansweredOnly;
    const filterQuestions = questions => questions.filter(question =>
        (questionTypeFilter === 'all' || question.type === questionTypeFilter)
        && (!showUnansweredOnly || !question.votes?.some(vote => isMyVote(question, vote)))
    );

    const sortedAndFilteredQuestions = filterQuestions(sortQuestions(questions.filter(question => !question.queued), sortOption));
    // Queued questions reach moderators only (the server sends them to nobody
    // else). Keep the saved agenda order supplied by the server.
    const queuedQuestions = questions.filter(question => question.queued);
    const canArrangePublished = sortOption === SortOptions.MODERATOR && !filtersActive;
    // Pinned questions float to the top, preserving the chosen sort within each
    // group (Array.prototype.sort is stable).
    const orderedQuestions = [...sortedAndFilteredQuestions].sort(
        (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
    );

    return {
        sortOption, setSortOption, showUnansweredOnly, setShowUnansweredOnly, questionTypeFilter, setQuestionTypeFilter,
        filtersActive, orderedQuestions, queuedQuestions, canArrangePublished,
    };
}
