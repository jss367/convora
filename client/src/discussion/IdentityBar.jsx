import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { NameModes, MAX_CUSTOM_NAME_LENGTH } from '../identity';

// Participant identity and live presence: the name this participant appears
// under, how many people are here, and a picker for how to appear.
export default function IdentityBar({
    identity, displayName, presence, effectivePseudonym, pseudonymReserved, shufflePending,
    onSelectNameMode, onRegeneratePseudonym, onCustomNameChange,
}) {
    const [editingIdentity, setEditingIdentity] = useState(false);
    return (
        <div className="mb-8 text-center text-sm text-gray-600">
            <div>
                You are <span className="font-semibold text-gray-800">{displayName || '…'}</span>
                <button
                    onClick={() => setEditingIdentity(v => !v)}
                    className="ml-2 text-primary hover:underline"
                    title="Choose how you appear to others"
                >
                    (change)
                </button>
                <span className="mx-2 text-gray-300">·</span>
                <span className="inline-flex items-center">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500 mr-1.5" />
                    {presence} {presence === 1 ? 'person' : 'people'} here now
                </span>
            </div>

            {editingIdentity && identity && (
                <div className="mt-3 inline-block max-w-full text-left bg-gray-50 border border-gray-200 rounded-lg p-4 space-y-2">
                    <p className="text-xs text-gray-500 mb-1">How would you like to appear?</p>

                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="radio"
                            name="nameMode"
                            checked={identity.mode === NameModes.PSEUDONYM}
                            onChange={() => onSelectNameMode(NameModes.PSEUDONYM)}
                        />
                        <span>
                            Pseudonym:{' '}
                            <span className="font-semibold text-gray-800">{effectivePseudonym}</span>
                        </span>
                        <button
                            type="button"
                            onClick={onRegeneratePseudonym}
                            disabled={!pseudonymReserved || shufflePending}
                            className="text-primary hover:underline disabled:opacity-50 disabled:no-underline disabled:cursor-default"
                            title="Get a new pseudonym"
                        >
                            (shuffle)
                        </button>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="radio"
                            name="nameMode"
                            checked={identity.mode === NameModes.ANONYMOUS}
                            onChange={() => onSelectNameMode(NameModes.ANONYMOUS)}
                        />
                        <span>Completely anonymous</span>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="radio"
                            name="nameMode"
                            checked={identity.mode === NameModes.CUSTOM}
                            onChange={() => onSelectNameMode(NameModes.CUSTOM)}
                        />
                        <span className="whitespace-nowrap">Enter your own name:</span>
                        <input
                            type="text"
                            value={identity.customName}
                            maxLength={MAX_CUSTOM_NAME_LENGTH}
                            placeholder="Your name"
                            onChange={(e) => onCustomNameChange(e.target.value)}
                            // The name saves as it is typed, so Enter just closes the picker.
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.nativeEvent.isComposing) setEditingIdentity(false);
                            }}
                            className="min-w-0 flex-1 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                    </label>

                    <div className="pt-1">
                        <button
                            type="button"
                            onClick={() => setEditingIdentity(false)}
                            className="text-primary hover:underline"
                        >
                            Done
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

IdentityBar.propTypes = {
    identity: PropTypes.shape({
        mode: PropTypes.string,
        customName: PropTypes.string,
    }),
    displayName: PropTypes.string,
    presence: PropTypes.number.isRequired,
    effectivePseudonym: PropTypes.string,
    pseudonymReserved: PropTypes.bool,
    shufflePending: PropTypes.bool,
    onSelectNameMode: PropTypes.func.isRequired,
    onRegeneratePseudonym: PropTypes.func.isRequired,
    onCustomNameChange: PropTypes.func.isRequired,
};
