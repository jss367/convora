import PropTypes from 'prop-types';
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

// Map a mean agreement score (-2..2) to a human-readable leaning. Always
// returns a text label so the view stays readable without relying on color.
function leaning(mean) {
    if (mean >= 1.2) return { label: 'Strongly agrees', tone: 'text-green-700', dot: 'bg-green-600' };
    if (mean >= 0.3) return { label: 'Agrees', tone: 'text-green-600', dot: 'bg-green-400' };
    if (mean > -0.3) return { label: 'Mixed / unsure', tone: 'text-gray-600', dot: 'bg-gray-400' };
    if (mean > -1.2) return { label: 'Disagrees', tone: 'text-red-600', dot: 'bg-red-400' };
    return { label: 'Strongly disagrees', tone: 'text-red-700', dot: 'bg-red-600' };
}

// A compact agree/unsure/disagree bar for one statement within a group.
const StanceBar = ({ agree, unsure, disagree }) => {
    const total = agree + unsure + disagree;
    if (total === 0) {
        return null;
    }
    const pct = n => `${(n / total) * 100}%`;
    return (
        <div className="mt-2">
            <div className="flex w-full h-2.5 rounded-full overflow-hidden bg-gray-200">
                {disagree > 0 && <div className="bg-red-500" style={{ width: pct(disagree) }} title={`Disagree: ${disagree}`} />}
                {unsure > 0 && <div className="bg-gray-400" style={{ width: pct(unsure) }} title={`Unsure: ${unsure}`} />}
                {agree > 0 && <div className="bg-green-500" style={{ width: pct(agree) }} title={`Agree: ${agree}`} />}
            </div>
            <div className="flex gap-x-3 mt-1 text-xs text-gray-500">
                <span>Agree: {agree}</span>
                <span>Unsure: {unsure}</span>
                <span>Disagree: {disagree}</span>
            </div>
        </div>
    );
};

StanceBar.propTypes = {
    agree: PropTypes.number.isRequired,
    unsure: PropTypes.number.isRequired,
    disagree: PropTypes.number.isRequired,
};

const GroupCard = ({ cluster }) => (
    <section className="bg-white shadow rounded-lg p-6">
        <div className="flex items-baseline justify-between mb-4">
            <h3 className="text-xl font-bold text-gray-900">{cluster.label}</h3>
            <span className="text-sm text-gray-500">
                {cluster.size} {cluster.size === 1 ? 'person' : 'people'}
            </span>
        </div>
        <p className="text-sm text-gray-500 mb-3">What sets this group apart:</p>
        {cluster.definingStatements.length === 0 ? (
            <p className="text-sm text-gray-400">Not enough votes to characterize this group.</p>
        ) : (
            <ul className="space-y-4">
                {cluster.definingStatements.map(st => {
                    const lean = leaning(st.mean);
                    return (
                        <li key={st.id} className="border-b border-gray-100 last:border-0 pb-3 last:pb-0">
                            <div className="text-gray-900">{st.text}</div>
                            <div className={`text-sm font-semibold mt-1 ${lean.tone}`}>
                                <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${lean.dot}`} />
                                {lean.label}
                                <span className="font-normal text-gray-400"> · {st.voters} voted</span>
                            </div>
                            <StanceBar agree={st.agree} unsure={st.unsure} disagree={st.disagree} />
                        </li>
                    );
                })}
            </ul>
        )}
    </section>
);

GroupCard.propTypes = {
    cluster: PropTypes.shape({
        label: PropTypes.string.isRequired,
        size: PropTypes.number.isRequired,
        definingStatements: PropTypes.arrayOf(PropTypes.shape({
            id: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
            text: PropTypes.string.isRequired,
            mean: PropTypes.number.isRequired,
            agree: PropTypes.number.isRequired,
            unsure: PropTypes.number.isRequired,
            disagree: PropTypes.number.isRequired,
            voters: PropTypes.number.isRequired,
        })).isRequired,
    }).isRequired,
};

const StatementList = ({ title, subtitle, items, clusters, emptyText }) => (
    <section className="bg-white shadow rounded-lg p-6">
        <h2 className="text-2xl font-bold mb-1 text-gray-800">{title}</h2>
        <p className="text-sm text-gray-500 mb-4">{subtitle}</p>
        {items.length === 0 ? (
            <p className="text-sm text-gray-400">{emptyText}</p>
        ) : (
            <ol className="space-y-4">
                {items.map(st => (
                    <li key={st.id} className="border-b border-gray-100 last:border-0 pb-4 last:pb-0">
                        <div className="text-gray-900 font-medium">{st.text}</div>
                        <div className="flex flex-wrap gap-2 mt-2">
                            {st.clusterMeans.map((mean, idx) => {
                                const lean = leaning(mean);
                                return (
                                    <span
                                        key={idx}
                                        className="inline-flex items-center text-xs px-2 py-1 rounded-full bg-gray-50 border border-gray-200 text-gray-700"
                                    >
                                        <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${lean.dot}`} />
                                        {clusters[idx] ? clusters[idx].label : `Group ${idx + 1}`}: {lean.label}
                                    </span>
                                );
                            })}
                        </div>
                    </li>
                ))}
            </ol>
        )}
    </section>
);

