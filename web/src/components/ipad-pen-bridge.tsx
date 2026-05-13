'use client';

/**
 * Global iPad / Apple-Pencil input bridge.
 *
 * Mounted once at app root. Solves two systemic iPad failures that
 * can't be fixed per-component:
 *
 *   1. PEN TAP → CLICK SYNTHESIS
 *      Apple Pencil taps fire `pointerdown` / `pointerup`, but iPad
 *      Safari's algorithm for synthesizing the `click` event from
 *      that pair is finicky: micro-tremor in the Pencil's tip
 *      pushes the down→up distance over the "click vs drag"
 *      threshold, so the click never fires. Most buttons (Radix
 *      triggers especially) only listen for `click`, which means
 *      they silently ignore Pencil taps.
 *
 *      Fix: listen for the down→up pair ourselves in the capture
 *      phase. If the pointerType is 'pen' AND the user's actual
 *      gesture was a tap (short, small distance) AND the browser
 *      didn't synthesize its own click within 60ms after pointerup,
 *      dispatch a native MouseEvent('click', {bubbles:true}) on
 *      the element the user originally pressed down on.
 *
 *      This fixes every button, link, and Radix trigger in the
 *      whole app without per-component changes.
 *
 *   2. BODY-LEVEL `pointer-events: none` UNLOCK
 *      Radix Dialog / Popover / DropdownMenu set
 *      `<body style="pointer-events: none">` while open to block
 *      stray interaction with the page underneath. If a close
 *      sequence is interrupted (navigation, error, hot-reload, …)
 *      that style sticks and the entire app becomes dead-on-click.
 *
 *      Fix: a 1.5s sentinel that clears the inline style whenever
 *      no Radix overlay (`[data-state="open"][role="dialog"]`,
 *      `[data-radix-popper-content-wrapper]`, …) is present.
 *
 * Both behaviors are inert on non-iPad devices: pen events never
 * arrive on a desktop with a mouse, and the unlock only acts when
 * body actually has pointer-events:none stuck.
 */

import { useEffect } from 'react';

type Pending = {
  x: number;
  y: number;
  t: number;
  target: Element;
  pointerId: number;
};

export function IpadPenBridge() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // ----- (1) Pen tap → synthetic click ---------------------------

    let pending: Pending | null = null;
    /** Set by the real click listener on capture so we know whether
     *  the browser already gave us a click. */
    let recentRealClickTarget: Element | null = null;
    let recentRealClickAt = 0;

    const TAP_MAX_DISTANCE = 14; // CSS px — generous for Pencil tremor
    const TAP_MAX_DURATION = 700; // ms

    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'pen') return;
      const target = e.target as Element | null;
      if (!target) return;
      pending = {
        x: e.clientX,
        y: e.clientY,
        t: Date.now(),
        target,
        pointerId: e.pointerId,
      };
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'pen') return;
      const p = pending;
      pending = null;
      if (!p) return;
      if (e.pointerId !== p.pointerId) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      const dist = Math.hypot(dx, dy);
      const dur = Date.now() - p.t;
      if (dist > TAP_MAX_DISTANCE) return;
      if (dur > TAP_MAX_DURATION) return;

      const downTarget = p.target as HTMLElement;
      // Skip surfaces that read raw pointer input directly — canvases
      // (drawing), contenteditable (caret placement), range/color
      // inputs (drag-to-value), and file inputs (the browser already
      // gestures-a-click into them on touch). Also skip text inputs
      // and textareas — they focus on tap natively; firing a synthetic
      // click does nothing useful and may interfere with selection.
      if (
        downTarget.closest(
          'canvas, [contenteditable="true"], [contenteditable=""], [data-pen-bridge="off"], input[type="range"], input[type="color"], input[type="text"], input[type="number"], input[type="email"], input[type="password"], input[type="search"], input[type="url"], input[type="tel"], textarea',
        )
      ) return;

      // Walk up checking for any disabled ancestor. If the user tapped
      // inside a disabled button (or anything with aria-disabled), the
      // tap should be inert — same as a mouse click on the same
      // element. Important because dispatchEvent bypasses the
      // browser's own disabled-button suppression.
      let cur: Element | null = downTarget;
      while (cur && cur !== document.body) {
        if ((cur as HTMLButtonElement).disabled) return;
        if (cur.getAttribute && cur.getAttribute('aria-disabled') === 'true') return;
        cur = cur.parentElement;
      }

      // Wait briefly to see if the browser fires its own click. If
      // it does (the gesture stayed inside Safari's click-vs-drag
      // threshold), our work is done. If not, synthesize one on the
      // original target. Click events bubble, so whichever ancestor
      // has the actual onClick / onPointerUp handler will get it.
      setTimeout(() => {
        if (
          recentRealClickTarget &&
          (recentRealClickTarget === downTarget ||
            downTarget.contains(recentRealClickTarget) ||
            recentRealClickTarget.contains(downTarget)) &&
          Date.now() - recentRealClickAt < 200
        ) {
          return;
        }
        const evt = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: e.clientX,
          clientY: e.clientY,
          button: 0,
        });
        downTarget.dispatchEvent(evt);
      }, 70);
    };

    const onClick = (e: MouseEvent) => {
      recentRealClickTarget = e.target as Element;
      recentRealClickAt = Date.now();
    };

    const onCancel = () => { pending = null; };

    window.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointerup', onUp, { capture: true });
    window.addEventListener('pointercancel', onCancel, { capture: true });
    window.addEventListener('click', onClick, { capture: true });

    // ----- (2) Stuck pointer-events: none unlock -------------------

    const unlockInterval = window.setInterval(() => {
      const body = document.body;
      if (!body) return;
      // Only act if the inline style is what's blocking — leave
      // stylesheet rules alone.
      const inline = body.style.pointerEvents;
      if (inline !== 'none') return;
      // If any Radix overlay is open, leave it alone.
      const overlayOpen = document.querySelector(
        '[data-state="open"][role="dialog"], [data-state="open"][role="menu"], [data-state="open"][role="listbox"], [data-radix-popper-content-wrapper]',
      );
      if (overlayOpen) return;
      body.style.pointerEvents = '';
    }, 1500);

    return () => {
      window.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      window.removeEventListener('pointercancel', onCancel, { capture: true });
      window.removeEventListener('click', onClick, { capture: true });
      window.clearInterval(unlockInterval);
    };
  }, []);

  return null;
}
