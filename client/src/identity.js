// Persistent anonymous identity for Convora participants.
//
// A participant gets a stable userId (used for vote ownership) and a friendly
// adjective-animal pseudonym (e.g. "Happy Badger") so people can refer to each
// other in open-ended discussion. Both are stored together in localStorage so a
// page refresh keeps the same identity and the same votes.

const STORAGE_KEY = 'convora_identity';

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

function readStored() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.userId === 'string' && typeof parsed.pseudonym === 'string') {
            return parsed;
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

// Returns the stored identity, creating and persisting one on first use.
export function getIdentity() {
    const existing = readStored();
    if (existing) return existing;
    const identity = { userId: generateUserId(), pseudonym: generatePseudonym() };
    writeStored(identity);
    return identity;
}

// Keeps the same userId (so votes stay attributed) but assigns a new pseudonym.
export function regeneratePseudonym() {
    const current = getIdentity();
    const updated = { ...current, pseudonym: generatePseudonym() };
    writeStored(updated);
    return updated;
}
