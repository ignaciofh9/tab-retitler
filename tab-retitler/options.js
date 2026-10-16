// Rule editor. Runs in two places:
// - the side panel (toolbar button), next to the page. The real tab is the
//   preview: edits apply to it as you type, and the panel shows how the rule
//   evaluates there. It follows you as you switch tabs.
// - a full tab (extension options), with the rule list beside the editor.
// Every change saves automatically.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const IN_EXTENSION = location.protocol === "chrome-extension:";

const BUILT_IN_HELP = {
  title: "The page's original title",
  url: "The full URL",
  host: "The site's domain",
  path: "The part of the URL after the domain",
};
const REGEX_PLACEHOLDERS = {
  url: "/items/(\\d+)",
  title: "\\[(.+?)\\]",
  element: "#(\\d+)",
  page: "Status: (\\w+)",
};
const CHECK_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let rules = [];
let selectedId = null;
let refs = {};               // elements in the open editor, by data-ref
const rowRefs = new Map();   // value id -> elements in its row
const caseRefs = new Map();  // badge case id -> elements in its row
let picking = null;          // { key, onPicked } while the picker is open in a tab
let IS_PANEL = false;
let live = null;             // what the side panel knows about the current tab, see refreshLive()

const current = () => rules.find((r) => r.id === selectedId);
const getPath = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

init();

async function init() {
  // The side panel has no tab of its own; the options page does.
  IS_PANEL = chrome.tabs ? !(await chrome.tabs.getCurrent()) : new URLSearchParams(location.search).has("panel");
  document.body.classList.toggle("panel", IS_PANEL);
  const stored = await chrome.storage.local.get("rules");
  rules = (stored.rules || []).map(TR.normalizeRule);
  // Rules from before sharing existed just got a share id; keep it.
  if ((stored.rules || []).some((r) => !r.shareId)) persist();
  selectedId = IS_PANEL ? null : rules[0]?.id ?? null;
  setView("list");

  $("#add-rule").addEventListener("click", () => addRule());
  $("#open-full").addEventListener("click", () => chrome.runtime.openOptionsPage());
  wireSharing();
  window.addEventListener("pagehide", persist);
  wireDragAndDrop();

  renderList();
  renderEditor();
  if (IS_PANEL) {
    wireTeach();
    watchTabs();
  }
}

// The side panel shows either the rule list or one rule's editor.
function setView(view) {
  document.body.dataset.view = view;
  // Leaving the teach view puts its example tabs back under their rules.
  if (view !== "teach") endPreviews();
}

// ---------- Saving ----------

let saveTimer;
function save() {
  setSaveState("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 350);
}

async function persist() {
  clearTimeout(saveTimer);
  await chrome.storage.local.set({ rules });
  setSaveState("All changes saved");
}

const setSaveState = (text) => ($("#save-state").textContent = text);

// ---------- Rule list ----------

let othersOpen = false; // whether the panel's "Other rules" section is expanded

// In the side panel, rules for the current tab's site come first and the rest
// fold into "Other rules". The full page lists everything.
function renderList() {
  const list = $("#rule-list");
  if (!rules.length) {
    list.innerHTML = '<p class="empty">No rules yet.</p>';
    return;
  }
  const host = IS_PANEL ? live?.host : "";
  if (!host) {
    list.replaceChildren(group(rules));
    return;
  }

  const here = rules.filter((r) => r.host && TR.hostMatches(r.host, host));
  const others = rules.filter((r) => !here.includes(r));
  const parts = [];
  if (here.length) parts.push(groupLabel("This site"), group(here));
  if (others.length) {
    const details = document.createElement("details");
    details.className = "other-rules";
    // With nothing for this site, there's no reason to hide the rest.
    details.open = othersOpen || !here.length;
    details.innerHTML = '<summary><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Other rules <span class="count"></span></summary>';
    $(".count", details).textContent = others.length;
    details.addEventListener("toggle", () => {
      if (here.length) othersOpen = details.open;
    });
    details.append(group(others));
    parts.push(details);
  }
  list.replaceChildren(...parts);
}

function group(list) {
  const ol = document.createElement("ol");
  ol.className = "rule-group";
  ol.append(...list.map(listItem));
  return ol;
}

function groupLabel(text) {
  return Object.assign(document.createElement("div"), { className: "group-label", textContent: text });
}

function listItem(rule) {
  const li = document.createElement("li");
  li.className = "rule-item";
  li.dataset.id = rule.id;
  li.draggable = true;
  li.innerHTML = `
    <span class="grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
    <button type="button" class="rule-select">
      <canvas width="32" height="32"></canvas>
      <span class="rule-text"><span class="rule-title"></span><span class="rule-host"></span></span>
    </button>
    <span class="rule-warn" title="Tab Retitler doesn't have access to this site yet" hidden></span>
    <button type="button" class="btn icon rule-delete" title="Delete rule" aria-label="Delete rule">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <label class="switch sm" title="Turn this rule on or off">
      <input type="checkbox" aria-label="Rule on"><span class="track"></span>
    </label>`;
  $(".rule-select", li).addEventListener("click", () => select(rule.id));
  $(".rule-delete", li).addEventListener("click", () => deleteRule(rule.id));
  const toggle = $("input", li);
  toggle.addEventListener("change", () => {
    rule.enabled = toggle.checked;
    save();
    refreshListItem(rule);
    if (rule.id === selectedId) syncEnabled();
  });
  refreshListItem(rule, li);
  return li;
}

function refreshListItem(rule, li = $(`.rule-item[data-id="${rule.id}"]`)) {
  if (!li) return;
  li.classList.toggle("selected", rule.id === selectedId);
  li.classList.toggle("disabled", !rule.enabled);
  $(".rule-title", li).textContent = rule.name || "Untitled rule";
  $(".rule-host", li).textContent = rule.host ? rule.host + (rule.path || "") : "No site yet";
  $("input", li).checked = rule.enabled;

  paintIcon($("canvas", li), rule.host ? TR.siteUrl(rule.host) : "", TR.resolveBadge(rule.badge, {}));

  const warn = $(".rule-warn", li);
  if (!rule.host) warn.hidden = true;
  else hasAccess(rule.host).then((ok) => (warn.hidden = ok));
}

function select(id) {
  selectedId = id;
  for (const li of $$(".rule-item")) li.classList.toggle("selected", li.dataset.id === id);
  renderEditor();
  setView(id ? "edit" : "list");
  scheduleLive();
}

function addRule(fields = {}) {
  const rule = { ...TR.newRule(), ...fields };
  rules.push(rule);
  save();
  renderList();
  select(rule.id);
  if (!fields.host) {
    const name = $(".rule-name");
    name.focus();
    name.select();
  }
  return rule;
}

// Deletes a rule from the list or from its editor, with Undo.
function deleteRule(id = selectedId) {
  const index = rules.findIndex((r) => r.id === id);
  if (index < 0) return;
  const [removed] = rules.splice(index, 1);
  const wasOpen = id === selectedId;
  save();
  renderList();
  if (wasOpen) select(IS_PANEL ? null : (rules[index] ?? rules[index - 1])?.id ?? null);
  scheduleLive();
  toast(`Deleted “${removed.name || "Untitled rule"}”`, "Undo", () => {
    rules.splice(index, 0, removed);
    save();
    renderList();
    if (wasOpen) select(removed.id);
    scheduleLive();
  });
}

function wireDragAndDrop() {
  const list = $("#rule-list");
  let dragId = null;
  const clearMarks = () =>
    $$(".drop-before, .drop-after", list).forEach((el) => el.classList.remove("drop-before", "drop-after"));

  list.addEventListener("dragstart", (e) => {
    const li = e.target.closest?.(".rule-item");
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragId);
  });
  list.addEventListener("dragend", () => {
    dragId = null;
    clearMarks();
    $$(".dragging", list).forEach((el) => el.classList.remove("dragging"));
  });
  list.addEventListener("dragover", (e) => {
    const li = e.target.closest?.(".rule-item");
    if (!dragId || !li) return;
    e.preventDefault();
    clearMarks();
    const box = li.getBoundingClientRect();
    li.classList.add(e.clientY < box.top + box.height / 2 ? "drop-before" : "drop-after");
  });
  list.addEventListener("drop", (e) => {
    e.preventDefault();
    const target = $(".drop-before, .drop-after", list);
    if (!target || !dragId || target.dataset.id === dragId) return;
    const after = target.classList.contains("drop-after");
    const [moved] = rules.splice(rules.findIndex((r) => r.id === dragId), 1);
    rules.splice(rules.findIndex((r) => r.id === target.dataset.id) + (after ? 1 : 0), 0, moved);
    save();
    renderList();
  });
}

// ---------- Editor ----------

function renderEditor() {
  const editor = $("#editor");
  const rule = current();
  rowRefs.clear();
  if (!rule) {
    editor.replaceChildren($("#empty-tpl").content.cloneNode(true));
    $("[data-action=add-rule]", editor).addEventListener("click", () => addRule());
    return;
  }

  editor.replaceChildren($("#editor-tpl").content.cloneNode(true));
  refs = Object.fromEntries($$("[data-ref]", editor).map((el) => [el.dataset.ref, el]));

  for (const el of $$("[data-field]", editor)) {
    const path = el.dataset.field;
    if (el.type === "checkbox") el.checked = getPath(rule, path);
    else el.value = getPath(rule, path) ?? "";
    el.addEventListener("input", () => {
      setPath(rule, path, el.type === "checkbox" ? el.checked : el.value);
      changed(path);
    });
  }

  refs.host.value = rule.host;
  refs.host.addEventListener("input", () => {
    rule.host = TR.normalizeHost(refs.host.value);
    changed("host");
  });
  refs.host.addEventListener("blur", () => {
    if (rule.host) refs.host.value = rule.host;
  });
  refs.path.value = rule.path;
  refs.path.addEventListener("input", () => {
    rule.path = TR.normalizePath(refs.path.value);
    changed("path");
  });
  refs.path.addEventListener("blur", () => (refs.path.value = rule.path));

  $("[data-action=delete]", editor).addEventListener("click", () => deleteRule());
  $("[data-action=share]", editor).addEventListener("click", () => openShare([rule.id]));
  $("[data-action=back]", editor).addEventListener("click", () => select(null));
  $("[data-action=teach]", editor).addEventListener("click", async () => {
    if (!(await requestAccess(rule.host))) return;
    openTeach(rule.id);
  });
  $("[data-action=add-var]", editor).addEventListener("click", addVar);

  renderBadgeCard();
  renderVars();
  syncEnabled();
  updateAccess();
  syncBadge();
  renderChips();
  validate();
  updateLive();
}

// Called after any edit to the open rule.
function changed(path) {
  const rule = current();
  save();
  refreshListItem(rule);
  if (path === "enabled") syncEnabled();
  if (path === "host") updateAccess();
  if (path === "vars") renderChips();
  if (path === "vars" || path.startsWith("badge")) syncBadge();
  validate();
  updateLive();
  scheduleLive();
}

function syncEnabled() {
  const rule = current();
  $("[data-field=enabled]").checked = rule.enabled;
  refs["enabled-label"].textContent = rule.enabled ? "On" : "Off";
}

async function hasAccess(host) {
  return chrome.permissions.contains({ origins: [TR.originFor(host)] });
}

