// Teaching on every open tab at once, in a full tab. Each open tab on the site
// is a row with the title wanted for it. Filling in any row teaches the rule;
// the others show what the rule would make of them, here and on the tabs
// themselves, so one look shows where it's right and where it isn't.
//
// Uses the same teaching state as the side panel (teach, with teach.board
// set) and the same result card, moved into this view's side column.

let boardRun = 0;
let boardTabsTimer;
const boardRefs = new Map(); // row → its elements

// A row is an example once it has a title typed or confirmed, or an icon.
// Rows from earlier whose tab is closed stay examples.
const isBoardExample = (row) => row.closed || !!row.want.trim() || !!row.look;

async function openBoard(host, ruleId, draft = []) {
  const rule = ruleId && rules.find((r) => r.id === ruleId);
  host = host || rule?.host;
  if (!host) return toast("Choose a site for this rule first.");
  const key = ruleId && `examples:${ruleId}`;
  const stored = key ? (await chrome.storage.local.get(key))[key] ?? [] : [];
  teach = {
    ruleId, saved: [], current: null, fit: null, history: [], asks: [], path: rule?.path ?? null, paths: [],
    board: { host, rows: [] },
  };
  $("#board-heading").textContent = rule ? `Teach “${rule.name || "Untitled rule"}”` : "Build a rule";
  $("#board-host").textContent = host.replace(/^\*\./, "");
  $("#teach-save").textContent = rule ? "Update rule" : "Create rule";
  $("#board-side").prepend($("#teach-result"));
  setView("board");
  await loadBoard(draft.length ? draft : stored);
}

// Reads every open tab on the site. Examples from before (the panel's, or
// the rule's saved ones) go back on their tabs; those whose tab is closed
// are listed too.
async function loadBoard(previous) {
  const board = teach?.board;
  if (!board) return;
  const origin = TR.originFor(board.host);
  const allowed = await chrome.permissions.contains({ origins: [origin] });
  $("#board-access").hidden = allowed;
  if (!allowed) {
    board.rows = [];
    renderBoard();
    return;
  }
  const tabs = (await chrome.tabs.query({ url: origin }))
    .filter((t) => { try { return TR.hostMatches(board.host, new URL(t.url).hostname); } catch { return false; } });
  const hints = [...new Set(previous.map((e) => e.hint).filter(Boolean))];
  const rows = [];
  for (const tab of tabs) {
    const prior = previous.find((e) => e.url === tab.url);
    const page = await askTab(tab.id, { type: "harvest", want: prior?.want ?? "", extra: hints });
    if (!teach?.board) return;
    if (!page) continue;
    rows.push({
      tabId: tab.id, ...page,
      want: prior?.want ?? "", look: prior?.look ?? null, hint: prior?.hint ?? null,
      picked: mergePicked(prior?.picked, page.picked), guess: null,
    });
  }
  for (const e of previous) {
    if (!rows.some((r) => r.url === e.url)) rows.push({ ...e, tabId: null, closed: true, guess: null });
  }
  board.rows = rows;
  buildBoardRows();
  boardChanged();
  refreshShots();
}

// Examples changed: teach from them again.
function boardChanged() {
  if (!teach?.board) return;
  teach.saved = teach.board.rows.filter(isBoardExample);
  refit();
}

// Whether a row's page is one of the pages the rule is for.
function boardInScope(row) {
  const rule = teach.ruleId && rules.find((r) => r.id === teach.ruleId);
  const path = teach.fit ? teach.path ?? teach.fit.path : rule?.path ?? "";
  try { return TR.pathMatches(path, new URL(row.url).pathname); } catch { return false; }
}

