// Pure discussion analysis and printable reports; no database or HTTP access.
const { AGREEMENT_OPTIONS, YES_NO_OPTIONS, getQuestionRange, parseStoredVoteValue } = require('./question-data');

function roundMetric(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(value.toFixed(digits));
}

function formatReportPercent(value) {
  if (!Number.isFinite(value)) {
    return '0%';
  }
  return `${Math.round(value * 100)}%`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function summarizePrompt(question) {
  return {
    id: question.id,
    text: question.text,
    type: question.type,
    responseCount: question.responseCount,
  };
}

function buildFacilitatorDashboard(questionSummaries, participantStats) {
  const participants = participantStats
    .map(({
      answeredQuestionIds,
      pseudonym,
      responseCount,
      agreementResponseCount,
      numericalResponseCount,
      writtenResponseCount,
    }) => ({
      pseudonym,
      responseCount,
      agreementResponseCount,
      numericalResponseCount,
      writtenResponseCount,
      answeredQuestionCount: answeredQuestionIds.size,
    }))
    .sort((a, b) => b.responseCount - a.responseCount || a.pseudonym.localeCompare(b.pseudonym))
    .map((participant, index) => ({
      ...participant,
      id: `participant-${index + 1}`,
    }));

  const participantCount = participants.length;
  const totalResponses = participants.reduce((sum, participant) => sum + participant.responseCount, 0);
  // Agreement and Yes/No are both single-choice opinion prompts, so they share
  // the divisiveness analysis. Yes/No phrasing uses "yes/no" rather than the
  // five-point scale's "agree/disagree/unsure".
  const opinionPrompts = questionSummaries.filter(question => question.type === 'Agreement' || question.type === 'Yes/No');
  const numericalPrompts = questionSummaries.filter(question => question.type === 'Numerical');

  const opinionTensionDetail = (question) => question.type === 'Yes/No'
    ? `${question.agreeCount} yes / ${question.disagreeCount} no`
    : `${question.agreeCount} agree / ${question.disagreeCount} disagree / ${question.unsureCount} unsure`;

  const mostDivisiveStatements = opinionPrompts
    .filter(question => question.decidedCount >= 2)
    .map(question => ({
      id: question.id,
      text: question.text,
      type: question.type,
      responseCount: question.responseCount,
      agreeCount: question.agreeCount,
      disagreeCount: question.disagreeCount,
      unsureCount: question.unsureCount,
      // Preformatted so renderers don't have to know the prompt type: Yes/No
      // reads "yes / no", the five-point scale reads "agree / disagree / unsure".
      detail: opinionTensionDetail(question),
      divisiveScore: roundMetric(question.divisiveScore),
      leadingPosition: question.leadingPosition,
    }))
    .sort((a, b) => b.divisiveScore - a.divisiveScore || b.responseCount - a.responseCount)
    .slice(0, 5);

  const agreementTensions = opinionPrompts
    .filter(question => question.decidedCount >= 2 && question.divisiveScore >= 0.35)
    .map(question => ({
      id: question.id,
      type: 'Opinion split',
      text: question.text,
      severity: roundMetric(question.divisiveScore),
      detail: opinionTensionDetail(question),
    }));

  const numericalTensions = numericalPrompts
    .filter(question => question.responseCount >= 2 && question.standardDeviation !== null)
    .map(question => {
      const range = Math.max(question.maxValue - question.minValue, 1);
      const spreadScore = question.standardDeviation / range;
      return {
        id: question.id,
        type: 'Numerical spread',
        text: question.text,
        severity: roundMetric(spreadScore),
        detail: `Average ${roundMetric(question.average, 1)}, range ${roundMetric(question.minResponse, 1)}-${roundMetric(question.maxResponse, 1)}`,
      };
    })
    .filter(item => item.severity >= 0.25);

  const unresolvedTensions = [...agreementTensions, ...numericalTensions]
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 6);

  const unansweredPrompts = questionSummaries
    .filter(question => question.responseCount === 0)
    .map(summarizePrompt);

  const underDiscussedPrompts = questionSummaries
    .filter(question => question.responseCount > 0 && participantCount >= 3 && question.responseCount <= Math.max(1, Math.floor(participantCount * 0.35)))
    .sort((a, b) => a.responseCount - b.responseCount)
    .slice(0, 5)
    .map(summarizePrompt);

  const participationGaps = [];
  if (participantCount === 0) {
    participationGaps.push({
      type: 'No responses yet',
      severity: 'high',
      detail: 'The discussion has prompts, but no participant has submitted a response.',
    });
  } else if (participantCount === 1) {
    participationGaps.push({
      type: 'Single voice',
      severity: 'medium',
      detail: 'Only one participant has responded so far.',
    });
  } else {
    const topContributor = participants[0];
    const nextContributor = participants[1];
    const topShare = totalResponses > 0 ? topContributor.responseCount / totalResponses : 0;
    if (topShare > 0.5 && topContributor.responseCount > nextContributor.responseCount) {
      participationGaps.push({
        type: 'Dominant contributor',
        severity: topShare >= 0.7 ? 'high' : 'medium',
        detail: `${topContributor.pseudonym} contributed ${formatReportPercent(topShare)} of all responses.`,
      });
    }

    const leastActive = [...participants]
      .sort((a, b) => a.responseCount - b.responseCount || a.pseudonym.localeCompare(b.pseudonym))
      .slice(0, Math.min(3, participants.length));
    const maxResponses = Math.max(...participants.map(participant => participant.responseCount));
    if (maxResponses >= 3 && leastActive.some(participant => participant.responseCount <= Math.max(1, Math.floor(maxResponses * 0.33)))) {
      participationGaps.push({
        type: 'Uneven participation',
        severity: 'medium',
        detail: `Lowest visible contributors: ${leastActive.map(participant => `${participant.pseudonym} (${participant.responseCount})`).join(', ')}.`,
      });
    }
  }

  const writtenParticipants = participants.filter(participant => participant.writtenResponseCount > 0);
  const hasWrittenPrompts = questionSummaries.some(question => question.type === 'Open Ended' || question.type === 'Brainstorm');
  if (hasWrittenPrompts && participantCount > 0 && writtenParticipants.length < participantCount) {
    participationGaps.push({
      type: 'Written-response gap',
      severity: 'medium',
      detail: `${participantCount - writtenParticipants.length} of ${participantCount} visible participants have not added an open-ended or brainstorm response.`,
    });
  }

  const recommendedNextActions = [];
  if (unresolvedTensions.length > 0) {
    recommendedNextActions.push(`Facilitate the top tension: "${unresolvedTensions[0].text}".`);
  }
  if (unansweredPrompts.length > 0) {
    recommendedNextActions.push(`Invite responses to ${unansweredPrompts.length} unanswered ${unansweredPrompts.length === 1 ? 'prompt' : 'prompts'}.`);
  }
  if (participationGaps.length > 0) {
    recommendedNextActions.push('Balance the room by inviting quieter visible participants to respond before closing.');
  }
  if (recommendedNextActions.length === 0) {
    recommendedNextActions.push('Review the consensus, then close with owners and next steps.');
  }

  return {
    unresolvedTensions,
    mostDivisiveStatements,
    unansweredPrompts,
    underDiscussedPrompts,
    participationGaps,
    participantStats: participants.slice(0, 12),
    recommendedNextActions,
  };
}

