let sequence = 0;

// Request IDs deduplicate delivery; they are not credentials. getRandomValues
// also works where the secure-context-only randomUUID API is unavailable.
export function createRequestId(cryptoApi = globalThis.crypto) {
    if (typeof cryptoApi?.getRandomValues === 'function') {
        const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    }
    sequence += 1;
    return `${Date.now().toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}
