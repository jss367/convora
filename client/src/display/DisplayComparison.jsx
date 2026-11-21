import PropTypes from 'prop-types';
import React from 'react';
import { distributionRows, snapshotQuestionChanged } from '../OpinionSnapshots';
import { formatNumerical } from '../questions/questionHelpers.mjs';

// The before-and-after view of the room display: two saved opinion snapshots
// side by side, sized to be read from across a room. Each answer gets one bar
// per snapshot, labelled with its share and count, so nothing depends on color
// alone. `focus` is the one-question view, where the comparison has the screen.

const sizes = focus => (focus
    ? { title: 'text-6xl', label: 'text-3xl', value: 'text-3xl', bar: 'h-10', headline: 'text-5xl', note: 'text-2xl', legend: 'text-3xl', histogram: 'h-[22rem]', axis: 'text-2xl' }
    : { title: 'text-3xl', label: 'text-xl', value: 'text-xl', bar: 'h-6', headline: 'text-3xl', note: 'text-lg', legend: 'text-2xl', histogram: 'h-56', axis: 'text-lg' });

const share = (count, total) => (total > 0 ? Math.round((count / total) * 100) : 0);

const SERIES = {
    before: { bar: 'bg-gray-400', swatch: 'bg-gray-400' },
    after: { bar: 'bg-primary', swatch: 'bg-primary' },
};

const SeriesBar = ({ series, count, total, name, s }) => (
    <div className="flex items-center gap-4" aria-label={`${name}: ${count}, ${share(count, total)}%`}>
        <span className={`${s.bar} relative flex-1 overflow-hidden rounded-md bg-gray-100`}>
            <span
                className={`absolute inset-y-0 left-0 rounded-md ${SERIES[series].bar} transition-[width] duration-500`}
                style={{ width: `${total > 0 ? (count / total) * 100 : 0}%` }}
            />
        </span>
        <span className={`${s.value} w-[7.5ch] shrink-0 text-right tabular-nums text-gray-900`}>
            <span className="font-bold">{share(count, total)}%</span>
            <span className="ml-2 text-gray-500">{count}</span>
        </span>
    </div>
);
SeriesBar.propTypes = {
    series: PropTypes.oneOf(['before', 'after']).isRequired,
    count: PropTypes.number.isRequired,
    total: PropTypes.number,
    name: PropTypes.string.isRequired,
    s: PropTypes.object.isRequired,
};

// One row per answer. `sides` lists which snapshots to draw a bar for.
const ComparisonRows = ({ rows, sides, s }) => (
    <ul className="space-y-4" data-testid="display-comparison-rows">
        {rows.map((row, index) => (
            <li key={row.label} className="flex items-center gap-4">
                <span className={`${s.label} w-[32%] max-w-[18rem] shrink-0 break-words font-medium text-gray-800`}>{row.label}</span>
                <div className="flex-1 space-y-1">
                    {sides.map(side => (
                        <SeriesBar
                            key={side.series}
                            series={side.series}
                            name={side.name}
                            count={distributionRows(side.question)[index]?.count || 0}
                            total={side.question.responseCount}
                            s={s}
                        />
                    ))}
                </div>
            </li>
        ))}
    </ul>
);
ComparisonRows.propTypes = { rows: PropTypes.array.isRequired, sides: PropTypes.array.isRequired, s: PropTypes.object.isRequired };

