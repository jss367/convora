import { useEffect, useRef } from 'react';

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
    'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(', ');

// A delayed similarity response can open a second panel over Share. Only the
// top panel may handle keys or restore focus while another modal remains open.
const activeDialogs = [];

// Keyboard and focus behavior for a modal panel. Attach the returned ref to the
// panel element, which also needs role="dialog", aria-modal="true",
// aria-labelledby pointing at its heading, and tabIndex={-1}.
//
// While `open` is true: focus moves into the panel (to the element marked
// data-autofocus, else the first focusable control, else the panel itself), Tab
// and Shift+Tab cycle within the panel, and Escape calls `onClose`. When the
// panel closes, focus returns to `returnFocusRef` if given (use it when the
// control that opened the dialog may not have been focused, or is gone by the
// time the dialog closes), otherwise to whatever was focused before it opened.
export function useModalDialog(open, onClose, returnFocusRef) {
    const panelRef = useRef(null);
    const onCloseRef = useRef(onClose);

    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useEffect(() => {
        const panel = panelRef.current;
        if (!open || !panel) return undefined;
        const previouslyFocused = document.activeElement;
        const focusable = () => Array.from(panel.querySelectorAll(FOCUSABLE))
            .filter((el) => el.getClientRects().length > 0);

        const focusInitial = () => (panel.querySelector('[data-autofocus]') || focusable()[0] || panel).focus();
        const dialog = { panel, focusInitial };
        activeDialogs.push(dialog);
        focusInitial();

        const onKeyDown = (event) => {
            if (activeDialogs[activeDialogs.length - 1] !== dialog) return;
            if (event.key === 'Escape') {
                // Escape that only dismisses an input method's suggestions is not ours.
                if (event.isComposing) return;
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') return;
            const items = focusable();
            if (items.length === 0) {
                event.preventDefault();
                panel.focus();
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            if (!panel.contains(active)) {
                event.preventDefault();
                first.focus();
            } else if (event.shiftKey && (active === first || active === panel)) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown);

        return () => {
            document.removeEventListener('keydown', onKeyDown);
            const wasTop = activeDialogs[activeDialogs.length - 1] === dialog;
            activeDialogs.splice(activeDialogs.indexOf(dialog), 1);
            if (!wasTop) return;
            const target = (returnFocusRef && returnFocusRef.current) || previouslyFocused;
            const remaining = activeDialogs[activeDialogs.length - 1];
            if (target && target.isConnected && typeof target.focus === 'function'
                && (!remaining || remaining.panel.contains(target))) {
                target.focus();
            } else if (remaining) {
                remaining.focusInitial();
            }
        };
    }, [open, returnFocusRef]);

    return panelRef;
}