async function updateAccess() {
  const rule = current();
  if (!rule) return;
  const box = refs.access;
  const host = rule.host;
  if (!host) return box.replaceChildren();
  const ok = await hasAccess(host);
  if (current() !== rule || rule.host !== host) return;

  if (ok) {
    box.innerHTML = `<span class="pill ok">${CHECK_SVG}Access granted</span>`;
    return;
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn allow";
  btn.textContent = "Allow access";
  btn.title = `Let Tab Retitler run on ${host}`;
  btn.addEventListener("click", async () => {
    if (await requestAccess(host)) toast(`Tab Retitler can now run on ${host}.`);
    updateAccess();
    refreshListItem(rule);
    scheduleLive();
  });
  box.replaceChildren(btn);
}

// Must be called straight from a click, before any other await, or Chrome
// won't show its prompt. Resolves to true without a prompt if already granted.
async function requestAccess(host) {
  try {
    return await chrome.permissions.request({ origins: [TR.originFor(host)] });
  } catch (err) {
    console.warn("Tab Retitler: access request failed", err);
    toast(`Chrome wouldn't ask for access to ${host}: ${err.message}`);
    return false;
  }
}

function validate() {
  const rule = current();

  const hostBad = refs.host.value.trim() !== "" && !rule.host;
  refs.host.classList.toggle("invalid", hostBad);
  setHint(refs["host-hint"], hostBad
    ? "That doesn't look like a site. Try example.com or *.example.com."
    : "Start with *. to include every subdomain.", hostBad);

  // Pages: what the pattern means, and whether this tab is one of them.
  let pathHint = "Which pages on the site. * is any one part of the path, ** is anything after. Empty is every page.";
  if (IS_PANEL && rule.host && live?.host && TR.hostMatches(rule.host, live.host)) {
    let here = "";
    try { here = new URL(live.tab.url).pathname; } catch {}
    if (rule.path) pathHint = TR.pathMatches(rule.path, here) ? `This tab (${here}) is one of these pages.` : `This tab (${here}) isn't one of these pages.`;
  }
  refs["path-hint"].textContent = pathHint;

  const filterErr = rule.urlFilter && TR.regexError(rule.urlFilter);
  $("[data-field=urlFilter]").classList.toggle("invalid", !!filterErr);
  setHint(refs["filter-hint"], filterErr
    ? `Not a valid pattern: ${filterErr}`
    : "A pattern (regular expression) that must appear somewhere in the URL.", !!filterErr);

  for (const v of rule.vars) {
    const row = rowRefs.get(v.id);
    if (row) validateVar(rule, v, row);
  }
}

function validateVar(rule, v, row) {
  let nameErr = null;
  if (!v.name) nameErr = "Give this value a name so you can use it.";
  else if (!TR.NAME_RE.test(v.name)) nameErr = "Names can use letters, numbers and _, and can't start with a number.";
  else if (TR.BUILT_INS.includes(v.name)) nameErr = `{${v.name}} is built in. Pick another name.`;
  else if (rule.vars.some((o) => o !== v && o.name === v.name)) nameErr = "Another value already uses this name.";

  let selectorErr = null;
  if (v.from === "element") {
    if (!v.selector.trim()) selectorErr = "Add a CSS selector for the element to read.";
    else if (!isValidSelector(v.selector)) selectorErr = "That CSS selector isn't valid.";
  } else if (v.from === "meta" && !v.selector.trim()) {
    selectorErr = "Add the metadata key to read, like og:title.";
  } else if (v.from === "label" && !v.selector.trim()) {
    selectorErr = "Add the label's text, like Status.";
  }

  const regexErr = v.regex && TR.regexError(v.regex);

  row.nameWrap.classList.toggle("invalid", !!nameErr && !!v.name);
  row.inputs.selector.classList.toggle("invalid", !!selectorErr && !!v.selector);
  row.inputs.regex.classList.toggle("invalid", !!regexErr);
  const message = nameErr || selectorErr || (regexErr && `Not a valid pattern: ${regexErr}`);
  row.err.hidden = !message;
  row.err.textContent = message || "";
}

function isValidSelector(sel) {
  try { document.createDocumentFragment().querySelector(sel); return true; }
  catch { return false; }
}

function setHint(el, text, isError) {
  el.textContent = text;
  el.classList.toggle("err", isError);
}

// ---------- Values ----------

function renderVars() {
  const rule = current();
  rowRefs.clear();
  refs.vars.replaceChildren(...rule.vars.map((v) => varRow(rule, v)));
}

function varRow(rule, v) {
  const root = $("#var-tpl").content.cloneNode(true).firstElementChild;
  const row = {
    nameWrap: $(".var-name-wrap", root),
    grid: $(".var-grid", root),
    selectorField: $("[data-ref=selector-field]", root),
    result: $("[data-ref=var-result]", root),
    err: $("[data-ref=var-err]", root),
    inputs: {},
  };
  for (const el of $$("[data-vf]", root)) {
    const key = el.dataset.vf;
    row.inputs[key] = el;
    if (el.type === "checkbox") el.checked = v[key];
    else if (el.type === "number") el.value = v[key] || "";
    else el.value = v[key];
    el.addEventListener("input", () => {
      v[key] = el.type === "checkbox" ? el.checked : el.type === "number" ? Math.max(0, Number(el.value) || 0) : el.value;
      syncVarRow(v, row);
      changed("vars");
    });
  }
  row.more = $("[data-ref=var-more]", root);
  row.moreSummary = $("[data-ref=more-summary]", root);
  row.mapRows = $("[data-ref=map-rows]", root);
  row.mapElse = $("[data-ref=map-else]", root);
  row.selectorLabel = $("[data-ref=selector-label]", root);
  row.more.open = hasExtras(v);
  $("[data-action=add-map]", root).addEventListener("click", () => {
    v.map = [...(v.map || []), { from: "", to: "" }];
    renderMapRows(v, row);
    syncVarRow(v, row);
    changed("vars");
    $$("input", row.mapRows).at(-2)?.focus();
  });
  renderMapRows(v, row);
  pointAt(row.result, () => live?.tab?.id, () => v, () => `{${v.name}}`);
  row.pick = $("[data-action=pick]", root);
  row.pick.addEventListener("click", () => startPick(rule, v));
  row.pick.classList.toggle("active", picking?.key === v.id);
  $("span", row.pick).textContent = picking?.key === v.id ? "Picking…" : "Pick";
  $("[data-action=remove-var]", root).addEventListener("click", () => {
    rule.vars.splice(rule.vars.indexOf(v), 1);
    renderVars();
    changed("vars");
  });
  syncVarRow(v, row);
  rowRefs.set(v.id, row);
  return root;
}

const KEYED = {
  element: { label: "CSS selector", placeholder: "h1 or #item-id" },
  meta: { label: "Metadata key", placeholder: "og:title, canonical or jsonld:sku" },
  label: { label: "Label", placeholder: "Status" },
};

function syncVarRow(v, row) {
  const keyed = KEYED[v.from];
  row.selectorField.hidden = !keyed;
  row.grid.classList.toggle("single", !keyed);
  if (keyed) {
    row.selectorLabel.textContent = keyed.label;
    row.inputs.selector.placeholder = keyed.placeholder;
  }
  row.pick.hidden = v.from !== "element";
  row.inputs.regex.placeholder = REGEX_PLACEHOLDERS[v.from] ?? "(.+)";
  row.mapElse.hidden = !v.map?.length;
  row.moreSummary.textContent = extrasSummary(v);
}

const hasExtras = (v) => v.pick !== "all" || v.nozeros || v.max > 0 || v.map?.length > 0;

function extrasSummary(v) {
  const parts = [];
  if (v.pick !== "all") parts.push({ first: "first word", last: "last word", initials: "initials" }[v.pick]);
  if (v.nozeros) parts.push("no leading zeros");
  if (v.max > 0) parts.push(`up to ${v.max} characters`);
  if (v.map?.length) parts.push(`${v.map.length} replacement${v.map.length === 1 ? "" : "s"}`);
  return parts.length ? `· ${parts.join(", ")}` : "";
}

// The "Replace values" table: one row per value → replacement.
function renderMapRows(v, row) {
  row.mapRows.replaceChildren(...(v.map || []).map((entry, i) => {
    const r = document.createElement("div");
    r.className = "map-row";
    r.innerHTML = `<input class="mono" placeholder="In Progress" aria-label="Value on the page" spellcheck="false">
      <span class="map-arrow" aria-hidden="true">→</span>
      <input placeholder="WIP" aria-label="Show it as" spellcheck="false">
      <button class="btn icon" type="button" title="Remove" aria-label="Remove replacement"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>`;
    const [from, to] = $$("input", r);
    from.value = entry.from;
    to.value = entry.to;
    from.addEventListener("input", () => { entry.from = from.value; changed("vars"); });
    to.addEventListener("input", () => { entry.to = to.value; changed("vars"); });
    $("button", r).addEventListener("click", () => {
      v.map.splice(i, 1);
      renderMapRows(v, row);
      syncVarRow(v, row);
      changed("vars");
    });
    return r;
  }));
}

function addVar() {
  const rule = current();
  const v = TR.newVar();
  rule.vars.push(v);
  renderVars();
  changed("vars");
  rowRefs.get(v.id).inputs.name.focus();
}

// ---------- Picking an element on the page ----------

async function startPick(rule, v) {
  pickOnSite(rule, v.id, "element", (msg) => {
    const r = rules.find((o) => o.id === rule.id);
    const target = r?.vars.find((o) => o.id === v.id);
    if (!target) return;
    target.selector = msg.selector;
    if (selectedId !== r.id) {
      select(r.id);
      save();
    } else {
      rowRefs.get(target.id).inputs.selector.value = target.selector;
      changed("vars");
    }
    const input = rowRefs.get(target.id).inputs.selector;
    input.classList.remove("flash");
    void input.offsetWidth; // restart the animation
    input.classList.add("flash");
    toast(msg.text ? `Picked “${clip(msg.text, 40)}”` : "Picked an element with no text.");
  });
}

const clip = (text, n) => (text.length > n ? text.slice(0, n) + "…" : text);

// Opens the picker on a tab of the rule's site (asking for access first) and
// calls onPicked with { selector, text, color } when an element is clicked.
// key marks which Pick button shows "Picking…"; mode "color" asks for a
// label to take a color from.
async function pickOnSite(rule, key, mode, onPicked) {
  if (!chrome.tabs) return toast("Picking only works when this page runs inside the extension.");
  if (!rule.host) return toast("Choose a site for this rule first.");
  if (!(await requestAccess(rule.host))) return;
  updateAccess();
  refreshListItem(rule);
  try {
    await pickOnTab(await findOrOpenTab(rule), key, mode, onPicked);
  } catch (err) {
    console.warn("Tab Retitler: could not start picker", err);
    setPicking(null);
    toast("Couldn't open the picker on that tab. Try reloading the tab.");
  }
}

async function pickOnTab(tab, key, mode, onPicked) {
  setPicking({ key, onPicked });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (m) => { self.__tabRetitlerPickMode = m; }, args: [mode] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shared.js", "picker.js"] });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

// Prefer the tab you're looking at, then another open tab on the site (one
// that passes the URL filter, then the most recently used). Otherwise open
// the site's home page.
async function findOrOpenTab(rule) {
  let filter = null;
  try { filter = rule.urlFilter && new RegExp(rule.urlFilter); } catch {}
  const onSite = (t) => { try { return TR.hostMatches(rule.host, new URL(t.url).hostname); } catch { return false; } };
  if (live?.tab && onSite(live.tab)) return live.tab;
  const fits = (t) => (filter && filter.test(t.url) ? 1 : 0);
  const tabs = await chrome.tabs.query({ url: TR.originFor(rule.host) });
  tabs.sort((a, b) => fits(b) - fits(a) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  if (tabs[0]) return tabs[0];

  const tab = await chrome.tabs.create({ url: TR.siteUrl(rule.host), active: true });
  await new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(onUpdated); clearTimeout(timer); resolve(); };
    const onUpdated = (id, info) => id === tab.id && info.status === "complete" && done();
    const timer = setTimeout(done, 15000);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
  return tab;
}

function setPicking(state) {
  picking = state;
  for (const [id, row] of rowRefs) {
    row.pick.classList.toggle("active", picking?.key === id);
    $("span", row.pick).textContent = picking?.key === id ? "Picking…" : "Pick";
  }
  for (const b of $$("[data-pick-key]")) b.classList.toggle("active", picking?.key === b.dataset.pickKey);
  const teachPick = $(".suggest-chip.pick .suggest-text");
  if (teachPick) teachPick.textContent = picking?.key === "teach-pick" ? "Picking…" : "Pick on page";
}

chrome.runtime.onMessage?.addListener((msg) => {
  if (!picking || (msg.type !== "element-picked" && msg.type !== "element-pick-cancelled")) return;
  const { onPicked } = picking;
  setPicking(null);
  focusThisTab();
  if (msg.type === "element-picked") onPicked(msg);
});

async function focusThisTab() {
  const me = await chrome.tabs.getCurrent();
  if (!me) return;
  await chrome.tabs.update(me.id, { active: true });
  await chrome.windows.update(me.windowId, { focused: true });
}

// ---------- Title ----------

function renderChips() {
  const rule = current();
  const names = [...new Set(rule.vars.map((v) => v.name))]
    .filter((n) => TR.NAME_RE.test(n) && !TR.BUILT_INS.includes(n));
  refs.chips.replaceChildren(
    ...names.map((n) => chip(n, "Insert this value", false)),
    ...TR.BUILT_INS.map((n) => chip(n, BUILT_IN_HELP[n], true)),
    optionalChip(),
  );
}

// Wraps the selected text (or an empty spot) in {? ... }: a part that only
// shows when every value inside it was found.
function optionalChip() {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip optional";
  b.textContent = "{? optional part}";
  b.title = "A part that only shows when every value in it is found, like {? [{status}]}";
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => {
    const input = refs.title;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const inner = input.value.slice(start, end);
    input.setRangeText(`{?${inner || " "}}`, start, end, "end");
    if (!inner) input.setSelectionRange(start + 3, start + 3);
    input.focus();
    input.dispatchEvent(new Event("input"));
  });
  return b;
}

function chip(name, help, builtIn) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = builtIn ? "chip builtin" : "chip";
  b.textContent = `{${name}}`;
  b.title = help;
  b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret where it is
  b.addEventListener("click", () => {
    const input = refs.title;
    const start = input.selectionStart ?? input.value.length;
    input.setRangeText(`{${name}}`, start, input.selectionEnd ?? start, "end");
    input.focus();
    input.dispatchEvent(new Event("input"));
  });
  return b;
}