// A numerical question's distributions as one histogram: for each bin, a column
// per snapshot, side by side. Ten bins as rows would not fit a screen nobody
// scrolls. Column heights are shares of each snapshot's own responses, so two
// snapshots with different numbers of responses compare fairly; the number on
// a column is its count. The axis is labelled where each bin starts, then the
// maximum.
const ComparisonHistogram = ({ sides, s }) => {
    const bins = sides[0].question.distribution;
    const rows = distributionRows(sides[0].question);
    const shareOf = (side, index) => {
        const total = side.question.responseCount;
        return total > 0 ? (side.question.distribution[index]?.count || 0) / total : 0;
    };
    const tallest = Math.max(0, ...sides.flatMap(side => bins.map((_, index) => shareOf(side, index))));
    const edges = [...bins.map(bin => bin.min), bins[bins.length - 1].max];
    return (
        <div data-testid="display-comparison-rows">
            <div className={`${s.histogram} flex items-end gap-2 border-b-2 border-gray-300`}>
                {bins.map((bin, index) => (
                    <div key={bin.min} className="flex h-full flex-1 items-end gap-0.5">
                        {sides.map(side => {
                            const count = side.question.distribution[index]?.count || 0;
                            return (
                                <div
                                    key={side.series}
                                    className="flex h-full flex-1 flex-col justify-end"
                                    aria-label={`${side.name}, ${rows[index].label}: ${count}, ${share(count, side.question.responseCount)}%`}
                                >
                                    {count > 0 && (
                                        <span className={`${s.axis} mb-1 text-center font-semibold tabular-nums text-gray-800`}>{count}</span>
                                    )}
                                    <div
                                        className={`rounded-t-md ${SERIES[side.series].bar} transition-[height] duration-500`}
                                        style={{ height: `${tallest > 0 ? (shareOf(side, index) / tallest) * 85 : 0}%` }}
                                    />
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
            <div className={`${s.axis} relative mt-2 h-[1.5em] tabular-nums text-gray-600`}>
                {edges.map((value, index) => {
                    const shift = index === 0 ? '' : index === edges.length - 1 ? '-translate-x-full' : '-translate-x-1/2';
                    return (
                        <span key={value} className={`absolute ${shift}`} style={{ left: `${(index / bins.length) * 100}%` }}>
                            {formatNumerical(value)}
                        </span>
                    );
                })}
            </div>
        </div>
    );
};
ComparisonHistogram.propTypes = { sides: PropTypes.array.isRequired, s: PropTypes.object.isRequired };

const ComparisonCard = ({ before, after, beforeName, afterName, focus }) => {
    const s = sizes(focus);
    const question = after || before;
    const hidden = before?.resultsHidden || after?.resultsHidden;
    const changed = snapshotQuestionChanged(before, after);
    const sides = [
        before && { series: 'before', name: beforeName, question: before },
        after && { series: 'after', name: afterName, question: after },
    ].filter(Boolean);
    const delta = !changed && before?.average != null && after?.average != null ? after.average - before.average : null;

    let body;
    if (hidden) {
        // The display has not voted, so it gets a snapshot's results only for
        // questions whose results the moderator has shown to everyone.
        body = <p className={`${s.note} text-gray-500`}>Hidden until the moderator shows this question’s results.</p>;
    } else if (changed) {
        body = (
            <>
                <p className={`${s.note} mb-4 text-amber-800`}>The question or its histogram bins changed between snapshots, so each is shown on its own.</p>
                <div className="space-y-8">
                    {sides.map(side => (
                        <ComparisonRows key={side.series} rows={distributionRows(side.question)} sides={[side]} s={s} />
                    ))}
                </div>
            </>
        );
    } else if (question.type === 'Numerical') {
        body = <ComparisonHistogram sides={sides} s={s} />;
    } else {
        body = <ComparisonRows rows={distributionRows(question)} sides={sides} s={s} />;
    }

    return (
        <article
            className={`flex flex-col rounded-2xl bg-white shadow-lg ring-1 ring-black/5 ${focus ? 'p-10' : 'p-7'}`}
            data-testid="display-comparison"
        >
            <h2 className={`${s.title} ${focus ? 'mb-8' : 'mb-5'} break-words font-bold leading-tight text-gray-900`}>{question.text}</h2>
            {!hidden && question.type === 'Numerical' && (
                <p className={`${s.headline} mb-6 font-bold tabular-nums text-gray-900`} data-testid="display-comparison-average">
                    Average {formatNumerical(before?.average)}
                    {after && <> → {formatNumerical(after.average)}</>}
                    {delta !== null && (
                        <span className="ml-4 text-primary">({delta > 0 ? '+' : ''}{formatNumerical(delta)})</span>
                    )}
                </p>
            )}
            {!hidden && (
                <p className={`${s.note} mb-4 tabular-nums text-gray-600`}>
                    {before?.responseCount ?? '—'}{after && ` → ${after.responseCount ?? '—'}`} responses
                </p>
            )}
            {body}
        </article>
    );
};
ComparisonCard.propTypes = {
    before: PropTypes.object,
    after: PropTypes.object,
    beforeName: PropTypes.string.isRequired,
    afterName: PropTypes.string,
    focus: PropTypes.bool,
};

// `questionId` narrows the comparison to one question (the one the moderator
// put on the display) when either snapshot holds it; otherwise every question
// in the two snapshots is listed.
const DisplayComparison = ({ before, after, questionId, hiddenIds, wide }) => {
    const beforeQuestions = before.data?.questions || [];
    const afterQuestions = after?.data?.questions || [];
    const ids = [...new Set([...beforeQuestions, ...afterQuestions].map(q => q.id))];
    const visibleIds = ids.filter(id => !hiddenIds.has(id));
    const focus = questionId != null && visibleIds.includes(questionId);
    const shownIds = focus ? [questionId] : visibleIds;
    const legend = sizes(focus).legend;

    return (
        <div data-testid="display-comparison-view">
            <div className={`${legend} mb-8 flex flex-wrap items-center gap-x-10 gap-y-2 font-semibold text-gray-800`}>
                <span className="flex items-center gap-3">
                    <span className={`inline-block h-[0.8em] w-[1.6em] rounded ${SERIES.before.swatch}`} aria-hidden="true" />
                    {before.name}
                </span>
                {after && (
                    <span className="flex items-center gap-3">
                        <span className={`inline-block h-[0.8em] w-[1.6em] rounded ${SERIES.after.swatch}`} aria-hidden="true" />
                        {after.name}
                    </span>
                )}
            </div>
            {!after && (
                <p className="mb-8 text-2xl text-gray-500">Save a second snapshot to see what changed.</p>
            )}
            {shownIds.length === 0 ? (
                <p className="text-4xl text-gray-500">{ids.length ? 'No questions on display' : 'This snapshot has no questions'}</p>
            ) : (
                <div className={focus ? '' : `grid grid-cols-1 gap-8 ${wide ? 'xl:grid-cols-2' : '2xl:grid-cols-2'}`}>
                    {shownIds.map(id => (
                        <ComparisonCard
                            key={id}
                            before={beforeQuestions.find(q => q.id === id)}
                            after={afterQuestions.find(q => q.id === id)}
                            beforeName={before.name}
                            afterName={after?.name}
                            focus={focus}
                        />
                    ))}
                </div>
            )}
        </div>
    );
};
DisplayComparison.propTypes = {
    before: PropTypes.shape({ name: PropTypes.string.isRequired, data: PropTypes.object }).isRequired,
    after: PropTypes.shape({ name: PropTypes.string.isRequired, data: PropTypes.object }),
    questionId: PropTypes.number,
    hiddenIds: PropTypes.instanceOf(Set).isRequired,
    wide: PropTypes.bool,
};

export default DisplayComparison;
