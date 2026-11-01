import PropTypes from 'prop-types';
import React from 'react';
import { AGREEMENT_SCALE, VoteOptions, YesNoOptions } from './config';

// Stacked divergence bar + summary for an Agreement question. Shows at a glance
// how opinion splits, and labels the statement as consensus or divisive.
const AgreementResults = ({ question }) => {
    const votes = question.votes || [];
    const total = votes.length;

    const counts = AGREEMENT_SCALE.map(seg => ({
        ...seg,
        count: votes.filter(v => v.value === seg.key).length,
    }));

    if (total === 0) {
        return <p className="text-sm text-gray-500 mb-4">No votes yet — be the first to weigh in.</p>;
    }

    const agreeCount = counts.filter(c => c.key === VoteOptions.AGREE || c.key === VoteOptions.STRONGLY_AGREE)
        .reduce((sum, c) => sum + c.count, 0);
    const disagreeCount = counts.filter(c => c.key === VoteOptions.DISAGREE || c.key === VoteOptions.STRONGLY_DISAGREE)
        .reduce((sum, c) => sum + c.count, 0);
    const agreePct = Math.round((agreeCount / total) * 100);
    const disagreePct = Math.round((disagreeCount / total) * 100);

    // Divisive when the room is split roughly evenly between agree and disagree;
    // consensus when one side clearly dominates.
    const decided = agreeCount + disagreeCount;
    let badge = null;
    if (decided >= 2) {
        const split = Math.min(agreeCount, disagreeCount) / decided; // 0..0.5
        if (split >= 0.4) {
            badge = <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-800">Divisive</span>;
        } else if (split <= 0.15) {
            badge = <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">Consensus</span>;
        }
    }

    return (
        <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">
                    {total} {total === 1 ? 'vote' : 'votes'} · {agreePct}% agree · {disagreePct}% disagree
                </span>
                {badge}
            </div>
            <div className="flex w-full h-4 rounded-full overflow-hidden bg-gray-200">
                {counts.map(seg => seg.count > 0 && (
                    <div
                        key={seg.key}
                        className={seg.bar}
                        style={{ width: `${(seg.count / total) * 100}%` }}
                        title={`${seg.label}: ${seg.count}`}
                    />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {counts.map(seg => (
                    <span key={seg.key} className="flex items-center text-xs text-gray-600">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full mr-1 ${seg.dot}`} />
                        {seg.label}: {seg.count}
                    </span>
                ))}
            </div>
        </div>
    );
};

AgreementResults.propTypes = {
    question: PropTypes.shape({
        votes: PropTypes.array,
    }).isRequired,
};

// Stacked divergence bar + summary for a Yes/No question — the binary sibling of
// AgreementResults. Yes is green, No is red, mirroring the agreement scale.
const YesNoResults = ({ question }) => {
    const votes = question.votes || [];
    const total = votes.length;

    if (total === 0) {
        return <p className="text-sm text-gray-500 mb-4">No votes yet — be the first to weigh in.</p>;
    }

    const yesCount = votes.filter(v => v.value === YesNoOptions.YES).length;
    const noCount = votes.filter(v => v.value === YesNoOptions.NO).length;
    const yesPct = Math.round((yesCount / total) * 100);
    const noPct = Math.round((noCount / total) * 100);

    // Divisive when the room is split roughly evenly; consensus when one side
    // clearly dominates. Mirrors the thresholds used for agreement questions.
    let badge = null;
    if (total >= 2) {
        const split = Math.min(yesCount, noCount) / total; // 0..0.5
        if (split >= 0.4) {
            badge = <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-800">Divisive</span>;
        } else if (split <= 0.15) {
            badge = <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-emerald-100 text-emerald-800">Consensus</span>;
        }
    }

    const segments = [
        { key: YesNoOptions.NO, label: 'No', count: noCount, bar: 'bg-red-500', dot: 'bg-red-500' },
        { key: YesNoOptions.YES, label: 'Yes', count: yesCount, bar: 'bg-green-500', dot: 'bg-green-500' },
    ];

    return (
        <div className="mb-4">
            <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-600">
                    {total} {total === 1 ? 'vote' : 'votes'} · {yesPct}% yes · {noPct}% no
                </span>
                {badge}
            </div>
            <div className="flex w-full h-4 rounded-full overflow-hidden bg-gray-200">
                {segments.map(seg => seg.count > 0 && (
                    <div
                        key={seg.key}
                        className={seg.bar}
                        style={{ width: `${(seg.count / total) * 100}%` }}
                        title={`${seg.label}: ${seg.count}`}
                    />
                ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {segments.map(seg => (
                    <span key={seg.key} className="flex items-center text-xs text-gray-600">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full mr-1 ${seg.dot}`} />
                        {seg.label}: {seg.count}
                    </span>
                ))}
            </div>
        </div>
    );
};

YesNoResults.propTypes = {
    question: PropTypes.shape({
        votes: PropTypes.array,
    }).isRequired,
};

// Compact agreement-distribution bar for a single brainstorm idea. Shows how the
// room splits without naming anyone — the whole point of the agreement axis.
const AgreementMiniBar = ({ counts }) => {
    const total = AGREEMENT_SCALE.reduce((sum, seg) => sum + (counts[seg.key] || 0), 0);
    if (total === 0) {
        return <p className="text-xs text-gray-400 mt-1">No agreement votes yet.</p>;
    }
    return (
        <div className="mt-1">
            <div className="flex w-full h-2 rounded-full overflow-hidden bg-gray-200">
                {AGREEMENT_SCALE.map(seg => (counts[seg.key] || 0) > 0 && (
                    <div
                        key={seg.key}
                        className={seg.bar}
                        style={{ width: `${((counts[seg.key] || 0) / total) * 100}%` }}
                        title={`${seg.label}: ${counts[seg.key]}`}
                    />
                ))}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{total} agreement {total === 1 ? 'vote' : 'votes'}</div>
        </div>
    );
};

AgreementMiniBar.propTypes = {
    counts: PropTypes.object,
};

export { AgreementResults, YesNoResults, AgreementMiniBar };
