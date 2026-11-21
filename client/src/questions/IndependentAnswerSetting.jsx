import React from 'react';
import PropTypes from 'prop-types';

export default function IndependentAnswerSetting({ checked, onChange }) {
    return <label className="mb-4 flex items-start gap-2">
        <input type="checkbox" checked={checked === true} onChange={event => onChange(event.target.checked)} />
        <span>Collect independent answers
            <span className="block text-sm text-gray-500">Participants see only their own responses until a moderator reveals everyone’s answers.</span>
        </span>
    </label>;
}
IndependentAnswerSetting.propTypes = { checked: PropTypes.bool, onChange: PropTypes.func.isRequired };
