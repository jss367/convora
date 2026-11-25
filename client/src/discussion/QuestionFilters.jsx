import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { questionTypeFilterOptions } from '../questions/questionTypes.mjs';
import { SortOptions } from '../hooks/useQuestionFilters';

// Sorting and filtering controls for the published questions. On a phone they
// fold behind a "Sort and filter" button.
export default function QuestionFilters({ filters }) {
    const {
        sortOption, setSortOption, showUnansweredOnly, setShowUnansweredOnly,
        questionTypeFilter, setQuestionTypeFilter, filtersActive,
    } = filters;
    const [filtersOpen, setFiltersOpen] = useState(false);
    return (
        <>
            <button type="button" aria-expanded={filtersOpen} aria-controls="question-filters"
                onClick={() => setFiltersOpen(open => !open)} className="mb-2 rounded-md border px-3 py-2 sm:hidden">
                Sort and filter{filtersActive ? ' (filtered)' : ''}
            </button>
            <div id="question-filters" className={`mb-6 flex-wrap items-center justify-between gap-3 sm:flex ${filtersOpen ? 'flex' : 'hidden'}`}>
                <select
                    value={sortOption}
                    aria-label="Sort submitted questions"
                    onChange={(e) => setSortOption(e.target.value)}
                    className="p-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
                >
                    {Object.values(SortOptions).map(option => (
                        <option key={option} value={option}>{option}</option>
                    ))}
                </select>
                <label className="flex items-center gap-2">
                    Question type
                    <select value={questionTypeFilter} onChange={event => setQuestionTypeFilter(event.target.value)} className="p-2 border border-gray-300 rounded-md">
                        {questionTypeFilterOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                </label>
                <label className="flex items-center">
                    <input
                        type="checkbox"
                        checked={showUnansweredOnly}
                        onChange={(e) => setShowUnansweredOnly(e.target.checked)}
                        className="mr-2"
                    />
                    Show only questions I haven’t answered
                </label>
            </div>
        </>
    );
}

QuestionFilters.propTypes = {
    filters: PropTypes.shape({
        sortOption: PropTypes.string.isRequired,
        setSortOption: PropTypes.func.isRequired,
        showUnansweredOnly: PropTypes.bool.isRequired,
        setShowUnansweredOnly: PropTypes.func.isRequired,
        questionTypeFilter: PropTypes.string.isRequired,
        setQuestionTypeFilter: PropTypes.func.isRequired,
        filtersActive: PropTypes.bool.isRequired,
    }).isRequired,
};
