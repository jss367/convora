import PropTypes from 'prop-types';
import React from 'react';
import { AGREEMENT_SCALE, VoteOptions, YesNoOptions } from '../questions/config';

// Charts drawn for the room display: read from across a room on a TV or
// projector, with nobody hovering to find a number. Every bar carries its own
// label, count and percentage, so nothing depends on color alone. `focus` is the
// one-question view, where the chart has the whole screen.

const pct = (count, total) => (total > 0 ? Math.round((count / total) * 100) : 0);

const sizes = focus => (focus
    ? { label: 'text-4xl', value: 'text-4xl', bar: 'h-16', headline: 'text-6xl', histogram: 'h-[22rem]', axis: 'text-2xl' }
    : { label: 'text-2xl', value: 'text-2xl', bar: 'h-10', headline: 'text-4xl', histogram: 'h-56', axis: 'text-lg' });

// Consensus or divisive, by the same thresholds the phone view uses.
const splitBadge = (a, b, focus) => {
    const decided = a + b;
    if (decided < 2) return null;
    const split = Math.min(a, b) / decided;
    const cls = focus ? 'text-2xl px-4 py-1' : 'text-lg px-3 py-0.5';
    if (split >= 0.4) return <span className={`${cls} rounded-full bg-amber-100 font-semibold text-amber-900`}>Divisive</span>;
    if (split <= 0.15) return <span className={`${cls} rounded-full bg-emerald-100 font-semibold text-emerald-900`}>Consensus</span>;
    return null;
};

const NoResponses = ({ focus }) => (
    <p className={`${focus ? 'text-4xl' : 'text-2xl'} text-gray-500`}>No responses yet</p>
);
NoResponses.propTypes = { focus: PropTypes.bool };

// One labelled horizontal bar per option, all against the same total.
const BarRows = ({ rows, total, focus }) => {
    const s = sizes(focus);
    return (
        <ul className="space-y-3" data-testid="display-chart">
            {rows.map(row => {
                const share = pct(row.count, total);
                return (
                    <li key={row.key} className="flex items-center gap-4" aria-label={`${row.label}: ${row.count}, ${share}%`}>
                        <span className={`${s.label} w-[40%] max-w-[18rem] shrink-0 font-medium text-gray-800`}>{row.label}</span>
                        <span className={`${s.bar} relative flex-1 overflow-hidden rounded-md bg-gray-100`}>
                            <span
                                className={`absolute inset-y-0 left-0 rounded-md ${row.bar} transition-[width] duration-500`}
                                style={{ width: `${total > 0 ? (row.count / total) * 100 : 0}%` }}
                            />
                        </span>
                        <span className={`${s.value} w-[7.5ch] shrink-0 text-right tabular-nums text-gray-900`}>
                            <span className="font-bold">{share}%</span>
                            <span className="ml-2 text-gray-500">{row.count}</span>
                        </span>
                    </li>
                );
            })}
        </ul>
    );
};
BarRows.propTypes = {
    rows: PropTypes.arrayOf(PropTypes.shape({
        key: PropTypes.string.isRequired,
        label: PropTypes.string.isRequired,
        count: PropTypes.number.isRequired,
        bar: PropTypes.string.isRequired,
    })).isRequired,
    total: PropTypes.number.isRequired,
    focus: PropTypes.bool,
};

const Headline = ({ children, badge, focus }) => (
    <div className="mb-5 flex flex-wrap items-center gap-4">
        <p className={`${sizes(focus).headline} font-bold text-gray-900`}>{children}</p>
        {badge}
    </div>
);
Headline.propTypes = { children: PropTypes.node.isRequired, badge: PropTypes.node, focus: PropTypes.bool };

export const AgreementChart = ({ question, focus }) => {
    const votes = question.votes || [];
    const total = votes.length;
    if (total === 0) return <NoResponses focus={focus} />;
    const rows = [...AGREEMENT_SCALE].reverse().map(seg => ({
        ...seg,
        count: votes.filter(v => v.value === seg.key).length,
    }));
    const countOf = keys => rows.filter(r => keys.includes(r.key)).reduce((sum, r) => sum + r.count, 0);
    const agree = countOf([VoteOptions.AGREE, VoteOptions.STRONGLY_AGREE]);
    const disagree = countOf([VoteOptions.DISAGREE, VoteOptions.STRONGLY_DISAGREE]);
    return (
        <div>
            <Headline focus={focus} badge={splitBadge(agree, disagree, focus)}>
                {pct(agree, total)}% agree
                <span className="mx-3 text-gray-300">·</span>
                {pct(disagree, total)}% disagree
            </Headline>
            <BarRows rows={rows} total={total} focus={focus} />
        </div>
    );
};
AgreementChart.propTypes = { question: PropTypes.object.isRequired, focus: PropTypes.bool };

export const YesNoChart = ({ question, focus }) => {
    const votes = question.votes || [];
    const total = votes.length;
    if (total === 0) return <NoResponses focus={focus} />;
    const yes = votes.filter(v => v.value === YesNoOptions.YES).length;
    const no = votes.filter(v => v.value === YesNoOptions.NO).length;
    const rows = [
        { key: YesNoOptions.YES, label: 'Yes', count: yes, bar: 'bg-green-500' },
        { key: YesNoOptions.NO, label: 'No', count: no, bar: 'bg-red-500' },
    ];
    return (
        <div>
            <Headline focus={focus} badge={splitBadge(yes, no, focus)}>
                {pct(yes, total)}% yes
                <span className="mx-3 text-gray-300">·</span>
                {pct(no, total)}% no
            </Headline>
            <BarRows rows={rows} total={total} focus={focus} />
        </div>
    );
};
YesNoChart.propTypes = { question: PropTypes.object.isRequired, focus: PropTypes.bool };

