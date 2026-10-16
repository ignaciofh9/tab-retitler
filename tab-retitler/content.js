// Runs in tabs on sites the user has added. TR comes from shared.js.
// Re-applies whenever rules change, so edits show up in open tabs right away.

(() => {
  // The background worker may inject this into a tab that already has it.
  if (self.__tabRetitlerLoaded) return;
  self.__tabRetitlerLoaded = true;

  const original = {
    title: document.title,
    icons: [...document.querySelectorAll('link[rel~="icon"]')],
    iconHref: pickIconHref(),
  };
  let ourIcon = null;
  let run = 0;

  const ctx = {
    get url() { return location.href; },
    title: original.title,
    elementText(selector) {
      try { return document.querySelector(selector)?.textContent ?? null; }
      catch { return null; } // invalid selector
    },
    pageText: () => document.body?.innerText ?? "",
  };

  async function apply() {
    const thisRun = ++run;
    const { rules = [] } = await chrome.storage.local.get("rules");
    const result = TR.firstMatch(rules, ctx);
    document.title = result ? result.title : original.title;

    if (!result?.badge) return restoreIcon();
    try {
      // The page can't draw a cross-origin favicon onto a canvas, so the
      // background worker fetches and draws it and hands back a data URL.
      const dataUrl = await chrome.runtime.sendMessage({
        type: "render-badge",
        iconHref: original.iconHref,
        pageUrl: location.href,
        badge: result.badge,
      });
      if (dataUrl && thisRun === run) showIcon(dataUrl);
    } catch {
      // Extension was reloaded or removed; this copy of the script is orphaned.
    }
  }

  // The page's declared icon, preferring the largest non-SVG one.
  function pickIconHref() {
    const links = [...document.querySelectorAll('link[rel~="icon"]')];
    const size = (l) => parseInt(l.sizes?.value) || 0;
    const raster = links.filter((l) => l.type !== "image/svg+xml" && !/\.svg(\?|$)/i.test(l.href));
    const best = (raster.length ? raster : links).sort((a, b) => size(b) - size(a))[0];
    return best?.href ?? new URL("/favicon.ico", location.origin).href;
  }

  // Chrome doesn't always notice a changed href on an existing <link>,
  // so swap in a fresh element instead.
  function showIcon(href) {
    document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove());
    ourIcon = document.createElement("link");
    ourIcon.rel = "icon";
    ourIcon.type = "image/png";
    ourIcon.href = href;
    document.head.append(ourIcon);
  }

  function restoreIcon() {
    if (!ourIcon) return;
    ourIcon.remove();
    ourIcon = null;
    document.head.append(...original.icons);
  }

  // The side panel asks what's happening on this tab: which rule is applied,
  // and how the rule being edited (sent along, possibly unsaved) evaluates here.
  async function inspect(draft) {
    const { rules = [] } = await chrome.storage.local.get("rules");
    const list = draft ? rules.map((r) => (r.id === draft.id ? draft : r)) : rules;
    const rule = draft && TR.normalizeRule(draft);
    return {
      url: location.href,
      title: original.title,
      appliedRuleId: TR.firstMatch(list, ctx)?.ruleId ?? null,
      result: rule ? TR.evaluate(rule, ctx) : null,
      values: rule ? Object.fromEntries(rule.vars.map((v) => [v.id, TR.extract(v, ctx)])) : {},
    };
  }

  // For building a rule from an example: the page's URL and original title,
  // plus visible elements whose text shares a word with the title the user
  // wants, each with a selector that finds it again.
  const SKIP = new Set(["script", "style", "noscript", "template", "svg", "head", "title"]);
  const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  function harvest(want) {
    // Case-insensitive, so "Sothe" also finds an element saying "SOTHE".
    const words = [...new Set((want.toLowerCase().match(/[a-z0-9]{2,}|\d/g) || []))];
    const elements = [];
    const seen = new Set();
    for (const el of words.length ? document.body?.querySelectorAll("*") ?? [] : []) {
      if (SKIP.has(el.localName)) continue;
      // Only elements with text of their own, not just text from children.
      if (![...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) continue;
      const text = squash(el.textContent);
      if (!text || text.length > 200 || seen.has(text)) continue;
      const lower = text.toLowerCase();
      if (!words.some((w) => lower.includes(w)) || !el.getClientRects().length) continue;
      seen.add(text);
      elements.push({ text, selector: TR.bestSelector(el) });
      if (elements.length >= 80) break;
    }
    return { url: location.href, title: original.title, elements, styled: styledLabels() };
  }

  // Short, colorful, label-like elements (status pills, tags, priority chips),
  // with their colors, to suggest icons from. Walks text nodes rather than
  // every element, so big pages stay fast.
  let styledCache = null;
  function styledLabels() {
    if (styledCache && Date.now() - styledCache.at < 3000) return styledCache.list;
    // One entry per kind of label and color: every green status pill is one
    // suggestion, listing the other texts it covers in `more`.
    const list = [];
    const byKey = new Map();
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && list.length < 12; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      // The text's element or one of its two nearest ancestors may be the pill.
      for (let el = node.parentElement, up = 0; el && up < 3; el = el.parentElement, up++) {
        if (SKIP.has(el.localName)) break;
        const text = squash(el.textContent);
        if (!text || text.length > 24) break;
        const color = colorfulBackground(el);
        if (!color) continue;
        const key = `${TR.elementKind(el)}|${color}`;
        const known = byKey.get(key);
        if (!known) {
          const entry = { text, selector: TR.bestSelector(el), color, more: [] };
          byKey.set(key, entry);
          list.push(entry);
        } else if (known.text !== text && !known.more.includes(text)) {
          known.more.push(text);
        }
        break;
      }
    }
    styledCache = { at: Date.now(), list };
    return list;
  }

  // The label's color as #rrggbb if it's sized like a label and clearly
  // colored, else null. Usually that's its background; for pale pastel pills
  // with darker colored text, it's the text color.
  function colorfulBackground(el) {
    const box = el.getBoundingClientRect();
    if (!box.width || box.height > 48 || box.width > 240) return null;
    const style = getComputedStyle(el);
    const bg = parseColor(style.backgroundColor);
    if (!bg || bg.a < 0.5) return colorfulOutline(el);
    if (saturation(bg) >= 0.25 && Math.max(bg.r, bg.g, bg.b) >= 40) return hex(bg);
    const fg = parseColor(style.color);
    if (saturation(bg) >= 0.05 && fg && saturation(fg) >= 0.3) return hex(fg);
    return null;
  }

  // Outline-only labels: no background, but a colored border and text.
  function colorfulOutline(el) {
    const style = getComputedStyle(el);
    const border = parseColor(style.borderTopColor);
    const fg = parseColor(style.color);
    if (!border || parseFloat(style.borderTopWidth) < 1 || saturation(border) < 0.3 || !fg || saturation(fg) < 0.3) return null;
    return hex(fg);
  }

  function parseColor(css) {
    const m = css.match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const [r, g, b, a = 1] = m.map(Number);
    return { r, g, b, a };
  }
  const saturation = ({ r, g, b }) => {
    const max = Math.max(r, g, b);
    return max ? (max - Math.min(r, g, b)) / max : 0;
  };
  const hex = ({ r, g, b }) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "harvest") return sendResponse(harvest(msg.want || ""));
    // What each candidate source gives on this page, to find where the
    // possible rules disagree.
    if (msg.type === "probe") {
      return sendResponse({ url: location.href, title: original.title, values: msg.sources.map((s) => TR.extract(s, ctx)) });
    }
    if (msg.type !== "inspect") return;
    inspect(msg.rule).then(sendResponse);
    return true; // async response
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.rules) apply();
  });
  apply();
})();
