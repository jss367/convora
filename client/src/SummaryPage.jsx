import PropTypes from 'prop-types';
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

const AGREEMENT_OPTIONS = [
    'Strongly Disagree',
    'Disagree',
    'Unsure',
    'Agree',
    'Strongly Agree',
];

function formatPercent(value) {
    if (!Number.isFinite(value)) {
        return '0%';
    }
    return `${Math.round(value * 100)}%`;
}

function formatNumber(value, digits = 1) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return '-';
    }
    return Number(value).toFixed(digits);
}

function formatDate(value) {
    if (!value) {
        return '';
    }
    return new Date(value).toLocaleString();
}

const SummaryPage = () => {
    const { topic } = useParams();
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [synthesisLoading, setSynthesisLoading] = useState(false);
    const [error, setError] = useState(null);

    const encodedTopic = encodeURIComponent(topic);

    const loadSummary = useCallback(async ({ llm = false } = {}) => {
        if (llm) {
            setSynthesisLoading(true);
        } else {
            setLoading(true);
        }
        setError(null);

        try {
            const suffix = llm ? '?synthesis=llm' : '';
            const response = await fetch(`/api/discussions/${encodedTopic}/summary${suffix}`);
            if (!response.ok) {
                throw new Error('Failed to load summary');
            }
            const data = await response.json();
            setSummary(data);
        } catch (err) {
            console.error('Error loading summary:', err);
            setError('Could not load the discussion summary.');
        } finally {
            setLoading(false);
            setSynthesisLoading(false);
        }
    }, [encodedTopic]);

    useEffect(() => {
        loadSummary();
    }, [loadSummary]);

    if (loading) {
        return <div className="max-w-5xl mx-auto mt-10 px-4 text-gray-600">Loading summary...</div>;
    }

    if (error) {
        return (
            <div className="max-w-5xl mx-auto mt-10 px-4">
                <p className="text-red-600 mb-4">{error}</p>
                <Link to={`/discussion/${topic}`} className="text-primary hover:underline">Back to discussion</Link>
            </div>
        );
    }

    if (!summary) {
        return null;
    }

    return (
        <div className="max-w-5xl mx-auto mt-10 px-4">
            <div className="mb-6">
                <Link to={`/discussion/${topic}`} className="text-primary hover:underline">
                    Back to discussion
                </Link>
                <h1 className="text-4xl font-bold mt-3 mb-2 text-gray-800">Summary: {summary.discussion.topic}</h1>
                <p className="text-sm text-gray-500">Created {formatDate(summary.discussion.createdAt)}</p>
            </div>

            <div className="flex flex-wrap gap-3 mb-8">
                <a
                    href={`/api/discussions/${encodedTopic}/export.csv`}
                    className="bg-primary text-white px-4 py-2 rounded-md hover:bg-opacity-90 transition duration-300"
                >
                    Export CSV
                </a>
                <a
                    href={`/api/discussions/${encodedTopic}/export.json`}
                    className="bg-secondary text-white px-4 py-2 rounded-md hover:bg-opacity-90 transition duration-300"
                >
                    Export JSON
                </a>
                <a
                    href={`/api/discussions/${encodedTopic}/report.html`}
                    className="bg-white border border-gray-300 text-gray-800 px-4 py-2 rounded-md hover:bg-gray-50 transition duration-300"
                >
                    Final Report
                </a>
                <button
                    onClick={() => loadSummary({ llm: true })}
                    disabled={synthesisLoading}
                    className="bg-gray-800 text-white px-4 py-2 rounded-md hover:bg-gray-700 transition duration-300 disabled:opacity-50"
                >
                    {synthesisLoading ? 'Generating...' : 'Generate Synthesis'}
                </button>
            </div>

            <section className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                <CountCard label="Questions" value={summary.counts.questions} />
                <CountCard label="Responses" value={summary.counts.responses} />
                <CountCard label="Participants" value={summary.counts.participants} />
                <CountCard label="Agreement Items" value={summary.counts.byType?.Agreement || 0} />
            </section>

            <FacilitatorDashboard dashboard={summary.facilitatorDashboard} />

            <section className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
                <RankedAgreementList
                    title="Top Consensus"
                    items={summary.topConsensus}
                    metricLabel="Consensus"
                    metricKey="consensusScore"
                />
                <RankedAgreementList
                    title="Top Divisive"
                    items={summary.topDivisive}
                    metricLabel="Split"
                    metricKey="divisiveScore"
                />
            </section>

            <SynthesisPanel synthesis={summary.synthesis} />

            <section className="mt-8">
                <h2 className="text-2xl font-bold mb-4 text-gray-800">Question Counts</h2>
                <div className="space-y-4">
                    {summary.questions.map(question => (
                        <QuestionSummary key={question.id} question={question} />
                    ))}
                </div>
            </section>
        </div>
    );
};

