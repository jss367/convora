import { useRef, useState } from 'react';

// A moderator's per-question controls: edit, publish, reorder, pin, delete,
// reveal results, and choose what the room display shows.
export function useQuestionModeration(socket, { discussionSlug, adminToken }) {
    // Id of the question a moderator is currently editing inline (null when none).
    const [editingQuestionId, setEditingQuestionId] = useState(null);
    const [editingDrafts, setEditingDrafts] = useState({});
    const editingQuestionIdRef = useRef(editingQuestionId);
    editingQuestionIdRef.current = editingQuestionId;
    const closeQuestionEditor = () => { setEditingQuestionId(null); setEditingDrafts({}); };
    const [spotlightError, setSpotlightError] = useState(null);

    const handleDeleteQuestion = (questionId) => {
        socket.emit('deleteQuestion', discussionSlug, questionId, adminToken);
    };

    // Show one question's results to everyone, including the room display, or go
    // back to showing them only after voting. Only offered while results are
    // shown after voting; with "Always show results" there is nothing to reveal.
    const handleToggleResultsRevealed = (questionId, revealed) => {
        socket.emit('setResultsRevealed', discussionSlug, questionId, !revealed, adminToken);
    };

    const handleTogglePin = (questionId, pinned) => {
        socket.emit('setPinned', discussionSlug, questionId, !pinned, adminToken);
    };

    // Spotlight one question, or clear the spotlight to resume the room's layout.
    const handleShowOnDisplay = (questionId) => {
        setSpotlightError(null);
        socket.emit('setDisplaySettings', discussionSlug, { questionId }, adminToken, result => {
            if (!result?.ok) setSpotlightError({ slug: discussionSlug, questionId, message: result?.message });
        });
    };

    const handleSetHiddenOnDisplay = (questionId, hidden) => {
        socket.emit('setQuestionHiddenOnDisplay', discussionSlug, questionId, hidden, adminToken);
    };

    // Show a queued question to everyone and open it for answers.
    const handlePublishQuestion = (questionId) => {
        socket.emit('publishQuestion', discussionSlug, questionId, adminToken);
    };

    // Save a moderator's edit to a question. The server only accepts it while the
    // question has no responses; on success it broadcasts fresh questions and we
    // close the inline editor, otherwise the editor stays open to show the error.
    const handleEditQuestion = (questionId, updates, onResult) => {
        socket.emit('editQuestion', discussionSlug, questionId, updates, adminToken, (resp) => {
            // Close only the editor this save came from: by the time a slow
            // acknowledgment arrives the moderator may be editing another question.
            if (resp && resp.updated && editingQuestionIdRef.current === questionId) closeQuestionEditor();
            if (typeof onResult === 'function') onResult(resp);
        });
    };

    const swapPublishedQuestions = (earlier, later) => {
        socket.emit('swapPublishedQuestions', discussionSlug, earlier.id, later.id, adminToken);
    };
    const swapQueuedQuestions = (earlier, later) => {
        socket.emit('swapQueuedQuestions', discussionSlug, earlier.id, later.id, adminToken);
    };

    // The failed spotlight request to report beside a question's controls, if
    // any: { slug, questionId, message }.
    const spotlightErrorFor = (questionId) => (
        spotlightError?.slug === discussionSlug && spotlightError.questionId === questionId ? spotlightError : null
    );

    return {
        editingQuestionId, setEditingQuestionId, editingDrafts, setEditingDrafts, closeQuestionEditor,
        spotlightErrorFor,
        handleDeleteQuestion, handleToggleResultsRevealed, handleTogglePin, handleShowOnDisplay,
        handleSetHiddenOnDisplay, handlePublishQuestion, handleEditQuestion,
        swapPublishedQuestions, swapQueuedQuestions,
    };
}
