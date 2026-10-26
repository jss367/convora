const OPTIONS = {
  Agreement: ['Strongly Disagree', 'Disagree', 'Unsure', 'Agree', 'Strongly Agree'],
  'Yes/No': ['No', 'Yes'],
};
const OPINION_TYPES = ['Numerical', ...Object.keys(OPTIONS)];

// Only aggregates leave this function. Never persist names, user ids, vote ids,
// or per-person histories in a snapshot that the whole room can read.
function buildOpinionSnapshot(questions) {
  const participants = new Set();
  const summaries = questions.filter(q => OPINION_TYPES.includes(q.type)).map(question => {
    const base = { id: question.id, text: question.text, type: question.type };
    let validVotes;
    let metrics;
    if (question.type === 'Numerical') {
      const minValue = question.min_value ?? 0;
      const maxValue = question.max_value ?? 100;
      validVotes = question.votes.filter(vote =>
        String(vote.value).trim() !== '' && Number.isFinite(Number(vote.value))
        && Number(vote.value) >= minValue && Number(vote.value) <= maxValue
      );
      const values = validVotes.map(vote => Number(vote.value));
      // Fixed bins keep the distribution comparable between snapshots of the
      // same scale. The final bin includes the upper bound.
      const binCount = Math.min(10, Math.max(1, maxValue - minValue));
      const width = (maxValue - minValue) / binCount;
      const distribution = Array.from({ length: binCount }, (_, index) => ({
        min: minValue + index * width,
        max: minValue + (index + 1) * width,
        count: 0,
      }));
      values.forEach(value => {
        const index = Math.min(binCount - 1, Math.max(0, Math.floor((value - minValue) / width)));
        distribution[index].count += 1;
      });
      metrics = {
        minValue, maxValue, distribution,
        average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      };
    } else {
      const options = OPTIONS[question.type];
      validVotes = question.votes.filter(vote => options.includes(vote.value));
      metrics = {
        optionCounts: Object.fromEntries(options.map(option => [option, validVotes.filter(v => v.value === option).length])),
      };
    }
    validVotes.forEach(vote => participants.add(vote.user_id || `legacy-vote-${vote.id}`));
    return { ...base, responseCount: validVotes.length, ...metrics };
  });
  return { participantCount: participants.size, questions: summaries };
}

module.exports = { buildOpinionSnapshot, OPINION_TYPES };