// ---------- Badge ----------

function renderBadgeCard() {
  const rule = current();
  const sw = rule.badgeSwitch;

  for (const b of $$("button", refs["badge-mode"])) {
    b.addEventListener("click", () => {
      sw.enabled = b.dataset.value === "switch";
      // Start the switch off with something to edit.
      if (sw.enabled && !sw.on) sw.on = userValueNames(rule)[0] ?? "title";
      if (sw.enabled && !sw.cases.length) addCase(false);
      changed("badge.mode");
    });
  }
  refs["switch-on"].addEventListener("change", () => {
    sw.on = refs["switch-on"].value;
    changed("badge.on");
  });
  $("[data-action=add-case]", refs["badge-switch"]).addEventListener("click", () => addCase(true));

  refs["badge-default"].replaceChildren(badgeEditor(rule.badge, () => changed("badge"), { pickColor: (key, done) => pickOnSite(rule, key, "color", done) }));
  renderCases();
}

function renderCases() {
  const rule = current();
  caseRefs.clear();
  refs.cases.replaceChildren(...rule.badgeSwitch.cases.map((c, i) => caseRow(rule, c, i)));
}

function caseRow(rule, c, index) {
  const root = $("#case-tpl").content.cloneNode(true).firstElementChild;
  const row = { root, icon: $(".case-icon", root), subject: $("[data-ref=subject]", root), inputs: {} };
  for (const el of $$("[data-cf]", root)) {
    const key = el.dataset.cf;
    row.inputs[key] = el;
    el.value = c[key];
    el.addEventListener("input", () => {
      c[key] = el.value;
      changed("badge.case");
    });
  }
  const cases = rule.badgeSwitch.cases;
  const up = $("[data-action=up]", root);
  up.disabled = index === 0;
  up.addEventListener("click", () => {
    cases.splice(index - 1, 0, ...cases.splice(index, 1));
    renderCases();
    changed("badge.order");
  });
  $("[data-action=remove]", root).addEventListener("click", () => {
    cases.splice(index, 1);
    renderCases();
    changed("badge.case");
  });
  $("[data-ref=editor]", root).replaceChildren(badgeEditor(c.badge, () => changed("badge"), { pickColor: (key, done) => pickOnSite(rule, key, "color", done) }));
  caseRefs.set(c.id, row);
  return root;
}

function addCase(focus) {
  const cases = current().badgeSwitch.cases;
  // Give each new case a different color: green, red, orange, purple...
  const order = [3, 0, 1, 5, 4, 6, 2, 7];
  const c = TR.newCase(TR.COLORS[order[cases.length % order.length]]);
  cases.push(c);
  renderCases();
  if (focus) {
    changed("badge.case");
    caseRefs.get(c.id).inputs.value.focus();
  }
}

const userValueNames = (rule) =>
  [...new Set(rule.vars.map((v) => v.name))].filter((n) => TR.NAME_RE.test(n) && !TR.BUILT_INS.includes(n));

// Updates the parts of the badge card that depend on other settings.
function syncBadge() {
  const rule = current();
  const sw = rule.badgeSwitch;
  for (const b of $$("button", refs["badge-mode"])) {
    b.setAttribute("aria-checked", (b.dataset.value === "switch") === sw.enabled);
  }
  refs["badge-switch"].hidden = !sw.enabled;
  refs["badge-fallback"].classList.toggle("plain", !sw.enabled);

  // Options for "Choose the badge using", keeping a value that no longer exists visible.
  const names = [...userValueNames(rule), ...TR.BUILT_INS];
  if (sw.on && !names.includes(sw.on)) names.unshift(sw.on);
  const select = refs["switch-on"];
  select.replaceChildren(...names.map((n) => {
    const missing = !userValueNames(rule).includes(n) && !TR.BUILT_INS.includes(n);
    return new Option(missing ? `{${n}} (removed)` : `{${n}}`, n);
  }));
  select.value = sw.on;
  const removed = sw.on && !userValueNames(rule).includes(sw.on) && !TR.BUILT_INS.includes(sw.on);
  select.classList.toggle("invalid", removed);

  for (const c of sw.cases) {
    const row = caseRefs.get(c.id);
    if (!row) continue;
    row.subject.textContent = `{${sw.on}}`;
    row.inputs.value.hidden = c.op === "empty";
    row.inputs.value.placeholder = c.op === "matches" ? "^(Open|Pending)$" : "Done";
    row.inputs.value.classList.toggle("invalid", c.op === "matches" && !!c.value && !!TR.regexError(c.value));
  }
}

// Controls for one icon look: badge style, color and text up front, with
// shape, corner, size, outline and tint under "Shape & effects". Used for the
// always-on look, the fallback, and each switch case. With opts.pickColor
// (key, onPicked), its colors can also come from a label on the page.
function badgeEditor(look, onChange, opts = {}) {
  const el = $("#badge-editor-tpl").content.cloneNode(true).firstElementChild;
  const pickKey = `color:${TR.uid()}`;
  const text = $(".badge-text", el);
  const more = $(".be-more", el);
  const advanced = $(".be-advanced", el);
  const amount = $(".be-amount input", el);
  const syncs = [];
  const update = () => {
    for (const sync of syncs) sync();
    onChange();
  };

  // Button groups: clicking one sets look[group's key] to its value.
  for (const group of $$("[data-be]", el)) {
    const key = group.dataset.be;
    group.setAttribute("role", "radiogroup");
    const buttons = $$("button", group);
    for (const b of buttons) {
      b.type = "button";
      b.setAttribute("role", "radio");
      b.addEventListener("click", () => {
        look[key] = b.dataset.value;
        update();
        if (key === "style" && look.style === "text") text.focus();
      });
    }
    syncs.push(() => buttons.forEach((b) => b.setAttribute("aria-checked", b.dataset.value === look[key])));
  }

  // Picking a label sets where the color comes from. Its color right now
  // becomes the fixed color too, so previews without the page look right.
  const pickColor = opts.pickColor && (() => opts.pickColor(pickKey, (msg) => {
    if (!msg.color) return toast("That has no color of its own. Pick the colored label, or press ↑ while picking to choose the box around the text.");
    look.colorFrom = msg.selector;
    look.color = look.outlineColor = look.tintColor = msg.color;
    update();
    toast(`Colored like “${clip(msg.text || msg.selector, 40)}” on each page.`);
  }));

  for (const box of $$("[data-be-colors]", el)) {
    const key = box.dataset.beColors;
    syncs.push(swatchRow(box, () => look[key], (color) => {
      look[key] = color;
      update();
    }, pickColor && { on: () => !!look.colorFrom, pick: pickColor, key: pickKey }));
  }

  const page = $(".be-page", el);
  $(".be-page-again", el).dataset.pickKey = pickKey;
  $(".be-page-again", el).addEventListener("click", () => pickColor?.());
  $(".be-page-off", el).addEventListener("click", () => {
    look.colorFrom = "";
    update();
  });
  syncs.push(() => {
    page.hidden = !look.colorFrom;
    page.dataset.selector = look.colorFrom;
    describePageColor(page);
  });
  pointAt(page, () => live?.tab?.id, () => ({ from: "element", selector: look.colorFrom }), "color");

  text.value = look.text;
  text.addEventListener("input", () => {
    look.text = text.value;
    onChange();
  });

  amount.value = look.tintAmount;
  amount.addEventListener("input", () => {
    look.tintAmount = Number(amount.value);
    update();
  });

  more.addEventListener("click", () => {
    advanced.hidden = !advanced.hidden;
    more.setAttribute("aria-expanded", !advanced.hidden);
  });

  // Show only the controls that apply to the current choices.
  syncs.push(() => {
    const noBadge = look.style === "none";
    for (const n of $$("[data-badge-only]", el)) n.hidden = noBadge;
    text.hidden = look.style !== "text";
    $("[data-be-colors=outlineColor]", el).hidden = look.outline === "none";
    $("[data-be-colors=tintColor]", el).hidden = look.tint !== "color";
    $(".be-amount", el).hidden = look.tint === "none";
    $(".be-amount span", el).textContent = `${look.tintAmount}%`;
    const summary = lookSummary(look);
    $(".be-summary", el).textContent = summary || "Shape & effects";
    more.classList.toggle("custom", !!summary);
  });

  for (const sync of syncs) sync();
  return el;
}

// Says which label a look takes its color from: in words when the tab showing
// has it ("a colored label next to “Status”"), else its selector.
function describePageColor(row) {
  const selector = row.dataset.selector;
  const place = live?.state === "ok" ? live.info?.places?.[selector] : null;
  const text = $(".be-page-text", row);
  const code = Object.assign(document.createElement(place ? "span" : "code"), { textContent: place || selector });
  text.replaceChildren("Color of ", code, " on each page, or the one chosen above where it's missing.");
}

// A short description of everything changed from the defaults, shown on the
// collapsed "Shape & effects" button.
function lookSummary(look) {
  const parts = [];
  if (look.style !== "none") {
    if (look.shape !== "round") parts.push({ square: "Square", corner: "Corner" }[look.shape]);
    if (look.position !== "br") parts.push({ tl: "Top left", tr: "Top right", bl: "Bottom left" }[look.position]);
    if (look.size !== "m") parts.push(look.size === "s" ? "Small" : "Large");
  }
  if (look.outline !== "none") parts.push(`${look.outline === "thick" ? "Thick" : "Thin"} outline`);
  if (look.tint !== "none") parts.push({ color: "Color tint", gray: "Grayscale", fade: "Faded" }[look.tint]);
  return parts.join(" · ");
}

// Preset color dots plus a custom color picker, and optionally a button to
// take the color from the page (page: { on(), pick(), key }). Returns a
// function that updates which one is marked as chosen.
function swatchRow(box, get, set, page) {
  const presets = TR.COLORS.map((color) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", color);
    b.dataset.color = color;
    b.style.background = color;
    b.addEventListener("click", () => set(color));
    return b;
  });
  const custom = document.createElement("label");
  custom.className = "swatch custom";
  custom.title = "Custom color";
  custom.innerHTML = '<input type="color" aria-label="Custom color">';
  const picker = $("input", custom);
  picker.value = get();
  picker.addEventListener("input", () => set(picker.value));
  const fromPage = page && Object.assign(document.createElement("button"), {
    type: "button",
    className: "swatch page",
    title: "Use a label's color from each page",
    innerHTML: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3-1.5 1.5-.8-.8-5.7 5.7H3.5v-2l5.7-5.7-.8-.8z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  });
  if (fromPage) {
    fromPage.setAttribute("aria-label", "Color from the page");
    fromPage.dataset.pickKey = page.key;
    fromPage.addEventListener("click", page.pick);
  }
  box.replaceChildren(...presets, custom, ...(fromPage ? [fromPage] : []));

  return () => {
    fromPage?.setAttribute("aria-pressed", page.on());
    const color = get().toLowerCase();
    const isPreset = TR.COLORS.includes(color);
    for (const s of presets) s.setAttribute("aria-checked", s.dataset.color === color);
    custom.setAttribute("aria-checked", !isPreset);
    custom.style.background = isPreset ? "" : color;
  };
}

