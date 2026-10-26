import PropTypes from 'prop-types';
import React, { useEffect, useState } from 'react';

const formatNumber = value => value == null ? '—' : Number(value.toFixed(1)).toLocaleString();
const formatDate = value => new Date(value).toLocaleString();
const OPINION_OPTIONS = {
    Agreement: ['Strongly Disagree', 'Disagree', 'Unsure', 'Agree', 'Strongly Agree'],
    'Yes/No': ['No', 'Yes'],
};

function distributionRows(question) {
    if (!question) return [];
    if (question.type !== 'Numerical') {
        // JSONB does not preserve object-key order; use the semantic scale.
        return OPINION_OPTIONS[question.type].map(label => ({ label, count: question.optionCounts[label] || 0 }));
    }
    return question.distribution.map((bin, index, bins) => ({
        label: `${formatNumber(bin.min)} to ${index < bins.length - 1 ? '<' : ''}${formatNumber(bin.max)}`,
        count: bin.count,
    }));
}

function DistributionCell({ count, total, color }) {
    if (count == null) return <td className="p-2 text-gray-400">—</td>;
    const percent = total ? count / total * 100 : 0;
    return (
        <td className="p-2 w-1/3">
            <div className="text-xs mb-1">{count} ({formatNumber(percent)}%)</div>
            <div className="h-2 rounded bg-gray-100 overflow-hidden">
                <div className={`h-full ${color}`} style={{ width: `${percent}%` }} />
            </div>
        </td>
    );
}
DistributionCell.propTypes = { count: PropTypes.number, total: PropTypes.number, color: PropTypes.string.isRequired };