const CountCard = ({ label, value }) => (
    <div className="bg-white shadow rounded-lg p-5">
        <div className="text-sm font-semibold text-gray-500 uppercase tracking-wide">{label}</div>
        <div className="text-3xl font-bold text-gray-900 mt-2">{value}</div>
    </div>
);

CountCard.propTypes = {
    label: PropTypes.string.isRequired,
    value: PropTypes.number.isRequired,
};

const FacilitatorDashboard = ({ dashboard }) => {
    if (!dashboard) {
        return null;
    }

    return (
        <section className="bg-white shadow rounded-lg p-6 mb-8">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
                <div>
                    <h2 className="text-2xl font-bold text-gray-800">Facilitator Dashboard</h2>
                    <p className="text-sm text-gray-500 mt-1">Signals to help close the discussion and guide follow-up.</p>
                </div>
                <span className="px-3 py-1 text-xs font-semibold rounded-full bg-blue-50 text-blue-700">
                    {dashboard.unresolvedTensions?.length || 0} tensions
                </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
                <FacilitatorMetric label="Unresolved tensions" value={dashboard.unresolvedTensions?.length || 0} />
                <FacilitatorMetric label="Unanswered prompts" value={dashboard.unansweredPrompts?.length || 0} />
                <FacilitatorMetric label="Participation gaps" value={dashboard.participationGaps?.length || 0} />
            </div>

            {dashboard.recommendedNextActions?.length > 0 && (
                <div className="bg-gray-50 rounded-md p-4 mb-6">
                    <h3 className="font-semibold text-gray-800 mb-2">Recommended Next Actions</h3>
                    <ul className="list-disc pl-5 text-gray-700 space-y-1">
                        {dashboard.recommendedNextActions.map(action => (
                            <li key={action}>{action}</li>
                        ))}
                    </ul>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <FacilitatorSignalList
                    title="Unresolved Tensions"
                    emptyText="No major unresolved tensions detected."
                    items={dashboard.unresolvedTensions}
                    renderMeta={item => `${item.type} - ${item.detail}`}
                />
                <FacilitatorSignalList
                    title="Most Divisive Statements"
                    emptyText="No divisive agreement statements yet."
                    items={dashboard.mostDivisiveStatements}
                    renderMeta={item => `${item.agreeCount} agree / ${item.disagreeCount} disagree / ${item.unsureCount} unsure`}
                    renderScore={item => `Split ${formatPercent(item.divisiveScore)}`}
                />
                <FacilitatorSignalList
                    title="Unanswered Prompts"
                    emptyText="Every prompt has at least one response."
                    items={dashboard.unansweredPrompts}
                    renderMeta={item => item.type}
                />
                <ParticipationGaps gaps={dashboard.participationGaps} />
            </div>

            {dashboard.participantStats?.length > 0 && (
                <div className="mt-6">
                    <h3 className="font-semibold text-gray-800 mb-3">Visible Participant Balance</h3>
                    <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                            <thead>
                                <tr className="text-left text-gray-500 border-b">
                                    <th className="py-2 pr-4 font-semibold">Participant</th>
                                    <th className="py-2 pr-4 font-semibold">Responses</th>
                                    <th className="py-2 pr-4 font-semibold">Prompts answered</th>
                                    <th className="py-2 pr-4 font-semibold">Written</th>
                                </tr>
                            </thead>
                            <tbody>
                                {dashboard.participantStats.map(participant => (
                                    <tr key={participant.id} className="border-b last:border-0">
                                        <td className="py-2 pr-4 text-gray-800">{participant.pseudonym}</td>
                                        <td className="py-2 pr-4 text-gray-700">{participant.responseCount}</td>
                                        <td className="py-2 pr-4 text-gray-700">{participant.answeredQuestionCount}</td>
                                        <td className="py-2 pr-4 text-gray-700">{participant.writtenResponseCount}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </section>
    );
};

FacilitatorDashboard.propTypes = {
    dashboard: PropTypes.shape({
        unresolvedTensions: PropTypes.array,
        mostDivisiveStatements: PropTypes.array,
        unansweredPrompts: PropTypes.array,
        participationGaps: PropTypes.array,
        participantStats: PropTypes.array,
        recommendedNextActions: PropTypes.arrayOf(PropTypes.string),
    }),
};

const FacilitatorMetric = ({ label, value }) => (
    <div className="border border-gray-200 rounded-md p-4">
        <div className="text-sm font-semibold text-gray-500">{label}</div>
        <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
    </div>
);

FacilitatorMetric.propTypes = {
    label: PropTypes.string.isRequired,
    value: PropTypes.number.isRequired,
};

const FacilitatorSignalList = ({ title, emptyText, items = [], renderMeta, renderScore }) => (
    <div>
        <h3 className="font-semibold text-gray-800 mb-3">{title}</h3>
        {items.length === 0 ? (
            <p className="text-sm text-gray-500">{emptyText}</p>
        ) : (
            <ul className="space-y-3">
                {items.map(item => (
                    <li key={`${title}-${item.id || item.text}`} className="border border-gray-100 rounded-md p-3">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <div className="font-medium text-gray-900">{item.text}</div>
                                {renderMeta && <div className="text-xs text-gray-500 mt-1">{renderMeta(item)}</div>}
                            </div>
                            {renderScore && (
                                <span className="text-xs font-semibold text-gray-700 whitespace-nowrap">
                                    {renderScore(item)}
                                </span>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        )}
    </div>
);

FacilitatorSignalList.propTypes = {
    title: PropTypes.string.isRequired,
    emptyText: PropTypes.string.isRequired,
    items: PropTypes.array,
    renderMeta: PropTypes.func,
    renderScore: PropTypes.func,
};

const ParticipationGaps = ({ gaps = [] }) => (
    <div>
        <h3 className="font-semibold text-gray-800 mb-3">Participation Gaps</h3>
        {gaps.length === 0 ? (
            <p className="text-sm text-gray-500">No obvious participation gaps detected.</p>
        ) : (
            <ul className="space-y-3">
                {gaps.map(gap => (
                    <li key={`${gap.type}-${gap.detail}`} className="border border-gray-100 rounded-md p-3">
                        <div className="flex items-center justify-between gap-3 mb-1">
                            <span className="font-medium text-gray-900">{gap.type}</span>
                            <span className={`text-xs font-semibold rounded-full px-2 py-0.5 ${gap.severity === 'high' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                                {gap.severity}
                            </span>
                        </div>
                        <p className="text-xs text-gray-500">{gap.detail}</p>
                    </li>
                ))}
            </ul>
        )}
    </div>
);

ParticipationGaps.propTypes = {
    gaps: PropTypes.arrayOf(PropTypes.shape({
        type: PropTypes.string.isRequired,
        severity: PropTypes.string.isRequired,
        detail: PropTypes.string.isRequired,
    })),
};

const RankedAgreementList = ({ title, items, metricLabel, metricKey }) => (
    <section className="bg-white shadow rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-4 text-gray-800">{title}</h2>
        {items.length === 0 ? (
            <p className="text-sm text-gray-500">No agreement responses yet.</p>
        ) : (
            <ol className="space-y-4">
                {items.map(item => (
                    <li key={item.id} className="border-b border-gray-100 last:border-0 pb-4 last:pb-0">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <h3 className="font-semibold text-gray-900">{item.text}</h3>
                                <p className="text-sm text-gray-500 mt-1">
                                    {item.responseCount} {item.responseCount === 1 ? 'response' : 'responses'} - {item.leadingPosition}
                                </p>
                            </div>
                            <span className="text-sm font-semibold text-gray-800 whitespace-nowrap">
                                {metricLabel}: {formatPercent(item[metricKey])}
                            </span>
                        </div>
                        <AgreementBar optionCounts={item.optionCounts} total={item.responseCount} />
                    </li>
                ))}
            </ol>
        )}
    </section>
);

const AgreementItemShape = PropTypes.shape({
    id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
    text: PropTypes.string.isRequired,
    responseCount: PropTypes.number.isRequired,
    leadingPosition: PropTypes.string,
    consensusScore: PropTypes.number,
    divisiveScore: PropTypes.number,
    optionCounts: PropTypes.objectOf(PropTypes.number).isRequired,
});

RankedAgreementList.propTypes = {
    title: PropTypes.string.isRequired,
    items: PropTypes.arrayOf(AgreementItemShape).isRequired,
    metricLabel: PropTypes.string.isRequired,
    metricKey: PropTypes.string.isRequired,
};

const AgreementBar = ({ optionCounts, total }) => {
    if (!total) {
        return null;
    }

    const colors = {
        'Strongly Disagree': 'bg-red-600',
        Disagree: 'bg-red-400',
        Unsure: 'bg-gray-400',
        Agree: 'bg-green-400',
        'Strongly Agree': 'bg-green-600',
    };

    return (
        <div className="mt-3">
            <div className="flex w-full h-3 rounded-full overflow-hidden bg-gray-200">
                {AGREEMENT_OPTIONS.map(option => {
                    const count = optionCounts[option] || 0;
                    if (count === 0) {
                        return null;
                    }
                    return (
                        <div
                            key={option}
                            className={colors[option]}
                            style={{ width: `${(count / total) * 100}%` }}
                            title={`${option}: ${count}`}
                        />
                    );
                })}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs text-gray-500">
                {AGREEMENT_OPTIONS.map(option => (
                    <span key={option}>{option}: {optionCounts[option] || 0}</span>
                ))}
            </div>
        </div>
    );
};

AgreementBar.propTypes = {
    optionCounts: PropTypes.objectOf(PropTypes.number).isRequired,
    total: PropTypes.number.isRequired,
};

const SynthesisPanel = ({ synthesis }) => (
    <section className="bg-white shadow rounded-lg p-6">
        <div className="flex items-center justify-between gap-4 mb-4">
            <h2 className="text-2xl font-bold text-gray-800">Written Response Synthesis</h2>
            {synthesis?.mode && (
                <span className="px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-700">
                    {synthesis.mode === 'llm' ? 'LLM' : 'Auto'}
                </span>
            )}
        </div>

        {!synthesis ? (
            <p className="text-sm text-gray-500">No open-ended responses yet.</p>
        ) : synthesis.mode === 'llm' ? (
            <div className="space-y-4">
                {synthesis.synthesis && <p className="text-gray-800">{synthesis.synthesis}</p>}
                <SynthesisList title="Common Themes" items={synthesis.commonThemes} />
                <SynthesisList title="Unresolved Questions" items={synthesis.unresolvedQuestions} />
                <SynthesisList title="Notable Divergences" items={synthesis.notableDivergences} />
            </div>
        ) : (
            <div className="space-y-4">
                <p className="text-gray-800">{synthesis.text}</p>
                {synthesis.llmError && <p className="text-sm text-amber-700">{synthesis.llmError}</p>}
                {synthesis.highlights?.length > 0 && (
                    <div>
                        <h3 className="font-semibold mb-2 text-gray-800">Prompts</h3>
                        <ul className="list-disc pl-5 text-gray-700 space-y-1">
                            {synthesis.highlights.map(item => (
                                <li key={item.question}>{item.question}: {item.responseCount}</li>
                            ))}
                        </ul>
                    </div>
                )}
                {synthesis.excerpts?.length > 0 && (
                    <div>
                        <h3 className="font-semibold mb-2 text-gray-800">Representative Excerpts</h3>
                        <ul className="space-y-2">
                            {synthesis.excerpts.map((item, index) => (
                                <li key={`${item.question}-${index}`} className="bg-gray-50 rounded-md p-3">
                                    <div className="text-xs font-semibold text-gray-500 mb-1">{item.question}</div>
                                    <div className="text-gray-800">{item.excerpt}</div>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        )}
    </section>
);

SynthesisPanel.propTypes = {
    synthesis: PropTypes.shape({
        mode: PropTypes.string,
        text: PropTypes.string,
        llmError: PropTypes.string,
        synthesis: PropTypes.string,
        commonThemes: PropTypes.array,
        unresolvedQuestions: PropTypes.array,
        notableDivergences: PropTypes.array,
        highlights: PropTypes.arrayOf(PropTypes.shape({
            question: PropTypes.string.isRequired,
            responseCount: PropTypes.number.isRequired,
        })),
        excerpts: PropTypes.arrayOf(PropTypes.shape({
            question: PropTypes.string.isRequired,
            excerpt: PropTypes.string.isRequired,
        })),
    }),
};

const SynthesisList = ({ title, items }) => {
    if (!Array.isArray(items) || items.length === 0) {
        return null;
    }

    return (
        <div>
            <h3 className="font-semibold mb-2 text-gray-800">{title}</h3>
            <ul className="list-disc pl-5 text-gray-700 space-y-1">
                {items.map((item, index) => (
                    <li key={`${title}-${index}`}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>
                ))}
            </ul>
        </div>
    );
};

SynthesisList.propTypes = {
    title: PropTypes.string.isRequired,
    items: PropTypes.array,
};

const QuestionSummary = ({ question }) => (
    <article className="bg-white shadow rounded-lg p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
            <div>
                <h3 className="text-lg font-semibold text-gray-900">{question.text}</h3>
                <p className="text-sm text-gray-500">{question.type} - {question.responseCount} {question.responseCount === 1 ? 'response' : 'responses'}</p>
            </div>
            {question.label && (
                <span className="px-2 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-700">{question.label}</span>
            )}
        </div>

        {question.type === 'Agreement' && (
            <AgreementBar optionCounts={question.optionCounts} total={question.responseCount} />
        )}

        {question.type === 'Numerical' && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm text-gray-700">
                <span>Average: <strong>{formatNumber(question.average)}</strong></span>
                <span>Low: <strong>{formatNumber(question.minResponse, 0)}</strong></span>
                <span>High: <strong>{formatNumber(question.maxResponse, 0)}</strong></span>
                <span>Std dev: <strong>{formatNumber(question.standardDeviation)}</strong></span>
            </div>
        )}

        {(question.type === 'Open Ended' || question.type === 'Brainstorm') && question.responses?.length > 0 && (
            <ul className="space-y-2 mt-3">
                {question.responses.slice(0, 5).map(response => (
                    <li key={response.id} className="bg-gray-50 rounded-md p-3">
                        <div className="text-xs font-semibold text-gray-500 mb-1">{response.pseudonym}</div>
                        <div className="text-gray-800 whitespace-pre-wrap">{String(response.value)}</div>
                    </li>
                ))}
            </ul>
        )}
    </article>
);

QuestionSummary.propTypes = {
    question: PropTypes.shape({
        id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
        text: PropTypes.string.isRequired,
        type: PropTypes.string.isRequired,
        responseCount: PropTypes.number.isRequired,
        label: PropTypes.string,
        optionCounts: PropTypes.objectOf(PropTypes.number),
        average: PropTypes.number,
        minResponse: PropTypes.number,
        maxResponse: PropTypes.number,
        standardDeviation: PropTypes.number,
        responses: PropTypes.arrayOf(PropTypes.shape({
            id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
            pseudonym: PropTypes.string.isRequired,
            value: PropTypes.oneOfType([PropTypes.string, PropTypes.array]),
        })),
    }).isRequired,
};

export default SummaryPage;