function buildSummary(discussion, questions) {
  const participantIds = new Set();
  const participantMap = new Map();
  const typeCounts = {};
  let totalResponses = 0;

  const questionSummaries = questions.map((question) => {
    // Results this viewer may not see yet (see hideUnansweredResults in
    // server.js). The question is listed, but it contributes to no count,
    // ranking or dashboard signal, where it would read as having no responses.
    if (question.resultsHidden) {
      typeCounts[question.type] = (typeCounts[question.type] || 0) + 1;
      return {
        id: question.id,
        text: question.text,
        type: question.type,
        createdAt: question.created_at,
        resultsHidden: true,
      };
    }
    const votes = question.votes || [];
    votes.forEach((vote) => {
      const participantKey = vote.userId || vote.pseudonym || `anonymous-${vote.id}`;
      if (participantKey) {
        participantIds.add(participantKey);
        if (!participantMap.has(participantKey)) {
          participantMap.set(participantKey, {
            id: participantKey,
            pseudonym: vote.pseudonym || 'Anonymous',
            responseCount: 0,
            answeredQuestionIds: new Set(),
            agreementResponseCount: 0,
            numericalResponseCount: 0,
            writtenResponseCount: 0,
          });
        }
        const participant = participantMap.get(participantKey);
        participant.responseCount += 1;
        participant.answeredQuestionIds.add(question.id);
        if (question.type === 'Agreement' || question.type === 'Yes/No') {
          participant.agreementResponseCount += 1;
        } else if (question.type === 'Numerical') {
          participant.numericalResponseCount += 1;
        } else if (question.type === 'Open Ended' || question.type === 'Brainstorm') {
          participant.writtenResponseCount += 1;
        }
      }
    });
    totalResponses += votes.length;
    typeCounts[question.type] = (typeCounts[question.type] || 0) + 1;

    const base = {
      id: question.id,
      text: question.text,
      type: question.type,
      createdAt: question.created_at,
      responseCount: votes.length,
    };

    if (question.type === 'Agreement') {
      const optionCounts = AGREEMENT_OPTIONS.reduce((acc, option) => {
        acc[option] = votes.filter(vote => vote.value === option).length;
        return acc;
      }, {});
      const agreeCount = optionCounts.Agree + optionCounts['Strongly Agree'];
      const disagreeCount = optionCounts.Disagree + optionCounts['Strongly Disagree'];
      const decidedCount = agreeCount + disagreeCount;
      const consensusScore = decidedCount > 0 ? Math.max(agreeCount, disagreeCount) / decidedCount : 0;
      const divisiveScore = decidedCount > 0 ? Math.min(agreeCount, disagreeCount) / decidedCount : 0;

      return {
        ...base,
        optionCounts,
        agreeCount,
        disagreeCount,
        unsureCount: optionCounts.Unsure,
        decidedCount,
        consensusScore,
        divisiveScore,
        label: decidedCount < 2 ? 'Not enough votes' : divisiveScore >= 0.4 ? 'Divisive' : consensusScore >= 0.85 ? 'Consensus' : 'Mixed',
        leadingPosition: agreeCount === disagreeCount ? 'Split' : agreeCount > disagreeCount ? 'Agree' : 'Disagree',
      };
    }

    if (question.type === 'Yes/No') {
      const optionCounts = YES_NO_OPTIONS.reduce((acc, option) => {
        acc[option] = votes.filter(vote => vote.value === option).length;
        return acc;
      }, {});
      const agreeCount = optionCounts.Yes;
      const disagreeCount = optionCounts.No;
      const decidedCount = agreeCount + disagreeCount;
      const consensusScore = decidedCount > 0 ? Math.max(agreeCount, disagreeCount) / decidedCount : 0;
      const divisiveScore = decidedCount > 0 ? Math.min(agreeCount, disagreeCount) / decidedCount : 0;

      return {
        ...base,
        optionCounts,
        agreeCount,
        disagreeCount,
        unsureCount: 0,
        decidedCount,
        consensusScore,
        divisiveScore,
        label: decidedCount < 2 ? 'Not enough votes' : divisiveScore >= 0.4 ? 'Divisive' : consensusScore >= 0.85 ? 'Consensus' : 'Mixed',
        leadingPosition: agreeCount === disagreeCount ? 'Split' : agreeCount > disagreeCount ? 'Yes' : 'No',
      };
    }

    if (question.type === 'Numerical') {
      const values = votes
        .map(vote => Number.parseFloat(vote.value))
        .filter(value => !Number.isNaN(value));
      const average = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const variance = values.length > 0
        ? values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length
        : null;
      const { minValue, maxValue } = getQuestionRange(question);

      return {
        ...base,
        minValue,
        maxValue,
        average,
        minResponse: values.length > 0 ? Math.min(...values) : null,
        maxResponse: values.length > 0 ? Math.max(...values) : null,
        standardDeviation: variance === null ? null : Math.sqrt(variance),
      };
    }

    return {
      ...base,
      responses: votes.map(vote => ({
        id: vote.id,
        pseudonym: vote.pseudonym || 'Anonymous',
        value: parseStoredVoteValue(vote.value),
        createdAt: vote.created_at,
      })),
    };
  });

  // Agreement and Yes/No are both single-choice opinion prompts and carry the
  // same consensus/divisive scores, so both feed the Top Consensus / Top
  // Divisive rankings. Each item carries its `type` so the renderer picks the
  // matching bar (five-point vs binary).
  const opinionSummaries = questionSummaries.filter(summary => (summary.type === 'Agreement' || summary.type === 'Yes/No') && summary.decidedCount >= 2);
  const topConsensus = [...opinionSummaries]
    .sort((a, b) => b.consensusScore - a.consensusScore || b.responseCount - a.responseCount)
    .slice(0, 5);
  const topDivisive = [...opinionSummaries]
    .sort((a, b) => b.divisiveScore - a.divisiveScore || b.responseCount - a.responseCount)
    .slice(0, 5);
  const facilitatorDashboard = buildFacilitatorDashboard(
    questionSummaries.filter(summary => !summary.resultsHidden),
    [...participantMap.values()]
  );

  return {
    discussion: {
      id: discussion.id,
      topic: discussion.topic,
      slug: discussion.slug,
      createdAt: discussion.created_at,
    },
    counts: {
      questions: questions.length,
      responses: totalResponses,
      participants: participantIds.size,
      byType: typeCounts,
      hiddenResults: questionSummaries.filter(summary => summary.resultsHidden).length,
    },
    topConsensus,
    topDivisive,
    facilitatorDashboard,
    questions: questionSummaries,
  };
}

