import { useEffect } from 'react';

// Color themes a moderator can apply to a discussion. Keys and the palettes
// they map to are defined in client/src/index.css ([data-theme] blocks) and
// validated server-side (ALLOWED_THEMES in discussion-state.js); `swatch` is only the
// picker dot color and mirrors each theme's primary. Keep all three in sync.
export const THEMES = [
    { key: 'indigo', label: 'Indigo', swatch: '#4F46E5' },
    { key: 'orange', label: 'Orange', swatch: '#FF3C00' },
    { key: 'emerald', label: 'Emerald', swatch: '#059669' },
    { key: 'rose', label: 'Rose', swatch: '#E11D48' },
    { key: 'slate', label: 'Slate', swatch: '#475569' },
];
const THEME_KEYS = THEMES.map((t) => t.key);
export const DEFAULT_THEME = 'indigo';

// Resolves the discussion's theme key, falling back to the default for an
// unknown one, and applies it to the page.
export function useDiscussionTheme(themeKey) {
    const theme = THEME_KEYS.includes(themeKey) ? themeKey : DEFAULT_THEME;

    // Mirror the discussion's chosen theme onto <html data-theme="..."> so the
    // CSS-variable palette (index.css) recolors every primary/secondary class,
    // including the app-wide header that lives outside this page. Cleared on
    // unmount so navigating away (e.g. back to the home page) returns to the
    // default look rather than leaving another discussion's colors stuck on.
    useEffect(() => {
        const root = document.documentElement;
        root.setAttribute('data-theme', theme);
        return () => root.removeAttribute('data-theme');
    }, [theme]);

    return theme;
}
