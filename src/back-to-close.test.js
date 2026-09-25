// Back closes the open panel instead of leaving the page. See back-to-close.js.
//
// Driven against a simulated browser history whose back() is asynchronous, as
// the real one is — the handover case below only fails when it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPanelHistory } from "./back-to-close.js";

function fakeBrowser() {
  const entries = [{ url: "/portal/bookings", state: null }];
  let index = 0;
  const queue = [];
  let ph;
  const history = {
    get state() { return entries[index].state; },
    pushState(state, _t, url) {
      entries.splice(index + 1);
      entries.push({ url: url ?? entries[index].url, state });
      index += 1;
    },
    back() { queue.push(-1); },
  };
  return {
    history,
    attach(p) { ph = p; },
    // Delivers queued traversals, the way the browser does after the task ends.
    settle() {
      while (queue.length) {
        const d = queue.shift();
        if (index + d < 0) continue;
        index += d;
        ph.onPop(entries[index].state);
      }
    },
    userBack() { index -= 1; ph.onPop(entries[index].state); this.settle(); },
    goSection(url) { history.pushState({}, "", url); },
    get depth() { return index; },
    get url() { return entries[index].url; },
  };
}

function setup() {
  const b = fakeBrowser();
  const ph = createPanelHistory(b.history);
  b.attach(ph);
  const panel = (name, log, mayClose) => {
    let release = null;
    return {
      open() { release = ph.open(() => { log.push(`closed ${name}`); release = null; }, mayClose); },
      closeFromUi() { const r = release; release = null; r(); },
      get isOpen() { return !!release; },
    };
  };
  return { b, panel };
}

test("Back closes the open panel and stays on the page", () => {
  const { b, panel } = setup();
  const log = [];
  const drawer = panel("drawer", log);
  drawer.open();
  assert.equal(b.depth, 1);
  b.userBack();
  assert.deepEqual(log, ["closed drawer"]);
  assert.equal(b.url, "/portal/bookings");
  assert.equal(b.depth, 0);
});

test("closing from the UI removes the entry, so the next Back is not a dead press", () => {
  const { b, panel } = setup();
  const drawer = panel("drawer", []);
  drawer.open();
  drawer.closeFromUi();
  b.settle();
  assert.equal(b.depth, 0, "the panel's entry is gone");
});

test("stacked panels close newest first", () => {
  const { b, panel } = setup();
  const log = [];
  const editor = panel("editor", log), dialog = panel("dialog", log);
  editor.open(); dialog.open();
  b.userBack();
  assert.deepEqual(log, ["closed dialog"]);
  assert.ok(editor.isOpen);
  b.userBack();
  assert.deepEqual(log, ["closed dialog", "closed editor"]);
  assert.equal(b.depth, 0);
});

test("one panel handing over to another in the same render keeps exactly one entry", () => {
  // The type picker closes and the editor opens together. With an async back()
  // the editor's entry must not be pushed until the picker's pop has landed.
  const { b, panel } = setup();
  const log = [];
  const picker = panel("picker", log), editor = panel("editor", log);
  picker.open();
  picker.closeFromUi();
  editor.open();
  b.settle();
  assert.equal(b.depth, 1, "one entry, the editor's");
  b.userBack();
  assert.deepEqual(log, ["closed editor"]);
  assert.equal(b.depth, 0);
});

test("a parent and its dialog closing together leave no entries behind", () => {
  const { b, panel } = setup();
  const editor = panel("editor", []), dialog = panel("dialog", []);
  editor.open(); dialog.open();
  editor.closeFromUi();   // not the current entry — left to be stepped over
  dialog.closeFromUi();
  b.settle();
  assert.equal(b.depth, 0);
});

test("a panel lost to a section switch is stepped over on the way back", () => {
  const { b, panel } = setup();
  const drawer = panel("drawer", []);
  drawer.open();
  b.goSection("/portal/departures");
  drawer.closeFromUi();   // unmounted by the switch
  b.settle();
  assert.equal(b.url, "/portal/departures", "the switch is not undone");
  b.userBack();
  assert.equal(b.url, "/portal/bookings");
  assert.equal(b.depth, 0, "one Back, past the dead entry, to the section itself");
});

test("an editor with unsaved changes can refuse Back — and stays reachable by Back", () => {
  const { b, panel } = setup();
  const log = [];
  let answer = false;
  const editor = panel("editor", log, () => answer);
  editor.open();
  b.userBack();                       // "Discard?" -> Cancel
  assert.deepEqual(log, [], "the editor stays open");
  assert.equal(b.depth, 1, "its entry is back, so Back asks again next time");
  answer = true;
  b.userBack();                       // "Discard?" -> OK
  assert.deepEqual(log, ["closed editor"]);
  assert.equal(b.depth, 0);
});

test("a refused Back leaves a dialog on top of the editor alone", () => {
  const { b, panel } = setup();
  const log = [];
  const editor = panel("editor", log, () => false), dialog = panel("dialog", log);
  editor.open(); dialog.open();
  b.userBack();
  assert.deepEqual(log, ["closed dialog"], "the dialog has no unsaved work; it just closes");
  b.userBack();
  assert.deepEqual(log, ["closed dialog"], "the editor refuses");
  assert.equal(b.depth, 1);
});

test("a button that edits marks the editor unsaved; close, save and step buttons do not", async () => {
  const { clickEdits } = await import("./back-to-close.js");
  const button = (keepsClean) => {
    const b = { hasAttribute: (a) => keepsClean && a === "data-keeps-clean" };
    b.closest = (sel) => (sel === "button" ? b : null);
    return b;
  };
  const iconInside = (btn) => ({ closest: (sel) => (sel === "button" ? btn : null) });
  assert.equal(clickEdits(button(false)), true, "Add day, remove photo, …");
  assert.equal(clickEdits(iconInside(button(false))), true, "a click on the icon inside the button");
  assert.equal(clickEdits(button(true)), false, "Cancel / Save / Next");
  assert.equal(clickEdits({ closest: () => null }), false, "not a button at all");
  assert.equal(clickEdits(null), false);
});

test("every way out of an editor is marked, and the sidebar's exits ask", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const admin = readFileSync(join(here, "AdminDashboard.jsx"), "utf8");
  const from = admin.indexOf("function DestinationEditor");
  const to = admin.indexOf("function PriceTierEditor");
  const editors = admin.slice(from, to);
  for (const line of editors.split("\n")) {
    if (/<button[^>]*onClick=\{(onClose|save|\(\) => save\(|\(\) => setStep\()/.test(line)) {
      assert.match(line, /data-keeps-clean/, `unmarked, so it would count as an edit: ${line.trim().slice(0, 90)}`);
    }
  }
  const sidebar = readFileSync(join(here, "DashSidebar.jsx"), "utf8");
  assert.match(sidebar, /if \(confirmDiscardAll\(\)\) navigate\("\/"\)/);
  assert.match(sidebar, /if \(confirmDiscardAll\(\)\) signOut\(\)/);
});
