// Shared display-title and canonical-route rules for discussions.
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

// Upper bound on a discussion's display title. The slug (the real routing key)
// is already capped at 80 chars in slugifyTopic; the title can be longer and
// more readable, but we still bound it so a rename can't store an unbounded
// blob. Kept in sync with the maxLength on the client's rename input.
const MAX_TOPIC_LENGTH = 200;

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

module.exports = { slugifyTopic, formatTopicTitle, titleFromSlug, suffixSlug, MAX_TOPIC_LENGTH };