function renderReportHtml(summary) {
  const dashboard = summary.facilitatorDashboard || {};
  const generatedAt = new Date().toLocaleString();

  const renderList = (items, emptyText, renderItem) => {
    if (!Array.isArray(items) || items.length === 0) {
      return `<p class="muted">${escapeHtml(emptyText)}</p>`;
    }
    return `<ul>${items.map(renderItem).join('')}</ul>`;
  };

  const questionRows = summary.questions.map(question => {
    if (question.resultsHidden) {
      return `
      <tr>
        <td>${escapeHtml(question.text)}</td>
        <td>${escapeHtml(question.type)}</td>
        <td>-</td>
        <td class="muted">Hidden until you vote</td>
      </tr>`;
    }
    const label = question.label ? `<span class="pill">${escapeHtml(question.label)}</span>` : '';
    const metric = question.type === 'Agreement'
      ? `${question.agreeCount || 0} agree / ${question.disagreeCount || 0} disagree / ${question.unsureCount || 0} unsure`
      : question.type === 'Yes/No'
        ? `${question.agreeCount || 0} yes / ${question.disagreeCount || 0} no`
        : question.type === 'Numerical'
          ? `Avg ${question.average === null ? '-' : roundMetric(question.average, 1)} | Low ${question.minResponse ?? '-'} | High ${question.maxResponse ?? '-'}`
          : `${question.responseCount} written ${question.responseCount === 1 ? 'response' : 'responses'}`;
    return `
      <tr>
        <td>${escapeHtml(question.text)} ${label}</td>
        <td>${escapeHtml(question.type)}</td>
        <td>${question.responseCount}</td>
        <td>${escapeHtml(metric)}</td>
      </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(summary.discussion.topic)} Report</title>
  <style>
    :root { color: #111827; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f3f4f6; }
    main { max-width: 1040px; margin: 0 auto; padding: 48px 24px; }
    header { margin-bottom: 28px; }
    h1 { font-size: 36px; line-height: 1.1; margin: 0 0 8px; }
    h2 { font-size: 20px; margin: 0 0 14px; }
    h3 { font-size: 15px; margin: 0 0 6px; }
    p, li, td, th { font-size: 14px; line-height: 1.5; }
    section { background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 22px; margin: 18px 0; }
    .muted { color: #6b7280; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 26px; margin-top: 4px; }
    .split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    ul { padding-left: 20px; margin: 0; }
    li { margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; color: #4b5563; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 10px 8px; vertical-align: top; }
    .pill { display: inline-block; color: #374151; background: #f3f4f6; border-radius: 999px; font-size: 11px; padding: 2px 7px; margin-left: 6px; }
    @media print { body { background: #fff; } main { padding: 0; } section { break-inside: avoid; } }
    @media (max-width: 760px) { .grid, .split { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="muted">Convora final report | Generated ${escapeHtml(generatedAt)}</p>
      <h1>${escapeHtml(summary.discussion.topic)}</h1>
      <p class="muted">Created ${escapeHtml(new Date(summary.discussion.createdAt).toLocaleString())}</p>
    </header>

    <section>
      <h2>Snapshot</h2>
      ${summary.counts.hiddenResults ? `<p class="muted">Results for ${summary.counts.hiddenResults} ${summary.counts.hiddenResults === 1 ? 'question is' : 'questions are'} hidden until you vote and are left out of this report.</p>` : ''}
      <div class="grid">
        <div class="metric">Questions<strong>${summary.counts.questions}</strong></div>
        <div class="metric">Responses<strong>${summary.counts.responses}</strong></div>
        <div class="metric">Participants<strong>${summary.counts.participants}</strong></div>
        <div class="metric">Unanswered<strong>${dashboard.unansweredPrompts?.length || 0}</strong></div>
      </div>
    </section>

    <section>
      <h2>Facilitator Brief</h2>
      ${renderList(dashboard.recommendedNextActions, 'No recommended actions.', item => `<li>${escapeHtml(item)}</li>`)}
    </section>

    <section class="split">
      <div>
        <h2>Unresolved Tensions</h2>
        ${renderList(dashboard.unresolvedTensions, 'No major unresolved tensions detected.', item => `<li><strong>${escapeHtml(item.text)}</strong><br><span class="muted">${escapeHtml(item.type)} | ${escapeHtml(item.detail)}</span></li>`)}
      </div>
      <div>
        <h2>Participation Gaps</h2>
        ${renderList(dashboard.participationGaps, 'No obvious participation gaps detected.', item => `<li><strong>${escapeHtml(item.type)}</strong><br><span class="muted">${escapeHtml(item.detail)}</span></li>`)}
      </div>
    </section>

    <section class="split">
      <div>
        <h2>Most Divisive Statements</h2>
        ${renderList(dashboard.mostDivisiveStatements, 'No divisive agreement statements yet.', item => `<li><strong>${escapeHtml(formatReportPercent(item.divisiveScore))}</strong> split | ${escapeHtml(item.text)}<br><span class="muted">${escapeHtml(item.detail)}</span></li>`)}
      </div>
      <div>
        <h2>Unanswered Prompts</h2>
        ${renderList(dashboard.unansweredPrompts, 'Every prompt has at least one response.', item => `<li>${escapeHtml(item.text)} <span class="muted">(${escapeHtml(item.type)})</span></li>`)}
      </div>
    </section>

    <section>
      <h2>Prompt Details</h2>
      <table>
        <thead><tr><th>Prompt</th><th>Type</th><th>Responses</th><th>Signal</th></tr></thead>
        <tbody>${questionRows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

module.exports = { buildSummary, renderReportHtml };