// Page patterns for the rule on this view: the ones from the examples, plus
// one for the open tabs shaped like them ("/units/sothe" with "/units/kael"
// open gives "/units/*"). Until one is chosen, the narrowest covering the
// most open tabs, leaving "every page" for when nothing narrower covers more.
function boardScopes(paths) {
  const open = teach.board.rows.filter((r) => !r.closed);
  const segs = (url) => { try { return TR.pathSegments(new URL(url).pathname); } catch { return []; } };
  const covers = (p) => open.filter((r) => { try { return TR.pathMatches(p, new URL(r.url).pathname); } catch { return false; } }).length;
  const shapes = teach.saved.filter((e) => e.want?.trim()).map((e) => segs(e.url));
  if (shapes.length && shapes.every((x) => x.length === shapes[0].length)) {
    const alike = [...shapes, ...open.map((r) => segs(r.url)).filter((x) => x.length === shapes[0].length)];
    const merged = shapes[0].map((part, i) => (alike.every((x) => x[i].toLowerCase() === part.toLowerCase()) ? part : "*"));
    const own = merged.length ? `/${merged.join("/")}` : "";
    if (own && !paths.includes(own)) {
      paths = [...paths.filter((p) => p !== ""), own]
        .sort((a, b) => TR.pathSpecificity(b) - TR.pathSpecificity(a) || covers(a) - covers(b))
        .concat(paths.includes("") ? [""] : []);
    }
  }
  if (!paths.length) return { paths, path: null };
  const narrower = paths.filter((p) => p !== "");
  if (!narrower.length) return { paths, path: paths[0] };
  const most = Math.max(...narrower.map(covers));
  return { paths, path: narrower.find((p) => covers(p) === most) };
}

// What the rule would give each row that isn't an example: from the
// examples, or before there are any, from the rule being taught again.
async function fillBoard() {
  const run = ++boardRun;
  const board = teach?.board;
  if (!board) return;
  const fit = teach.fit;
  const examples = teachExamples();
  const rule = teach.ruleId && rules.find((r) => r.id === teach.ruleId);
  for (const row of board.rows) {
    let guess = null;
    if (!row.closed && !isBoardExample(row) && boardInScope(row)) {
      if (examples.length && fit?.count) guess = await guessFromFit(row.tabId, row, fit, teach.lookFit, 40);
      else if (!examples.length && rule) guess = await guessFromRule(rule, row.tabId);
      if (run !== boardRun || teach?.board !== board) return;
    }
    row.guess = guess;
    renderBoardRow(row);
    previewBoardRow(row);
  }
}

// The tab shows what its row says: the example, else the guess.
function previewBoardRow(row) {
  if (row.closed) return;
  if (isBoardExample(row)) previewExample(row);
  else if (row.guess) previewExample({ tabId: row.tabId, want: row.guess.title, look: row.guess.look });
  else endPreview(row.tabId);
}

// ---------- Rows ----------

function buildBoardRows() {
  boardRefs.clear();
  const rows = teach.board.rows;
  $("#board-rows").replaceChildren(...rows.map(boardRow));
  renderBoard();
}

function renderBoard() {
  const board = teach?.board;
  if (!board) return;
  const open = board.rows.filter((r) => !r.closed).length;
  $("#board-count").textContent = board.rows.length
    ? `${open} open tab${open === 1 ? "" : "s"}${open < board.rows.length ? `, ${board.rows.length - open} closed` : ""}`
    : "";
  $("#board-empty").hidden = board.rows.length > 0 || !$("#board-access").hidden;
  $("#board-start").hidden = !!teach.fit;
  for (const row of board.rows) renderBoardRow(row);
}

