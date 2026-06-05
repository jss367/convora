// Persistent identity for Convora participants.
//
// A participant gets a stable userId (used for vote ownership) plus a chosen way
// of being shown to others. There are three name modes:
//   - 'pseudonym': a friendly adjective-animal handle (e.g. "Happy Badger") so
//     people can refer to each other consistently in discussion.
//   - 'anonymous': no handle at all; every response just shows as "Anonymous".
//   - 'custom':    a name the participant types in themselves (real or made up).
// The userId, generated pseudonym, chosen mode and custom name are stored
// together in localStorage so a page refresh keeps the same identity, the same
// display name and the same votes.

const STORAGE_KEY = 'convora_identity';
// Pre-pseudonym clients stored just the stable id under this key. We migrate it
// into the new identity object so existing votes stay attributed after upgrade.
const LEGACY_USER_ID_KEY = 'convora_user_id';

export const NameModes = {
    PSEUDONYM: 'pseudonym',
    ANONYMOUS: 'anonymous',
    CUSTOM: 'custom',
};

// What a participant who has opted out of any handle is shown as. The display
// layers already fall back to this for missing names, so we keep it identical.
export const ANONYMOUS_LABEL = 'Anonymous';

// Upper bound on a typed-in name so one participant can't push a wall of text
// into everyone else's view. The server applies the same clamp defensively.
export const MAX_CUSTOM_NAME_LENGTH = 40;

const ADJECTIVES = [
    'Happy', 'Brave', 'Clever', 'Gentle', 'Swift', 'Mighty', 'Curious', 'Calm',
    'Bold', 'Bright', 'Cheerful', 'Daring', 'Eager', 'Fierce', 'Friendly', 'Jolly',
    'Kind', 'Lively', 'Loyal', 'Lucky', 'Merry', 'Nimble', 'Noble', 'Plucky',
    'Proud', 'Quick', 'Quiet', 'Sleepy', 'Sly', 'Snappy', 'Sunny', 'Witty',
    'Zesty', 'Breezy', 'Cozy', 'Dapper', 'Fuzzy', 'Glad', 'Hardy', 'Humble',
    'Jazzy', 'Keen', 'Mellow', 'Peppy', 'Rosy', 'Spry', 'Tidy', 'Wise',
];

const ANIMALS = [
    'Badger', 'Otter', 'Fox', 'Falcon', 'Panda', 'Heron', 'Lynx', 'Moose',
    'Beaver', 'Bison', 'Cobra', 'Crane', 'Dingo', 'Eagle', 'Ferret', 'Gecko',
    'Hawk', 'Ibis', 'Jaguar', 'Koala', 'Lemur', 'Marmot', 'Newt', 'Ocelot',
    'Puffin', 'Quokka', 'Raccoon', 'Salmon', 'Tapir', 'Urchin', 'Viper', 'Walrus',
    'Yak', 'Zebra', 'Wombat', 'Stoat', 'Robin', 'Possum', 'Mink', 'Lark',
    'Kestrel', 'Hare', 'Gull', 'Finch', 'Egret', 'Civet', 'Bat', 'Antelope',
];

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

export function generatePseudonym() {
    return `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
}

function generateUserId() {
    // Longer than the old 9-char id to make collisions across participants
    // vanishingly unlikely now that ids are persisted and reused.
    return (
        Math.random().toString(36).slice(2, 10) +
        Math.random().toString(36).slice(2, 10)
    );
}

// Trims and length-caps a typed name. Returns '' for anything unusable.
export function sanitizeCustomName(name) {
    if (typeof name !== 'string') return '';
    return name.trim().slice(0, MAX_CUSTOM_NAME_LENGTH);
}

// The name everyone else should see for this participant, derived from the mode.
// Custom mode falls back to the pseudonym when the typed name is blank so we
// never broadcast an empty label.
export function getDisplayName(identity) {
    if (!identity) return '';
    if (identity.mode === NameModes.ANONYMOUS) return ANONYMOUS_LABEL;
    if (identity.mode === NameModes.CUSTOM) {
        return sanitizeCustomName(identity.customName) || identity.pseudonym;
    }
    return identity.pseudonym;
}

// Fills in defaults for fields older stored identities may not have, so callers
// can always rely on mode/customName being present.
function withDefaults(identity) {
    const mode = Object.values(NameModes).includes(identity.mode)
        ? identity.mode
        : NameModes.PSEUDONYM;
    return {
        userId: identity.userId,
        pseudonym: identity.pseudonym,
        mode,
        customName: typeof identity.customName === 'string' ? identity.customName : '',
    };
}

function readStored() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.userId === 'string' && typeof parsed.pseudonym === 'string') {
            return withDefaults(parsed);
        }
        return null;
    } catch (e) {
        console.warn('Failed to read stored identity:', e);
        return null;
    }
}

function writeStored(identity) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
    } catch (e) {
        console.warn('Failed to persist identity:', e);
    }
}

function readLegacyUserId() {
    try {
        const id = localStorage.getItem(LEGACY_USER_ID_KEY);
        return typeof id === 'string' && id ? id : null;
    } catch (e) {
        console.warn('Failed to read legacy user id:', e);
        return null;
    }
}

// Returns the stored identity, creating and persisting one on first use.
export function getIdentity() {
    const existing = readStored();
    if (existing) return existing;
    // Reuse the legacy id from pre-pseudonym clients (if any) so a returning
    // participant's existing votes keep matching; otherwise mint a fresh one.
    const userId = readLegacyUserId() || generateUserId();
    const identity = {
        userId,
        pseudonym: generatePseudonym(),
        mode: NameModes.PSEUDONYM,
        customName: '',
    };
    writeStored(identity);
    return identity;
}

// Keeps the same userId (so votes stay attributed) but assigns a new pseudonym.
export function regeneratePseudonym() {
    const updated = { ...getIdentity(), pseudonym: generatePseudonym() };
    writeStored(updated);
    return updated;
}

// Switches which kind of name is shown, persisting the choice.
export function setNameMode(mode) {
    const next = Object.values(NameModes).includes(mode) ? mode : NameModes.PSEUDONYM;
    const updated = { ...getIdentity(), mode: next };
    writeStored(updated);
    return updated;
}

// Stores the participant's typed-in name (used when mode is 'custom'). We only
// length-cap here (no trim) so the value stays usable as a controlled input —
// trimming on every keystroke would swallow the spaces in names like "Jane Doe".
// getDisplayName() trims when it derives the name actually broadcast to others.
export function setCustomName(name) {
    const capped = typeof name === 'string' ? name.slice(0, MAX_CUSTOM_NAME_LENGTH) : '';
    const updated = { ...getIdentity(), customName: capped };
    writeStored(updated);
    return updated;
}