// ---------- Live: the current tab (side panel only) ----------

// Keep up with whichever tab is showing next to the panel.
function watchTabs() {
  chrome.tabs.onActivated.addListener(() => scheduleLive());
  chrome.windows.onFocusChanged.addListener(() => scheduleLive());
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== live?.tab?.id) return;
    if (info.status === "complete" || info.url || info.title || info.favIconUrl) scheduleLive();
  });
  scheduleLive();
}

let liveTimer;
let liveRun = 0;
function scheduleLive() {
  if (!IS_PANEL) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(refreshLive, 120);
}

// Works out what's happening on the current tab. `live.state` is one of:
//   ok       - the content script answered; live.info has the details
//   blocked  - not a normal web page (chrome://, the Web Store, ...)
//   noaccess - Tab Retitler hasn't been allowed on this site
//   unknown  - couldn't read the tab for some other reason
async function refreshLive() {
  const run = ++liveRun;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try { host = new URL(tab.url).hostname; } catch {}
  const next = { tab, host, state: "unknown", info: null };

  if (!tab || !/^https?:/.test(tab.url || "")) {
    next.state = "blocked";
  } else if (!(await chrome.permissions.contains({ origins: [`*://${host}/*`] }))) {
    next.state = "noaccess";
  } else {
    next.info = await inspectTab(tab.id, current());
    if (next.info) next.state = "ok";
  }
  if (run !== liveRun) return; // a newer refresh started
  const hostChanged = live?.host !== next.host;
  live = next;
  if (hostChanged) renderList();
  renderThisTab();
  updateLive();
  if (document.body.dataset.view === "teach") teachTabChanged();
}

function inspectTab(tabId, rule) {
  return askTab(tabId, { type: "inspect", rule: rule ? structuredClone(rule) : null });
}

// Sends a message to the content script in a tab, injecting it first if needed.
async function askTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // No content script yet, e.g. the site was just allowed or its rules are off.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["shared.js", "content.js"] });
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      return null;
    }
  }
}

// The card at the top of the panel's rule list.
function renderThisTab() {
  if (!IS_PANEL) return;
  const tab = live?.tab;
  const icon = $("#this-tab-icon");
  icon.hidden = !tab?.favIconUrl;
  if (tab?.favIconUrl) icon.src = tab.favIconUrl;
  $("#this-tab-title").textContent = tab?.title || "No tab";
  $("#this-tab-host").textContent = live?.host || "";

  const status = $("#this-tab-status");
  const actions = $("#this-tab-actions");
  actions.replaceChildren();
  let here = "";
  try { here = new URL(tab.url).pathname; } catch {}
  const ruleForHost = live?.host && rules.find((r) => r.host && TR.hostMatches(r.host, live.host));
  // A rule for this site that also covers this page.
  const ruleForPage = live?.host && rules.find((r) => r.host && TR.hostMatches(r.host, live.host) && TR.pathMatches(r.path, here));
  const applied = live?.info?.appliedRuleId && rules.find((r) => r.id === live.info.appliedRuleId);

  if (!live || live.state === "blocked") {
    status.textContent = "Extensions can't change this page.";
  } else if (live.state === "noaccess" && ruleForHost) {
    // Ask for the rule's site (which may be *.example.com), not just this tab's.
    const host = ruleForHost.host;
    status.textContent = "";
    status.append(strong(ruleForHost.name || "Untitled rule"), " is for this site, but Tab Retitler isn't allowed on it yet.");
    actions.append(button("Allow access", async () => {
      await requestAccess(host);
      updateAccess();
      renderList();
      scheduleLive();
    }, "primary"));
    actions.append(button("Edit rule", () => select(ruleForHost.id)));
  } else if (applied) {
    status.textContent = "";
    status.append("Changed by ", strong(applied.name || "Untitled rule"));
    actions.append(button("Edit rule", () => select(applied.id), "primary"));
  } else if (ruleForPage) {
    status.textContent = "";
    status.append("No rule applies to this page. ", strong(ruleForPage.name || "Untitled rule"), " covers it, but didn't find what it needs here.");
    actions.append(button("Edit rule", () => select(ruleForPage.id)));
    actions.append(newRuleButton());
  } else if (ruleForHost) {
    status.textContent = "";
    status.append("This site's rules are for other pages: ", strong(ruleForHost.name || "Untitled rule"), ` is for ${ruleForHost.path || "every page"}.`);
    actions.append(button("Edit rule", () => select(ruleForHost.id)));
  } else {
    status.textContent = live.state === "noaccess" ? "Tab Retitler isn't set up for this site yet." : "No rule applies to this page.";
    actions.append(newRuleButton());
  }
  if (live?.host && live.state !== "blocked") actions.append(teachButton(applied || ruleForPage));
}

// Opens "Build from examples" for this tab: to teach an existing rule, or to
// make a new one.
function teachButton(rule) {
  const host = rule?.host ?? live.host;
  return button(rule ? "Teach with this tab" : "Build from an example", async () => {
    // Reading the page needs access; ask while this still counts as a click.
    if (!(await requestAccess(host))) return;
    openTeach(rule?.id ?? null);
  }, rule ? "" : "primary");
}

function newRuleButton(kind) {
  const host = live.host;
  return button("New rule for this site", async () => {
    // Ask for access first, while this still counts as a response to the click.
    await requestAccess(host);
    addRule({ name: host.replace(/^www\./, ""), host });
    updateAccess();
    scheduleLive();
  }, kind);
}