function boardRow(row) {
  const root = $("#board-row-tpl").content.cloneNode(true).firstElementChild;
  const refs = {
    root,
    icon: $(".board-icon", root),
    input: $("input", root),
    status: $(".board-status", root),
    editor: $(".board-icon-editor", root),
    iconBtn: $("[data-action=icon]", root),
    clear: $("[data-action=clear]", root),
    thumb: $(".board-thumb", root),
    img: $(".board-thumb img", root),
    marks: $(".board-thumb .board-marks", root),
  };
  boardRefs.set(row, refs);
  $(".board-title", root).textContent = row.title || hostPath(row.url);
  $(".board-path", root).textContent = (() => { try { const u = new URL(row.url); return u.pathname + u.search; } catch { return row.url; } })();
  refs.input.value = row.want;
  refs.input.disabled = !!row.closed;

  let timer;
  refs.input.addEventListener("input", () => {
    row.want = refs.input.value;
    refs.input.classList.remove("guess");
    previewBoardRow(row);
    clearTimeout(timer);
    timer = setTimeout(() => harvestRow(row), 250);
  });
  refs.iconBtn.addEventListener("click", () => {
    refs.editor.hidden = !refs.editor.hidden;
    refs.iconBtn.setAttribute("aria-expanded", !refs.editor.hidden);
    if (!refs.editor.hidden) renderRowIcon(row);
  });
  refs.clear.addEventListener("click", () => {
    if (row.closed) {
      teach.board.rows = teach.board.rows.filter((r) => r !== row);
      root.remove();
      boardRefs.delete(row);
    } else {
      Object.assign(row, { want: "", look: null, hint: null });
      refs.input.value = "";
      refs.editor.hidden = true;
    }
    boardChanged();
  });
  refs.thumb.addEventListener("click", async () => {
    if (row.closed) return;
    const tab = await chrome.tabs.get(row.tabId).catch(() => null);
    if (!tab) return;
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  });
  refs.thumb.addEventListener("mouseenter", () => showZoom(row));
  refs.thumb.addEventListener("mouseleave", hideZoom);
  refs.thumb.addEventListener("focus", () => showZoom(row));
  refs.thumb.addEventListener("blur", hideZoom);
  if (row.shot) refs.img.src = row.shot.data;
  return root;
}

function renderBoardRow(row) {
  const refs = boardRefs.get(row);
  if (!refs) return;
  const example = isBoardExample(row);
  const inScope = boardInScope(row);
  refs.root.classList.toggle("example", example);
  refs.root.classList.toggle("closed", !!row.closed);
  refs.root.classList.toggle("out", !example && !inScope && !!teach.fit);

  // A guess fills the box until something is typed over it.
  if (document.activeElement !== refs.input) {
    const showGuess = !row.want && row.guess;
    refs.input.value = row.want || row.guess?.title || "";
    refs.input.classList.toggle("guess", !!showGuess);
  }
  refs.input.placeholder = row.closed ? "" : "Type the title you want";
  refs.thumb.title = row.closed ? "This tab is closed" : "Go to this tab";
  refs.clear.hidden = !example;
  refs.clear.title = row.closed ? "Remove this example" : "Clear this example";
  refs.clear.setAttribute("aria-label", refs.clear.title);

  const look = example ? row.look : row.guess?.look;
  paintIcon(refs.icon, row.url, look ? TR.resolveBadge(look, {}) : null);
  refs.status.replaceChildren(...boardStatus(row, example, inScope));
}

// The line under a row's title: how the rule does on it.
function boardStatus(row, example, inScope) {
  const text = (t, cls) => Object.assign(document.createElement("span"), { textContent: t, className: cls || "" });
  if (row.closed) return [text("Example from a tab that's closed now")];
  if (example) {
    const withTitle = teachExamples().filter((e) => e.want?.trim());
    const res = teach.fit?.results[withTitle.indexOf(row)];
    if (!row.want.trim()) return [text("Icon only. Type a title too, or the rule keeps this page's own.")];
    if (!res) return [text("Example")];
    return res.ok ? [text("✓ Example. The rule gives this.", "ok")] : [text(`The rule gives “${res.got}”`, "bad")];
  }
  if (!inScope && teach.fit) return [text(`Not one of the rule's pages (${teach.path || "every page"}). Type a title to include it.`)];
  if (!row.guess) return teach.fit?.count ? [text("The rule doesn't apply here. Type the title you want to teach it.")] : [];
  if (row.guess.choices.length > 1) {
    const out = [text("Which is right?", "ask")];
    for (const title of row.guess.choices) out.push(button(title, () => adoptGuess(row, title), "choice sm"));
    return out;
  }
  return [text("The rule's guess."), button("Looks right", () => adoptGuess(row, row.guess.title), "sm")];
}

