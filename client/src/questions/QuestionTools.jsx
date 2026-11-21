import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import definitions from '../../../question-tools.json';

const eligible = type => definitions.filter(tool => !tool.types || tool.types.includes(type));
const labels = { clarification: 'Clarification request', explanation: 'Vote explanation', suggestion: 'Suggested answer' };
const errors = {
    locked: 'This discussion is locked.', unavailable: 'This tool is no longer available.',
    already_voted: 'Clarifications must be sent before voting.', vote_changed: 'Your vote changed. Explain your current vote instead.',
    existing_option: 'That answer is already an option.', invalid: 'Enter a valid note within the character limit.',
};

export function QuestionToolSettings({ type, tools = [], onChange }) {
    return <fieldset className="mb-4 space-y-1 text-sm">
        <legend className="font-semibold">Private participant tools</legend>
        <p className="text-gray-600">Only moderators can read submissions.</p>
        {eligible(type).map(tool => <label key={tool.kind} className="block">
            <input type="checkbox" checked={tools.includes(tool.kind)} onChange={event => onChange(event.target.checked
                ? [...tools, tool.kind] : tools.filter(kind => kind !== tool.kind))} /> {tool.label}
        </label>)}
    </fieldset>;
}
QuestionToolSettings.propTypes = { type: PropTypes.string.isRequired, tools: PropTypes.array, onChange: PropTypes.func.isRequired };

function NoteForm({ tool, socket, slug, questionId, vote, disabled }) {
    const [body, setBody] = useState('');
    const [status, setStatus] = useState('');
    const [pending, setPending] = useState(false);
    function submit(event) {
        event.preventDefault();
        if (disabled || pending || !body.trim() || !socket.connected) return;
        setPending(true);
        setStatus('Sending…');
        const payload = { kind: tool.kind, body };
        if (tool.kind === 'explanation') Object.assign(payload, { voteId: vote.id, voteValue: vote.value });
        socket.timeout(10000).emit('submitQuestionNote', slug, questionId, payload, (err, result) => {
            setPending(false);
            if (!err && result?.ok) {
                setBody('');
                setStatus('Sent privately to moderators.');
            } else setStatus(errors[result?.reason] || 'Could not confirm delivery. You can retry.');
        });
    }
    return <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-primary">{tool.label}</summary>
        <form onSubmit={submit} className="mt-2 space-y-1">
            <label className="block">{labels[tool.kind]} {tool.kind === 'explanation' && `for “${vote.value}”`}
                <textarea className="block w-full rounded border p-2" value={body} maxLength={tool.limit} disabled={pending || disabled}
                    onChange={event => { setBody(event.target.value); setStatus(''); }} />
            </label>
            <p className="text-gray-600">Only moderators see this. Sending again replaces your previous {labels[tool.kind].toLowerCase()}.</p>
            <button disabled={disabled || pending || !body.trim()} className="rounded border px-2 py-1 disabled:opacity-50">Send privately</button>
            <span role="status" className="ml-2">{status}</span>
        </form>
    </details>;
}
NoteForm.propTypes = { tool: PropTypes.object.isRequired, socket: PropTypes.object.isRequired, slug: PropTypes.string.isRequired,
    questionId: PropTypes.number.isRequired, vote: PropTypes.object, disabled: PropTypes.bool };

function ModeratorNotes({ socket, slug, token, question }) {
    const [open, setOpen] = useState(false);
    const [unread, setUnread] = useState(false);
    const [version, refresh] = useState(0);
    const [notes, setNotes] = useState(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        function changed(update) {
            if (update.slug !== slug || update.questionId !== question.id) return;
            if (open) refresh(value => value + 1); else setUnread(true);
        }
        socket.on('questionNotesChanged', changed);
        return () => socket.off('questionNotesChanged', changed);
    }, [socket, slug, question.id, open]);
    useEffect(() => {
        if (!open) return undefined;
        let active = true;
        setFailed(false);
        socket.timeout(10000).emit('getQuestionNotes', slug, question.id, { token }, (err, result) => {
            if (!active) return;
            setFailed(Boolean(err || !result?.ok));
            setNotes(!err && result?.ok ? result.notes : null);
        });
        return () => { active = false; };
    }, [socket, slug, question, token, open, version]);
    return <div className="mt-3 text-sm">
        <button className="rounded border px-2 py-1" aria-expanded={open} onClick={() => { setOpen(!open); setUnread(false); setNotes(null); }}>
            Moderator notes{open ? ' ▴' : ' ▾'}
        </button> <span role="status">{unread ? 'New private note' : ''}</span>
        {open && <div className="mt-2 rounded bg-gray-50 p-3">
            {failed ? <button onClick={() => refresh(value => value + 1)}>Could not load notes. Retry</button> : notes === null ? 'Loading…' : !notes.length ? 'No private notes yet.' :
                <ul className="space-y-2">{notes.map(note => <li key={note.id} className="break-words">
                    <strong>{labels[note.kind]}{note.answer != null && ` · ${note.answer}`}</strong><p className="whitespace-pre-wrap">{note.body}</p>
                </li>)}</ul>}
        </div>}
    </div>;
}
ModeratorNotes.propTypes = { socket: PropTypes.object.isRequired, slug: PropTypes.string.isRequired, token: PropTypes.string.isRequired, question: PropTypes.object.isRequired };

export default function QuestionTools({ question, socket, slug, token, vote, locked, disabled }) {
    const available = eligible(question.type).filter(tool => question.tools?.includes(tool.kind)
        && !(tool.kind === 'clarification' && vote) && !(tool.kind === 'explanation' && !vote));
    return <>
        {!locked && available.map(tool => <NoteForm key={tool.kind === 'explanation' ? `${tool.kind}:${vote.id}:${vote.value}` : tool.kind}
            tool={tool} socket={socket} slug={slug} questionId={question.id} vote={vote} disabled={disabled} />)}
        {token && <ModeratorNotes key={token} socket={socket} slug={slug} question={question} token={token} />}
    </>;
}
QuestionTools.propTypes = { question: PropTypes.object.isRequired, socket: PropTypes.object.isRequired, slug: PropTypes.string.isRequired,
    token: PropTypes.string, vote: PropTypes.object, locked: PropTypes.bool, disabled: PropTypes.bool };
