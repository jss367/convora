require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const { analyzeClusters } = require('./clustering');

const app = express();
const server = http.createServer(app);

const isProduction = process.env.NODE_ENV === 'production';
const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Enable CORS for your client URL
app.use(cors({
  origin: clientUrl,
  credentials: true,
}));

const io = socketIo(server, {
  cors: {
    origin: clientUrl,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://username:password@localhost:5432/convora',
  ssl: isProduction ? { rejectUnauthorized: false } : false,
});

function parseOptions(options) {
  if (Array.isArray(options)) {
    return options;
  }
  if (typeof options === 'string') {
    try {
      const parsed = JSON.parse(options);
      return Array.isArray(parsed) ? parsed : [options];
    } catch (e) {
      console.warn('Failed to parse options as JSON, falling back to comma-separated string:', options);
      return options.split(',').map(opt => opt.trim());
    }
  }
  if (options === null || options === undefined) {
    return [];
  }
  console.warn('Unexpected options type:', typeof options);
  return [String(options)];
}

const AGREEMENT_OPTIONS = [
  'Strongly Disagree',
  'Disagree',
  'Unsure',
  'Agree',
  'Strongly Agree',
];

function sanitizeFilename(value) {
  return String(value || 'discussion')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'discussion';
}

function slugifyTopic(value) {
  return String(value || 'discussion')
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'discussion';
}

function formatTopicTitle(value) {
  const title = String(value || '').trim().replace(/\s+/g, ' ');
  if (title) {
    return title;
  }
  return 'Discussion';
}

function titleFromSlug(slug) {
  return slugifyTopic(slug)
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Discussion';
}

function suffixSlug(baseSlug, suffix) {
  if (suffix <= 1) {
    return baseSlug;
  }
  const suffixText = `-${suffix}`;
  return `${baseSlug.slice(0, 80 - suffixText.length)}${suffixText}`;
}

function escapeCsv(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const stringValue = Array.isArray(value) ? JSON.stringify(value) : String(value);
  const neutralizedValue = /^[=+\-@]/.test(stringValue) ? `'${stringValue}` : stringValue;
  return `"${neutralizedValue.replace(/"/g, '""')}"`;
}

function parseStoredVoteValue(value) {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
}

function getQuestionRange(question) {
  const min = Number.parseInt(question.min_value, 10);
  const max = Number.parseInt(question.max_value, 10);
  return {
    minValue: Number.isNaN(min) ? 0 : min,
    maxValue: Number.isNaN(max) ? 100 : max,
  };
}

function extractResponseText(data) {
  if (typeof data.output_text === 'string') {
    return data.output_text;
  }

  const contentItems = (data.output || [])
    .flatMap(item => Array.isArray(item.content) ? item.content : []);
  const text = contentItems
    .map(item => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();

  return text || null;
}

function buildDeterministicSynthesis(writtenResponses) {
  if (writtenResponses.length === 0) {
    return null;
  }

  const byQuestion = writtenResponses.reduce((acc, response) => {
    if (!acc.has(response.questionText)) {
      acc.set(response.questionText, []);
    }
    acc.get(response.questionText).push(response.value);
    return acc;
  }, new Map());

  const longestResponses = [...writtenResponses]
    .sort((a, b) => b.value.length - a.value.length)
    .slice(0, 3)
    .map(response => ({
      question: response.questionText,
      excerpt: response.value.length > 180 ? `${response.value.slice(0, 177)}...` : response.value,
    }));

  return {
    mode: 'deterministic',
    text: `${writtenResponses.length} written ${writtenResponses.length === 1 ? 'response' : 'responses'} across ${byQuestion.size} ${byQuestion.size === 1 ? 'prompt' : 'prompts'}.`,
    highlights: [...byQuestion.entries()].map(([question, responses]) => ({
      question,
      responseCount: responses.length,
    })),
    excerpts: longestResponses,
  };
}

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
  const agreementPrompts = questionSummaries.filter(question => question.type === 'Agreement');
  const numericalPrompts = questionSummaries.filter(question => question.type === 'Numerical');

  const mostDivisiveStatements = agreementPrompts
    .filter(question => question.decidedCount >= 2)
    .map(question => ({
      id: question.id,
      text: question.text,
      responseCount: question.responseCount,
      agreeCount: question.agreeCount,
      disagreeCount: question.disagreeCount,
      unsureCount: question.unsureCount,
      divisiveScore: roundMetric(question.divisiveScore),
      leadingPosition: question.leadingPosition,
    }))
    .sort((a, b) => b.divisiveScore - a.divisiveScore || b.responseCount - a.responseCount)
    .slice(0, 5);

  const agreementTensions = agreementPrompts
    .filter(question => question.decidedCount >= 2 && question.divisiveScore >= 0.35)
    .map(question => ({
      id: question.id,
      type: 'Opinion split',
      text: question.text,
      severity: roundMetric(question.divisiveScore),
      detail: `${question.agreeCount} agree / ${question.disagreeCount} disagree / ${question.unsureCount} unsure`,
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
    recommendedNextActions.push('Review the consensus and written synthesis, then close with owners and next steps.');
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

async function buildLlmSynthesis(writtenResponses) {
  if (
    writtenResponses.length === 0 ||
    process.env.ENABLE_LLM_SYNTHESIS !== 'true' ||
    !process.env.OPENAI_API_KEY
  ) {
    return null;
  }

  const payload = writtenResponses.slice(0, 80).map(response => ({
    question: response.questionText,
    response: response.value,
  }));

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      input: [
        {
          role: 'system',
          content: 'Summarize open-ended discussion responses for a read-only post-discussion report. Be concise, neutral, and preserve unresolved tensions.',
        },
        {
          role: 'user',
          content: `Return JSON with keys synthesis, commonThemes, unresolvedQuestions, and notableDivergences. Responses: ${JSON.stringify(payload)}`,
        },
      ],
      text: {
        format: {
          type: 'json_object',
        },
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM synthesis failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const outputText = extractResponseText(data);
  if (!outputText) {
    return null;
  }

  return {
    mode: 'llm',
    ...JSON.parse(outputText),
  };
}

function buildSummary(discussion, questions, synthesis) {
  const participantIds = new Set();
  const participantMap = new Map();
  const typeCounts = {};
  let totalResponses = 0;

  const questionSummaries = questions.map((question) => {
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
        if (question.type === 'Agreement') {
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

  const agreementSummaries = questionSummaries.filter(summary => summary.type === 'Agreement' && summary.decidedCount >= 2);
  const topConsensus = [...agreementSummaries]
    .sort((a, b) => b.consensusScore - a.consensusScore || b.responseCount - a.responseCount)
    .slice(0, 5);
  const topDivisive = [...agreementSummaries]
    .sort((a, b) => b.divisiveScore - a.divisiveScore || b.responseCount - a.responseCount)
    .slice(0, 5);
  const facilitatorDashboard = buildFacilitatorDashboard(questionSummaries, [...participantMap.values()]);

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
    },
    topConsensus,
    topDivisive,
    facilitatorDashboard,
    synthesis,
    questions: questionSummaries,
  };
}

function renderReportHtml(summary) {
  const dashboard = summary.facilitatorDashboard || {};
  const synthesis = summary.synthesis;
  const synthesisText = synthesis?.mode === 'llm'
    ? synthesis.synthesis
    : synthesis?.text;
  const generatedAt = new Date().toLocaleString();

  const renderList = (items, emptyText, renderItem) => {
    if (!Array.isArray(items) || items.length === 0) {
      return `<p class="muted">${escapeHtml(emptyText)}</p>`;
    }
    return `<ul>${items.map(renderItem).join('')}</ul>`;
  };

  const questionRows = summary.questions.map(question => {
    const label = question.label ? `<span class="pill">${escapeHtml(question.label)}</span>` : '';
    const metric = question.type === 'Agreement'
      ? `${question.agreeCount || 0} agree / ${question.disagreeCount || 0} disagree / ${question.unsureCount || 0} unsure`
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
        ${renderList(dashboard.mostDivisiveStatements, 'No divisive agreement statements yet.', item => `<li><strong>${escapeHtml(formatReportPercent(item.divisiveScore))}</strong> split | ${escapeHtml(item.text)}<br><span class="muted">${item.agreeCount} agree / ${item.disagreeCount} disagree / ${item.unsureCount} unsure</span></li>`)}
      </div>
      <div>
        <h2>Unanswered Prompts</h2>
        ${renderList(dashboard.unansweredPrompts, 'Every prompt has at least one response.', item => `<li>${escapeHtml(item.text)} <span class="muted">(${escapeHtml(item.type)})</span></li>`)}
      </div>
    </section>

    <section>
      <h2>Written Response Synthesis</h2>
      <p>${escapeHtml(synthesisText || 'No open-ended responses yet.')}</p>
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

async function getDiscussionBySlug(slug) {
  const canonicalSlug = slugifyTopic(slug);
  const result = await pool.query(
    'SELECT id, topic, slug, created_at FROM discussions WHERE slug = $1 ORDER BY id DESC LIMIT 1',
    [canonicalSlug]
  );
  return result.rows[0] || null;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'dist')));

// Emit the number of clients currently in a discussion room to everyone there.
function emitPresence(topic) {
  if (!topic) return;
  const count = io.sockets.adapter.rooms.get(topic)?.size || 0;
  io.to(topic).emit('presence', count);
}

// Read the lock state and whether a moderator has been claimed.
async function getDiscussionState(topic) {
  const slug = slugifyTopic(topic);
  const result = await pool.query(
    'SELECT locked, reaction_keys, admin_token IS NOT NULL AS has_moderator FROM discussions WHERE slug = $1',
    [slug]
  );
  if (result.rows.length === 0) {
    return { locked: false, hasModerator: false, reactionKeys: [...DEFAULT_REACTION_KEYS] };
  }
  return {
    locked: result.rows[0].locked === true,
    hasModerator: result.rows[0].has_moderator === true,
    reactionKeys: resolveReactionKeys(result.rows[0].reaction_keys),
  };
}

async function emitDiscussionState(topic) {
  io.to(topic).emit('discussionState', await getDiscussionState(topic));
}

// WebSocket handlers
io.on('connection', (socket) => {
  console.log('New client connected');

  socket.on('joinDiscussion', async (topic) => {
    const discussionSlug = slugifyTopic(topic);
    // If this socket was viewing another discussion, leave it so presence
    // counts stay accurate as the user navigates within the SPA.
    const previousTopic = socket.data.topic;
    if (previousTopic && previousTopic !== discussionSlug) {
      socket.leave(previousTopic);
      emitPresence(previousTopic);
    }

    socket.join(discussionSlug);
    socket.data.topic = discussionSlug;
    emitPresence(discussionSlug);

    try {
      socket.emit('discussion', await getDiscussionBySlug(discussionSlug));
      const questions = await getQuestions(discussionSlug);
      socket.emit('questions', questions);
      socket.emit('discussionState', await getDiscussionState(discussionSlug));
    } catch (error) {
      console.error('Error getting questions:', error);
      socket.emit('error', { message: 'Failed to get questions' });
    }
  });

  // Associate this socket with the client's persistent userId so the server can
  // route a live moderator grant to it when a moderator promotes this user.
  //
  // Deliberately does NOT hand back an existing moderator token here: userId is
  // not a secret (getQuestions broadcasts each vote's userId to the whole room),
  // so re-delivering a token to anyone who supplies a promoted user's id would
  // let an observer steal moderator access. A genuinely promoted user receives
  // their token live at promotion time and persists it locally (so it survives
  // reloads/reconnects via verifyAdmin); we never re-mint it from the id alone.
  socket.on('identify', (topic, userId) => {
    if (!userId) return;
    socket.data.userId = userId;
  });

  socket.on('leaveDiscussion', (topic) => {
    // The client unmounted its discussion page; drop it from the room and
    // recompute presence so the counter doesn't over-report lingering viewers.
    const roomToLeave = topic || socket.data.topic;
    if (!roomToLeave) return;
    socket.leave(roomToLeave);
    if (socket.data.topic === roomToLeave) {
      socket.data.topic = null;
    }
    emitPresence(roomToLeave);
  });

  socket.on('addQuestion', async (topic, question, force, ack) => {
    const discussionSlug = slugifyTopic(topic);
    console.log('Received addQuestion event');
    console.log('topic:', discussionSlug);
    console.log('question:', question);

    // Report the outcome back to the submitter so the client only clears its
    // draft once the question is actually added — not when it's bounced as a
    // near-duplicate or fails.
    const reply = (result) => {
      if (typeof ack === 'function') ack(result);
    };

    try {
      if (await isDiscussionLocked(discussionSlug)) {
        socket.emit('error', { message: 'This discussion is locked.' });
        reply({ added: false, reason: 'locked' });
        return;
      }

      // Surface a near-duplicate so the submitter can vote on the existing
      // statement instead — unless they explicitly chose to post anyway.
      if (!force) {
        const similar = await findSimilarQuestion(discussionSlug, question.text);
        if (similar) {
          socket.emit('similarQuestion', { candidate: similar, question });
          reply({ added: false, reason: 'similar' });
          return;
        }
      }

      await addQuestion(discussionSlug, question);
      console.log('Question added successfully');
      const updatedQuestions = await getQuestions(discussionSlug);
      console.log('Retrieved updated questions:', updatedQuestions);
      io.to(discussionSlug).emit('discussion', await getDiscussionBySlug(discussionSlug));
      io.to(discussionSlug).emit('questions', updatedQuestions);
      reply({ added: true });
    } catch (error) {
      console.error('Error adding question:', error);
      socket.emit('error', { message: 'Failed to add question' });
      reply({ added: false, reason: 'error' });
    }
  });

  socket.on('vote', async (topic, questionId, vote, userId, pseudonym) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      // Verify the question actually belongs to this topic AND that the topic is
      // not locked. Without this, a client could bypass a locked discussion by
      // sending the locked question's id under some other (unlocked) topic.
      const target = await getQuestionForTopic(discussionSlug, questionId);
      if (!target) {
        socket.emit('error', { message: 'Invalid question for this discussion.' });
        return;
      }
      if (target.locked) {
        socket.emit('error', { message: 'Voting is closed for this discussion.' });
        return;
      }
      await addVote(questionId, vote, userId, pseudonym);
      const questions = await getQuestions(discussionSlug);
      io.to(discussionSlug).emit('questions', questions);
    } catch (error) {
      console.error('Error handling vote:', error);
      socket.emit('error', { message: 'Failed to handle vote' });
    }
  });

  // First-come moderator claim. Replies via ack callback with the admin token.
  socket.on('claimModerator', async (topic, cb) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const token = await claimModerator(discussionSlug);
      if (token) {
        if (typeof cb === 'function') cb({ success: true, token });
        io.to(discussionSlug).emit('discussion', await getDiscussionBySlug(discussionSlug));
        await emitDiscussionState(discussionSlug);
      } else if (typeof cb === 'function') {
        cb({ success: false, error: 'already_claimed' });
      }
    } catch (error) {
      console.error('Error claiming moderator:', error);
      if (typeof cb === 'function') cb({ success: false, error: 'server_error' });
    }
  });

  // Moderator-only: list the discussion's participants (opaque handle +
  // pseudonym + whether they already moderate) so a moderator can pick someone
  // to promote. Raw user_ids are never sent to the client.
  socket.on('listParticipants', async (topic, token, cb) => {
    if (typeof cb !== 'function') return;
    const discussionSlug = slugifyTopic(topic);
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) {
        cb({ success: false, error: 'not_authorized' });
        return;
      }
      cb({ success: true, participants: await listParticipants(discussionSlug) });
    } catch (error) {
      console.error('Error listing participants:', error);
      cb({ success: false, error: 'server_error' });
    }
  });

  // Moderator-only: promote a participant (named by their opaque handle) to
  // moderator. Mints them a personal token, delivers it live to their connected
  // sockets, and returns the refreshed participant list.
  socket.on('promoteModerator', async (topic, token, participantId, cb) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) {
        if (typeof cb === 'function') cb({ success: false, error: 'not_authorized' });
        return;
      }
      const target = await resolveParticipant(discussionSlug, participantId);
      if (!target) {
        // The handle no longer maps to a participant (e.g. the list shifted).
        if (typeof cb === 'function') cb({ success: false, error: 'unknown_participant' });
        return;
      }
      const { token: grantedToken, inserted } = await promoteModerator(discussionId, target.userId);
      const delivered = deliverModeratorToken(discussionSlug, target.userId, grantedToken);
      // A token can only reach a user via a live push (we never re-deliver from a
      // client-supplied id). If this call newly granted moderation but the user
      // isn't connected to receive it, roll the grant back rather than leaving
      // them marked as a moderator with a token they can never obtain.
      if (inserted && delivered === 0) {
        await revokeModerator(discussionId, target.userId);
        if (typeof cb === 'function') cb({ success: false, error: 'participant_offline' });
        return;
      }
      await emitDiscussionState(discussionSlug);
      if (typeof cb === 'function') {
        cb({ success: true, participants: await listParticipants(discussionSlug) });
      }
    } catch (error) {
      console.error('Error promoting moderator:', error);
      if (typeof cb === 'function') cb({ success: false, error: 'server_error' });
    }
  });

  socket.on('deleteQuestion', async (topic, questionId, token) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        return;
      }
      // Scope the vote delete through the question's discussion so a moderator of
      // one discussion can never wipe another discussion's votes by passing a
      // foreign questionId. Delete votes first to satisfy the FK constraint, then
      // the question itself (also constrained by discussion_id).
      await pool.query(
        `DELETE FROM votes
         WHERE question_id = $1
           AND question_id IN (SELECT id FROM questions WHERE discussion_id = $2)`,
        [questionId, discussionId]
      );
      await pool.query('DELETE FROM questions WHERE id = $1 AND discussion_id = $2', [questionId, discussionId]);
      io.to(discussionSlug).emit('questions', await getQuestions(discussionSlug));
    } catch (error) {
      console.error('Error deleting question:', error);
      socket.emit('error', { message: 'Failed to delete question' });
    }
  });

  socket.on('setLocked', async (topic, locked, token) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        return;
      }
      await pool.query('UPDATE discussions SET locked = $1 WHERE id = $2', [!!locked, discussionId]);
      await emitDiscussionState(discussionSlug);
    } catch (error) {
      console.error('Error setting lock state:', error);
      socket.emit('error', { message: 'Failed to update discussion' });
    }
  });

  socket.on('setPinned', async (topic, questionId, pinned, token) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        return;
      }
      await pool.query('UPDATE questions SET pinned = $1 WHERE id = $2 AND discussion_id = $3', [!!pinned, questionId, discussionId]);
      io.to(discussionSlug).emit('questions', await getQuestions(discussionSlug));
    } catch (error) {
      console.error('Error setting pin state:', error);
      socket.emit('error', { message: 'Failed to update question' });
    }
  });

  socket.on('toggleResponseVote', async (topic, responseId, userId) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      await toggleResponseVote(discussionSlug, responseId, userId);
      const questions = await getQuestions(discussionSlug);
      io.to(discussionSlug).emit('questions', questions);
    } catch (error) {
      console.error('Error toggling response vote:', error);
      socket.emit('error', { message: 'Failed to upvote response' });
    }
  });

  // Set/clear one axis (quality or agreement) of a user's rating on a brainstorm
  // idea. Gated on the question being a Brainstorm with reactions currently
  // revealed, so a hidden/disabled phase can't be rated through a crafted event.
  socket.on('setResponseRating', async (topic, responseId, axis, value, userId) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      if (axis !== 'quality' && axis !== 'agreement') return;
      const ctx = await getResponseContext(topic, responseId);
      // Locking closes voting; ratings are votes, so reject them just like the
      // `vote` handler does. (Phasing uses reactionsVisible, not the lock.)
      if (!ctx || ctx.locked || ctx.type !== 'Brainstorm' || !ctx.reactionsEnabled || !ctx.reactionsVisible) return;
      // No self-rating: an author can't vote on their own idea, mirroring the
      // self-upvote guard on toggleResponseVote, so they can't inflate it.
      if (ctx.ownerId === userId) return;
      await setResponseRating(responseId, userId, axis, value);
      io.to(discussionSlug).emit('questions', await getQuestions(discussionSlug));
    } catch (error) {
      console.error('Error setting response rating:', error);
      socket.emit('error', { message: 'Failed to rate response' });
    }
  });

  socket.on('toggleResponseReaction', async (topic, responseId, reaction, userId) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const ctx = await getResponseContext(topic, responseId);
      if (!ctx || ctx.locked || ctx.type !== 'Brainstorm' || !ctx.reactionsEnabled || !ctx.reactionsVisible) return;
      // Reject anything outside the set the creator has active for this session.
      if (!ctx.reactionKeys.includes(reaction)) return;
      // No self-reactions on your own idea, same rationale as ratings.
      if (ctx.ownerId === userId) return;
      await toggleResponseReaction(responseId, userId, reaction);
      io.to(discussionSlug).emit('questions', await getQuestions(discussionSlug));
    } catch (error) {
      console.error('Error toggling response reaction:', error);
      socket.emit('error', { message: 'Failed to react to response' });
    }
  });

  socket.on('addResponseComment', async (topic, responseId, body, userId, pseudonym, ack) => {
    const discussionSlug = slugifyTopic(topic);
    const reply = (result) => { if (typeof ack === 'function') ack(result); };
    try {
      const ctx = await getResponseContext(topic, responseId);
      // A locked discussion has new statements closed; comments are statements.
      if (!ctx || ctx.locked || ctx.type !== 'Brainstorm' || !ctx.commentsEnabled) {
        reply({ added: false });
        return;
      }
      const text = String(body || '').trim();
      if (!text) {
        reply({ added: false });
        return;
      }
      // Sanitize the display name the same way votes do (trim + length cap), so
      // a crafted oversized/whitespace pseudonym can't bloat or break the UI.
      await pool.query(
        'INSERT INTO response_comments (response_id, user_id, pseudonym, body) VALUES ($1, $2, $3, $4)',
        [responseId, userId, sanitizePseudonym(pseudonym), text.slice(0, 2000)]
      );
      io.to(discussionSlug).emit('questions', await getQuestions(discussionSlug));
      reply({ added: true });
    } catch (error) {
      console.error('Error adding response comment:', error);
      socket.emit('error', { message: 'Failed to add comment' });
      reply({ added: false });
    }
  });

  // Delete a comment. Scoped through the discussion and to the comment's own
  // author, so a participant can only remove their own comments.
  socket.on('deleteResponseComment', async (topic, commentId, userId) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      await pool.query(
        `DELETE FROM response_comments c
         USING votes v, questions q, discussions d
         WHERE c.id = $1 AND c.user_id = $2
           AND c.response_id = v.id AND v.question_id = q.id AND q.discussion_id = d.id
           AND d.slug = $3`,
        [commentId, userId, discussionSlug]
      );
      io.to(discussionSlug).emit('questions', await getQuestions(discussionSlug));
    } catch (error) {
      console.error('Error deleting response comment:', error);
      socket.emit('error', { message: 'Failed to delete comment' });
    }
  });

  // Moderator-only: flip the per-question interaction flags (allow/disallow
  // reactions, reveal/hide reactions, allow/disallow comments). Only known
  // boolean flags are applied.
  socket.on('setQuestionFlags', async (topic, questionId, flags, token) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const discussionId = await verifyAdmin(topic, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        return;
      }
      const allowed = ['reactions_enabled', 'reactions_visible', 'comments_enabled'];
      const sets = [];
      const values = [];
      for (const key of allowed) {
        if (flags && Object.prototype.hasOwnProperty.call(flags, key)) {
          values.push(!!flags[key]);
          sets.push(`${key} = $${values.length}`);
        }
      }
      if (sets.length === 0) return;
      values.push(questionId, discussionId);
      await pool.query(
        `UPDATE questions SET ${sets.join(', ')} WHERE id = $${values.length - 1} AND discussion_id = $${values.length}`,
        values
      );
      io.to(discussionSlug).emit('questions', await getQuestions(discussionSlug));
    } catch (error) {
      console.error('Error setting question flags:', error);
      socket.emit('error', { message: 'Failed to update question' });
    }
  });

  // Moderator-only: choose which epistemic reactions are active for the whole
  // discussion. The selection is stored as a subset of REACTION_CATALOG (keys
  // outside it are dropped); an all-empty selection is ignored so a session is
  // never left with reactions enabled but nothing to place. Broadcast via
  // discussionState so every connected client re-renders the set live.
  socket.on('setReactionKeys', async (topic, keys, token) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      const discussionId = await verifyAdmin(discussionSlug, token);
      if (!discussionId) {
        socket.emit('error', { message: 'Not authorized to moderate this discussion.' });
        return;
      }
      const filtered = Array.isArray(keys) ? REACTION_CATALOG.filter(k => keys.includes(k)) : [];
      if (filtered.length === 0) return;
      await pool.query(
        'UPDATE discussions SET reaction_keys = $1 WHERE id = $2',
        [JSON.stringify(filtered), discussionId]
      );
      await emitDiscussionState(discussionSlug);
    } catch (error) {
      console.error('Error setting reaction keys:', error);
      socket.emit('error', { message: 'Failed to update reactions' });
    }
  });

  // Return the requesting user's own ratings/reactions so the client can restore
  // its selected state after a reload or reconnect.
  socket.on('getBrainstormState', async (topic, userId, ack) => {
    try {
      const state = await getMyBrainstormState(topic, userId);
      if (typeof ack === 'function') ack(state);
    } catch (error) {
      console.error('Error fetching brainstorm state:', error);
      if (typeof ack === 'function') ack({ ratings: {}, reactions: {} });
    }
  });

  socket.on('deleteVote', async (topic, voteId, userId) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      await deleteVote(voteId, userId);
      const questions = await getQuestions(discussionSlug);
      io.to(discussionSlug).emit('questions', questions);
    } catch (error) {
      console.error('Error deleting vote:', error);
      socket.emit('error', { message: 'Failed to delete vote' });
    }
  });

  // Retroactively rename a participant's already-submitted responses when they
  // change name mode, edit their custom name, or shuffle their pseudonym. Without
  // this, switching to "Completely anonymous" would still show the old name on
  // prior responses, breaking the privacy promise. Allowed even when the
  // discussion is locked: this is a display-name edit, not a new vote.
  socket.on('updateDisplayName', async (topic, userId, displayName) => {
    const discussionSlug = slugifyTopic(topic);
    try {
      if (!topic || !userId) return;
      const pseudonym = sanitizePseudonym(displayName);
      await pool.query(
        `UPDATE votes SET pseudonym = $1
         WHERE user_id = $2
           AND question_id IN (
             SELECT id FROM questions
             WHERE discussion_id = (SELECT id FROM discussions WHERE slug = $3)
           )`,
        [pseudonym, userId, discussionSlug]
      );
      // Brainstorm comments persist their author's name separately, so rename /
      // anonymize must reach them too — otherwise old comments keep showing the
      // previous name after a privacy action.
      await pool.query(
        `UPDATE response_comments SET pseudonym = $1
         WHERE user_id = $2
           AND response_id IN (
             SELECT v.id FROM votes v
             JOIN questions q ON v.question_id = q.id
             WHERE q.discussion_id = (SELECT id FROM discussions WHERE slug = $3)
           )`,
        [pseudonym, userId, discussionSlug]
      );
      io.to(discussionSlug).emit('questions', await getQuestions(discussionSlug));
    } catch (error) {
      console.error('Error updating display name:', error);
      socket.emit('error', { message: 'Failed to update display name' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected');
    // The socket has already left its rooms by now, so the count reflects the
    // remaining participants.
    emitPresence(socket.data.topic);
  });
});

app.use((req, res, next) => {
  console.log('Request body:', req.body);
  next();
});

// HTTP routes
app.post('/api/discussions', async (req, res) => {
  const { topic } = req.body;
  try {
    // The creator becomes the moderator: createDiscussion mints an admin token
    // and returns it when (and only when) this caller is the one establishing
    // the discussion's moderator. The client persists it so the person who made
    // the session lands as its moderator instead of racing others for the role.
    const discussion = await createDiscussion(topic);
    res.json({ success: true, ...discussion });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/discussions/resolve/:topic', async (req, res) => {
  try {
    const discussion = await resolveDiscussionRoute(req.params.topic);
    if (!discussion) {
      return res.status(404).json({ error: 'Discussion not found' });
    }
    res.json(discussion);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/discussions/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Select explicit columns, never admin_token: this endpoint is public and
    // the discussion id is discoverable via GET /api/discussions, so returning
    // the moderator secret here would let anyone claim moderator controls.
    const result = await pool.query(
      'SELECT id, topic, slug, created_at, locked FROM discussions WHERE id = $1',
      [id]
    );
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ error: 'Discussion not found' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Database functions
async function resolveDiscussionRoute(routeTopic) {
  const displayTopic = formatTopicTitle(routeTopic);
  const slug = slugifyTopic(routeTopic);
  const result = await pool.query(
    `SELECT id, topic, slug, created_at
       FROM discussions
      WHERE topic = $1 OR slug = $2
      ORDER BY CASE WHEN topic = $1 THEN 0 ELSE 1 END, id
      LIMIT 1`,
    [displayTopic, slug]
  );
  return result.rows[0] || null;
}

async function getOrCreateDiscussionForSlug(db, slug) {
  const canonicalSlug = slugifyTopic(slug);
  const result = await db.query(
    `INSERT INTO discussions (topic, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
     RETURNING id, topic, slug`,
    [titleFromSlug(canonicalSlug), canonicalSlug]
  );
  return result.rows[0];
}

async function getQuestions(topic, { includeUserIds = false } = {}) {
  const slug = slugifyTopic(topic);
  const query = `
    SELECT 
      q.id, 
      q.text, 
      q.type, 
      q.min_value,
      q.max_value,
      q.options,
      q.created_at,
      q.pinned,
      q.reactions_enabled,
      q.reactions_visible,
      q.comments_enabled,
      COALESCE(json_agg(
        json_build_object(
          'id', v.id,
          'value', v.value,
          'userId', v.user_id,
          'pseudonym', v.pseudonym,
          'created_at', v.created_at,
          'upvotes', (SELECT COUNT(*) FROM response_votes rv WHERE rv.response_id = v.id),
          'upvoters', (SELECT COALESCE(json_agg(rv.user_id), '[]'::json) FROM response_votes rv WHERE rv.response_id = v.id)
        ) ORDER BY v.id
      ) FILTER (WHERE v.id IS NOT NULL), '[]'::json) as votes
    FROM questions q
    JOIN discussions d ON q.discussion_id = d.id
    LEFT JOIN votes v ON q.id = v.question_id
    WHERE d.slug = $1
    GROUP BY q.id
    ORDER BY q.pinned DESC, q.id
  `;

  const result = await pool.query(query, [slug]);
  const questions = result.rows.map(row => ({
    ...row,
    minValue: row.min_value,
    maxValue: row.max_value,
    reactionsEnabled: row.reactions_enabled === true,
    reactionsVisible: row.reactions_visible === true,
    commentsEnabled: row.comments_enabled === true,
    options: parseOptions(row.options),
    // Replace raw stable user ids on the wire with per-response ownership
    // tokens so a socket observer can't correlate a participant's responses —
    // not across prompts, and not even across multiple ideas in the same
    // Brainstorm prompt. Each token is keyed by the vote's own row id, so one
    // anonymous participant's separate ideas each carry a DIFFERENT token and
    // can't be grouped. Each client recomputes the same token for its own votes
    // (see ownerToken() in client/src/identity.js — the two MUST match).
    votes: (Array.isArray(row.votes) ? row.votes : []).map(vote => {
      // Internal callers (e.g. getDiscussionSummary) opt into keeping the raw
      // stable user_id so they can count distinct participants correctly. This
      // path is SERVER-SIDE ONLY and must never feed a socket/API response.
      if (includeUserIds) return { ...vote };
      const tokenized = {
        ...vote,
        ownerToken: ownerToken(vote.id, vote.userId),
        upvoterTokens: (Array.isArray(vote.upvoters) ? vote.upvoters : [])
          .map(uid => ownerToken(vote.id, uid)),
      };
      delete tokenized.userId;
      delete tokenized.upvoters;
      return tokenized;
    }),
  }));
  await attachBrainstormInteractions(questions, { includeUserIds });
  return questions;
}

// Curated catalog of epistemic reactions the system knows how to render. The
// keys are stable and the client owns their display labels; the server keeps
// this list purely as the validation allowlist (a key outside it is never
// accepted). A discussion's creator may narrow which of these are active for
// their session — see reaction_keys / resolveReactionKeys.
const REACTION_CATALOG = [
  'changed-mind',
  'crux',
  'follows',
  'citation-needed',
  'key-insight',
];

// Reactions a discussion starts with before its creator customizes the set
// (reaction_keys IS NULL) — currently the whole catalog.
const DEFAULT_REACTION_KEYS = REACTION_CATALOG;

// Resolve a discussion's stored reaction_keys (raw JSONB, possibly null) into an
// ordered, validated list of active reaction keys. Null/empty/all-invalid falls
// back to the defaults; otherwise the stored selection is filtered to the
// catalog and re-ordered to match it, so every client renders the same order.
function resolveReactionKeys(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_REACTION_KEYS];
  const selected = new Set(raw);
  const resolved = REACTION_CATALOG.filter(k => selected.has(k));
  return resolved.length > 0 ? resolved : [...DEFAULT_REACTION_KEYS];
}

// Enrich Brainstorm responses in place with aggregated interaction data:
// quality up/down tallies, the agreement distribution, reaction counts, and
// comments. Everything here is an aggregate or a pseudonymous comment — never
// a list of who voted which way — so reactions stay unattributable. Ratings and
// reactions are only attached when the moderator currently has them revealed;
// comments only when comments are enabled. This enforces the hide/disable
// toggles server-side rather than trusting the client to omit hidden data.
async function attachBrainstormInteractions(questions, { includeUserIds = false } = {}) {
  const ratingIds = [];
  const commentIds = [];
  for (const q of questions) {
    if (q.type !== 'Brainstorm') continue;
    const votes = q.votes || [];
    if (q.reactionsEnabled && q.reactionsVisible) {
      for (const v of votes) ratingIds.push(v.id);
    }
    if (q.commentsEnabled) {
      for (const v of votes) commentIds.push(v.id);
    }
  }

  const ratingsByResponse = new Map();
  const reactionsByResponse = new Map();
  if (ratingIds.length > 0) {
    const qualityResult = await pool.query(
      `SELECT response_id,
              COUNT(*) FILTER (WHERE quality > 0) AS up,
              COUNT(*) FILTER (WHERE quality < 0) AS down
       FROM response_ratings
       WHERE response_id = ANY($1::int[])
       GROUP BY response_id`,
      [ratingIds]
    );
    for (const r of qualityResult.rows) {
      ratingsByResponse.set(r.response_id, {
        qualityUp: Number(r.up),
        qualityDown: Number(r.down),
        agreementCounts: {},
      });
    }

    const agreementResult = await pool.query(
      `SELECT response_id, agreement, COUNT(*) AS c
       FROM response_ratings
       WHERE response_id = ANY($1::int[]) AND agreement IS NOT NULL
       GROUP BY response_id, agreement`,
      [ratingIds]
    );
    for (const r of agreementResult.rows) {
      const entry = ratingsByResponse.get(r.response_id)
        || { qualityUp: 0, qualityDown: 0, agreementCounts: {} };
      entry.agreementCounts[r.agreement] = Number(r.c);
      ratingsByResponse.set(r.response_id, entry);
    }

    const reactionResult = await pool.query(
      `SELECT response_id, reaction, COUNT(*) AS c
       FROM response_reactions
       WHERE response_id = ANY($1::int[])
       GROUP BY response_id, reaction`,
      [ratingIds]
    );
    for (const r of reactionResult.rows) {
      const counts = reactionsByResponse.get(r.response_id) || {};
      counts[r.reaction] = Number(r.c);
      reactionsByResponse.set(r.response_id, counts);
    }
  }

  const commentsByResponse = new Map();
  if (commentIds.length > 0) {
    const commentResult = await pool.query(
      `SELECT id, response_id, user_id, pseudonym, body, created_at
       FROM response_comments
       WHERE response_id = ANY($1::int[])
       ORDER BY created_at, id`,
      [commentIds]
    );
    for (const c of commentResult.rows) {
      const list = commentsByResponse.get(c.response_id) || [];
      // Like votes, comments carry a per-comment ownership token rather than the
      // raw user id, so the author can recognize (and delete) their own without
      // exposing who wrote what. The token is namespaced (`comment:<id>`) so it
      // can't collide with a vote's token: comment ids and vote ids are separate
      // sequences that both start at 1, and an un-namespaced token would let a
      // client link a comment author to an equally-numbered anonymous idea. The
      // client mirrors this namespace (see commentOwnerToken in DiscussionPage).
      const comment = { id: c.id, pseudonym: c.pseudonym, body: c.body, created_at: c.created_at };
      if (includeUserIds) {
        comment.userId = c.user_id;
      } else {
        comment.ownerToken = ownerToken(`comment:${c.id}`, c.user_id);
      }
      list.push(comment);
      commentsByResponse.set(c.response_id, list);
    }
  }

  for (const q of questions) {
    if (q.type !== 'Brainstorm') continue;
    const reveal = q.reactionsEnabled && q.reactionsVisible;
    for (const v of q.votes || []) {
      if (reveal) {
        const rating = ratingsByResponse.get(v.id);
        v.qualityUp = rating ? rating.qualityUp : 0;
        v.qualityDown = rating ? rating.qualityDown : 0;
        v.agreementCounts = rating ? rating.agreementCounts : {};
        v.reactionCounts = reactionsByResponse.get(v.id) || {};
      }
      if (q.commentsEnabled) {
        v.comments = commentsByResponse.get(v.id) || [];
      }
    }
  }
}

// Per-response, non-reversible ownership token broadcast in place of raw stable
// user ids (see getQuestions). Definition: sha256(idPart + ':' + userId), hex,
// where idPart is the vote's own row id. No server secret needed — userIds are
// long random strings, and folding in the per-response id means the same
// browser gets a different token for every response (so an anonymous
// participant's multiple ideas in one prompt can't be grouped).
//
// IMPORTANT: must stay byte-for-byte identical to ownerToken() in
// client/src/identity.js. Change one, change both.
function ownerToken(idPart, userId) {
  if (idPart === null || idPart === undefined || !userId) return null;
  return crypto.createHash('sha256').update(`${idPart}:${userId}`).digest('hex');
}

async function addQuestion(topic, question) {
  console.log('Entering addQuestion');
  console.log('Topic:', topic);
  console.log('Question:', question);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const discussion = await getOrCreateDiscussionForSlug(client, topic);
    const discussionId = discussion.id;

    // Ensure options is a valid JSON array
    const optionsJson = JSON.stringify(Array.isArray(question.options) ? question.options : []);

    // Insert the question
    const questionResult = await client.query(
      'INSERT INTO questions (discussion_id, text, type, min_value, max_value, options) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [discussionId, question.text, question.type, question.minValue, question.maxValue, optionsJson]
    );

    await client.query('COMMIT');
    console.log('Question added successfully:', questionResult.rows[0]);
    return {
      ...questionResult.rows[0],
      options: parseOptions(questionResult.rows[0].options)
    };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error in addQuestion:', e);
    throw e;
  } finally {
    client.release();
  }
}

// Add the pseudonym column to votes if it doesn't already exist. Idempotent so
// it's safe to run on every boot. Must complete before the server starts
// serving questions, since getQuestions() selects v.pseudonym.
async function migrateAddPseudonymColumn() {
  await pool.query('ALTER TABLE votes ADD COLUMN IF NOT EXISTS pseudonym TEXT');
  console.log('Pseudonym column migration completed');
}

// Older deployments could create duplicate discussions because several paths
// performed SELECT-then-INSERT without a uniqueness guarantee. Collapse those
// duplicates before adding the unique constraint.
async function migrateUniqueDiscussionTopics() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      WITH duplicate_topics AS (
        SELECT
          topic,
          MIN(id) AS keep_id,
          MIN(admin_token) AS admin_token,
          BOOL_OR(locked) AS locked
        FROM discussions
        GROUP BY topic
        HAVING COUNT(*) > 1
      ),
      merged_discussions AS (
        UPDATE discussions d
        SET
          admin_token = COALESCE(d.admin_token, duplicate_topics.admin_token),
          locked = d.locked OR duplicate_topics.locked
        FROM duplicate_topics
        WHERE d.id = duplicate_topics.keep_id
        RETURNING d.id
      ),
      moved_questions AS (
        UPDATE questions q
        SET discussion_id = duplicate_topics.keep_id
        FROM duplicate_topics
        JOIN discussions d
          ON d.topic = duplicate_topics.topic
         AND d.id <> duplicate_topics.keep_id
        WHERE q.discussion_id = d.id
        RETURNING q.id
      )
      DELETE FROM discussions d
      USING duplicate_topics
      WHERE d.topic = duplicate_topics.topic
        AND d.id <> duplicate_topics.keep_id
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint c
          WHERE c.conrelid = 'discussions'::regclass
            AND c.contype = 'u'
            AND c.conkey = ARRAY(
              SELECT a.attnum
              FROM pg_attribute a
              WHERE a.attrelid = 'discussions'::regclass
                AND a.attname = 'topic'
            )::smallint[]
        ) THEN
          CREATE UNIQUE INDEX IF NOT EXISTS discussions_topic_unique_idx
            ON discussions(topic);
          ALTER TABLE discussions
            ADD CONSTRAINT discussions_topic_unique
            UNIQUE USING INDEX discussions_topic_unique_idx;
        END IF;
      END $$;
    `);
    await client.query('COMMIT');
    console.log('Discussion topic uniqueness migration completed');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error migrating discussion topic uniqueness:', e);
    throw e;
  } finally {
    client.release();
  }
}

async function migrateDiscussionSlugs() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS slug TEXT');

    const result = await client.query('SELECT id, topic, slug FROM discussions ORDER BY id');
    const rows = result.rows
      .map(row => ({
        ...row,
        baseSlug: getMigrationBaseSlug(row),
        priority: isSlugShapedLegacyTitle(row.topic) ? 0 : 1,
      }))
      .sort((a, b) => a.priority - b.priority || a.id - b.id);
    const usedSlugs = new Set();
    const assignments = [];

    for (const row of rows) {
      let slug = row.baseSlug;
      let suffix = 2;
      while (usedSlugs.has(slug)) {
        slug = suffixSlug(row.baseSlug, suffix);
        suffix += 1;
      }

      usedSlugs.add(slug);
      assignments.push({ id: row.id, currentSlug: row.slug, slug });
    }

    const changedAssignments = assignments.filter(row => row.currentSlug !== row.slug);
    const tempPrefix = `__convora_slug_migration_${process.pid}_`;
    for (const row of changedAssignments) {
      await client.query('UPDATE discussions SET slug = $1 WHERE id = $2', [`${tempPrefix}${row.id}`, row.id]);
    }

    for (const row of changedAssignments) {
      await client.query('UPDATE discussions SET slug = $1 WHERE id = $2', [row.slug, row.id]);
    }

    await client.query(`
      UPDATE discussions
      SET slug = id::text
      WHERE slug IS NULL OR slug = ''
    `);
    await client.query('ALTER TABLE discussions ALTER COLUMN slug SET NOT NULL');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS discussions_slug_unique_idx ON discussions(slug)');
    await client.query('COMMIT');
    console.log('Discussion slug migration completed');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error migrating discussion slugs:', e);
    throw e;
  } finally {
    client.release();
  }
}

function isSlugShapedLegacyTitle(topic) {
  const title = formatTopicTitle(topic);
  return title === slugifyTopic(title);
}

function getMigrationBaseSlug(row) {
  if (isSlugShapedLegacyTitle(row.topic)) {
    return slugifyTopic(row.topic);
  }
  return row.slug ? slugifyTopic(row.slug) : slugifyTopic(row.topic);
}

// Table for upvotes on individual open-ended responses. One row per
// (response, user); a response is identified by its votes.id. Idempotent.
async function migrateResponseVotesTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS response_votes (
        id SERIAL PRIMARY KEY,
        response_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        UNIQUE (response_id, user_id)
      )
    `);
    console.log('response_votes table migration completed');
  } catch (e) {
    console.error('Error creating response_votes table:', e);
    throw e;
  }
}

