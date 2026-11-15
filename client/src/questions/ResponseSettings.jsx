import React from 'react';
import PropTypes from 'prop-types';

export default function ResponseSettings({ maxResponses, showAttribution, onChange }) {
    return <div className="mb-4 space-y-3">
        <label className="block">Maximum responses per person (blank for unlimited)
            <input type="number" min="1" max="2147483647" step="1" value={maxResponses ?? ''}
                onChange={e => onChange('maxResponses', e.target.value)} className="block p-2 border rounded" />
        </label>
        <label className="flex gap-2 items-center">
            <input type="checkbox" checked={showAttribution !== false} onChange={e => onChange('showAttribution', e.target.checked)} />
            Show author pseudonyms
        </label>
    </div>;
}
ResponseSettings.propTypes = { maxResponses: PropTypes.oneOfType([PropTypes.string, PropTypes.number]), showAttribution: PropTypes.bool, onChange: PropTypes.func.isRequired };
