// Keeps the content script registered on the sites the user has added and
// granted access to, and draws badged favicons for it.

importScripts("shared.js");

const SCRIPT_ID = "tab-retitler";
const SCRIPT_FILES = ["shared.js", "content.js"];
const ICON_SIZE = 64;

// The toolbar button opens the editor in the side panel, next to the page.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
  await syncContentScripts();
  // After an update or reload, the old copies in open tabs put their pages
  // back as they were, so apply the rules there again.
  if (reason === "update") reapplyInOpenTabs();
});
chrome.runtime.onStartup.addListener(syncContentScripts);
chrome.permissions.onAdded.addListener(syncContentScripts);
chrome.permissions.onRemoved.addListener(syncContentScripts);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.rules) syncContentScripts();
});

// Runs one sync at a time so overlapping calls can't register the script twice.
let syncing = Promise.resolve();
function syncContentScripts() {
  syncing = syncing.then(sync).catch((err) => console.warn("Tab Retitler: sync failed", err));
  return syncing;
}

async function sync() {
  const { rules = [] } = await chrome.storage.local.get("rules");
  const hosts = [...new Set(rules.filter((r) => r.enabled && r.host).map((r) => r.host))];
  const matches = [];
  for (const host of hosts) {
    const origin = TR.originFor(host);
    if (await chrome.permissions.contains({ origins: [origin] })) matches.push(origin);
  }
  matches.sort();

  const [current] = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (current && JSON.stringify([...current.matches].sort()) === JSON.stringify(matches)) return;

  if (current) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    { id: SCRIPT_ID, matches, js: SCRIPT_FILES, runAt: "document_idle" },
  ]);

  // Tabs that were already open on a newly added site don't have the script yet.
  await reapplyInOpenTabs(matches);
}

// Runs the tab script in open tabs on the registered sites. Tabs that already
// have a working copy ignore it.
async function reapplyInOpenTabs(matches) {
  if (!matches) {
    const [current] = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    matches = current?.matches ?? [];
  }
  if (!matches.length) return;
  for (const tab of await chrome.tabs.query({ url: matches })) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: SCRIPT_FILES }).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "page-icon") return void savePageIcon(msg);
  if (msg.type !== "render-badge") return;
  renderBadge(msg).then(sendResponse, (err) => {
    console.warn("Tab Retitler: could not badge icon", err);
    sendResponse(null);
  });
  return true; // keep the channel open for the async response
});

// Sites' own icons, as the tab script drew them before changing anything, for
// the side panel's previews. Chrome's favicon cache can't be trusted for
// that: it keeps whatever icon a tab showed last, which may be ours.
async function savePageIcon({ origin, data }) {
  if (typeof origin !== "string" || typeof data !== "string" || !data.startsWith("data:image/png") || data.length > 200000) return;
  const key = `icon:${origin}`;
  if ((await chrome.storage.session.get(key))[key] !== data) await chrome.storage.session.set({ [key]: data });
}

async function renderBadge({ iconHref, iconData, pageUrl, badge }) {
  const canvas = new OffscreenCanvas(ICON_SIZE, ICON_SIZE);
  const ctx = canvas.getContext("2d");
  const icon = iconData?.startsWith("data:image/png") ? await loadBitmap(iconData) : await sourceIcon(iconHref, pageUrl);
  ctx.drawImage(icon, 0, 0, ICON_SIZE, ICON_SIZE);
  TR.decorate(ctx, ICON_SIZE, badge);
  return toDataUrl(await canvas.convertToBlob({ type: "image/png" }));
}

// When the tab couldn't draw its own icon: try the icon the page declares. If
// that fails too (it's on a host we have no access to, or it's an SVG, which
// workers can't decode), fall back to the copy in Chrome's own favicon cache
// via the "favicon" permission. That copy may already be badged.
async function sourceIcon(iconHref, pageUrl) {
  try {
    return await loadBitmap(iconHref);
  } catch {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", pageUrl);
    url.searchParams.set("size", String(ICON_SIZE));
    return loadBitmap(url.href);
  }
}

async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  return createImageBitmap(await res.blob());
}

async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `data:${blob.type};base64,${btoa(binary)}`;
}
