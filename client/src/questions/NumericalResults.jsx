import PropTypes from 'prop-types';
import React from 'react';

// Summary stats + histogram for a Numerical question.
const NumericalResults = ({ question, minValue, maxValue }) => {
    const values = (question.votes || [])
        .map(v => parseInt(v.value))
        .filter(n => !Number.isNaN(n));
    const total = values.length;

    if (total === 0) {
        return <p className="text-sm text-gray-500 mb-2">No responses yet — drag the slider to add yours.</p>;
    }

    const average = values.reduce((sum, n) => sum + n, 0) / total;
    const range = Math.max(maxValue - minValue, 1);

    // Bucket values into up to 10 bins across the [min, max] range.
    const binCount = Math.min(10, range + 1);
    const bins = new Array(binCount).fill(0);
    values.forEach(n => {
        const clamped = Math.min(Math.max(n, minValue), maxValue);
        let idx = Math.floor(((clamped - minValue) / range) * binCount);
        if (idx >= binCount) idx = binCount - 1; // include the max edge
        bins[idx] += 1;
    });
    const tallestBin = Math.max(...bins);

    // Up to three integer y-axis ticks (top, middle, baseline) positioned
    // proportionally so they line up with the bar heights.
    const yTicks = tallestBin <= 1
        ? [1, 0]
        : [...new Set([tallestBin, Math.round(tallestBin / 2), 0])].sort((a, b) => b - a);

    return (
        <div className="mb-2">
            <div className="text-sm text-gray-600 mb-2">
                {total} {total === 1 ? 'response' : 'responses'} · average <span className="font-semibold">{average.toFixed(1)}</span>
            </div>
            <div className="flex gap-1">
                {/* Y-axis count labels. Each is anchored by its bottom edge at the
                    tick's proportional height, then nudged vertically so it stays
                    inside the box: the top tick hangs down from the top line, the
                    baseline tick sits on the bottom, and middle ticks are centered. */}
                <div className="relative w-6 h-16 text-[10px] leading-none text-gray-400">
                    {yTicks.map((t, idx) => {
                        const nudge = idx === 0 ? 'translate-y-full' : t === 0 ? '' : 'translate-y-1/2';
                        return (
                            <span
                                key={t}
                                className={`absolute right-0 ${nudge}`}
                                style={{ bottom: `${(t / tallestBin) * 100}%` }}
                            >
                                {t}
                            </span>
                        );
                    })}
                </div>
                <div className="flex items-end gap-1 h-16 flex-1">
                    {bins.map((count, i) => (
                        <div
                            key={i}
                            className="flex-1 bg-primary rounded-t"
                            style={{ height: tallestBin > 0 ? `${(count / tallestBin) * 100}%` : '0%' }}
                            title={`${count} ${count === 1 ? 'response' : 'responses'}`}
                        />
                    ))}
                </div>
            </div>
            {/* X-axis min/max labels, offset to align with the bars */}
            <div className="ml-7 flex justify-between text-[10px] text-gray-400 mt-1">
                <span>{minValue}</span>
                <span>{maxValue}</span>
            </div>
        </div>
    );
};

NumericalResults.propTypes = {
    question: PropTypes.shape({
        votes: PropTypes.array,
    }).isRequired,
    minValue: PropTypes.number.isRequired,
    maxValue: PropTypes.number.isRequired,
};

export default NumericalResults;