// Interaction features layered on individual Brainstorm ideas: two-axis ratings
// (a quality up/down vote and an agreement selection), curated epistemic
// reactions, and threaded comments. Plus per-question moderator flags: whether
// reactions/comments are available, and — for reactions — whether they're
// currently revealed (so a moderator can collect ideas first, then open
// reactions for an evaluation phase). All idempotent.
async function migrateBrainstormInteractions() {
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS reactions_enabled BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS reactions_visible BOOLEAN NOT NULL DEFAULT TRUE');
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT FALSE');

  // Which epistemic reactions are active for this discussion (a subset of
  // REACTION_CATALOG). NULL means "the creator hasn't customized it" → defaults.
  await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS reaction_keys JSONB');

  // One row per (response, user): that user's quality vote (-1/+1) and/or
  // agreement selection. Either axis may be null when only the other is set.
  // Always aggregated before broadcast, so individual votes stay unattributable.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS response_ratings (
      id SERIAL PRIMARY KEY,
      response_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      quality SMALLINT,
      agreement TEXT,
      UNIQUE (response_id, user_id)
    )
  `);

  // One row per (response, user, reaction); reaction is a curated epistemic tag.
  // Aggregated to counts before broadcast — also unattributable.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS response_reactions (
      id SERIAL PRIMARY KEY,
      response_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      reaction TEXT NOT NULL,
      UNIQUE (response_id, user_id, reaction)
    )
  `);

  // Carry existing reactions across the locally-valid → follows rename, and drop
  // the removed locally-invalid rows, so reactions placed before this change
  // don't strand under keys the catalog no longer renders. Idempotent.
  await pool.query("UPDATE response_reactions SET reaction = 'follows' WHERE reaction = 'locally-valid'");
  await pool.query("DELETE FROM response_reactions WHERE reaction = 'locally-invalid'");

  // Comments on a brainstorm idea. Unlike ratings/reactions these carry their
  // author's pseudonym, since they're conversation rather than an anonymous vote.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS response_comments (
      id SERIAL PRIMARY KEY,
      response_id INTEGER NOT NULL REFERENCES votes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      pseudonym TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )
  `);
  console.log('Brainstorm interactions migration completed');
}

// Moderation columns: a per-discussion admin token, a discussion lock, and a
// per-question pin flag. Plus the pg_trgm extension for near-duplicate
// statement detection. All idempotent.
async function migrateModerationAndDedup() {
  await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS admin_token TEXT');
  await pool.query('ALTER TABLE discussions ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE');

  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } catch (e) {
    console.error('pg_trgm extension migration failed; similarity checks will be skipped:', e.message);
  }
  console.log('Moderation + dedup migration completed');
}

// Per-user moderator grants: when a moderator promotes a participant, that user
// gets their own token here (one row per user per discussion). verifyAdmin
// accepts these tokens alongside the creator's admin_token. Idempotent.
async function migrateModeratorsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discussion_moderators (
      id SERIAL PRIMARY KEY,
      discussion_id INTEGER NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (discussion_id, user_id)
    )
  `);
  console.log('discussion_moderators table migration completed');
}