function button(label, onClick, kind = "") {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `btn sm ${kind}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function strong(text) {
  const el = document.createElement("strong");
  el.textContent = text;
  return el;
}

// Shows how the open rule evaluates on the current tab: the status line under
// its name, the value each extraction finds, and which badge case is in use.
function updateLive() {
  renderThisTab();
  const rule = current();
  if (!rule || !refs.live) return;

  const info = live?.state === "ok" ? live.info : null;
  const res = info?.result;
  const onRuleSite = !!(rule.host && live?.host && TR.hostMatches(rule.host, live.host));
  let tone = "idle";
  let text;
  if (!IS_PANEL) {
    text = "Open Tab Retitler from the toolbar to edit this rule next to the page it changes.";
  } else if (!rule.host) {
    text = "Choose a site to start.";
  } else if (!onRuleSite) {
    text = `Switch to a tab on ${rule.host.replace(/^\*\./, "")} to see this rule in action.`;
  } else if (live.state === "noaccess") {
    tone = "no";
    text = "Allow access to this site to see the rule on this tab.";
  } else if (!res) {
    tone = "no";
    text = "Couldn't read this tab. Try reloading it.";
  } else if (!res.matched) {
    tone = "no";
    text = `Not applied to this tab: ${lowerFirst(res.reason)}`;
  } else if (!rule.enabled) {
    tone = "off";
    text = "Would apply to this tab, but the rule is turned off.";
  } else if (info.appliedRuleId && info.appliedRuleId !== rule.id) {
    const other = rules.find((r) => r.id === info.appliedRuleId);
    tone = "no";
    text = `Matches this tab, but “${other?.name || "another rule"}” comes first in the list.`;
  } else {
    tone = "ok";
    text = "Applied to this tab.";
  }
  refs.live.className = `live ${tone}`;
  refs["live-text"].textContent = text;
  $("[data-action=teach]", refs.live).hidden = !(IS_PANEL && onRuleSite && live.state !== "blocked");

  for (const row of $$(".be-page")) if (row.dataset.selector) describePageColor(row);

  // Value rows: what each one finds on this tab.
  for (const v of rule.vars) {
    const row = rowRefs.get(v.id);
    if (!row) continue;
    const value = info && onRuleSite ? info.values?.[v.id] : undefined;
    const place = v.from === "element" ? info?.places?.[v.selector] : null;
    row.result.replaceChildren(...(value === undefined ? [] : value
      ? ["On this tab: ", Object.assign(document.createElement("b"), { textContent: value }), ...(place ? [`, ${place}`] : [])]
      : ["Not found on this tab"]));
    row.result.title = value ? value + (place ? `, ${place}` : "") : "";
  }

  // Badge cases: a small icon of each, and which one this tab uses.
  const hit = res?.matched && onRuleSite;
  const vars = hit ? res.vars : {};
  // Icons that take their color from a label show this tab's color.
  const page = hit ? { elementColor: (selector) => info.colors?.[selector] ?? null } : null;
  const pageUrl = onRuleSite ? live.tab.url : rule.host ? TR.siteUrl(rule.host) : "";
  const sw = rule.badgeSwitch;
  for (const c of sw.cases) {
    const row = caseRefs.get(c.id);
    if (!row) continue;
    row.root.classList.toggle("hit", hit && res.caseId === c.id);
    paintIcon(row.icon, pageUrl, TR.resolveBadge(c.badge, vars, page));
  }
  refs["badge-fallback"].classList.toggle("hit", sw.enabled && hit && res.caseId === null);
  paintIcon(refs["fallback-icon"], pageUrl, TR.resolveBadge(rule.badge, vars, page));
}

const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// ---------- Build from examples (side panel) ----------

// While the "Build from examples" view is open:
//   ruleId  - the rule being taught, or null for a new one
//   saved   - examples from other tabs
//   current - the example for the tab showing: { tabId, url, title, elements, want }
//   fit     - what Infer.fit made of them
//   history - how many rules were possible after each example, oldest first
//   asks    - open tabs where the possible rules disagree: { tab, titles }
let teach = null;
let teachTimer;

async function openTeach(ruleId) {
  const key = ruleId && `examples:${ruleId}`;
  const saved = key ? (await chrome.storage.local.get(key))[key] ?? [] : [];
  const rule = ruleId && rules.find((r) => r.id === ruleId);
  // Access may have just been granted, so look at the tab again first.
  await refreshLive();
  teach = { ruleId, saved, current: null, fit: null, history: [], asks: [], path: rule?.path ?? null, paths: [] };
  $("#teach-heading").textContent = rule ? `Teach “${rule.name || "Untitled rule"}”` : "Build from examples";
  $("#teach-save").textContent = rule ? "Update rule" : "Create rule";
  setView("teach");
  await loadTeachTab();
  $("#teach-want").focus();
}

function closeTeach() {
  const ruleId = teach?.ruleId;
  teach = null;
  select(ruleId ?? null);
}

// Reads the tab showing and makes it the current example.
async function loadTeachTab() {
  const input = $("#teach-want");
  const tab = live?.tab;
  const icon = $("#teach-icon");
  icon.hidden = !tab?.favIconUrl;
  if (tab?.favIconUrl) icon.src = tab.favIconUrl;
  $("#teach-host").textContent = live?.host || "";
  teach.current = null;

  const page = tab && live.state !== "blocked" && live.state !== "noaccess"
    ? await askTab(tab.id, { type: "harvest", want: "", extra: teachHints() })
    : null;
  if (!teach) return;
  if (!page) {
    input.value = "";
    input.disabled = true;
    $("#teach-original").textContent = "";
    setTeachHint(
      !tab || live.state === "blocked" ? "Switch to a web page to use it as an example."
        : live.state === "noaccess" ? "Tab Retitler isn't allowed on this site. Go back and use “Build from an example” on it."
        : "Couldn't read this tab. Try reloading it.",
      true,
    );
    return refit();
  }

  // Coming back to a tab that's already an example picks up where you left off.
  // Otherwise start from the best guess for this tab, if there's a rule (or
  // examples) to guess from, else from the page's own title.
  const prior = teach.saved.find((e) => e.url === page.url);
  teach.saved = teach.saved.filter((e) => e !== prior);
  const guess = prior ? null : await guessFor(tab.id, page);
  if (!teach) return;
  teach.current = {
    tabId: tab.id,
    ...page,
    want: prior?.want ?? guess?.title ?? "",
    look: prior?.look ?? guess?.look ?? null,
    hint: prior?.hint ?? null,
    picked: mergePicked(prior?.picked, page.picked),
    // A guess isn't an example until it's edited or confirmed.
    guessed: !!guess,
  };
  input.disabled = false;
  input.value = teach.current.want;
  $("#teach-original").textContent = page.title;
  syncGuess();
  renderTeachIcon();
  await harvestWant();
}

// What the rule would give on this tab: for a rule being taught again, what it
// does here right now; for a new rule, the simplest one that fits the
// examples so far. null when there's nothing to go on, or the rule wouldn't
// apply to this tab.
async function guessFor(tabId, page) {
  const rule = teach.ruleId && rules.find((r) => r.id === teach.ruleId);
  if (rule) {
    const res = (await inspectTab(tabId, rule))?.result;
    if (!res?.matched) return null;
    const sw = rule.badgeSwitch;
    const hasIcon = sw.enabled || !!TR.resolveBadge(rule.badge, {});
    const chosen = res.caseId ? sw.cases.find((c) => c.id === res.caseId)?.badge : rule.badge;
    // As this tab gets it: badge text filled in, color taken from its label.
    return { title: res.title, look: hasIcon ? TR.newLook({ ...(res.badge ?? chosen), colorFrom: "" }) : null };
  }

  if (!teach.saved.length) return null;
  const fit = Infer.fit(teach.saved);
  if (!fit?.count) return null;
  const [variant] = Infer.variants(fit, 1);
  const lookFit = Infer.fitLook(teach.saved, fit);
  // The value the icon switches on may be one the title doesn't use.
  const keySource = lookFit?.mode === "switch"
    ? (lookFit.newVar ? { from: "element", selector: lookFit.newVar.selector, regex: "" } : fit.parts.find((p) => p.name === lookFit.on)?.source)
    : null;
  // Named values, for badge text: the title's, and ones only the badge uses.
  const named = lookFit ? [...fit.vars, ...(lookFit.textVars ?? [])].map((v) => ({ ...v, regex: v.regex ?? "" })) : [];
  const sources = [...variant.map((p) => p.source), keySource, ...named].filter((s) => s && s.from !== "builtin");
  const colorFrom = lookFit?.colorFrom?.selector;
  const res = await askTab(tabId, { type: "probe", sources, colors: colorFrom ? [colorFrom] : [] });
  if (!res) return null;
  const valueOf = (src) => src.from === "builtin"
    ? (src.name === "title" ? page.title.replace(/\s+/g, " ").trim() : new URL(page.url).hostname)
    : res.values[sources.indexOf(src)];
  if (variant.some((p) => p.source && p.opt === undefined && !valueOf(p.source))) return null; // a value it needs is missing here

  let look = null;
  if (lookFit?.mode === "always") look = lookFit.look;
  if (lookFit?.mode === "switch") {
    const key = (keySource && valueOf(keySource) || "").toLowerCase();
    look = lookFit.cases.find((c) => c.value.toLowerCase() === key)?.look ?? TR.newLook();
  }
  if (look) {
    // Examples hold the icon as this tab shows it, not the general rule.
    const vars = Object.fromEntries(named.map((s) => [s.name, valueOf(s)]));
    const shown = TR.resolveBadge(look, vars, { elementColor: () => res.colors?.[0] ?? null });
    look = TR.newLook({ ...(shown ?? TR.newLook()), colorFrom: "" });
  }
  return { title: Infer.renderVariant(variant, valueOf), look };
}

// Shows whether the box holds a guess, with the Looks right button.
function syncGuess() {
  const guessed = !!teach?.current?.guessed;
  $("#teach-guess").hidden = !guessed;
  $("#teach-hint").hidden = guessed;
  if (!guessed) setTeachHint("Type it as you'd like to see it. Parts can come from the address, the page's title or text on the page.", false);
}

// Editing or confirming a guess makes it a real example.
function confirmGuess() {
  const cur = teach?.current;
  if (!cur?.guessed) return;
  cur.guessed = false;
  cur.confirmed = true;
  syncGuess();
}

function setTeachHint(text, isError) {
  const hint = $("#teach-hint");
  hint.textContent = text;
  hint.classList.toggle("err", isError);
}

// Called when the panel's tab changes while this view is open. The example
// you typed on the previous tab is kept.
function teachTabChanged() {
  const cur = teach?.current;
  if (cur && live?.tab?.id === cur.tabId && live.tab.url === cur.url) return; // same page, e.g. its title just changed
  if (cur && !cur.guessed && (cur.want.trim() || cur.look)) teach.saved.push(cur);
  loadTeachTab();
}

// Re-reads the page for elements matching what's typed, then refits.
async function harvestWant() {
  const cur = teach?.current;
  if (!cur) return refit();
  const page = await askTab(cur.tabId, { type: "harvest", want: cur.want, extra: teachHints() });
  if (page && teach?.current === cur) {
    cur.elements = page.elements;
    cur.styled = page.styled ?? [];
    cur.picked = mergePicked(cur.picked, page.picked);
    renderSuggestions();
  }
  refit();
}

// ---------- The real tab as the preview ----------

// Each example's tab shows the title typed for it and the icon chosen, until
// teaching ends. A port per tab: when the panel closes, the tabs notice and
// go back to their rules.
const previewPorts = new Map();

function previewExample(ex) {
  if (!ex?.tabId || !chrome.tabs?.connect) return;
  let port = previewPorts.get(ex.tabId);
  if (!port) {
    try {
      port = chrome.tabs.connect(ex.tabId, { name: "preview" });
    } catch {
      return;
    }
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // the tab closed or navigated
      if (previewPorts.get(ex.tabId) === port) previewPorts.delete(ex.tabId);
    });
    previewPorts.set(ex.tabId, port);
  }
  try {
    port.postMessage({ title: ex.want.trim(), badge: ex.look ? TR.resolveBadge(ex.look, {}) : null });
  } catch {
    previewPorts.delete(ex.tabId);
  }
}

function endPreview(tabId) {
  previewPorts.get(tabId)?.disconnect();
  previewPorts.delete(tabId);
}

function endPreviews() {
  for (const port of previewPorts.values()) port.disconnect();
  previewPorts.clear();
}

function teachExamples() {
  const cur = teach.current;
  return [...teach.saved, ...(cur && !cur.guessed && cur.want.trim() ? [cur] : [])];
}

function refit() {
  if (!teach) return;
  previewExample(teach.current);
  const examples = teachExamples();
  teach.fit = Infer.fit(examples);
  // Keep a chosen scope while it's still an option; otherwise the narrowest.
  teach.paths = teach.fit?.paths ?? [];
  if (!teach.paths.includes(teach.path)) teach.path = teach.paths[0];
  teach.lookFit = teach.fit && Infer.fitLook(examples, teach.fit);
  // One entry per number of examples; typing just updates the latest.
  const count = teach.fit?.count ?? 0;
  const last = teach.history.at(-1);
  if (last && last.examples === examples.length) last.count = count;
  else if (examples.length) teach.history.push({ examples: examples.length, count });
  renderTeach(examples);
  scheduleAsks();
}

// ---------- Finding where the possible rules disagree ----------

let askTimer;
let askRun = 0;
function scheduleAsks() {
  clearTimeout(askTimer);
  askTimer = setTimeout(findAsks, 400);
}

// Tries the possible rules on other open tabs on the site. A tab where they
// give different titles is a good next example: answering it rules some out.
async function findAsks() {
  const run = ++askRun;
  const fit = teach?.fit;
  teach && (teach.asks = []);
  if (!fit || fit.count < 2) return renderAsks();

  const variants = Infer.variants(fit, 40);
  const sources = [];
  const index = new Map();
  for (const v of variants) {
    for (const p of v) {
      if (!p.source || p.source.from === "builtin") continue;
      const key = Infer.sourceKey(p.source);
      if (!index.has(key)) index.set(key, sources.push(p.source) - 1);
    }
  }

  const exampleUrls = new Set(teachExamples().map((e) => e.url));
  // Only tabs the rule will cover: the pages chosen under "Applies to".
  const inScope = (t) => { try { return TR.pathMatches(teach.path ?? fit.path, new URL(t.url).pathname); } catch { return false; } };
  const tabs = (await chrome.tabs.query({ url: TR.originFor(fit.host) }))
    .filter((t) => !exampleUrls.has(t.url) && inScope(t))
    .slice(0, 12);
  const asks = [];
  for (const tab of tabs) {
    const res = await askTab(tab.id, { type: "probe", sources });
    if (run !== askRun || !teach) return;
    if (!res) continue;
    const valueOf = (src) => src.from === "builtin"
      ? (src.name === "title" ? res.title.replace(/\s+/g, " ").trim() : new URL(res.url).hostname)
      : res.values[index.get(Infer.sourceKey(src))];
    const titles = [];
    for (const v of variants) {
      // A variant missing a value it needs wouldn't touch this tab.
      if (v.some((p) => p.source && p.opt === undefined && !valueOf(p.source))) continue;
      const title = Infer.renderVariant(v, valueOf);
      if (!titles.includes(title)) titles.push(title);
    }
    if (titles.length > 1) asks.push({ tab, titles: titles.slice(0, 4) });
    if (asks.length >= 3) break;
  }
  teach.asks = asks;
  renderAsks(tabs.length);
}

function renderAsks(tabsChecked = 0) {
  if (!teach) return;
  const box = $("#teach-asks");
  const list = $("#teach-ask-list");
  box.hidden = !teach.asks.length;
  list.replaceChildren(...teach.asks.map((ask) => {
    const item = document.createElement("div");
    item.className = "ask";
    const head = document.createElement("div");
    head.className = "ask-tab";
    head.textContent = ask.tab.title || hostPath(ask.tab.url);
    const choices = document.createElement("div");
    choices.className = "ask-choices";
    for (const title of ask.titles) {
      const b = button(title, () => answerAsk(ask, title), "choice");
      choices.append(b);
    }
    choices.append(button("Something else…", () => {
      // Go to that tab; the panel follows and you can type its title.
      chrome.tabs.update(ask.tab.id, { active: true });
    }, "ghost"));
    item.append(head, choices);
    return item;
  }));

  const fit = teach.fit;
  if (teach.asks.length && fit.results.every((r) => r.ok)) {
    $("#teach-note").textContent = "Answer the question above to narrow it down, or switch to another tab on the site and type its title.";
  }
  if (fit?.count > 1 && !teach.asks.length && tabsChecked) {
    const note = $("#teach-undecided");
    note.hidden = false;
    note.append(" Your other open tabs on this site come out the same either way, so it doesn't matter yet.");
  }
}

// Turns an answer into an example from that tab.
async function answerAsk(ask, title) {
  const page = await askTab(ask.tab.id, { type: "harvest", want: title, extra: teachHints() });
  if (!page || !teach) return toast("Couldn't read that tab. Try reloading it.");
  teach.saved = teach.saved.filter((e) => e.url !== page.url);
  teach.saved.push({ tabId: ask.tab.id, ...page, want: title });
  refit();
}

const SEG_COLORS = ["#0090ff", "#30a46c", "#8e4ec6", "#f76b15", "#d6409f", "#e5484d"];

function renderTeach(examples) {
  const fit = teach.fit;
  $("#teach-result").hidden = !fit;
  if (!fit) return;

  // How many rules are still possible, and how that's gone down.
  const countBox = $("#teach-count");
  countBox.replaceChildren();
  if (fit.count > 0) {
    const n = Object.assign(document.createElement("strong"), { textContent: fit.count === 1 ? "1 possible rule" : `${fit.count} possible rules` });
    countBox.append(n, fit.count === 1 ? " fits your examples." : " fit your examples. Using the simplest one.");
    const counts = teach.history.map((h) => h.count);
    if (counts.length > 1) {
      const trail = document.createElement("span");
      trail.className = "count-trail";
      trail.textContent = counts.slice(-6).join(" → ");
      trail.title = "Possible rules after each example";
      countBox.append(trail);
    }
  }
  countBox.hidden = fit.count === 0;

  // Each part of the wanted title, with where its value comes from.
  const ex = teach.current?.want.trim() ? teach.current : examples.at(-1);
  let color = 0;
  $("#teach-breakdown").replaceChildren(...fit.parts.map((p) => {
    if (p.lit !== undefined) {
      return Object.assign(document.createElement("span"), { className: p.opt !== undefined ? "lit optional" : "lit", textContent: p.lit });
    }
    const seg = document.createElement("span");
    seg.className = p.opt !== undefined ? "seg optional" : "seg";
    seg.style.setProperty("--seg", SEG_COLORS[color++ % SEG_COLORS.length]);
    seg.title = p.source.regex ? `Pattern: ${p.source.regex}` : "";
    const name = Object.assign(document.createElement("span"), { className: "seg-name", textContent: `{${p.name}}` });
    const value = Object.assign(document.createElement("span"), { className: "seg-text", textContent: Infer.run(p.source, ex) || "…" });
    const from = Object.assign(document.createElement("span"), {
      className: "seg-src",
      textContent: describeSource(p.source, ex) + (p.opt !== undefined ? " · only when found" : ""),
    });
    seg.append(value, name, from);
    // Hovering shows where it is on the tab showing.
    pointAt(seg, () => teach?.current?.tabId ?? ex.tabId, p.source, `{${p.name}}`);
    return seg;
  }));

  renderTeachLook();
  renderScope();

  // Values whose source is still undecided.
  const undecided = fit.count > 0 ? fit.parts.filter((p) => p.lit === undefined && p.options.length > 1) : [];
  $("#teach-undecided").textContent = undecided
    .map((p) => `{${p.name}} could come ${p.options.map((o) => describeSource(o, ex)).join(" or ")}.`)
    .join(" ");
  $("#teach-undecided").hidden = !undecided.length;

  // Every example, and whether the rule gets it right.
  $("#teach-examples").replaceChildren(...examples.map((e, i) => {
    const r = fit.results[i];
    const li = document.createElement("li");
    li.className = r.ok ? "ok" : "bad";
    li.innerHTML = `<span class="ex-mark" aria-hidden="true">${r.ok ? "✓" : "✕"}</span><span class="ex-body"><span class="ex-want"></span><span class="ex-meta"></span></span>`;
    $(".ex-want", li).textContent = e.want;
    if (e.look) {
      const icon = Object.assign(document.createElement("canvas"), { width: 32, height: 32, className: "ex-icon", title: "Icon taught for this tab" });
      paintIcon(icon, e.url, TR.resolveBadge(e.look, {}));
      $(".ex-want", li).prepend(icon);
    }
    $(".ex-meta", li).textContent = (e === teach.current ? "This tab" : hostPath(e.url)) + (r.ok ? "" : ` · gives “${r.got}”`);
    if (e !== teach.current) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn icon";
      remove.title = "Remove this example";
      remove.setAttribute("aria-label", "Remove this example");
      remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
      remove.addEventListener("click", () => {
        teach.saved = teach.saved.filter((s) => s !== e);
        if (!teachExamples().some((x) => x.tabId === e.tabId)) endPreview(e.tabId);
        refit();
      });
      li.append(remove);
    }
    return li;
  }));

  renderSplit(fit);
  const failed = fit.results.filter((r) => !r.ok).length;
  const anyFromPage = fit.parts.some((p) => p.lit === undefined);
  $("#teach-note").textContent =
    fit.count === 0 && fit.split ? "These titles need separate rules, one for each kind of page. You can create them below."
    : !anyFromPage ? `None of this text is on the page, so every tab on ${fit.host} would get exactly this title.`
    : failed ? "One rule can't produce all of these. Switch to a tab marked ✕ to change its title, or remove it."
    : examples.length === 1 ? "Works for this tab. Switch to another tab on the site and type its title too, to check it works there."
    : examples.length === 2 ? "Works for both examples."
    : `Works for all ${examples.length} examples.`;
  $("#teach-note").classList.toggle("err", failed > 0);
}

const CHANGE_NAMES = { lower: "lowercase", upper: "UPPERCASE", capitalize: "Sentence case", title: "Title Case" };

// When the examples need different rules (pull requests and issues, say),
// offer to make one per kind of page, each limited to its URLs.
function renderSplit(fit) {
  const box = $("#teach-split");
  const groups = fit.count === 0 ? fit.split : null;
  box.hidden = !groups;
  if (!groups) return;
  $("#teach-split-list").replaceChildren(...groups.map((g) => {
    const li = document.createElement("li");
    const head = Object.assign(document.createElement("strong"), { textContent: g.fit.path || "Every other page" });
    const what = Object.assign(document.createElement("span"), {
      textContent: ` · ${g.examples.length} example${g.examples.length === 1 ? "" : "s"} · ${g.fit.title}`,
    });
    li.append(head, what);
    return li;
  }));
  $("#teach-split-go").textContent = `Create ${groups.length} rules`;
}

async function saveSplit() {
  const groups = teach?.fit?.split;
  if (!groups) return;
  await requestAccess(teach.fit.host);
  const examples = teachExamples();
  const made = [];
  for (const g of groups) {
    const vars = g.fit.vars.map((v) => ({ ...TR.newVar(), ...v }));
    const icon = iconSettings(Infer.fitLook(g.examples, g.fit), vars);
    const label = g.filter ? g.filter.replace(/[\\/]/g, "") : "other pages";
    const rule = { ...TR.newRule(), name: `${g.fit.host.replace(/^\*\.|^www\./g, "")} – ${label}`, host: g.fit.host,
      path: g.fit.path, title: g.fit.title, vars, ...icon };
    rules.push(rule);
    made.push(rule);
    const own = examples.filter((e) => g.examples.some((x) => x.url === e.url));
    await chrome.storage.local.set({ [`examples:${rule.id}`]: own.map(({ url, title, elements, styled, picked, meta, labels, want, look, hint }) => ({ url, title, elements, styled, picked, meta, labels, want, look, hint })) });
  }
  made.forEach(placeBySpecificity);
  save();
  renderList();
  teach = null;
  select(made[0].id);
  toast(`Created ${made.length} rules, one for each kind of page.`);
}

// Where a value comes from, in words. ex, an example page, says where its
// elements are ("from a colored label next to “Status”") instead of giving
// their selectors.
function describeSource(src, ex) {
  if (src.from === "builtin") return src.name === "title" ? "from the whole page title" : "from the site name";
  const short = (s) => (s.length > 32 ? `${s.slice(0, 31)}…` : s);
  const ordinal = (n) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);
  const [kind, ...rest] = (src.how || "").split(":");
  let where;
  if (src.from === "url") {
    if (kind === "segment") {
      const n = Number(rest[0]);
      where = n === -1 ? "from the URL’s last folder" : n < 0 ? `from the URL, ${ordinal(-n)} folder from the end` : `from the URL’s ${ordinal(n)} folder`;
    } else if (kind === "query") where = `from the URL’s ?${rest.join(":")}=`;
    else if (kind === "host") where = "from the site’s subdomain";
    else where = "from the URL";
  } else if (src.from === "title") where = "from the page title";
  else if (src.from === "meta") where = `from page metadata (${short(src.selector)})`;
  else if (src.from === "label") where = `next to “${short(src.selector)}”`;
  else if (src.from === "page") where = "from the page text";
  else {
    const found = ex && [...(ex.elements ?? []), ...(ex.styled ?? []), ...(ex.picked ?? [])]
      .find((e) => e.where && (e.selector === src.selector || e.selectors?.includes(src.selector)));
    where = found ? `from ${found.where}` : `from ${short(src.selector)}`;
  }
  if (kind === "split") {
    const n = Number(rest.at(-1));
    const sep = rest.slice(0, -1).join(":").trim() || rest.slice(0, -1).join(":");
    where += n < 0 ? (n === -1 ? `, last part split on “${sep}”` : `, ${ordinal(-n)} part from the end split on “${sep}”`) : `, ${ordinal(n + 1)} part split on “${sep}”`;
  }
  const changes = [
    src.spaces && "- as spaces",
    src.pick && src.pick !== "all" && { first: "first word", last: "last word", initials: "initials" }[src.pick],
    src.nozeros && "no leading zeros",
    CHANGE_NAMES[src.transform],
    src.map?.length && `looked up (${src.map.slice(0, 2).map((m) => `${m.from} → ${m.to}`).join(", ")}${src.map.length > 2 ? ", …" : ""})`,
  ].filter(Boolean);
  return changes.length ? `${where}, ${changes.join(", ")}` : where;
}

// While the mouse (or focus) is on el, the tab outlines the element a value
// is read from and scrolls to it. tabId(), and source and label when they're
// functions, are asked each time, since they can change. Only for values that
// sit in one place on the page.
function pointAt(el, tabId, source, label) {
  if (!chrome.tabs?.connect) return;
  const now = (x) => (typeof x === "function" ? x() : x);
  const usable = () => {
    const src = now(source);
    return ["element", "label"].includes(src?.from) && !!src.selector;
  };
  let port = null;
  const show = () => {
    hide();
    const id = tabId();
    if (!id || !usable()) return;
    const src = now(source);
    try {
      port = chrome.tabs.connect(id, { name: "highlight" });
      port.onDisconnect.addListener(() => void chrome.runtime.lastError);
      port.postMessage({ source: { from: src.from, selector: src.selector }, label: now(label) });
    } catch {
      port = null;
    }
  };
  const hide = () => {
    port?.disconnect();
    port = null;
  };
  if (typeof source !== "function") {
    if (!usable()) return;
    el.classList.add("points");
    if (!el.hasAttribute("tabindex") && !el.matches("button, input, a")) el.tabIndex = 0;
  }
  // Marked only while it can point at something.
  el.addEventListener("mouseenter", () => el.classList.toggle("points", usable()));
  el.addEventListener("mouseenter", show);
  el.addEventListener("mouseleave", hide);
  el.addEventListener("focus", show);
  el.addEventListener("blur", hide);
}

function hostPath(url) {
  try { const u = new URL(url); return u.hostname + u.pathname; } catch { return url; }
}

async function saveTeach() {
  const fit = teach?.fit;
  if (!fit) return;
  // Ask for the rule's site first, while this still counts as a click.
  await requestAccess(fit.host);
  const vars = fit.vars.map((v) => ({ ...TR.newVar(), ...v }));
  const icon = iconSettings(teach.lookFit, vars);
  const existing = teach.ruleId && rules.find((r) => r.id === teach.ruleId);
  let rule = existing;
  const path = teach.paths?.includes(teach.path) ? teach.path : fit.path;
  if (existing) {
    Object.assign(existing, { host: fit.host, path, title: fit.title, vars, ...icon });
  } else {
    const kind = TR.pathSegments(path).filter((s) => !s.includes("*")).at(-1);
    rule = { ...TR.newRule(), name: fit.host.replace(/^\*\.|^www\./g, "") + (kind ? ` – ${kind}` : ""), host: fit.host, path, title: fit.title, vars, ...icon };
    rules.push(rule);
  }
  placeBySpecificity(rule);
  save();
  renderList();
  // Keep the examples, so teaching this rule again starts from them.
  const examples = teachExamples().map(({ url, title, elements, styled, picked, meta, labels, want, look, hint }) => ({ url, title, elements, styled, picked, meta, labels, want, look, hint }));
  await chrome.storage.local.set({ [`examples:${rule.id}`]: examples });
  teach = null;
  select(rule.id);
  toast(existing ? "Rule updated." : "Rule created. It's already working on this tab.");
}

// Puts a rule before broader rules for the same site, so on a page both
// cover, the more specific one wins (the first matching rule is used).
function placeBySpecificity(rule) {
  rules = rules.filter((r) => r !== rule);
  const mine = TR.pathSpecificity(rule.path);
  const at = rules.findIndex((r) => r.host && rule.host && (TR.hostMatches(r.host, rule.host.replace(/^\*\./, "")) || TR.hostMatches(rule.host, r.host.replace(/^\*\./, "")))
    && TR.pathSpecificity(r.path) < mine);
  rules.splice(at < 0 ? rules.length : at, 0, rule);
}

// ---------- Which pages the rule is for ----------

// The page patterns teaching came up with, narrowest first, each with how
// many of your open tabs on the site it covers.
let scopeRun = 0;
async function renderScope() {
  const box = $("#teach-scope");
  const fit = teach?.fit;
  box.hidden = !fit?.paths?.length || (fit.count === 0 && !!fit.split);
  if (box.hidden) return;
  const list = $("#teach-scope-list");
  const describe = (p) => {
    if (!p) return `Every page on ${fit.host}`;
    return p.endsWith("/**") ? "These pages and any below them" : "Only pages with exactly this shape";
  };
  list.replaceChildren(...fit.paths.map((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "scope-option";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", p === teach.path);
    b.dataset.path = p;
    b.innerHTML = '<span class="scope-dot" aria-hidden="true"></span><span class="scope-text"><code></code><span class="scope-desc"></span></span><span class="scope-count"></span>';
    $("code", b).textContent = p || "/**";
    $(".scope-desc", b).textContent = describe(p);
    b.addEventListener("click", () => {
      teach.path = p;
      for (const o of $$(".scope-option", list)) o.setAttribute("aria-checked", o.dataset.path === p);
      scheduleAsks(); // questions only cover pages in scope
    });
    return b;
  }));
  // Counting open tabs needs the tabs API (side panel only).
  if (!chrome.tabs?.query) return;
  const run = ++scopeRun;
  const tabs = await chrome.tabs.query({ url: TR.originFor(fit.host) });
  if (run !== scopeRun || !teach) return;
  const seen = new Set(teachExamples().map((e) => e.url));
  for (const o of $$(".scope-option", list)) {
    const covered = tabs.filter((t) => { try { return TR.pathMatches(o.dataset.path, new URL(t.url).pathname); } catch { return false; } });
    $(".scope-count", o).textContent = `${covered.length} open tab${covered.length === 1 ? "" : "s"}`;
    // An open tab this option adds over the narrower ones makes the choice concrete.
    const added = covered.find((t) => !seen.has(t.url));
    if (added) $(".scope-desc", o).textContent += ` · adds ${new URL(added.url).pathname}`;
    covered.forEach((t) => seen.add(t.url));
  }
}

// ---------- Teaching icons ----------

// The icon part of a rule from what fitLook found: nothing if no icon was
// taught, else the always-on look, or a badge switch (adding the value it
// switches on to `vars` when that's new).
function iconSettings(lookFit, vars) {
  if (!lookFit || lookFit.mode === "unknown") return {};
  for (const v of lookFit.textVars ?? []) vars.push({ ...TR.newVar(), ...v });
  if (lookFit.mode === "always") {
    return { badge: TR.newLook(lookFit.look), badgeSwitch: { enabled: false, on: "", cases: [] } };
  }
  if (lookFit.newVar) vars.push({ ...TR.newVar(), ...lookFit.newVar });
  return {
    badge: TR.newLook(), // anything not taught: no badge
    badgeSwitch: {
      enabled: true,
      on: lookFit.on,
      cases: lookFit.cases.map((c) => ({ ...TR.newCase(), op: "is", value: c.value, badge: TR.newLook(c.look) })),
    },
  };
}

// The "Icon for this tab" controls under the title box.
function renderTeachIcon() {
  const cur = teach?.current;
  $("#teach-icon").hidden = !cur;
  if (!cur) return;
  $("#teach-icon-add").hidden = !!cur.look;
  $("#teach-icon-remove").hidden = !cur.look;
  $("#teach-icon-preview").hidden = !cur.look;
  const box = $("#teach-icon-look");
  box.hidden = !cur.look;
  box.replaceChildren(...(cur.look ? [badgeEditor(cur.look, () => {
    confirmGuess();
    paintTeachPreview();
    renderSuggestions();
    refit();
  })] : []));
  paintTeachPreview();
  renderSuggestions();
}

function paintTeachPreview() {
  const cur = teach?.current;
  if (cur?.look) paintIcon($("#teach-icon-preview"), cur.url, TR.resolveBadge(cur.look, {}));
}

// Colored labels found on the page, and ones picked on it, as one-click
// icons, plus a button to pick another. Choosing one also tells the
// inference that this label is what the icon follows: its color, or its text.
function renderSuggestions() {
  const cur = teach?.current;
  const box = $("#teach-suggest");
  box.hidden = !cur;
  if (!cur) return;
  const styled = cur.styled ?? [];
  const picked = (cur.picked ?? []).filter((p) => p.color && !styled.some((s) => s.selector === p.selector));
  const list = [...picked, ...styled].slice(0, 6);
  $(".suggest-label", box).textContent = list.length ? "Colors on this page" : "Have the icon follow a label on the page";
  const chips = list.map((s) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "suggest-chip";
    // With no badge (an outline or tint only), the chip colors those instead.
    const effectOnly = cur.look && cur.look.style === "none";
    const chosen = effectOnly ? (cur.look.outline !== "none" ? cur.look.outlineColor : cur.look.tintColor) : cur.look?.color;
    b.classList.toggle("on", cur.hint === s.selector && chosen === s.color);
    const labels = [s.text, ...(s.more ?? [])].map((t) => `“${t}”`).join(", ");
    b.title = effectOnly
      ? `Use ${s.color}, the color this page gives ${labels}`
      : `A ${s.color} dot, the color this page gives ${labels}`;
    b.innerHTML = '<span class="suggest-dot"></span><span class="suggest-text"></span>';
    $(".suggest-dot", b).style.background = s.color;
    $(".suggest-text", b).textContent = s.text;
    if (s.more?.length) {
      b.append(Object.assign(document.createElement("span"), { className: "suggest-more", textContent: `+${s.more.length}` }));
    }
    b.addEventListener("click", () => {
      confirmGuess();
      useColor(cur, s.color);
      cur.hint = s.selector;
      renderTeachIcon();
      refit();
    });
    return b;
  });
  const pick = Object.assign(document.createElement("button"), { type: "button", className: "suggest-chip pick" });
  pick.dataset.pickKey = "teach-pick";
  pick.classList.toggle("active", picking?.key === "teach-pick");
  pick.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5l9.5 4-4 1.5-1.5 4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg><span class="suggest-text"></span>';
  $(".suggest-text", pick).textContent = picking?.key === "teach-pick" ? "Picking…" : "Pick on page";
  pick.title = "Click a label on the page, like a status, for the icon to follow";
  pick.addEventListener("click", () => pickForTeach(cur));
  $("#teach-suggest-chips").replaceChildren(...chips, pick);
}

// Puts a color on the example's icon: the badge, or with no badge the
// outline (adding a thin one if there's neither) and/or tint.
function useColor(cur, color) {
  if (cur.look && cur.look.style === "none") {
    const look = { ...cur.look };
    if (look.outline === "none" && look.tint === "none") look.outline = "thin";
    if (look.outline !== "none") look.outlineColor = color;
    if (look.tint === "color") look.tintColor = color;
    cur.look = TR.newLook(look);
  } else {
    cur.look = TR.newLook({ ...(cur.look ?? {}), style: cur.look?.style === "text" ? "text" : "dot", color });
  }
}

// Picks a label on the example's own tab for the icon to follow.
async function pickForTeach(cur) {
  if (!cur?.tabId) return;
  try {
    const tab = await chrome.tabs.get(cur.tabId);
    await pickOnTab(tab, "teach-pick", "color", async (msg) => {
      if (teach?.current !== cur) return;
      confirmGuess();
      cur.hint = msg.selector;
      cur.picked = mergePicked(cur.picked, [{ selector: msg.selector, selectors: [msg.selector], text: (msg.text || "").slice(0, 200), color: msg.color }]);
      if (msg.color) {
        useColor(cur, msg.color);
        toast(`The icon follows “${clip(msg.text || msg.selector, 40)}”.`);
      } else {
        if (!cur.look) cur.look = TR.newLook({ style: "dot" });
        toast("That has no color of its own, so the icon can only follow its text. To use a color, pick the colored label (↑ chooses the box around the text).");
      }
      renderTeachIcon();
      await fillPicked();
      refit();
    });
    renderSuggestions();
  } catch {
    setPicking(null);
    toast("Couldn't open the picker on this tab. Try reloading it.");
  }
}

// Labels the user picked or chose, on any example: looked up on every other
// example's page too, so the inference can compare them.
const teachHints = () => [...new Set([...(teach?.saved ?? []), teach?.current].map((e) => e?.hint).filter(Boolean))];

function mergePicked(a = [], b = []) {
  const out = (a ?? []).filter((p) => !(b ?? []).some((q) => q.selector === p.selector));
  return [...out, ...(b ?? [])];
}

// Fills in picked labels on earlier examples whose tabs are still open.
async function fillPicked() {
  const hints = teachHints();
  const open = await chrome.tabs.query({});
  for (const ex of teach?.saved ?? []) {
    const missing = hints.filter((h) => !ex.picked?.some((p) => p.selector === h));
    if (!missing.length) continue;
    const tab = open.find((t) => t.id === ex.tabId && t.url === ex.url) ?? open.find((t) => t.url === ex.url);
    const found = tab && await askTab(tab.id, { type: "picked", selectors: missing });
    if (found) ex.picked = mergePicked(ex.picked, found);
  }
}

// The "Icon" section of the result: what the rule will do with icons.
function renderTeachLook() {
  const lookFit = teach.lookFit;
  const box = $("#teach-look");
  const body = $("#teach-look-body");
  box.hidden = !lookFit;
  if (!lookFit) return;
  const pageUrl = teach.current?.url ?? teachExamples().at(-1)?.url ?? "";
  // Drawn as on the current tab: its label colors, and badge text as typed there.
  const here = teach.current;
  const page = { elementColor: (sel) => [...(here?.picked ?? []), ...(here?.styled ?? [])].find((e) => e.selector === sel || e.selectors?.includes(sel))?.color ?? null };
  const shown = (look) => (/\{\w+\}/.test(look.text) && here?.look?.style === "text" ? { ...look, text: here.look.text } : look);
  const row = (look, label) => {
    const r = document.createElement("div");
    r.className = "look-row";
    const c = Object.assign(document.createElement("canvas"), { width: 32, height: 32, className: "case-icon" });
    paintIcon(c, pageUrl, TR.resolveBadge(shown(look), {}, page));
    r.append(c, Object.assign(document.createElement("span"), { textContent: label }));
    return r;
  };
  const fromPage = [];
  if (lookFit.colorFrom) fromPage.push(`colored like “${clip(lookFit.colorFrom.text || lookFit.colorFrom.selector, 30)}” on each page`);
  const texts = lookFit.mode === "always" ? [lookFit.look] : lookFit.mode === "switch" ? lookFit.cases.map((c) => c.look) : [];
  const template = texts.find((l) => l.style === "text" && /\{\w+\}/.test(l.text))?.text;
  if (template) fromPage.push(`with the text ${template}`);
  const note = fromPage.length ? `, ${fromPage.join(", ")}` : "";
  if (lookFit.mode === "always") {
    body.replaceChildren(row(lookFit.look, `Every tab gets this icon${note}.`));
  } else if (lookFit.mode === "switch") {
    const intro = Object.assign(document.createElement("p"), { className: "look-intro" });
    intro.append("Depends on ", Object.assign(document.createElement("code"), { textContent: `{${lookFit.on}}` }), lookFit.newVar ? ` (read from ${lookFit.newVar.selector})` : "", `${note}:`);
    body.replaceChildren(intro, ...lookFit.cases.map((c) => row(c.look, `When it's “${c.value}”`)),
      row(TR.newLook(), "Anything else: no badge"));
  } else {
    body.replaceChildren(Object.assign(document.createElement("p"), {
      className: "hint err",
      textContent: "Nothing on these pages explains why their icons differ. Choose a color from the page, or pick the label the icon should follow, so it knows what to go by.",
    }));
  }
}