export function QuestionComparison({ before, after, comparing, beforeName, afterName }) {
    const question = after || before;
    const changed = before && after && (before.text !== after.text || before.type !== after.type
        || before.minValue !== after.minValue || before.maxValue !== after.maxValue);
    const beforeRows = distributionRows(before);
    const afterRows = distributionRows(after);
    const delta = !changed && before?.average != null && after?.average != null
        ? after.average - before.average : null;
    const renderTable = (rows, left, right, keyPrefix = '') => (
        <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
                <caption className="sr-only">Response distribution for {question.text}{keyPrefix}</caption>
                <thead>
                    <tr className="text-xs text-gray-500 border-b">
                        <th scope="col" className="p-2">Response</th>
                        <th scope="col" className="p-2 break-words">{beforeName}</th>
                        {comparing && <th scope="col" className="p-2 break-words">{afterName}</th>}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, index) => (
                        <tr key={row.label}>
                            <th scope="row" className="p-2 font-normal text-gray-600">{row.label}</th>
                            <DistributionCell count={left ? distributionRows(left)[index]?.count : null} total={left?.responseCount} color="bg-primary" />
                            {comparing && <DistributionCell count={right ? distributionRows(right)[index]?.count : null} total={right?.responseCount} color="bg-amber-500" />}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
    return (
        <article className="border border-gray-200 rounded-lg p-4">
            <div className="flex flex-wrap justify-between gap-2 mb-2">
                <h3 className="font-semibold text-gray-800 break-words">{question.text}</h3>
                <span className="text-xs text-gray-500">{question.type}</span>
            </div>
            <p className="text-sm text-gray-600 mb-2">
                Responses: {before?.responseCount ?? '—'}{comparing && ` → ${after?.responseCount ?? '—'}`}
            </p>
            {(before?.type === 'Numerical' || after?.type === 'Numerical') && (
                <p className="text-sm font-medium mb-3">
                    Average: {formatNumber(before?.average)}{comparing && ` → ${formatNumber(after?.average)}`}
                    {delta !== null && <span className="ml-2 text-primary">({delta > 0 ? '+' : ''}{formatNumber(delta)} points)</span>}
                </p>
            )}
            {comparing && (!before || !after) && (
                <p className="text-sm text-amber-800 mb-3">This question was only present in {before ? beforeName : afterName}.</p>
            )}
            {changed ? (
                <>
                    <p className="text-sm text-amber-800 mb-3">The question wording, type, or scale changed. Results are shown separately; no change is calculated.</p>
                    <p className="text-sm mb-2">Earlier wording: {before.text}</p>
                    {renderTable(beforeRows, before, null, ' (earlier scale)')}
                    {renderTable(afterRows, null, after, ' (later scale)')}
                </>
            ) : renderTable(afterRows.length ? afterRows : beforeRows, before, after)}
        </article>
    );
}
QuestionComparison.propTypes = {
    before: PropTypes.object, after: PropTypes.object, comparing: PropTypes.bool.isRequired,
    beforeName: PropTypes.string.isRequired, afterName: PropTypes.string.isRequired,
};

export default function OpinionSnapshots({ discussionSlug, adminToken }) {
    const [snapshots, setSnapshots] = useState([]);
    const [beforeId, setBeforeId] = useState('');
    const [afterId, setAfterId] = useState('');
    const [name, setName] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');
    const [refresh, setRefresh] = useState(0);
    const endpoint = `/api/discussions/${encodeURIComponent(discussionSlug)}/snapshots`;

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError('');
        fetch(endpoint, { signal: controller.signal }).then(async response => {
            if (!response.ok) throw new Error('Could not load opinion snapshots.');
            const { snapshots: loaded } = await response.json();
            if (controller.signal.aborted) return;
            setSnapshots(loaded);
            setBeforeId(current => loaded.some(item => String(item.id) === current) ? current : String(loaded[0]?.id || ''));
            setAfterId(current => loaded.some(item => String(item.id) === current) ? current : loaded.length > 1 ? String(loaded[loaded.length - 1].id) : '');
        }).catch(err => {
            if (!controller.signal.aborted) setError(err.message);
        }).finally(() => {
            if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
    }, [endpoint, refresh]);

    const saveSnapshot = async event => {
        event.preventDefault();
        if (saving || !name.trim()) return;
        setSaving(true);
        setError('');
        setStatus('');
        try {
            const response = await fetch(endpoint, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ adminToken, name: name.trim() }),
            });
            const saved = await response.json();
            if (!response.ok) throw new Error(saved.error || 'Could not save the snapshot.');
            setSnapshots(current => [...current, saved]);
            if (!beforeId) setBeforeId(String(saved.id));
            else setAfterId(String(saved.id));
            setName('');
            setStatus(`Saved “${saved.name}”.`);
        } catch (err) {
            setError(err.message);
        } finally {
            setSaving(false);
        }
    };

    const before = snapshots.find(item => String(item.id) === beforeId);
    const after = snapshots.find(item => String(item.id) === afterId && item.id > Number(beforeId));
    const questionIds = [...new Set([...(before?.data.questions || []), ...(after?.data.questions || [])].map(q => q.id))];
    return (
        <section id="opinion-snapshots" aria-labelledby="snapshot-heading" className="bg-white shadow-lg rounded-lg p-6 mb-8">
            <div className="flex items-start justify-between gap-4 mb-2">
                <h2 id="snapshot-heading" className="text-2xl font-bold text-gray-800">Opinion snapshots</h2>
                <button type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading || saving} className="text-sm text-primary hover:underline disabled:opacity-50">Refresh</button>
            </div>
            <p className="text-sm text-gray-600 mb-4">Save the room’s opinions before discussion, then ask everyone to update their answers and save another snapshot. Each snapshot preserves numerical, agreement, and yes/no results.</p>
            {adminToken ? (
                <form onSubmit={saveSnapshot} className="mb-5">
                    <label htmlFor="snapshot-name" className="block text-sm font-medium mb-2">Snapshot name</label>
                    <div className="flex flex-wrap gap-2">
                        <input id="snapshot-name" value={name} onChange={event => setName(event.target.value)} maxLength={120} required placeholder={snapshots.length ? 'e.g. After discussion' : 'e.g. Before discussion'} className="flex-1 min-w-0 border border-gray-300 rounded px-3 py-2" />
                        <button type="submit" disabled={saving || loading || !name.trim()} className="bg-primary text-white rounded px-4 py-2 disabled:opacity-50">{saving ? 'Saving…' : 'Save snapshot'}</button>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">Saved snapshots stay unchanged as people update their answers. For probabilities, use a Numerical question with a 0–100 scale.</p>
                </form>
            ) : <p className="text-sm text-gray-500 mb-4">Only moderators can save snapshots. Everyone can view and compare them.</p>}
            {error && <p role="alert" className="text-red-600 mb-3">{error}</p>}
            <p role="status" className="text-sm text-green-700 mb-3">{status}</p>
            {loading ? <p className="text-gray-500">Loading snapshots…</p> : snapshots.length === 0 ? (
                <p className="text-gray-500">No snapshots saved yet. Save one after the initial votes and another at the end.</p>
            ) : (
                <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                        {['before', 'after'].map(side => (
                            <div key={side}>
                                <label htmlFor={`snapshot-${side}`} className="block text-sm font-medium mb-1">{side === 'before' ? 'Earlier snapshot' : 'Later snapshot'}</label>
                                <select id={`snapshot-${side}`} value={side === 'before' ? beforeId : after ? String(after.id) : ''} onChange={event => {
                                    if (side === 'after') setAfterId(event.target.value);
                                    else {
                                        setBeforeId(event.target.value);
                                        if (Number(afterId) <= Number(event.target.value)) setAfterId('');
                                    }
                                }} className="w-full border border-gray-300 rounded p-2">
                                    {side === 'after' && <option value="">Choose a snapshot to compare</option>}
                                    {snapshots.filter(snapshot => side === 'before' || snapshot.id > Number(beforeId)).map(snapshot => <option key={snapshot.id} value={snapshot.id}>{snapshot.name} — {formatDate(snapshot.createdAt)}</option>)}
                                </select>
                            </div>
                        ))}
                    </div>
                    <p className="text-sm text-gray-600 mb-4">
                        Participants with opinion responses: {before?.data.participantCount ?? '—'}{after && ` → ${after.data.participantCount}`}.
                        {' '}These are group-level comparisons; participants may differ between snapshots.
                    </p>
                    {snapshots.length === 1 && <p className="text-sm text-gray-500 mb-4">Save a second snapshot after the discussion to see what changed.</p>}
                    <div className="space-y-4">
                        {questionIds.map(id => <QuestionComparison key={id}
                            before={before?.data.questions.find(q => q.id === id)} after={after?.data.questions.find(q => q.id === id)}
                            comparing={!!after} beforeName={before?.name || 'Earlier'} afterName={after?.name || 'Later'} />)}
                    </div>
                </>
            )}
        </section>
    );
}
OpinionSnapshots.propTypes = { discussionSlug: PropTypes.string.isRequired, adminToken: PropTypes.string };
