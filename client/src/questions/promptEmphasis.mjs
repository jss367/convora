const emphasis = /(?<![\p{L}\p{N}_*\\])(\*{1,2})(?![\s*])([^*\r\n]+?)(?<!\s)\1(?![\p{L}\p{N}_*])/gu;

export function promptParts(text) {
    const parts = [];
    let offset = 0;
    for (const match of text.matchAll(emphasis)) {
        if (match.index > offset) parts.push({ type: 'text', text: text.slice(offset, match.index) });
        parts.push({ type: match[1] === '**' ? 'strong' : 'em', text: match[2] });
        offset = match.index + match[0].length;
    }
    if (offset < text.length) parts.push({ type: 'text', text: text.slice(offset) });
    return parts;
}

export function plainPrompt(text) {
    return promptParts(text).map(part => part.text).join('');
}