function wireTeach() {
  $("#teach-icon-add").addEventListener("click", () => {
    confirmGuess();
    teach.current.look = TR.newLook({ style: "dot" });
    renderTeachIcon();
    refit();
  });
  $("#teach-icon-remove").addEventListener("click", () => {
    confirmGuess();
    teach.current.look = null;
    teach.current.hint = null;
    renderTeachIcon();
    refit();
  });
  $("#teach-back").addEventListener("click", closeTeach);
  $("#teach-save").addEventListener("click", saveTeach);
  $("#teach-split-go").addEventListener("click", saveSplit);
  $("#teach-confirm").addEventListener("click", () => {
    confirmGuess();
    refit();
  });
  $("#teach-want").addEventListener("input", (e) => {
    if (!teach?.current) return;
    confirmGuess();
    teach.current.want = e.target.value;
    previewExample(teach.current);
    clearTimeout(teachTimer);
    teachTimer = setTimeout(harvestWant, 200);
  });
}

// ---------- Icons ----------

const faviconCache = new Map();

// A site's own icon: as one of its tabs drew it before changing anything, or
// else Chrome's cached favicon via the "favicon" permission, which may still
// show a badge we drew.
function loadFavicon(pageUrl) {
  let origin;
  try { origin = new URL(pageUrl).origin; } catch { return Promise.resolve(null); }
  if (!IN_EXTENSION) return Promise.resolve(null);
  if (!faviconCache.has(origin)) {
    faviconCache.set(origin, (async () => {
      const key = `icon:${origin}`;
      const own = chrome.storage.session && (await chrome.storage.session.get(key).catch(() => ({})))[key];
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = own || chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(origin + "/")}&size=64`);
      });
    })());
  }
  return faviconCache.get(origin);
}

// A tab drew its site's icon: redraw previews with it.
chrome.storage?.session?.onChanged?.addListener((changes) => {
  const origins = Object.keys(changes).filter((k) => k.startsWith("icon:")).map((k) => k.slice(5));
  if (!origins.length) return;
  origins.forEach((o) => faviconCache.delete(o));
  renderList();
  if (current()) updateLive();
  if (teach) {
    renderTeachIcon();
    refit();
  }
});

async function paintIcon(canvas, pageUrl, badge) {
  const token = String(Number(canvas.dataset.token || 0) + 1);
  canvas.dataset.token = token;
  const img = await loadFavicon(pageUrl);
  if (canvas.dataset.token !== token) return; // a newer paint started

  const size = canvas.width;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  if (img) ctx.drawImage(img, 0, 0, size, size);
  else drawPlaceholder(ctx, size, pageUrl);
  if (badge) TR.decorate(ctx, size, badge);
}

function drawPlaceholder(ctx, size, pageUrl) {
  let letter = "?";
  try { letter = new URL(pageUrl).hostname.replace(/^www\./, "")[0].toUpperCase(); } catch {}
  ctx.fillStyle = "#8a8f98";
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.22);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = `600 ${Math.round(size * 0.58)}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letter, size / 2, size / 2 + size * 0.04);
}

// ---------- Sharing ----------

let shareFormat = "code";
let shareRun = 0;

function wireSharing() {
  for (const dialog of $$(".dialog")) {
    for (const b of $$("[data-close]", dialog)) b.addEventListener("click", () => dialog.close());
    // Clicking the dimmed area outside closes it.
    dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
  }
  $("#share-btn").addEventListener("click", () => openShare(defaultShareIds()));
  $("#share-all").addEventListener("click", () => {
    const boxes = $$("#share-list input");
    const all = boxes.every((b) => b.checked);
    boxes.forEach((b) => (b.checked = !all));
    updateShare();
  });
  for (const b of $$("#share-format button")) {
    b.addEventListener("click", () => {
      shareFormat = b.dataset.value;
      updateShare();
    });
  }
  $("#share-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#share-output").value);
    toast(shareFormat === "code" ? "Code copied. Paste it anywhere to share." : "JSON copied.");
  });
  $("#share-download").addEventListener("click", () => {
    const chosen = chosenShareRules();
    const name = chosen.length === 1 ? slug(chosen[0].name) || "rule" : "rules";
    download(`tab-retitler-${name}.json`, Share.toJSON(chosen));
  });

  $("#import-btn").addEventListener("click", openImport);
  $("#import-choose").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) loadImportText(await file.text());
  });
  let importTimer;
  $("#import-input").addEventListener("input", () => {
    clearTimeout(importTimer);
    importTimer = setTimeout(previewImport, 250);
  });
  const drop = $("#import-drop");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const file = e.dataTransfer.files[0];
    if (file) loadImportText(await file.text());
    else loadImportText(e.dataTransfer.getData("text/plain"));
  });
  $("#import-go").addEventListener("click", runImport);
}

