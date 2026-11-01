// PostgreSQL errors may include identities, answers, or tokens in message/detail.
// Keep the caller's static context and a diagnostic code, never the raw error.
function logError(context, error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code)
    ? error.code
    : 'UNKNOWN';
  console.error(context, { code });
}

module.exports = { logError };
