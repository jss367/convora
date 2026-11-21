import React from 'react';
import { promptParts } from './promptEmphasis.mjs';

export function formatPrompt(text) {
    return promptParts(text).map((part, index) => {
        if (part.type === 'strong') return <strong key={index} className="font-black">{part.text}</strong>;
        if (part.type === 'em') return <em key={index}>{part.text}</em>;
        return part.text;
    });
}