// What the topbar Share button starts with: the open rule, else the rules
// for the tab beside the panel, else everything.
function defaultShareIds() {
  if (current()) return [current().id];
  const here = live?.host ? rules.filter((r) => r.host && TR.hostMatches(r.host, live.host)) : [];
  return (here.length ? here : rules).map((r) => r.id);
}

function openShare(ids) {
  if (!rules.length) return toast("There are no rules to share yet.");
  $("#share-list").replaceChildren(...rules.map((rule) => {
    const li = pickRow(rule);
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: ids.includes(rule.id) });
    box.addEventListener("change", updateShare);
    li.prepend(box);
    li.addEventListener("click", (e) => {
      if (e.target !== box) {
        box.checked = !box.checked;
        updateShare();
      }
    });
    li.dataset.id = rule.id;
    return li;
  }));
  $("#share-dialog").showModal();
  updateShare();
}

function chosenShareRules() {
  const ids = $$("#share-list li").filter((li) => $("input", li).checked).map((li) => li.dataset.id);
  return rules.filter((r) => ids.includes(r.id));
}

async function updateShare() {
  const run = ++shareRun;
  const chosen = chosenShareRules();
  for (const b of $$("#share-format button")) b.setAttribute("aria-checked", b.dataset.value === shareFormat);
  $("#share-all").textContent = $$("#share-list input").every((b) => b.checked) ? "Select none" : "Select all";
  const out = $("#share-output");
  const info = $("#share-info");
  ["#share-copy", "#share-download"].forEach((id) => ($(id).disabled = !chosen.length));
  if (!chosen.length) {
    out.value = "";
    info.textContent = "Choose at least one rule.";
    return;
  }
  const text = shareFormat === "code" ? await Share.encode(chosen) : Share.toJSON(chosen);
  if (run !== shareRun) return;
  out.value = text;
  out.classList.toggle("is-code", shareFormat === "code");
  const count = `${chosen.length} rule${chosen.length === 1 ? "" : "s"}`;
  info.textContent = shareFormat === "code"
    ? `${count} · ${text.length} characters. Teaching examples aren't included, since they hold text from your pages.`
    : `${count} · readable, so others can check it before importing. Teaching examples aren't included.`;
}

