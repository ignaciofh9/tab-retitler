// Runs in tabs on sites the user has added. TR comes from shared.js.
// Re-applies whenever rules change, so edits show up in open tabs right away,
// and puts the page back the way it was if the extension goes away.

(() => {
  // The background worker may inject this into a tab that already has it. A
  // copy that can still reach the extension keeps going; one left behind by
  // an update or reload hands over to this one.
  const previous = self.__tabRetitler;
  if (previous?.alive()) return;
  previous?.stop();

  const original = {
    title: document.title,
    icons: [...document.querySelectorAll('link[rel~="icon"]')],
    iconHref: pickIconHref(),
  };
  let ourIcon = null;
  let run = 0;
  let stopped = false;
  // What the side panel shows on this tab while teaching: { title, badge }.
  let preview = null;

  // Whether this copy can still reach the extension. It can't once the
  // extension is removed, turned off, reloaded or updated.
  const alive = () => {
    if (stopped) return false;
    try { return !!chrome.runtime?.id; } catch { return false; }
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(watch);
    document.title = original.title;
    restoreIcon();
  }

  // Chrome gives no notice when an extension goes away, so check now and
  // then (a cheap property read) and undo the changes when it has.
  const watch = setInterval(() => alive() || stop(), 2000);
  self.__tabRetitler = { alive, stop };

  const ctx = {
    get url() { return location.href; },
    title: original.title,
    elementText(selector) {
      try { return document.querySelector(selector)?.textContent ?? null; }
      catch { return null; } // invalid selector
    },
    pageText: () => document.body?.innerText ?? "",
    meta: (key) => TR.readMeta(key),
    labelValue: (label) => TR.labelValue(label),
    elementColor: (selector) => TR.elementColor(selector),
  };

  async function apply() {
    if (stopped) return;
    const thisRun = ++run;
    let rules = [];
    try {
      ({ rules = [] } = await chrome.storage.local.get("rules"));
    } catch {
      return stop(); // the extension is gone
    }
    if (stopped) return;
    const result = preview ?? TR.firstMatch(rules, ctx);
    document.title = result?.title || original.title;

    if (!result?.badge) return restoreIcon();
    try {
      // The background worker draws the badge and hands back a data URL.
      const dataUrl = await chrome.runtime.sendMessage({
        type: "render-badge",
        iconHref: original.iconHref,
        iconData: await originalIcon,
        pageUrl: location.href,
        badge: result.badge,
      });
      if (dataUrl && thisRun === run && !stopped) showIcon(dataUrl);
    } catch {
      // Extension was reloaded or removed; this copy of the script is orphaned.
    }
  }

  // The page's own icon as a PNG, drawn here before anything changes it. The
  // background worker can't decode SVG icons or fetch ones from other hosts,
  // and Chrome's favicon cache holds whatever the tab showed last, which may
  // be our badged icon: drawing on that would keep an old tint or badge.
  // null when the icon is on another host that doesn't allow it.
  const originalIcon = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 64;
        canvas.getContext("2d").drawImage(img, 0, 0, 64, 64);
        resolve(canvas.toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = original.iconHref;
  });
  // The side panel draws its previews with it too.
  originalIcon.then((data) => data && chrome.runtime.sendMessage({ type: "page-icon", origin: location.origin, data }).catch(() => {}));

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
      // Colors of the labels the rule's icons take their color from.
      colors: rule ? Object.fromEntries([rule.badge, ...rule.badgeSwitch.cases.map((c) => c.badge)]
        .filter((l) => l.colorFrom).map((l) => [l.colorFrom, TR.elementColor(l.colorFrom)])) : {},
    };
  }

  // For building a rule from an example: the page's URL and original title,
  // plus visible elements whose text shares a word with the title the user
  // wants, each with a selector that finds it again.
  const SKIP = new Set(["script", "style", "noscript", "template", "svg", "head", "title"]);
  const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  // Elements the user picked on other pages, looked up here by selector:
  // their text and color.
  function picked(selectors = []) {
    const out = [];
    for (const selector of selectors) {
      let el = null;
      try { el = document.querySelector(selector); } catch {}
      if (el) out.push({ selector, selectors: [selector], text: squash(el.textContent).slice(0, 200), color: TR.colorOf(el) });
    }
    return out;
  }

  function harvest(want, extra) {
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
      // The first few get several selectors, so teaching can keep one that
      // also works on the other pages; the rest get just the best one.
      const selectors = elements.length < 30 ? TR.selectorOptions(el) : [TR.bestSelector(el)];
      elements.push({ text, selector: selectors[0], selectors });
      if (elements.length >= 80) break;
    }
    return {
      url: location.href,
      title: original.title,
      elements,
      styled: styledLabels(),
      meta: TR.listMeta(),
      labels: TR.listLabels(),
      picked: picked(extra),
    };
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
        const color = TR.labelColor(el);
        if (!color) continue;
        const key = `${TR.elementKind(el)}|${color}`;
        const known = byKey.get(key);
        if (!known) {
          const selectors = TR.selectorOptions(el);
          const entry = { text, selector: selectors[0], selectors, color, more: [] };
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "harvest") return sendResponse(harvest(msg.want || "", msg.extra));
    if (msg.type === "picked") return sendResponse(picked(msg.selectors));
    // What each candidate source gives on this page, to find where the
    // possible rules disagree.
    if (msg.type === "probe") {
      return sendResponse({
        url: location.href,
        title: original.title,
        values: msg.sources.map((s) => TR.extract(s, ctx)),
        colors: (msg.colors ?? []).map((sel) => TR.elementColor(sel)),
      });
    }
    if (msg.type !== "inspect") return;
    inspect(msg.rule).then(sendResponse);
    return true; // async response
  });

  // While teaching, the side panel shows the example on its tab: the title
  // typed and the icon chosen. It ends when the panel lets go of the port,
  // including when the panel closes.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "preview") return;
    port.onMessage.addListener((msg) => {
      preview = msg;
      apply();
    });
    port.onDisconnect.addListener(() => {
      preview = null;
      apply();
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.rules) apply();
  });
  apply();
})();