// Takes the guess (or one of its choices) as this row's example.
function adoptGuess(row, title) {
  row.want = title;
  if (!row.look && row.guess?.look) row.look = row.guess.look;
  const refs = boardRefs.get(row);
  refs.input.value = title;
  refs.input.classList.remove("guess");
  harvestRow(row);
}

// Reads the row's page again for elements matching what's typed, then refits.
async function harvestRow(row) {
  if (row.closed) return boardChanged();
  const hints = [...new Set(teach.board.rows.map((r) => r.hint).filter(Boolean))];
  const page = await askTab(row.tabId, { type: "harvest", want: row.want, extra: hints });
  if (!teach?.board?.rows.includes(row)) return;
  if (page) {
    row.elements = page.elements;
    row.styled = page.styled ?? [];
    row.picked = mergePicked(row.picked, page.picked);
  }
  boardChanged();
}

// ---------- Pictures of the tabs ----------

// Each tab draws a small picture of what's on its screen (see snapshot() in
// content.js). Asked for when the view opens, when a tab finishes loading,
// and when you come back to this view from another tab.
let shotRun = 0;
async function refreshShots(rows = teach?.board?.rows ?? []) {
  const run = ++shotRun;
  for (const row of rows) {
    if (row.closed || !row.tabId) continue;
    const shot = await askTab(row.tabId, { type: "snapshot", width: 480 });
    if (run !== shotRun || !teach?.board?.rows.includes(row)) return;
    if (!shot?.data) continue;
    row.shot = shot;
    const refs = boardRefs.get(row);
    if (refs) refs.img.src = shot.data;
  }
}

let zoomTimer;
function showZoom(row) {
  clearTimeout(zoomTimer);
  if (!row.shot) return;
  zoomTimer = setTimeout(() => {
    const refs = boardRefs.get(row);
    const zoom = $("#board-zoom");
    if (!refs || !zoom) return;
    $("img", zoom).src = row.shot.data;
    $(".board-marks", zoom).replaceChildren(...[...refs.marks.children].map((m) => m.cloneNode(true)));
    zoom.hidden = false;
    // Beside the picture, or below it when there's no room.
    const r = refs.thumb.getBoundingClientRect();
    const w = zoom.offsetWidth;
    const h = zoom.offsetHeight;
    const right = r.right + 12 + w <= innerWidth - 8;
    const left = right ? r.right + 12 : Math.max(8, Math.min(r.left, innerWidth - w - 8));
    const top = right ? Math.max(8, Math.min(r.top - 20, innerHeight - h - 8)) : Math.min(r.bottom + 8, innerHeight - h - 8);
    Object.assign(zoom.style, { left: `${left}px`, top: `${top}px` });
  }, 200);
}

function hideZoom() {
  clearTimeout(zoomTimer);
  const zoom = $("#board-zoom");
  if (zoom) zoom.hidden = true;
}

// While a value is hovered in the rule card: where it is on every tab's
// picture, or an arrow when it's further down the page.
let markRun = 0;
async function markBoard(source, color) {
  const run = ++markRun;
  document.body.style.setProperty("--mark", color || "var(--accent)");
  for (const row of teach?.board?.rows ?? []) {
    const refs = boardRefs.get(row);
    if (!refs || row.closed || !row.shot) continue;
    const at = await askTab(row.tabId, { type: "locate", source });
    if (run !== markRun) return;
    const marks = [];
    if (at?.below || at?.above) {
      marks.push(Object.assign(document.createElement("b"), { className: at.below ? "below" : "above", textContent: at.below ? "↓" : "↑" }));
    } else if (at) {
      const box = document.createElement("i");
      Object.assign(box.style, { left: `${at.left * 100}%`, top: `${at.top * 100}%`, width: `${at.width * 100}%`, height: `${at.height * 100}%` });
      marks.push(box);
    }
    refs.marks.replaceChildren(...marks);
  }
}