StatementList.propTypes = {
    title: PropTypes.string.isRequired,
    subtitle: PropTypes.string.isRequired,
    items: PropTypes.array.isRequired,
    clusters: PropTypes.array.isRequired,
    emptyText: PropTypes.string.isRequired,
};

const ClusterPage = () => {
    const { topic } = useParams();
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const encodedTopic = encodeURIComponent(topic);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`/api/discussions/${encodedTopic}/clusters`);
            if (!response.ok) {
                throw new Error('Failed to load clusters');
            }
            setData(await response.json());
        } catch (err) {
            console.error('Error loading clusters:', err);
            setError('Could not load opinion groups.');
        } finally {
            setLoading(false);
        }
    }, [encodedTopic]);

    useEffect(() => {
        load();
    }, [load]);

    return (
        <div className="max-w-5xl mx-auto mt-10 px-4">
            <div className="mb-6">
                <Link to={`/discussion/${topic}`} className="text-primary hover:underline">
                    Back to discussion
                </Link>
                <div className="flex items-center gap-3 mt-3 mb-2">
                    <h1 className="text-4xl font-bold text-gray-800">Opinion Groups</h1>
                    <span className="px-2 py-1 text-xs font-semibold rounded-full bg-amber-100 text-amber-800">
                        Experimental
                    </span>
                </div>
                <p className="text-gray-600">{topic}</p>
            </div>

            {loading && <p className="text-gray-600">Finding opinion groups…</p>}
            {error && <p className="text-red-600">{error}</p>}

            {!loading && !error && data && !data.eligible && (
                <div className="bg-white shadow rounded-lg p-6 text-gray-600">
                    {data.reason}
                </div>
            )}

            {!loading && !error && data && data.eligible && (
                <>
                    <p className="text-gray-700 mb-6">
                        {data.participantCount} participants split into{' '}
                        <span className="font-semibold">{data.k} opinion groups</span> based on how they
                        voted across {data.statementCount} agreement statements. Groups are found
                        automatically and updated as votes come in.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                        {data.clusters.map(cluster => (
                            <GroupCard key={cluster.id} cluster={cluster} />
                        ))}
                    </div>

                    <div className="grid grid-cols-1 gap-6">
                        <StatementList
                            title="Common Ground"
                            subtitle="Statements every group leans the same way on — the shared starting points."
                            items={data.bridging}
                            clusters={data.clusters}
                            emptyText="No statements yet where all groups agree."
                        />
                        <StatementList
                            title="Most Divisive"
                            subtitle="Statements where the groups disagree most sharply."
                            items={data.divisive}
                            clusters={data.clusters}
                            emptyText="Not enough votes to find divisive statements."
                        />
                    </div>
                </>
            )}
        </div>
    );
};

export default ClusterPage;
