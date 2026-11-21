import PropTypes from 'prop-types';
import React, { useCallback, useLayoutEffect, useRef } from 'react';

export default function ResponseTextArea({ value, ...props }) {
    const ref = useRef(null);
    const fit = useCallback(() => {
        const box = ref.current;
        if (!window.matchMedia('(pointer: coarse)').matches) return;

        const scrollTop = box.scrollTop;
        box.style.height = 'auto';
        const minimum = box.offsetHeight;
        const content = box.scrollHeight + minimum - box.clientHeight;
        const visibleHeight = window.visualViewport?.height ?? window.innerHeight;
        box.style.height = `${Math.max(minimum, Math.min(content, visibleHeight * 0.4))}px`;
        box.scrollTop = scrollTop;
    }, []);

    useLayoutEffect(fit, [fit, value]);
    useLayoutEffect(() => {
        const touch = window.matchMedia('(pointer: coarse)');
        const viewport = window.visualViewport ?? window;
        const onPointerChange = () => {
            if (touch.matches) fit();
            else ref.current.style.removeProperty('height');
        };
        touch.addEventListener('change', onPointerChange);
        viewport.addEventListener('resize', fit);
        return () => {
            touch.removeEventListener('change', onPointerChange);
            viewport.removeEventListener('resize', fit);
        };
    }, [fit]);

    return <textarea {...props} ref={ref} rows={3} value={value} />;
}

ResponseTextArea.propTypes = { value: PropTypes.string.isRequired };