function unmarkBoard() {
  markRun++;
  for (const refs of boardRefs.values()) refs.marks.replaceChildren();
}

// ---------- A row's icon ----------

function renderRowIcon(row) {
  const refs = boardRefs.get(row);
  const box = refs.editor;
  const changed = () => {
    if (!row.want && row.guess) {
      row.want = row.guess.title;
      refs.input.value = row.want;
      refs.input.classList.remove("guess");
    }
    renderBoardRow(row);
    previewBoardRow(row);
    clearTimeout(row.iconTimer);
    row.iconTimer = setTimeout(boardChanged, 200);
  };
  const parts = [];
  if (!row.look) {
    parts.push(button("Add an icon", () => {
      row.look = TR.newLook({ ...(row.guess?.look ?? { style: "dot" }) });
      renderRowIcon(row);
      changed();
    }, "ghost sm"));
  } else {
    parts.push(badgeEditor(row.look, changed));
    parts.push(button("No icon", () => {
      row.look = null;
      row.hint = null;
      renderRowIcon(row);
      changed();
    }, "ghost sm"));
  }
  // Colors on the page, and picking a label for the icon to follow.
  const chips = document.createElement("div");
  chips.className = "suggest-chips";
  const styled = row.styled ?? [];
  const list = [...(row.picked ?? []).filter((p) => p.color && !styled.some((s) => s.selector === p.selector)), ...styled].slice(0, 6);
  for (const s of list) {
    const b = colorChip(() => {
      useColor(row, s.color);
      row.hint = s.selector;
      renderRowIcon(row);
      changed();
    });
    b.innerHTML = '<span class="suggest-dot"></span><span class="suggest-text"></span>';
    $(".suggest-dot", b).style.background = s.color;
    $(".suggest-text", b).textContent = s.text;
    b.classList.toggle("on", row.hint === s.selector);
    chips.append(b);
  }
  if (!row.closed) {
    const pick = colorChip(() => pickForRow(row, changed), "pick");
    pick.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5l9.5 4-4 1.5-1.5 4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="suggest-text">Pick on page</span>';
    pick.title = "Click a label on the page, like a status, for the icon to follow";
    pick.dataset.pickKey = `board:${row.tabId}`;
    chips.append(pick);
  }
  const label = Object.assign(document.createElement("span"), { className: "suggest-label", textContent: list.length ? "Colors on this page" : "Have the icon follow a label on the page" });
  const suggest = document.createElement("div");
  suggest.className = "suggest";
  suggest.append(label, chips);
  box.replaceChildren(...parts, suggest);
}

function colorChip(onClick, kind = "") {
  const b = Object.assign(document.createElement("button"), { type: "button", className: `suggest-chip ${kind}`.trim() });
  b.addEventListener("click", onClick);
  return b;
}

async function pickForRow(row, changed) {
  try {
    const tab = await chrome.tabs.get(row.tabId);
    await pickOnTab(tab, `board:${row.tabId}`, "color", async (msg) => {
      if (!teach?.board?.rows.includes(row)) return;
      row.hint = msg.selector;
      row.picked = mergePicked(row.picked, [{ selector: msg.selector, selectors: [msg.selector], text: (msg.text || "").slice(0, 200), color: msg.color }]);
      if (msg.color) useColor(row, msg.color);
      else if (!row.look) row.look = TR.newLook({ style: "dot" });
      renderRowIcon(row);
      await fillPicked();
      changed();
    });
  } catch {
    setPicking(null);
    toast("Couldn't open the picker on that tab. Try reloading it.");
  }
}

// ---------- Keeping up with the site's tabs ----------

