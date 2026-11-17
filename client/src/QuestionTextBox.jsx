import PropTypes from 'prop-types';
import React, { forwardRef, useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// A question box that wraps long text and grows to show all of it. Questions
// are one paragraph, so Enter submits the surrounding form (as a text input
// would) and pasted line breaks become spaces.
const QuestionTextBox = forwardRef(function QuestionTextBox({ value, onChange, onKeyDown, className = '', ...props }, forwardedRef) {
    const innerRef = useRef(null);
    const setRefs = useCallback((node) => {
        innerRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
    }, [forwardedRef]);

    const fitHeight = useCallback(() => {
        const box = innerRef.current;
        if (!box) return;
        box.style.height = 'auto';
        // scrollHeight excludes borders; add them back so no scrollbar appears.
        const borders = box.offsetHeight - box.clientHeight;
        box.style.height = `${box.scrollHeight + borders}px`;
    }, []);

    useLayoutEffect(fitHeight, [value, fitHeight]);

    // The box can change width (window resize, composer expanding from
    // hidden), which changes how many lines the text wraps to.
    useEffect(() => {
        const box = innerRef.current;
        if (!box || typeof ResizeObserver === 'undefined') return undefined;
        let lastWidth = box.clientWidth;
        const observer = new ResizeObserver(() => {
            if (box.clientWidth === lastWidth) return;
            lastWidth = box.clientWidth;
            fitHeight();
        });
        observer.observe(box);
        return () => observer.disconnect();
    }, [fitHeight]);

    return (
        <textarea
            ref={setRefs}
            rows={1}
            value={value}
            onChange={(e) => {
                e.target.value = e.target.value.replace(/\r?\n/g, ' ');
                onChange(e);
            }}
            onKeyDown={(e) => {
                onKeyDown?.(e);
                if (e.defaultPrevented) return;
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                }
            }}
            className={`resize-none overflow-hidden ${className}`}
            {...props}
        />
    );
});

QuestionTextBox.propTypes = {
    value: PropTypes.string.isRequired,
    onChange: PropTypes.func.isRequired,
    onKeyDown: PropTypes.func,
    className: PropTypes.string,
};

export default QuestionTextBox;
