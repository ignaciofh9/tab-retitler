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
      // Where the rule's elements are on this page, in words.
      places: rule ? Object.fromEntries([
        ...rule.vars.filter((v) => v.from === "element" && v.selector).map((v) => v.selector),
        ...[rule.badge, ...rule.badgeSwitch.cases.map((c) => c.badge)].map((l) => l.colorFrom).filter(Boolean),
      ].map((sel) => {
        const el = TR.sourceElement({ from: "element", selector: sel });
        return [sel, el ? TR.describeElement(el) : null];
      })) : {},
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
      if (el) out.push({ selector, selectors: [selector], text: squash(el.textContent).slice(0, 200), color: TR.colorOf(el), where: TR.describeElement(el) });
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
      elements.push({ text, selector: selectors[0], selectors, where: TR.describeElement(el) });
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
          const entry = { text, selector: selectors[0], selectors, color, more: [], where: TR.describeElement(el) };
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
    if (msg.type === "snapshot") return sendResponse(snapshot(msg.width));
    if (msg.type === "locate") return sendResponse(locate(msg.source));
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

  // The side panel points at where a value comes from: a box around that
  // element, scrolled into view, while the port stays open (the mouse is over
  // it in the panel).
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "highlight") return;
    let box = null;
    port.onMessage.addListener(({ source, label }) => {
      box?.remove();
      const el = TR.sourceElement(source);
      box = el ? highlight(el, label) : null;
    });
    port.onDisconnect.addListener(() => box?.remove());
  });

  function highlight(el, label) {
    const host = document.createElement("tab-retitler-highlight");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box { position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #3b6cf6;
          background: rgb(59 108 246 / 0.14); border-radius: 4px; box-shadow: 0 0 0 4px rgb(59 108 246 / 0.18); }
        .tag { position: fixed; pointer-events: none; z-index: 2147483647; background: #3b6cf6; color: #fff;
          font: 600 12px/1.4 ui-monospace, "SF Mono", Menlo, monospace; padding: 2px 7px; border-radius: 5px; white-space: nowrap; }
      </style>
      <div class="box"></div><div class="tag"></div>`;
    const box = root.querySelector(".box");
    const tag = root.querySelector(".tag");
    tag.textContent = label || "";
    tag.hidden = !label;
    document.documentElement.append(host);
    const place = () => {
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
      const above = r.top > 26;
      Object.assign(tag.style, { left: `${Math.max(4, r.left - 3)}px`, top: above ? `${r.top - 26}px` : `${r.bottom + 6}px` });
    };
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) el.scrollIntoView({ block: "center", behavior: "smooth" });
    place();
    // Follow it while the page scrolls or moves.
    let frame = requestAnimationFrame(function follow() {
      place();
      frame = requestAnimationFrame(follow);
    });
    return { remove: () => { cancelAnimationFrame(frame); host.remove(); } };
  }

  // ---------- A small picture of the page ----------

  // For the all-tabs teaching view: the top of what's on screen, drawn from
  // the page's layout rather than captured (capturing other tabs needs access
  // to every site). Boxes with their colors, large text as text, the rest as
  // lines. Images show as gray boxes, since most can't be copied. Works in
  // background tabs too.
  function snapshot(width = 480) {
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = Math.min(innerHeight, Math.round(vw * 0.625));
    const k = width / vw;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(vh * k);
    const g = canvas.getContext("2d");
    g.scale(k, k);
    const color = (c) => {
      const m = String(c).match(/[\d.]+/g);
      return m && m.length >= 3 && (m[3] === undefined || Number(m[3]) > 0.05) ? c : null;
    };
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = document.body ? getComputedStyle(document.body) : rootStyle;
    g.fillStyle = color(rootStyle.backgroundColor) || color(bodyStyle.backgroundColor) || "#fff";
    g.fillRect(0, 0, vw, vh);

    const started = performance.now();
    const inFrame = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    const visible = (st) => st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) > 0.05;
    const MEDIA = new Set(["img", "svg", "video", "canvas", "picture", "iframe"]);
    const texts = [];
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        if (SKIP.has(node.localName) && node.localName !== "svg") return NodeFilter.FILTER_REJECT;
        if (node.localName.startsWith("tab-retitler")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let node = walker.nextNode(), n = 0; node && n < 4000 && performance.now() - started < 150; node = walker.nextNode(), n++) {
      if (node.nodeType === Node.TEXT_NODE) {
        texts.push(node);
        continue;
      }
      const el = node;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (!visible(st)) {
        walker.currentNode = lastInside(el);
        continue;
      }
      // Below the picture, and nothing inside can be above it.
      if (r.top >= vh && st.position !== "fixed" && st.position !== "absolute") {
        walker.currentNode = lastInside(el);
        continue;
      }
      if (!inFrame(r)) continue;
      const radius = Math.min(parseFloat(st.borderTopLeftRadius) || 0, r.height / 2, r.width / 2);
      const box = () => { g.beginPath(); g.roundRect(r.left, r.top, r.width, r.height, radius); };
      if (MEDIA.has(el.localName)) {
        box();
        g.fillStyle = "rgb(128 128 128 / 0.22)";
        g.fill();
        if (el.localName !== "picture") walker.currentNode = lastInside(el);
        continue;
      }
      const bg = color(st.backgroundColor);
      if (bg) {
        box();
        g.fillStyle = bg;
        g.fill();
      }
      if (st.backgroundImage !== "none" && !bg) {
        box();
        g.fillStyle = "rgb(128 128 128 / 0.14)";
        g.fill();
      }
      const bw = parseFloat(st.borderTopWidth) || 0;
      const bc = bw >= 1 && st.borderTopStyle !== "none" && color(st.borderTopColor);
      if (bc) {
        box();
        g.lineWidth = Math.max(1, bw);
        g.strokeStyle = bc;
        g.stroke();
      }
    }

    // Text after the boxes, so it's on top of its background.
    const range = document.createRange();
    for (const node of texts) {
      if (performance.now() - started > 250) break;
      const el = node.parentElement;
      if (!el) continue;
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(inFrame);
      if (!rects.length) continue;
      const st = getComputedStyle(el);
      if (!visible(st) || clippedAway(el)) continue;
      const size = parseFloat(st.fontSize) || 16;
      g.fillStyle = color(st.color) || "#000";
      // Big enough to read when small: draw the words.
      if (size * k >= 6 && rects.length === 1) {
        g.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
        g.textBaseline = "middle";
        const r = rects[0];
        g.fillText(node.textContent.replace(/\s+/g, " ").trim(), r.left, r.top + r.height / 2, r.width + 2);
        continue;
      }
      g.globalAlpha = 0.45;
      for (const r of rects) {
        const h = Math.max(1, r.height * 0.5);
        g.beginPath();
        g.roundRect(r.left, r.top + (r.height - h) / 2, r.width, h, h / 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }
    return { data: canvas.toDataURL("image/jpeg", 0.72), width: vw, height: vh };
  }

  // Text hidden for screen readers only: squeezed into a tiny clipped box.
  function clippedAway(el) {
    for (let e = el, up = 0; e && up < 4; e = e.parentElement, up++) {
      const r = e.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return true;
      const st = getComputedStyle(e);
      if ((st.clip && st.clip !== "auto") || (st.clipPath && st.clipPath !== "none" && /inset\(50%|circle\(0/.test(st.clipPath))) return true;
    }
    return false;
  }

  // The last node inside el, to skip past everything it contains.
  function lastInside(el) {
    let last = el;
    while (last.lastChild) last = last.lastChild;
    return last;
  }

  // Where a value's element is, in the same frame as snapshot(): for marking
  // it on the picture. below: it's further down than the picture shows.
  function locate(source) {
    const el = TR.sourceElement(source);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = Math.min(innerHeight, Math.round(vw * 0.625));
    return { left: r.left / vw, top: r.top / vh, width: r.width / vw, height: r.height / vh, below: r.top >= vh, above: r.bottom <= 0 };
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.rules) apply();
  });
  apply();
})();