// Verify that the supplied token grants moderation of this discussion. A token
// is valid if it's the discussion's creator admin_token OR a per-user token
// granted to a promoted moderator (discussion_moderators). Returns the
// discussion id when valid, or null otherwise.
async function verifyAdmin(topic, token) {
  if (!token) return null;
  const slug = slugifyTopic(topic);
  const result = await pool.query(
    `SELECT d.id
       FROM discussions d
      WHERE d.slug = $1
        AND (
          d.admin_token = $2
          OR EXISTS (
            SELECT 1 FROM discussion_moderators m
             WHERE m.discussion_id = d.id AND m.token = $2
          )
        )`,
    [slug, token]
  );
  return result.rows.length > 0 ? result.rows[0].id : null;
}

// Create a discussion (or look up the existing one) and, when it has no
// moderator yet, make the creator its moderator by minting a fresh admin token.
// Returns the discussion id plus an adminToken that is non-null ONLY when this
// caller became the moderator. If a moderator already exists, adminToken is null
// and the existing token is never disclosed — so re-creating an already-moderated
// topic can't hand its controls to whoever re-submits it.
// Shares claimModerator()'s advisory-lock + COALESCE upsert so the create-time
// claim is race-safe against concurrent creates and lazy (question-post) creation.
async function createDiscussion(topic) {
  const displayTopic = formatTopicTitle(topic);
  const baseSlug = slugifyTopic(displayTopic);
  const token = crypto.randomBytes(16).toString('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [displayTopic]);

    const existing = await client.query(
      'SELECT id, topic, slug, admin_token FROM discussions WHERE topic = $1 LIMIT 1',
      [displayTopic]
    );
    if (existing.rows.length > 0) {
      const updated = await client.query(
        `UPDATE discussions
            SET admin_token = COALESCE(admin_token, $2)
          WHERE id = $1
          RETURNING id, topic, slug, admin_token`,
        [existing.rows[0].id, token]
      );
      await client.query('COMMIT');
      const row = updated.rows[0];
      return {
        id: row.id,
        topic: row.topic,
        slug: row.slug,
        adminToken: row.admin_token === token ? token : null,
      };
    }

    let row = null;
    for (let suffix = 1; suffix <= 1000; suffix += 1) {
      const slug = suffixSlug(baseSlug, suffix);
      const result = await client.query(
        `INSERT INTO discussions (topic, slug, admin_token)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id, topic, slug, admin_token`,
        [displayTopic, slug, token]
      );

      if (result.rows.length > 0) {
        row = result.rows[0];
        break;
      }
    }

    if (!row) {
      throw new Error(`Could not create a unique slug for discussion topic: ${displayTopic}`);
    }

    await client.query('COMMIT');
    // The stored token equals ours exactly when we just minted it (fresh row, or
    // an existing row that had no moderator); otherwise a moderator already held it.
    return {
      id: row.id,
      topic: row.topic,
      slug: row.slug,
      adminToken: row.admin_token === token ? token : null,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// First-come moderator claim: assigns a fresh admin token only if the
// discussion has none yet. Returns the token, or null if already claimed.
// The advisory lock serializes moderator claims for the same topic; the upsert
// also keeps the claim race-safe against non-moderator topic creation paths.
async function claimModerator(topic) {
  const slug = slugifyTopic(topic);
  const token = crypto.randomBytes(16).toString('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [slug]);

    const claim = await client.query(
      `INSERT INTO discussions (topic, slug, admin_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE
       SET admin_token = COALESCE(discussions.admin_token, EXCLUDED.admin_token)
       WHERE discussions.admin_token IS NULL
       RETURNING admin_token`,
      [titleFromSlug(slug), slug, token]
    );

    await client.query('COMMIT');
    return claim.rows.length > 0 ? claim.rows[0].admin_token : null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// An opaque, stable handle for a participant: a hash of their user_id, so it
// stays bound to the same user no matter how the list reorders or who drops
// out. This lets the moderator UI refer to users without ever receiving the
// raw user_id (which doubles as the vote-ownership secret), and means a stale
// UI promotes the user it displayed — never whoever now sits at that position.
function participantHandle(userId) {
  return `participant-${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 16)}`;
}

// The discussion's participants: everyone who has cast a vote or written a
// response (the only users the server can identify, since there are no
// accounts and presence is anonymous). Ordered by first activity for a stable
// display order. Returns rows of { id, userId, pseudonym, isModerator }.
async function getParticipants(topic) {
  const slug = slugifyTopic(topic);
  const result = await pool.query(
    `SELECT v.user_id,
            MIN(v.created_at) AS first_seen,
            (ARRAY_AGG(v.pseudonym ORDER BY v.id DESC))[1] AS pseudonym,
            BOOL_OR(m.user_id IS NOT NULL) AS is_moderator
       FROM votes v
       JOIN questions q ON v.question_id = q.id
       JOIN discussions d ON q.discussion_id = d.id
       LEFT JOIN discussion_moderators m
              ON m.discussion_id = d.id AND m.user_id = v.user_id
      WHERE d.slug = $1 AND v.user_id IS NOT NULL
      GROUP BY v.user_id
      ORDER BY MIN(v.created_at), v.user_id`,
    [slug]
  );
  return result.rows.map((row) => ({
    id: participantHandle(row.user_id),
    userId: row.user_id,
    pseudonym: row.pseudonym || 'Anonymous',
    isModerator: row.is_moderator === true,
  }));
}

// The moderator-facing view of getParticipants: opaque handle, display name,
// and whether they already moderate — never the raw user_id.
async function listParticipants(topic) {
  const participants = await getParticipants(topic);
  return participants.map(({ id, pseudonym, isModerator }) => ({ id, pseudonym, isModerator }));
}

// Resolve an opaque participant handle back to its user_id. Because the handle
// is a hash of the user_id (not a position), this matches the exact user the
// moderator selected even if the list has since reordered; it returns null when
// that user is no longer a participant (e.g. they removed their only response).
async function resolveParticipant(topic, participantId) {
  const participants = await getParticipants(topic);
  return participants.find(p => p.id === participantId) || null;
}

// Promote a user to moderator by minting them a personal token (idempotent: a
// user already promoted keeps their existing token). Returns the token plus
// whether this call newly created the grant (vs. the user already being a
// moderator), so the caller can roll back a brand-new grant that couldn't be
// delivered.
async function promoteModerator(discussionId, userId) {
  const token = crypto.randomBytes(16).toString('hex');
  const result = await pool.query(
    `INSERT INTO discussion_moderators (discussion_id, user_id, token)
     VALUES ($1, $2, $3)
     ON CONFLICT (discussion_id, user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING token, (xmax = 0) AS inserted`,
    [discussionId, userId, token]
  );
  return { token: result.rows[0].token, inserted: result.rows[0].inserted === true };
}

// Remove a user's moderator grant for a discussion.
async function revokeModerator(discussionId, userId) {
  await pool.query(
    'DELETE FROM discussion_moderators WHERE discussion_id = $1 AND user_id = $2',
    [discussionId, userId]
  );
}

// Push a freshly granted moderator token to every connected socket belonging to
// the given user in the discussion's room, so promotion takes effect live.
// Returns how many sockets received it — 0 means the user isn't currently
// connected/identified, so the grant can't reach them.
function deliverModeratorToken(topic, userId, token) {
  const room = io.sockets.adapter.rooms.get(topic);
  if (!room) return 0;
  let delivered = 0;
  for (const socketId of room) {
    const target = io.sockets.sockets.get(socketId);
    if (target && target.data.userId === userId) {
      target.emit('moderatorGranted', { token });
      delivered++;
    }
  }
  return delivered;
}

// Whether voting is currently closed for a discussion.
async function isDiscussionLocked(topic) {
  const slug = slugifyTopic(topic);
  const result = await pool.query('SELECT locked FROM discussions WHERE slug = $1', [slug]);
  return result.rows.length > 0 ? result.rows[0].locked === true : false;
}

// Confirm a question belongs to the given topic and report whether that
// discussion is locked. Returns null when the question does not belong to the
// topic, so callers can reject mismatched/forged questionIds. The join on
// topic means a question id from a different discussion never matches.
async function getQuestionForTopic(topic, questionId) {
  const slug = slugifyTopic(topic);
  const result = await pool.query(
    `SELECT q.id, d.locked
     FROM questions q
     JOIN discussions d ON q.discussion_id = d.id
     WHERE d.slug = $1 AND q.id = $2`,
    [slug, questionId]
  );
  if (result.rows.length === 0) return null;
  return { id: result.rows[0].id, locked: result.rows[0].locked === true };
}

// Return the text of the most similar existing statement in the discussion if
// it crosses the trigram-similarity threshold, otherwise null.
const SIMILARITY_THRESHOLD = 0.5;
async function findSimilarQuestion(topic, text) {
  if (!text) return null;
  const slug = slugifyTopic(topic);
  try {
    const result = await pool.query(
      `SELECT q.text, similarity(q.text, $2) AS sim
       FROM questions q
       JOIN discussions d ON q.discussion_id = d.id
       WHERE d.slug = $1 AND similarity(q.text, $2) > $3
       ORDER BY sim DESC
       LIMIT 1`,
      [slug, text, SIMILARITY_THRESHOLD]
    );
    return result.rows.length > 0 ? result.rows[0].text : null;
  } catch (e) {
    // If pg_trgm isn't available, skip dedup rather than blocking submission.
    console.error('Similarity check failed (skipping dedup):', e.message);
    return null;
  }
}

// Clients pick their own display name (a pseudonym, "Anonymous", or a typed-in
// name), so clamp it defensively: a name is at most 40 chars and we never store
// an empty string (let it fall back to the display layer's 'Anonymous').
const MAX_PSEUDONYM_LENGTH = 40;
function sanitizePseudonym(pseudonym) {
  if (typeof pseudonym !== 'string') return null;
  const trimmed = pseudonym.trim().slice(0, MAX_PSEUDONYM_LENGTH);
  return trimmed || null;
}

async function addVote(questionId, vote, userId, pseudonym) {
  pseudonym = sanitizePseudonym(pseudonym);
  console.log('Adding vote:', questionId, vote, userId, pseudonym);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Brainstorm questions allow each user to add many separate ideas, so every
    // submission is a brand new row rather than an update to a single answer.
    const typeResult = await client.query(
      'SELECT type FROM questions WHERE id = $1',
      [questionId]
    );
    const questionType = typeResult.rows[0] && typeResult.rows[0].type;

    if (questionType === 'Brainstorm') {
      await client.query(
        'INSERT INTO votes (question_id, user_id, value, pseudonym) VALUES ($1, $2, $3, $4)',
        [questionId, userId, vote, pseudonym]
      );
      await client.query('COMMIT');
      console.log('Brainstorm idea added successfully');
      return;
    }

    // Check if the user has already voted on this question
    const existingVoteResult = await client.query(
      'SELECT * FROM votes WHERE question_id = $1 AND user_id = $2',
      [questionId, userId]
    );

    if (existingVoteResult.rows.length > 0) {
      console.log('User has already voted');
      const existingVote = existingVoteResult.rows[0];
      // Arrays (e.g. multi-value responses) are stored as JSON strings
      if (Array.isArray(vote)) {
        await client.query(
          'UPDATE votes SET value = $1, pseudonym = $2 WHERE id = $3',
          [JSON.stringify(vote), pseudonym, existingVote.id]
        );
      } else if (existingVote.value === vote && questionType === 'Agreement') {
        // Agreement votes toggle: re-selecting your current option undoes it.
        // This must stay scoped to Agreement — for Open Ended, re-submitting the
        // same text means "keep it", not "delete it".
        console.log('Voting for a option they already voted for');
        await client.query(
          'DELETE FROM votes WHERE id = $1',
          [existingVote.id]
        );
      } else {
        console.log('Voting for a different option');
        await client.query(
          'UPDATE votes SET value = $1, pseudonym = $2 WHERE id = $3',
          [vote, pseudonym, existingVote.id]
        );
      }
    } else {
      console.log('User has not voted yet');
      await client.query(
        'INSERT INTO votes (question_id, user_id, value, pseudonym) VALUES ($1, $2, $3, $4)',
        [questionId, userId, Array.isArray(vote) ? JSON.stringify(vote) : vote, pseudonym]
      );
    }

    await client.query('COMMIT');
    console.log('Vote added/updated successfully');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error in addVote:', e);
    throw e;
  } finally {
    client.release();
  }
}

// Toggle a user's upvote on an open-ended response. Adds the upvote if absent,
// removes it if already present.
async function toggleResponseVote(topic, responseId, userId) {
  // Confirm the response belongs to the room's discussion before mutating it.
  // Without the topic join a client in one room could toggle a vote on a
  // response id that lives in another discussion. Also fetch the owner so we
  // can reject self-upvotes below.
  const slug = slugifyTopic(topic);
  const ownerResult = await pool.query(
    `SELECT v.user_id
     FROM votes v
     JOIN questions q ON v.question_id = q.id
     JOIN discussions d ON q.discussion_id = d.id
     WHERE v.id = $1 AND d.slug = $2`,
    [responseId, slug]
  );
  if (ownerResult.rows.length === 0) {
    return;
  }
  // Reject self-upvotes: the UI disables the button for your own response, but
  // the event can still be emitted from the console, so enforce it server-side.
  if (ownerResult.rows[0].user_id === userId) {
    console.log('Ignoring self-upvote on response', responseId);
    return;
  }
  const deleteResult = await pool.query(
    'DELETE FROM response_votes WHERE response_id = $1 AND user_id = $2',
    [responseId, userId]
  );
  if (deleteResult.rowCount === 0) {
    await pool.query(
      'INSERT INTO response_votes (response_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [responseId, userId]
    );
  }
}

// Look up a brainstorm response within a topic and return its owner plus the
// parent question's interaction flags. Returns null when the response doesn't
// belong to the topic, so callers reject forged/cross-topic response ids.
async function getResponseContext(topic, responseId) {
  const slug = slugifyTopic(topic);
  const result = await pool.query(
    `SELECT v.user_id, q.type, q.reactions_enabled, q.reactions_visible, q.comments_enabled, d.locked, d.reaction_keys
     FROM votes v
     JOIN questions q ON v.question_id = q.id
     JOIN discussions d ON q.discussion_id = d.id
     WHERE v.id = $1 AND d.slug = $2`,
    [responseId, slug]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    ownerId: row.user_id,
    type: row.type,
    reactionsEnabled: row.reactions_enabled === true,
    reactionsVisible: row.reactions_visible === true,
    commentsEnabled: row.comments_enabled === true,
    locked: row.locked === true,
    reactionKeys: resolveReactionKeys(row.reaction_keys),
  };
}

// Set or clear one axis of a user's rating on a brainstorm response. Upserts so
// the two axes (quality, agreement) can be set independently; passing null
// clears that axis (e.g. un-clicking the up arrow).
async function setResponseRating(responseId, userId, axis, value) {
  if (axis === 'quality') {
    const quality = value === 1 || value === -1 ? value : null;
    await pool.query(
      `INSERT INTO response_ratings (response_id, user_id, quality) VALUES ($1, $2, $3)
       ON CONFLICT (response_id, user_id) DO UPDATE SET quality = EXCLUDED.quality`,
      [responseId, userId, quality]
    );
  } else if (axis === 'agreement') {
    const agreement = AGREEMENT_OPTIONS.includes(value) ? value : null;
    await pool.query(
      `INSERT INTO response_ratings (response_id, user_id, agreement) VALUES ($1, $2, $3)
       ON CONFLICT (response_id, user_id) DO UPDATE SET agreement = EXCLUDED.agreement`,
      [responseId, userId, agreement]
    );
  }
}

// Toggle a single epistemic reaction for a user on a response: remove it if
// present, add it otherwise.
async function toggleResponseReaction(responseId, userId, reaction) {
  const deleteResult = await pool.query(
    'DELETE FROM response_reactions WHERE response_id = $1 AND user_id = $2 AND reaction = $3',
    [responseId, userId, reaction]
  );
  if (deleteResult.rowCount === 0) {
    await pool.query(
      'INSERT INTO response_reactions (response_id, user_id, reaction) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [responseId, userId, reaction]
    );
  }
}

// A user's own ratings and reactions across a whole discussion, so the client
// can restore which buttons it had selected after a reload. This is the only
// path that returns per-user selections, and it's scoped to the requesting
// user's own rows — never another participant's.
async function getMyBrainstormState(topic, userId) {
  const ratings = {};
  const reactions = {};
  if (!userId) return { ratings, reactions };
  const slug = slugifyTopic(topic);

  const ratingResult = await pool.query(
    `SELECT rr.response_id, rr.quality, rr.agreement
     FROM response_ratings rr
     JOIN votes v ON rr.response_id = v.id
     JOIN questions q ON v.question_id = q.id
     JOIN discussions d ON q.discussion_id = d.id
     WHERE d.slug = $1 AND rr.user_id = $2`,
    [slug, userId]
  );
  for (const row of ratingResult.rows) {
    ratings[row.response_id] = { quality: row.quality, agreement: row.agreement };
  }

  const reactionResult = await pool.query(
    `SELECT react.response_id, react.reaction
     FROM response_reactions react
     JOIN votes v ON react.response_id = v.id
     JOIN questions q ON v.question_id = q.id
     JOIN discussions d ON q.discussion_id = d.id
     WHERE d.slug = $1 AND react.user_id = $2`,
    [slug, userId]
  );
  for (const row of reactionResult.rows) {
    (reactions[row.response_id] = reactions[row.response_id] || []).push(row.reaction);
  }

  return { ratings, reactions };
}

// Removes a single vote (used for Brainstorm ideas). The user_id check ensures a
// participant can only delete their own ideas.
async function deleteVote(voteId, userId) {
  console.log('Deleting vote:', voteId, userId);
  await pool.query(
    'DELETE FROM votes WHERE id = $1 AND user_id = $2',
    [voteId, userId]
  );
  console.log('Vote deleted successfully');
}

app.get('/api/discussions', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, topic, slug, created_at FROM discussions ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

async function getDiscussionSummary(topic, options = {}) {
  const discussion = await getDiscussionBySlug(topic);
  if (!discussion) {
    return null;
  }

  // Internal use: keep the raw stable user_id on each vote so buildSummary can
  // count distinct participants (anonymous/duplicate display names must not
  // collapse). buildFacilitatorDashboard re-keys to participant-N before any
  // of this reaches a client, so the raw ids never leave the server.
  const questions = await getQuestions(topic, { includeUserIds: true });
  const writtenResponses = questions
    .filter(question => question.type === 'Open Ended' || question.type === 'Brainstorm')
    .flatMap(question => (question.votes || [])
      .map(vote => ({
        questionId: question.id,
        questionText: question.text,
        questionType: question.type,
        pseudonym: vote.pseudonym || 'Anonymous',
        value: String(parseStoredVoteValue(vote.value) || '').trim(),
      }))
      .filter(response => response.value !== ''));

  let synthesis = buildDeterministicSynthesis(writtenResponses);
  if (options.llm) {
    if (
      writtenResponses.length > 0 &&
      (process.env.ENABLE_LLM_SYNTHESIS !== 'true' || !process.env.OPENAI_API_KEY)
    ) {
      synthesis = {
        ...synthesis,
        llmError: 'LLM synthesis is not configured, so the deterministic summary is shown.',
      };
    } else {
      try {
        const llmSynthesis = await buildLlmSynthesis(writtenResponses);
        if (llmSynthesis) {
          synthesis = llmSynthesis;
        }
      } catch (error) {
        console.error('Error generating LLM synthesis:', error);
        synthesis = {
          ...synthesis,
          llmError: 'LLM synthesis was unavailable, so the deterministic summary is shown.',
        };
      }
    }
  }

  return buildSummary(discussion, questions, synthesis);
}

app.get('/api/discussions/:topic/summary', async (req, res) => {
  try {
    const summary = await getDiscussionSummary(req.params.topic, {
      llm: req.query.synthesis === 'llm',
    });

    if (!summary) {
      return res.status(404).json({ error: 'Discussion not found' });
    }

    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Read-only opinion clustering ("opinion groups"). Computes participant groups
// from existing Agreement votes on the fly; writes nothing. Kept separate from
// the summary so the experimental clusters view can be removed cleanly.
app.get('/api/discussions/:topic/clusters', async (req, res) => {
  try {
    const discussion = await getDiscussionByTopic(req.params.topic);
    if (!discussion) {
      return res.status(404).json({ error: 'Discussion not found' });
    }

    // Opt into raw user ids: clustering groups participants by stable id, and
    // this runs server-side only — the response carries aggregate cluster data
    // (sizes, per-statement means), never individual ids.
    const questions = await getQuestions(req.params.topic, { includeUserIds: true });
    const analysis = analyzeClusters(questions);

    res.json({
      discussion: {
        id: discussion.id,
        topic: discussion.topic,
        createdAt: discussion.created_at,
      },
      ...analysis,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/discussions/:topic/export.json', async (req, res) => {
  try {
    const summary = await getDiscussionSummary(req.params.topic);

    if (!summary) {
      return res.status(404).json({ error: 'Discussion not found' });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(req.params.topic)}-summary.json"`);
    res.send(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/discussions/:topic/report.html', async (req, res) => {
  try {
    const summary = await getDiscussionSummary(req.params.topic);

    if (!summary) {
      return res.status(404).json({ error: 'Discussion not found' });
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(req.params.topic)}-final-report.html"`);
    res.send(renderReportHtml(summary));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/discussions/:topic/export.csv', async (req, res) => {
  try {
    const discussion = await getDiscussionBySlug(req.params.topic);
    if (!discussion) {
      return res.status(404).json({ error: 'Discussion not found' });
    }

    const questions = await getQuestions(req.params.topic);
    const headers = [
      'discussion_topic',
      'question_id',
      'question_text',
      'question_type',
      'question_created_at',
      'response_id',
      'respondent',
      'response_value',
      'response_created_at',
    ];
    const rows = questions.flatMap(question => {
      const votes = question.votes || [];
      if (votes.length === 0) {
        return [[
          discussion.topic,
          question.id,
          question.text,
          question.type,
          question.created_at,
          '',
          '',
          '',
          '',
        ]];
      }

      return votes.map(vote => [
        discussion.topic,
        question.id,
        question.text,
        question.type,
        question.created_at,
        vote.id,
        vote.pseudonym || 'Anonymous',
        parseStoredVoteValue(vote.value),
        vote.created_at,
      ]);
    });

    const csv = [
      headers.map(escapeCsv).join(','),
      ...rows.map(row => row.map(escapeCsv).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizeFilename(req.params.topic)}-responses.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/duplicate-discussion', async (req, res) => {
  const { originalTopic, newTopic } = req.body;
  console.log(`Attempting to duplicate discussion. Original: ${originalTopic}, New: ${newTopic}`);

  if (!originalTopic || !newTopic) {
    console.log('Missing required fields');
    return res.status(400).json({ error: 'Original topic and new topic are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Get the original discussion
    const originalDiscussionResult = await client.query(
      'SELECT id FROM discussions WHERE slug = $1',
      [slugifyTopic(originalTopic)]
    );

    if (originalDiscussionResult.rows.length === 0) {
      throw new Error('Original discussion not found');
    }

    const originalDiscussionId = originalDiscussionResult.rows[0].id;

    // Create new discussion. Duplicating into an existing topic would merge
    // questions into that discussion, so treat the unique conflict as a user
    // error instead.
    // Mint an admin token so the person duplicating lands as its moderator
    // (same creator-is-moderator rule as POST /api/discussions). Slug
    // collisions get a suffix, but exact topic duplicates are rejected.
    const displayNewTopic = formatTopicTitle(newTopic);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [displayNewTopic]);
    const existingNewTopic = await client.query(
      'SELECT id FROM discussions WHERE topic = $1 LIMIT 1',
      [displayNewTopic]
    );
    if (existingNewTopic.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Discussion topic already exists' });
    }

    const newAdminToken = crypto.randomBytes(16).toString('hex');
    const baseNewSlug = slugifyTopic(displayNewTopic);
    let newDiscussion = null;
    for (let suffix = 1; suffix <= 1000; suffix += 1) {
      const newSlug = suffixSlug(baseNewSlug, suffix);
      const newDiscussionResult = await client.query(
        `INSERT INTO discussions (topic, slug, admin_token)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO NOTHING
         RETURNING id, topic, slug`,
        [displayNewTopic, newSlug, newAdminToken]
      );

      if (newDiscussionResult.rows.length > 0) {
        newDiscussion = newDiscussionResult.rows[0];
        break;
      }
    }

    if (!newDiscussion) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Could not create a unique discussion slug' });
    }

    const newDiscussionId = newDiscussion.id;

    // Copy questions from original to new discussion. Carry the brainstorm
    // interaction flags too, so duplicating a discussion preserves whether
    // reactions/comments were enabled (and reactions revealed) rather than
    // silently resetting them to the migration defaults.
    await client.query(`
      INSERT INTO questions (discussion_id, text, type, min_value, max_value, options, reactions_enabled, reactions_visible, comments_enabled)
      SELECT $1, text, type, min_value, max_value, options, reactions_enabled, reactions_visible, comments_enabled
      FROM questions
      WHERE discussion_id = $2
    `, [newDiscussionId, originalDiscussionId]);

    // Carry the session-level reaction set (see reaction_keys) for the same
    // reason as the per-question flags above: a duplicate should preserve the
    // creator's chosen reactions, not silently reset to the defaults.
    await client.query(
      'UPDATE discussions SET reaction_keys = (SELECT reaction_keys FROM discussions WHERE id = $2) WHERE id = $1',
      [newDiscussionId, originalDiscussionId]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      newTopic: newDiscussion.topic,
      newSlug: newDiscussion.slug,
      adminToken: newAdminToken,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error duplicating discussion:', error);
    res.status(500).json({ error: 'Failed to duplicate discussion' });
  } finally {
    client.release();
  }
});

// Catch-all route
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Ensure the database schema exists before serving requests. schema.sql is
// idempotent (CREATE TABLE IF NOT EXISTS), so this is a no-op on a database
// that's already populated (e.g. restored from latest.dump) and creates the
// tables on a fresh, empty database.
async function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

const PORT = process.env.PORT || 3001;

// Create the schema on a fresh deploy, then run required migrations before
// accepting connections so that no client can query a column or table that
// doesn't exist yet (e.g. votes.pseudonym, or the response_votes table that
// getQuestions selects from on the first join). Order matters: create tables
// first, then run all migrations against the existing/just-created schema, then
// start listening.
initSchema()
  .then(() => migrateModerationAndDedup())
  .then(() => migrateUniqueDiscussionTopics())
  .then(() => migrateDiscussionSlugs())
  .then(() => Promise.all([migrateAddPseudonymColumn(), migrateResponseVotesTable(), migrateModeratorsTable()]))
  .then(() => migrateBrainstormInteractions())
  .then(() => {
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database, exiting:', err);
    process.exit(1);
  });
