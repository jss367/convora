import { slugifyTopic } from './slugs';

// Discussions are unlisted: the server never enumerates them. "Your
// discussions" on the home page is therefore just what this browser remembers
// creating or opening, kept in localStorage. Storage can be unavailable
// (private mode, blocked site data) or hold anything, so every access is
// guarded and every stored value is validated; the worst case is an empty list.
const STORAGE_KEY = 'convora_discussions';
const ADMIN_TOKEN_PREFIX = 'convora_admin_';
export const MAX_KNOWN_DISCUSSIONS = 50;

const isSlug = value => typeof value === 'string' && value !== '' && slugifyTopic(value) === value;

function readStored() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (!Array.isArray(parsed)) return [];
        const seen = new Set();
        return parsed
            .filter(entry => entry && isSlug(entry.slug) && !seen.has(entry.slug) && seen.add(entry.slug))
            .map(entry => ({
                slug: entry.slug,
                topic: typeof entry.topic === 'string' && entry.topic.trim() !== '' ? entry.topic : null,
                created_at: typeof entry.created_at === 'string' ? entry.created_at : null,
                lastVisited: Number.isFinite(entry.lastVisited) ? entry.lastVisited : 0,
            }));
    } catch {
        return [];
    }
}

function writeStored(entries) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_KNOWN_DISCUSSIONS)));
    } catch (error) {
        console.warn('Failed to remember discussions:', error);
    }
}

// Moderator tokens are stored as convora_admin_<slug>, so a browser that
// created discussions before this list existed still finds them.
function moderatedSlugs() {
    try {
        const slugs = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key && key.startsWith(ADMIN_TOKEN_PREFIX)) {
                const slug = key.slice(ADMIN_TOKEN_PREFIX.length);
                if (isSlug(slug)) slugs.push(slug);
            }
        }
        return slugs;
    } catch {
        return [];
    }
}

// Most recently opened first. Entries known only from a moderator token have
// no title (topic is null) until the server confirms them.
export function getKnownDiscussions() {
    const stored = readStored();
    const known = new Set(stored.map(entry => entry.slug));
    const seeded = moderatedSlugs()
        .filter(slug => !known.has(slug))
        .map(slug => ({ slug, topic: null, created_at: null, lastVisited: 0 }));
    return [...stored, ...seeded]
        .sort((a, b) => b.lastVisited - a.lastVisited)
        .slice(0, MAX_KNOWN_DISCUSSIONS);
}

// Record that this browser created or opened a discussion.
export function rememberDiscussion(discussion) {
    if (!discussion || !isSlug(discussion.slug)) return;
    const entry = {
        slug: discussion.slug,
        topic: typeof discussion.topic === 'string' ? discussion.topic : null,
        created_at: typeof discussion.created_at === 'string' ? discussion.created_at : null,
        lastVisited: Date.now(),
    };
    writeStored([entry, ...readStored().filter(stored => stored.slug !== entry.slug)]);
}

// Apply the server's answer for the slugs we asked about: refresh titles and
// forget discussions that no longer exist. Slugs we did not ask about (for
// example one opened in another tab meanwhile) are left alone. Moderator
// tokens are never removed here.
export function reconcileKnownDiscussions(queriedSlugs, found) {
    const queried = new Set(queriedSlugs);
    const bySlug = new Map(
        found.filter(row => row && isSlug(row.slug)).map(row => [row.slug, row])
    );
    const next = getKnownDiscussions()
        .filter(entry => !queried.has(entry.slug) || bySlug.has(entry.slug))
        .map(entry => {
            const row = bySlug.get(entry.slug);
            if (!row) return entry;
            return {
                ...entry,
                topic: typeof row.topic === 'string' ? row.topic : entry.topic,
                created_at: typeof row.created_at === 'string' ? row.created_at : entry.created_at,
            };
        });
    writeStored(next);
    return next;
}
