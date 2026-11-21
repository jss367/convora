const emphasis = /(^|[^\p{L}\p{M}\p{N}_*\\])(\*{1,2})([^\s*](?:[^*\r\n]*?[^\s*])?)\2(?![\p{L}\p{M}\p{N}_*])/gu;

export function promptParts(text) {
    const parts = [];
    let offset = 0;
    for (const match of text.matchAll(emphasis)) {
        const [, prefix, marker, content] = match;
        const start = match.index + prefix.length;
        if (start > offset) parts.push({ type: 'text', text: text.slice(offset, start) });
        parts.push({ type: marker === '**' ? 'strong' : 'em', text: content });
        offset = match.index + match[0].length;
    }
    if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) });
    return parts;
}

export function plainPrompt(text) {
    return promptParts(text).map(part => part.text).join('');
}