// Tabs opened, closed or moved to another page while the view is open.
function watchBoardTabs() {
  if (!chrome.tabs?.onUpdated) return;
  const soon = () => {
    if (!teach?.board) return;
    clearTimeout(boardTabsTimer);
    boardTabsTimer = setTimeout(syncBoardTabs, 600);
  };
  chrome.tabs.onCreated.addListener(soon);
  chrome.tabs.onRemoved.addListener(soon);
  chrome.tabs.onUpdated.addListener((_id, info) => (info.status === "complete" || info.url) && soon());
}

async function syncBoardTabs() {
  const board = teach?.board;
  if (!board || !$("#board-access").hidden) return;
  const tabs = (await chrome.tabs.query({ url: TR.originFor(board.host) }))
    .filter((t) => { try { return TR.hostMatches(board.host, new URL(t.url).hostname); } catch { return false; } });
  let changedRows = false;
  // Rows whose tab closed or went elsewhere: examples stay, as closed.
  for (const row of [...board.rows]) {
    if (row.closed) continue;
    if (tabs.some((t) => t.id === row.tabId && t.url === row.url)) continue;
    changedRows = true;
    if (isBoardExample(row)) Object.assign(row, { closed: true, tabId: null, guess: null });
    else board.rows = board.rows.filter((r) => r !== row);
  }
  const hints = [...new Set(board.rows.map((r) => r.hint).filter(Boolean))];
  for (const tab of tabs) {
    if (board.rows.some((r) => !r.closed && r.tabId === tab.id)) continue;
    const page = await askTab(tab.id, { type: "harvest", want: "", extra: hints });
    if (teach?.board !== board) return;
    if (!page) continue;
    // A closed example back on a tab again.
    const closed = board.rows.find((r) => r.closed && r.url === page.url);
    if (closed) Object.assign(closed, { tabId: tab.id, closed: false, styled: page.styled, meta: page.meta, labels: page.labels });
    else board.rows.push({ tabId: tab.id, ...page, want: "", look: null, hint: null, picked: page.picked ?? [], guess: null });
    changedRows = true;
  }
  if (!changedRows) return refreshShots();
  buildBoardRows();
  boardChanged();
  refreshShots();
}

function wireBoard() {
  $("#board-back").addEventListener("click", closeTeach);
  $("#board-allow").addEventListener("click", async () => {
    const board = teach?.board;
    if (!board || !(await requestAccess(board.host))) return;
    loadBoard(teach.saved);
  });
  watchBoardTabs();
  // Back from another tab: what's on the tabs may have changed.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && teach?.board) refreshShots();
  });
}

// From the side panel's teaching view: carry on in a full tab, with the
// examples given so far.
async function openBoardTab() {
  const rule = teach?.ruleId && rules.find((r) => r.id === teach.ruleId);
  const host = rule?.host || teach?.fit?.host || live?.host;
  if (!host) return toast("Switch to a tab on the site first.");
  const examples = teachExamples().map(({ tabId, url, title, elements, styled, picked, meta, labels, want, look, hint }) =>
    ({ tabId, url, title, elements, styled, picked, meta, labels, want, look, hint }));
  await chrome.storage.session.set({ "board:draft": { host, ruleId: teach?.ruleId ?? null, examples } });
  closeTeach();
  const tab = live?.tab;
  await chrome.tabs.create({ url: chrome.runtime.getURL("options.html?board"), ...(tab ? { windowId: tab.windowId, index: tab.index + 1 } : {}) });
  // The view has everything the panel did, so the panel gets out of the way.
  try {
    if (chrome.sidePanel?.close && tab) await chrome.sidePanel.close({ windowId: tab.windowId });
    else window.close();
  } catch {
    window.close();
  }
}

// A full tab opened for teaching on all tabs picks up where the panel was.
async function openBoardFromDraft() {
  if (!new URLSearchParams(location.search).has("board")) return;
  const { "board:draft": draft } = await chrome.storage.session.get("board:draft");
  if (!draft) return;
  await chrome.storage.session.remove("board:draft");
  history.replaceState(null, "", location.pathname);
  openBoard(draft.host, draft.ruleId, draft.examples ?? []);
}
