export function slugifyTopic(value) {
    if (typeof value === 'string' && value.length === 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*(?:-|--\d+)$/.test(value)) return value;
    return String(value || 'discussion')
        .trim()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-/, '')
        .slice(0, 80)
        .replace(/-$/, '') || 'discussion';
}
