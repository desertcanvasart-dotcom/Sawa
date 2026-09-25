// The browser's Back button closes the open panel, editor or drawer.
//
// Panels inside a dashboard section (the product editor, a booking's drawer, a
// "Decline" dialog) are React state, not URLs, so Back skipped straight past
// them to the previous section. Encoding each panel in the URL is not possible
// (most hold a whole object), so each open panel instead pushes one history
// entry at the SAME address:
//
//   - Back pops that entry and the panel closes; the page underneath stays.
//   - Closing it in the UI (✕, Save, Cancel) takes its entry back off, so the
//     next Back is never a press that appears to do nothing.
//   - A panel that vanishes because the user switched section leaves its entry
//     behind the new one; landing on it later steps over it.
//
// Panels stack — the product editor can open a dialog of its own — and Back
// closes them newest first.
//
// history.back() is asynchronous, so a panel closing and another opening in
// the same render (a type picker handing over to the editor) would push the
// new entry before the old one is gone, and the pop would then land on the
// wrong side of it. Pushes wait until our own pops have landed.
import { useEffect, useRef, useState } from "react";

const KEY = "sawaPanel";

export function createPanelHistory(history) {
  let nextToken = 0;
  const stack = [];          // open panels, oldest first: { token, close, pushed }
  let ownPops = 0;           // history.back() calls we made that have not landed
  const tokenOf = (state) => (state && typeof state[KEY] === "number" ? state[KEY] : 0);
  const isLive = (t) => stack.some((p) => p.token === t);

  function push(entry) {
    entry.pushed = true;
    history.pushState({ ...(history.state || {}), [KEY]: entry.token }, "");
  }

  function popOurs() {
    ownPops += 1;
    history.back();
  }

  return {
    // `mayClose`, if given, is asked before Back closes the panel. Answering no
    // keeps it open: the entry Back just took away is put back, so the next
    // Back asks again rather than skipping past the panel.
    open(close, mayClose) {
      const entry = { token: ++nextToken, close, mayClose, pushed: false };
      stack.push(entry);
      if (ownPops === 0) push(entry);
      return function release() {
        const i = stack.indexOf(entry);
        if (i === -1) return;            // already closed by Back
        stack.splice(i, 1);
        // Take the entry off only while it is the one the user is on. After a
        // section switch a newer entry sits on top; this one is stepped over
        // when it is reached.
        if (entry.pushed && tokenOf(history.state) === entry.token) popOurs();
      };
    },

    onPop(state) {
      const landed = tokenOf(state);
      if (ownPops > 0) {
        ownPops -= 1;
        // Landed on an entry whose panel has already gone — keep going.
        if (landed > 0 && !isLive(landed)) { popOurs(); return; }
        // Our pops are done: push panels that opened while they were in flight.
        if (ownPops === 0) for (const p of stack) if (!p.pushed) push(p);
        return;
      }
      // The user pressed Back (or Forward): close everything opened after the
      // entry they landed on, newest first.
      while (stack.length && stack[stack.length - 1].token > landed) {
        const top = stack[stack.length - 1];
        if (top.mayClose && !top.mayClose()) {
          push(top);
          return;
        }
        stack.pop();
        top.close();
      }
      if (landed > 0 && !isLive(landed)) popOurs();
    },
  };
}

let shared = null;
function panelHistory() {
  if (shared || typeof window === "undefined") return shared;
  shared = createPanelHistory(window.history);
  window.addEventListener("popstate", (e) => shared.onPop(e.state));
  return shared;
}

export function useBackToClose(isOpen, close, mayClose) {
  const closeRef = useRef(close);
  closeRef.current = close;
  const mayCloseRef = useRef(mayClose);
  mayCloseRef.current = mayClose;
  useEffect(() => {
    if (!isOpen) return undefined;
    return panelHistory()?.open(
      () => closeRef.current?.(),
      () => (mayCloseRef.current ? mayCloseRef.current() : true),
    );
  }, [isOpen]);
}

// An editor that asks before throwing away what was typed into it.
//
// Back, ✕, Cancel and "Back to …" all close an editor, and a refresh or a
// closed tab loses it too; none of them used to ask. Any typing inside the
// editor (`dirtyProps` on its wrapper catches input and change events as they
// bubble, including the rich-text editor's), or any button that edits (see
// clickEdits), marks it unsaved, and from then on every one of those exits
// asks first. Saving closes through `close` directly,
// so a successful save is never questioned.
export const DISCARD_MESSAGE = "You have unsaved changes. Discard them?";

// A button inside an editor changes its content — Add day, remove a photo,
// move it, add a tier — unless it is marked `data-keeps-clean`: the buttons
// that only close, save or step between the editor's pages. Counting every
// other button errs toward asking once too often rather than losing work.
export function clickEdits(target) {
  const button = target && typeof target.closest === "function" ? target.closest("button") : null;
  return !!button && !button.hasAttribute("data-keeps-clean");
}

// Editors open right now with unsaved changes, so that leaving the section
// from the sidebar (portal-section.js) can ask too.
const unsaved = new Set();
export function confirmDiscardAll(message = DISCARD_MESSAGE) {
  for (const isDirty of unsaved) if (isDirty()) return window.confirm(message);
  return true;
}

export function useUnsavedGuard(isOpen, close, message = DISCARD_MESSAGE) {
  const dirtyRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const markDirty = () => {
    if (dirtyRef.current) return;
    dirtyRef.current = true;
    setDirty(true);
  };
  // Each opening starts clean.
  useEffect(() => {
    if (!isOpen) return;
    dirtyRef.current = false;
    setDirty(false);
  }, [isOpen]);

  const mayClose = () => !dirtyRef.current || window.confirm(message);
  useBackToClose(isOpen, close, mayClose);

  useEffect(() => {
    if (!isOpen) return undefined;
    const isDirty = () => dirtyRef.current;
    unsaved.add(isDirty);
    return () => unsaved.delete(isDirty);
  }, [isOpen]);

  // Refresh or closing the tab: the browser shows its own "Leave site?" prompt.
  useEffect(() => {
    if (!isOpen || !dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isOpen, dirty]);

  return {
    // For ✕, Cancel and "Back to …".
    requestClose: () => { if (mayClose()) close(); },
    // Spread onto the element wrapping the editor. display:contents keeps the
    // wrapper out of the layout.
    dirtyProps: {
      onInput: markDirty,
      onChange: markDirty,
      onClickCapture: (e) => { if (clickEdits(e.target)) markDirty(); },
      style: { display: "contents" },
    },
  };
}
