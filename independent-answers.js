function collectingIndependentAnswers(question) {
  return question.independentAnswers === true && !question.resultsRevealed;
}

function independentAnswerView(questions, ownIds) {
  if (!questions.some(collectingIndependentAnswers)) return questions;
  return questions.map(question => {
    if (!collectingIndependentAnswers(question)) return question;
    const votes = ownIds ? question.votes.filter(vote => ownIds.has(vote.id)).map(
      ({ id, value, pseudonym, created_at, ownerToken }) => ({ id, value, pseudonym, created_at, ownerToken })
    ) : [];
    return { ...question, votes, resultsHidden: true };
  });
}

module.exports = { collectingIndependentAnswers, independentAnswerView };
