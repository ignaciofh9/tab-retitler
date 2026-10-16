// Rule engine shared by the background worker, the content script and the
// settings page. Assigned to self rather than declared with const, so
// injecting it again into a tab that already has it doesn't throw.

self.TR = (() => {
  // Values every rule gets for free, usable as {name} in templates.
  const BUILT_INS = ["title", "url", "host", "path"];
  const COLORS = ["#e5484d", "#f76b15", "#f5b400", "#30a46c", "#0090ff", "#8e4ec6", "#d6409f", "#60646c"];
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  const uid = () => Math.random().toString(36).slice(2, 10);

  // A value read from the page. After it's found it can be changed:
  //   spaces    - turn - _ + into spaces ("fix-login" becomes "fix login")
  //   transform - none | lower | upper | capitalize (Sentence case) | title (Title Case)
  const newVar = () => ({
    id: uid(), name: "", from: "url", selector: "", regex: "", required: false, spaces: false, transform: "none",
  });

  // How a tab's icon gets changed: a badge plus optional outline and tint.
  // Stored under the name "badge" for compatibility with saved rules.
  const newLook = (overrides) => ({
    style: "none",        // badge: none | dot | text
    color: COLORS[4],
    text: "",
    shape: "round",       // round | square | corner
    position: "br",       // br | bl | tr | tl
    size: "m",            // s | m | l
    outline: "none",      // none | thin | thick
    outlineColor: COLORS[0],
    tint: "none",         // none | color | gray | fade
    tintColor: COLORS[0],
    tintAmount: 50,       // percent
    ...overrides,
  });

  // One branch of a badge switch: "when {on} <op> <value>, use this look".
  const CASE_OPS = ["is", "contains", "starts", "matches", "empty"];
  const newCase = (color = COLORS[3]) => ({ id: uid(), op: "is", value: "", badge: newLook({ style: "dot", color }) });

  const newRule = () => ({
    id: uid(),
    // Stays the same when the rule is shared, so importing it again updates
    // the copy instead of adding another.
    shareId: uid(),
    name: "New rule",
    enabled: true,
    host: "",
    urlFilter: "",
    vars: [],
    title: "",
    badge: newLook(),
    // When enabled, the first case matching {on} picks the badge, and
    // `badge` above becomes the fallback.
    badgeSwitch: { enabled: false, on: "", cases: [] },
  });

  // Fills in anything missing, e.g. from an imported file or an older version.
  function normalizeRule(r) {
    const d = newRule();
    const { sample, ...rest } = r; // test values from older versions are no longer used
    r = rest;
    return {
      ...d,
      ...r,
      badge: { ...d.badge, ...r.badge },
      badgeSwitch: {
        ...d.badgeSwitch,
        ...r.badgeSwitch,
        cases: (r.badgeSwitch?.cases || []).map((c) => ({ ...newCase(), ...c, badge: newLook(c.badge) })),
      },
      vars: (r.vars || []).map((v) => ({ ...newVar(), ...v })),
    };
  }

  // Accepts "shop.example.com", "*.example.com", "https://example.com/path" or
  // "localhost:3000" and returns a bare host pattern, or "" if it's not one.
  function normalizeHost(input) {
    const h = String(input || "").trim().toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/:\d+$/, "");
    return /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h) ? h : "";
  }

  function hostMatches(pattern, hostname) {
    if (!pattern.startsWith("*.")) return hostname === pattern;
    const base = pattern.slice(2);
    return hostname === base || hostname.endsWith("." + base);
  }

  // The Chrome match pattern used for permissions and content scripts.
  const originFor = (host) => `*://${host}/*`;
  const siteUrl = (host) => `https://${host.replace(/^\*\./, "")}/`;

  function toRegex(src) {
    try { return new RegExp(src); } catch { return null; }
  }

  function regexError(src) {
    try { new RegExp(src); return null; }
    catch (e) { return e.message.replace(/^Invalid regular expression: (\/.*\/[a-z]*: )?/, ""); }
  }

  const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  const render = (template, vars) =>
    squash(String(template || "").replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ""));

  // URLs are read decoded, so %20 and accented letters come through as text.
  const urlText = (url) => {
    try { return decodeURIComponent(url); } catch { return url; }
  };

  function transformValue(text, { spaces = false, transform = "none" } = {}) {
    let t = String(text ?? "");
    if (spaces) t = t.replace(/[-_+]+/g, " ");
    t = squash(t);
    switch (transform) {
      case "lower": return t.toLowerCase();
      case "upper": return t.toUpperCase();
      case "capitalize": return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
      case "title": return t.toLowerCase().replace(/(^|\s)(\S)/g, (_, gap, ch) => gap + ch.toUpperCase());
    }
    return t;
  }

  function sourceText(v, ctx) {
    switch (v.from) {
      case "url": return urlText(ctx.url);
      case "title": return ctx.title;
      case "element": return v.selector ? ctx.elementText(v.selector) : null;
      case "page": return ctx.pageText();
    }
    return null;
  }

  // The first ( ) group in the pattern if there is one, else the whole match,
  // then changed as the value asks.
  function extract(v, ctx) {
    const text = sourceText(v, ctx);
    if (text == null) return "";
    if (!v.regex) return transformValue(text, v);
    const m = toRegex(v.regex)?.exec(text);
    return m ? transformValue(m[1] ?? m[0], v) : "";
  }

  // ctx: { url, title, elementText(selector), pageText() }
  // Returns { matched: true, vars, title, badge } or { matched: false, reason }.
  function evaluate(rule, ctx) {
    const fail = (reason) => ({ matched: false, reason });
    if (!rule.host) return fail("Choose a site for this rule.");
    let url;
    try { url = new URL(ctx.url); } catch { return fail("Enter a valid URL to test with."); }
    if (!hostMatches(rule.host, url.hostname)) return fail(`This URL isn't on ${rule.host}.`);
    if (rule.urlFilter) {
      const re = toRegex(rule.urlFilter);
      if (!re) return fail("The URL filter isn't a valid pattern.");
      if (!re.test(ctx.url)) return fail("The URL filter doesn't match this URL.");
    }

    const vars = { title: ctx.title, url: ctx.url, host: url.hostname, path: url.pathname };
    for (const v of rule.vars) {
      if (!NAME_RE.test(v.name) || BUILT_INS.includes(v.name)) continue;
      vars[v.name] = extract(v, ctx);
      if (v.required && !vars[v.name]) return fail(`{${v.name}} wasn't found, and the rule requires it.`);
    }

    const title = (rule.title.trim() && render(rule.title, vars)) || ctx.title;
    const { badge, caseId } = chooseBadge(rule, vars);
    return { matched: true, vars, title, badge: resolveBadge(badge, vars), caseId };
  }

  // Returns the badge settings to use, and which switch case picked them
  // (null for the fallback / always-on badge).
  function chooseBadge(rule, vars) {
    const sw = rule.badgeSwitch;
    if (sw?.enabled && sw.on) {
      const subject = String(vars[sw.on] ?? "");
      for (const c of sw.cases) if (caseMatches(c, subject)) return { badge: c.badge, caseId: c.id };
    }
    return { badge: rule.badge, caseId: null };
  }

  // Comparisons ignore case, except "matches", which uses the pattern as written.
  function caseMatches(c, subject) {
    const a = subject.toLowerCase();
    const b = c.value.trim().toLowerCase();
    switch (c.op) {
      case "is": return a === b;
      case "contains": return b !== "" && a.includes(b);
      case "starts": return b !== "" && a.startsWith(b);
      case "matches": return c.value !== "" && !!toRegex(c.value)?.test(subject);
      case "empty": return a === "";
    }
    return false;
  }

  // Turns look settings into what gets drawn, filling in {values} in the
  // badge text. Returns null when there's nothing to change.
  function resolveBadge(b, vars) {
    const look = newLook(b);
    if (look.style === "text") {
      look.text = [...render(look.text, vars)].slice(0, 3).join("");
      if (!look.text) look.style = "none";
    }
    if (look.style === "none" && look.outline === "none" && look.tint === "none") return null;
    return look;
  }

  function firstMatch(rules, ctx) {
    for (const rule of rules) {
      if (!rule.enabled) continue;
      const result = evaluate(normalizeRule(rule), ctx);
      if (result.matched) return { ...result, ruleId: rule.id };
    }
    return null;
  }

  function contrastText(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 165 ? "#111" : "#fff";
  }

  // Changes a size×size 2D context that already holds the favicon: tint
  // first, then the outline, then the badge on top. Works with both <canvas>
  // and OffscreenCanvas.
  function decorate(ctx, size, look) {
    applyTint(ctx, size, look);
    if (look.outline !== "none") drawOutline(ctx, size, look);
    if (look.style !== "none") drawBadge(ctx, size, look);
  }

  function applyTint(ctx, size, { tint, tintColor, tintAmount }) {
    if (tint === "none") return;
    const amount = Math.min(Math.max(tintAmount, 0), 100) / 100;
    if (tint === "color") {
      // source-atop paints only where the icon already has pixels.
      ctx.save();
      ctx.globalCompositeOperation = "source-atop";
      ctx.globalAlpha = amount;
      ctx.fillStyle = tintColor;
      ctx.fillRect(0, 0, size, size);
      ctx.restore();
      return;
    }
    const img = ctx.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (tint === "gray") {
        const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i] += (l - d[i]) * amount;
        d[i + 1] += (l - d[i + 1]) * amount;
        d[i + 2] += (l - d[i + 2]) * amount;
      } else if (tint === "fade") {
        d[i + 3] *= 1 - amount * 0.85; // never fully invisible
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawOutline(ctx, size, { outline, outlineColor }) {
    const w = size * (outline === "thick" ? 0.15 : 0.08);
    ctx.save();
    ctx.lineWidth = w;
    ctx.strokeStyle = outlineColor;
    ctx.beginPath();
    ctx.roundRect(w / 2, w / 2, size - w, size - w, size * 0.2);
    ctx.stroke();
    ctx.restore();
  }

  const BADGE_SCALE = { s: 0.8, m: 1, l: 1.2 };
  const FONT = `system-ui, -apple-system, "Segoe UI", sans-serif`;

  function drawBadge(ctx, size, look) {
    const k = BADGE_SCALE[look.size] ?? 1;
    const right = look.position[1] === "r";
    const bottom = look.position[0] === "b";
    const gap = size * 0.07;
    const hasText = look.style === "text";
    if (look.shape === "corner") return drawCorner(ctx, size, look, k, right, bottom, gap);

    let w, h;
    if (hasText) {
      ctx.font = `700 ${Math.round(size * 0.42 * k)}px ${FONT}`;
      h = Math.min(size, size * 0.58 * k);
      w = Math.min(size, Math.max(h, ctx.measureText(look.text).width + size * 0.2));
    } else {
      w = h = size * 0.46 * k;
    }
    const x = right ? size - w : 0;
    const y = bottom ? size - h : 0;
    const r = look.shape === "square" ? h * 0.22 : h / 2;

    // Cut a transparent ring around the badge so it reads on any icon.
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.roundRect(x - gap, y - gap, w + gap * 2, h + gap * 2, r + gap);
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = look.color;
    ctx.fill();

    if (hasText) {
      ctx.fillStyle = contrastText(look.color);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(look.text, x + w / 2, y + h / 2 + size * 0.02, w - size * 0.08);
    }
  }

  // A right triangle filling the chosen corner, like a folded page corner.
  function drawCorner(ctx, size, look, k, right, bottom, gap) {
    const leg = Math.min(size, size * 0.6 * k);
    const cx = right ? size : 0;
    const cy = bottom ? size : 0;
    const dx = right ? -1 : 1;
    const dy = bottom ? -1 : 1;
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(cx, cy + dy * leg);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + dx * leg, cy);
      ctx.closePath();
    };

    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.lineWidth = gap * 2;
    ctx.lineJoin = "round";
    path();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    path();
    ctx.fillStyle = look.color;
    ctx.fill();

    if (look.style === "text") {
      ctx.font = `700 ${Math.round(leg * 0.38)}px ${FONT}`;
      ctx.fillStyle = contrastText(look.color);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(look.text, cx + dx * leg * 0.3, cy + dy * leg * 0.3, leg * 0.5);
    }
  }

  // ---------- CSS selectors for page elements ----------
  // Used by the element picker and when building rules from examples. Only
  // called where there's a page (not in the background worker).


  const TEST_ATTRS = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy", "data-automation-id"];
  const LABEL_ATTRS = ["aria-label", "name", "itemprop", "title"];

  // Ids and classes that frameworks generate tend to change between page
  // loads or deploys, so they make fragile selectors.
  function looksGenerated(s) {
    return (
      s.length > 40 ||
      /\d{3,}/.test(s) ||                                     // counters, record ids
      /^(css|sc|jsx|emotion|styled|svelte|ember)-/i.test(s) ||
      s.split(/[-_]+/).some((p) => p.length >= 5 && /\d/.test(p) && /[a-z]/i.test(p)) || // hashes: Button_root__x7Kq2
      /[:[\]/()!@%]/.test(s)                                  // React ids like :r1a:, Tailwind like hover:x
    );
  }

  const UTILITY_CLASS = /^(text|bg|font|leading|tracking|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min|max|flex|grid|gap|rounded|border|shadow|items|justify|self|place|space|inline|block|hidden|truncate|opacity|z|overflow|cursor|transition|duration|ease)(-|$)/;
  const classScore = (c) => (UTILITY_CLASS.test(c) ? -10 : 0) + (/[-_]/.test(c) ? 5 : 0) + c.length * 0.1;

  // What kind of element this is, ignoring where it sits: its tag and most
  // descriptive class, like "span.status-pill". Every status pill on a page
  // is the same kind even though each has its own selector.
  function elementKind(el) {
    const best = [...el.classList].filter((c) => !looksGenerated(c)).sort((a, b) => classScore(b) - classScore(a))[0];
    return best ? `${el.localName}.${best}` : el.localName;
  }

  const attrSel = (name, value) => `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;

  // Ways to describe one element on its own, most robust first.
  function candidates(el) {
    const tag = el.localName;
    const out = [];
    if (el.id && !looksGenerated(el.id)) out.push(`#${CSS.escape(el.id)}`);
    for (const a of TEST_ATTRS) {
      const v = el.getAttribute(a);
      if (v) out.push(attrSel(a, v));
    }
    for (const a of LABEL_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.length <= 60 && !looksGenerated(v)) out.push(tag + attrSel(a, v));
    }
    // Descriptive class names ("status-pill") before styling ones ("solid",
    // "text-sm"), so selectors and the names taken from them mean something.
    const classes = [...el.classList].filter((c) => !looksGenerated(c)).sort((a, b) => classScore(b) - classScore(a)).slice(0, 4);
    for (const c of classes) out.push(`${tag}.${CSS.escape(c)}`);
    if (classes.length > 1) out.push(`${tag}.${CSS.escape(classes[0])}.${CSS.escape(classes[1])}`);
    out.push(tag);
    return out;
  }

  function isUnique(selector, el) {
    try {
      const found = document.querySelectorAll(selector);
      return found.length === 1 && found[0] === el;
    } catch {
      return false;
    }
  }

  function bestSelector(target) {
    const own = candidates(target);
    for (const c of own) if (isUnique(c, target)) return c;

    // Anchor under a distinctive ancestor: "header.page-nav a.name".
    let anc = target.parentElement;
    for (let depth = 0; anc && anc !== document.documentElement && depth < 6; depth++, anc = anc.parentElement) {
      for (const a of candidates(anc).slice(0, -1)) {
        for (const c of own) {
          const sel = `${a} ${c}`;
          if (isUnique(sel, target)) return sel;
        }
      }
    }
    return structuralPath(target);
  }

  // Last resort: a path that adds positions, from the target upward, until
  // it's unique. E.g. "div.field:nth-of-type(2) > span.value".
  function structuralPath(target) {
    const parts = [];
    for (let el = target; el && el !== document.documentElement; el = el.parentElement) {
      const own = candidates(el);
      if (el !== target && own[0].startsWith("#") && isUnique(own[0], el)) {
        parts.unshift(own[0]);
        break;
      }
      let piece = own.find((c) => !c.startsWith("#"));
      const siblings = el.parentElement ? [...el.parentElement.children] : [el];
      // Add a position only when other siblings match the same description.
      if (siblings.filter((s) => s.matches(piece)).length > 1) {
        const sameTag = siblings.filter((s) => s.localName === el.localName);
        piece += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
      }
      parts.unshift(piece);
      if (isUnique(parts.join(" > "), target)) break;
    }
    return parts.join(" > ");
  }

  return {
    BUILT_INS, COLORS, NAME_RE,
    CASE_OPS,
    uid, newLook, newVar, newCase, newRule, normalizeRule,
    normalizeHost, hostMatches, originFor, siteUrl,
    regexError, render, extract, transformValue, urlText, evaluate, resolveBadge, firstMatch, decorate, bestSelector, elementKind,
  };
})();