const formatNumber = n => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// Bins match the phone view's NumericalResults: up to 10 across [min, max].
// Bin i holds the integers v with floor((v - min) / range * binCount) === i, so
// it starts at min + ceil(i * range / binCount).
export const NumericalChart = ({ question, minValue, maxValue, focus }) => {
    const s = sizes(focus);
    const values = (question.votes || []).map(v => parseInt(v.value)).filter(n => !Number.isNaN(n));
    const total = values.length;
    if (total === 0) return <NoResponses focus={focus} />;

    const range = Math.max(maxValue - minValue, 1);
    const binCount = Math.min(10, range + 1);
    const bins = new Array(binCount).fill(0);
    values.forEach(n => {
        const clamped = Math.min(Math.max(n, minValue), maxValue);
        bins[Math.min(binCount - 1, Math.floor(((clamped - minValue) / range) * binCount))] += 1;
    });
    // A short whole-number range (1-5, 0-10) gets one bin per value: each bar is
    // labelled with its value, centered under it. A longer range is labelled at
    // the bin edges, where each bin starts and then the maximum. With many labels
    // and little room, every other one is enough.
    const oneValuePerBin = binCount === range + 1;
    const labelStep = !focus && binCount > 6 ? 2 : 1;
    const axisLabels = oneValuePerBin
        ? bins
            .map((_, i) => ({ value: minValue + i, at: ((i + 0.5) / binCount) * 100, align: 'center' }))
            .filter((_, i) => i % labelStep === 0 || i === binCount - 1)
        : [...bins.map((_, i) => minValue + Math.ceil((i * range) / binCount)), maxValue]
            .map((value, i) => ({ value, at: (i / binCount) * 100, align: i === 0 ? 'start' : i === binCount ? 'end' : 'center' }))
            .filter((_, i) => i % labelStep === 0 || i === binCount);
    const tallest = Math.max(...bins);
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(total / 2);
    const median = total % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const average = values.reduce((sum, n) => sum + n, 0) / total;
    // On the same scale as the axis: one-value bars are centered on their value.
    const clampedAverage = Math.min(Math.max(average, minValue), maxValue) - minValue;
    const averageAt = oneValuePerBin
        ? ((clampedAverage + 0.5) / binCount) * 100
        : (clampedAverage / range) * 100;

    return (
        <div>
            <div className="mb-5 flex flex-wrap items-baseline gap-x-8 gap-y-2">
                <p className={`${s.headline} flex items-center gap-4 font-bold text-gray-900`}>
                    <span className="inline-block h-[0.8em] border-l-4 border-dashed border-gray-800" aria-hidden="true" />
                    Average {formatNumber(average)}
                </p>
                <p className={`${s.label} text-gray-600`}>Median {formatNumber(median)}</p>
            </div>
            <div className="relative" data-testid="display-chart">
                <div className={`${s.histogram} flex items-end gap-1 border-b-2 border-gray-300`}>
                    {bins.map((count, i) => (
                        <div
                            // eslint-disable-next-line react/no-array-index-key -- bins are positional
                            key={i}
                            className="flex h-full flex-1 flex-col justify-end"
                            data-testid="display-histogram-bin"
                            aria-label={`${count} ${count === 1 ? 'response' : 'responses'}`}
                        >
                            {count > 0 && (
                                <span className={`${s.axis} mb-1 text-center font-semibold tabular-nums text-gray-800`}>{count}</span>
                            )}
                            <div
                                className="rounded-t-md bg-primary transition-[height] duration-500"
                                style={{ height: `${(count / tallest) * 85}%` }}
                            />
                        </div>
                    ))}
                </div>
                {/* The average, as a dashed line through the bars. */}
                <div
                    className={`${s.histogram} pointer-events-none absolute top-0 border-l-4 border-dashed border-gray-800`}
                    style={{ left: `${averageAt}%` }}
                    aria-hidden="true"
                />
                <div className={`${s.axis} relative mt-2 h-[1.5em] tabular-nums text-gray-600`} data-testid="display-histogram-axis">
                    {axisLabels.map(({ value, at, align }) => {
                        const shift = { start: '', center: '-translate-x-1/2', end: '-translate-x-full' }[align];
                        return (
                            <span key={at} className={`absolute top-0 ${shift}`} style={{ left: `${at}%` }}>{value}</span>
                        );
                    })}
                </div>
            </div>
        </div>
    );
};
NumericalChart.propTypes = {
    question: PropTypes.object.isRequired,
    minValue: PropTypes.number.isRequired,
    maxValue: PropTypes.number.isRequired,
    focus: PropTypes.bool,
};

// Under "show results after you vote" the server sends only how many have
// answered, so that is the whole chart.
export const ResponseCountOnly = ({ count, focus }) => (
    <div data-testid="display-results-hidden">
        <p className="flex flex-col items-start">
            <span className={`${focus ? 'text-[9rem]' : 'text-7xl'} font-bold leading-none tabular-nums text-primary`}>{count}</span>
            {' '}
            <span className={`${focus ? 'text-4xl' : 'text-2xl'} mt-2 font-semibold text-gray-800`}>
                {count === 1 ? 'response' : 'responses'}
            </span>
        </p>
        <p className={`${focus ? 'text-2xl' : 'text-lg'} mt-3 text-gray-500`}>Vote on your phone. The moderator will show the results here.</p>
    </div>
);
ResponseCountOnly.propTypes = { count: PropTypes.number.isRequired, focus: PropTypes.bool };
