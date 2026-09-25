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
import { useEffect, useRef } from "react";

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
    open(close) {
      const entry = { token: ++nextToken, close, pushed: false };
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
        const p = stack.pop();
        p.close();
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

export function useBackToClose(isOpen, close) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!isOpen) return undefined;
    return panelHistory()?.open(() => closeRef.current?.());
  }, [isOpen]);
}