// ---------- Importing ----------

let importItems = []; // { rule, existing, status: "new" | "update" | "same" }
let importRun = 0;

function openImport() {
  importItems = [];
  $("#import-input").value = "";
  $("#import-error").hidden = true;
  $("#import-list").replaceChildren();
  $("#import-note").hidden = true;
  $("#import-go").disabled = true;
  $("#import-go").textContent = "Import";
  $("#import-dialog").showModal();
  $("#import-input").focus();
}

function loadImportText(text) {
  $("#import-input").value = text;
  previewImport();
}

async function previewImport() {
  const run = ++importRun;
  const error = $("#import-error");
  let parsed = [];
  try {
    parsed = await Share.parse($("#import-input").value);
    error.hidden = true;
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
  if (run !== importRun) return;

  importItems = parsed.map((rule) => {
    const existing = rules.find((r) => r.shareId && r.shareId === rule.shareId);
    const status = !existing ? "new" : Share.sameRule(existing, rule) ? "same" : "update";
    return { rule, existing, status, chosen: status !== "same" };
  });
  $("#import-list").replaceChildren(...importItems.map((item) => {
    const li = pickRow(item.rule, true);
    const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: item.chosen, disabled: item.status === "same" });
    box.addEventListener("change", () => {
      item.chosen = box.checked;
      syncImportButton();
    });
    li.prepend(box);
    const tag = document.createElement("span");
    tag.className = `pick-tag ${item.status}`;
    tag.textContent = item.status === "new" ? "New" : item.status === "same" ? "Already added" : `Updates “${item.existing.name || "Untitled rule"}”`;
    $(".pick-text", li).append(tag);
    return li;
  }));
  $("#import-note").hidden = !importItems.some((i) => i.status !== "same" && i.rule.host);
  syncImportButton();
}

function syncImportButton() {
  const chosen = importItems.filter((i) => i.chosen);
  const go = $("#import-go");
  go.disabled = !chosen.length;
  const adds = chosen.filter((i) => i.status === "new").length;
  const updates = chosen.length - adds;
  go.textContent = !chosen.length ? "Import"
    : updates && adds ? `Add ${adds}, update ${updates}`
    : updates ? `Update ${updates} rule${updates === 1 ? "" : "s"}`
    : `Import ${adds} rule${adds === 1 ? "" : "s"}`;
}

async function runImport() {
  const chosen = importItems.filter((i) => i.chosen);
  if (!chosen.length) return;
  // One prompt for every site, while this still counts as a click.
  const origins = [...new Set(chosen.map((i) => i.rule.host).filter(Boolean))].map(TR.originFor);
  let granted = true;
  if (origins.length) {
    try { granted = await chrome.permissions.request({ origins }); } catch { granted = false; }
  }

  for (const { rule, existing, status } of chosen) {
    if (status === "update") {
      // Keep the local id and on/off; take everything else from the import.
      Object.assign(existing, { ...rule, id: existing.id, enabled: existing.enabled });
    } else {
      rules.push(rule);
    }
  }
  save();
  renderList();
  $("#import-dialog").close();
  const first = chosen[0].status === "update" ? chosen[0].existing : chosen[0].rule;
  if (!IS_PANEL || chosen.length === 1) select(first.id);
  else select(null);
  scheduleLive();
  const adds = chosen.filter((i) => i.status === "new").length;
  const updates = chosen.length - adds;
  const plural = (n) => `${n} rule${n === 1 ? "" : "s"}`;
  const what = adds && updates ? `Added ${plural(adds)}, updated ${updates}` : adds ? `Added ${plural(adds)}` : `Updated ${plural(updates)}`;
  toast(granted ? `${what}.` : `${what}. Allow site access from each rule to turn them on.`);
}

// A row describing a rule: icon, name and site, and with `details` what it
// does, so you can check a rule before importing it.
function pickRow(rule, details = false) {
  const li = document.createElement("li");
  li.className = "pick-row";
  const icon = Object.assign(document.createElement("canvas"), { width: 32, height: 32, className: "pick-icon" });
  const look = rule.badgeSwitch.enabled && rule.badgeSwitch.cases[0] ? rule.badgeSwitch.cases[0].badge : rule.badge;
  paintIcon(icon, rule.host ? TR.siteUrl(rule.host) : "", TR.resolveBadge(look, {}));
  const text = document.createElement("div");
  text.className = "pick-text";
  const name = Object.assign(document.createElement("span"), { className: "pick-name", textContent: rule.name || "Untitled rule" });
  const host = Object.assign(document.createElement("span"), { className: "pick-host", textContent: rule.host || "No site" });
  text.append(name, host);
  if (details) {
    const dl = document.createElement("dl");
    dl.className = "pick-details";
    const add = (term, desc) => dl.append(
      Object.assign(document.createElement("dt"), { textContent: term }),
      Object.assign(document.createElement("dd"), { textContent: desc }),
    );
    if (rule.path) add("Pages", rule.path);
    add("Title", rule.title || "Keeps the page's own title");
    if (rule.vars.length) add("Reads", rule.vars.map((v) => `{${v.name}} ${describeSource(v)}`).join(" · "));
    if (rule.urlFilter) add("Only URLs matching", rule.urlFilter);
    add("Icon", describeIcon(rule));
    text.append(dl);
  }
  li.append(icon, text);
  return li;
}

function describeIcon(rule) {
  const sw = rule.badgeSwitch;
  if (sw.enabled && sw.cases.length) {
    return `Depends on {${sw.on}}: ${sw.cases.map((c) => `“${c.value}”`).join(", ")}`;
  }
  const l = rule.badge;
  const base = { none: "", dot: "Dot", text: `Text “${l.text}”` }[l.style];
  const extra = lookSummary(l);
  return [base, extra].filter(Boolean).join(" · ") || "No change";
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

function download(filename, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Toast ----------

let toastTimer;
function toast(text, actionLabel, onAction) {
  const el = $("#toast");
  const action = $("#toast-action");
  $("#toast-text").textContent = text;
  action.hidden = !actionLabel;
  action.textContent = actionLabel || "";
  action.onclick = () => {
    el.hidden = true;
    onAction?.();
  };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}
