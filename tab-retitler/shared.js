// Rule engine shared by the background worker, the content script and the
// settings page. Assigned to self rather than declared with const, so
// injecting it again into a tab that already has it doesn't throw.

self.TR = (() => {
  // Values every rule gets for free, usable as {name} in templates.
  const BUILT_INS = ["title", "url", "host", "path"];
  const COLORS = ["#e5484d", "#f76b15", "#f5b400", "#30a46c", "#0090ff", "#8e4ec6", "#d6409f", "#60646c"];
  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  const uid = () => Math.random().toString(36).slice(2, 10);

  // A value read from the page.
  //   from      - url | title | element | page | meta | label
  //   selector  - for element: a CSS selector; for meta: a metadata key like
  //               "og:title", "canonical" or "jsonld:sku"; for label: the
  //               label's text, like "Status" (the value is what's next to it)
  //   regex     - optional; the first ( ) group is kept
  //   how       - how the source was found, only for describing it
  //               ("segment:2", "query:id", "split: · :-1", ...)
  // After it's found, a value can be changed, in this order:
  //   spaces    - turn - _ + into spaces ("fix-login" becomes "fix login")
  //   pick      - all | first (word) | last (word) | initials
  //   nozeros   - drop leading zeros from numbers ("0042" becomes "42")
  //   map       - replace whole values: [{ from: "In Progress", to: "WIP" }];
  //               mapElse says what to do with others: keep | empty
  //   transform - none | lower | upper | capitalize (Sentence case) | title (Title Case)
  //   max       - shorten to this many characters, adding "…" (0: no limit)
  const newVar = () => ({
    id: uid(), name: "", from: "url", selector: "", regex: "", required: false, spaces: false, transform: "none",
    pick: "all", nozeros: false, map: [], mapElse: "keep", max: 0, how: "",
  });
  const SOURCES = ["url", "title", "element", "page", "meta", "label"];
  const PICKS = ["all", "first", "last", "initials"];

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
    // A CSS selector, usually a status pill or tag. When set, the badge,
    // outline and tint use that element's color on each page, and the colors
    // above are only used where it isn't found.
    colorFrom: "",
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
    // Which pages on the site: "/products/*" ("*" is one part of the path,
    // "**" anything after). Empty means every page.
    path: "",
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

  // ---------- Page scopes ----------

  const pathSegments = (path) => {
    let p = String(path || "");
    try { p = decodeURIComponent(p); } catch {}
    return p.split("/").filter(Boolean);
  };

  // Accepts "/products/*", "products/*", or a whole URL pasted in, and returns
  // a tidy pattern ("" for every page).
  function normalizePath(input) {
    let p = String(input || "").trim();
    if (!p || p === "/" || p === "/**" || p === "**") return "";
    p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").replace(/[?#].*$/, "");
    const segs = p.split("/").filter(Boolean);
    return segs.length ? "/" + segs.join("/") : "";
  }

  // Whether a page's path is one of a pattern's pages. Parts match exactly
  // (ignoring case), "*" matches one part, "**" any number, and "*" inside a
  // part matches any characters there ("ABC-*").
  function pathMatches(pattern, pathname) {
    const pat = pathSegments(pattern);
    if (!pat.length) return true;
    const segs = pathSegments(pathname);
    const part = (p, s) => {
      if (p === "*") return true;
      if (!p.includes("*")) return p.toLowerCase() === s.toLowerCase();
      return new RegExp("^" + p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i").test(s);
    };
    const memo = new Map();
    const match = (i, j) => {
      const key = i * 1000 + j;
      if (memo.has(key)) return memo.get(key);
      let ok;
      if (i === pat.length) ok = j === segs.length;
      else if (pat[i] === "**") ok = match(i + 1, j) || (j < segs.length && match(i, j + 1));
      else ok = j < segs.length && part(pat[i], segs[j]) && match(i + 1, j + 1);
      memo.set(key, ok);
      return ok;
    };
    return match(0, 0);
  }

  // How narrow a pattern is: fixed parts count most, then "*" parts.
  const pathSpecificity = (pattern) =>
    pathSegments(pattern).reduce((n, p) => n + (p === "**" ? 0 : p === "*" ? 1 : p.includes("*") ? 2 : 3), 0);

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

  // Fills {name} with values. A part written {? ...} is optional: it only
  // shows when every value inside it was found, so "{num}{? [{status}]}"
  // gives "42 [Done]" or just "42".
  const render = (template, vars) => squash(renderPart(String(template || ""), vars));

  function renderPart(t, vars) {
    let out = "";
    for (let i = 0; i < t.length;) {
      if (t.startsWith("{?", i)) {
        let depth = 1;
        let j = i + 2;
        for (; j < t.length && depth; j++) {
          if (t[j] === "{") depth++;
          else if (t[j] === "}") depth--;
        }
        const inner = t.slice(i + 2, depth ? j : j - 1);
        const names = [...inner.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        if (names.every((n) => vars[n])) out += renderPart(inner, vars);
        i = j;
        continue;
      }
      const m = /^\{(\w+)\}/.exec(t.slice(i, i + 64));
      if (m) {
        out += vars[m[1]] ?? "";
        i += m[0].length;
        continue;
      }
      out += t[i++];
    }
    return out;
  }

  // The names inside optional {? ...} parts, which a rule doesn't need to apply.
  const optionalNames = (template) => {
    const names = new Set();
    for (const m of String(template || "").matchAll(/\{\?((?:[^{}]|\{\w+\})*)\}/g)) {
      for (const n of m[1].matchAll(/\{(\w+)\}/g)) names.add(n[1]);
    }
    return names;
  };

  // URLs are read decoded, so %20 and accented letters come through as text.
  const urlText = (url) => {
    try { return decodeURIComponent(url); } catch { return url; }
  };

  function transformValue(text, v = {}) {
    const { spaces = false, transform = "none", pick = "all", nozeros = false, map = [], mapElse = "keep", max = 0 } = v;
    let t = String(text ?? "");
    if (spaces) t = t.replace(/[-_+]+/g, " ");
    t = squash(t);
    if (!t) return "";
    const words = t.split(" ");
    if (pick === "first") t = words[0];
    else if (pick === "last") t = words[words.length - 1];
    else if (pick === "initials") t = words.map((w) => w[0]).join("");
    if (nozeros) t = t.replace(/(^|[^\d.])0+(?=\d)/g, "$1");
    if (map.length) {
      const hit = map.find((m) => m.from.trim().toLowerCase() === t.toLowerCase());
      if (hit) return squash(hit.to);
      if (mapElse === "empty") return "";
    }
    switch (transform) {
      case "lower": t = t.toLowerCase(); break;
      case "upper": t = t.toUpperCase(); break;
      case "capitalize": t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase(); break;
      case "title": t = t.toLowerCase().replace(/(^|\s)(\S)/g, (_, gap, ch) => gap + ch.toUpperCase()); break;
    }
    if (max > 0 && [...t].length > max) t = [...t].slice(0, max).join("").trimEnd() + "…";
    return t;
  }

  function sourceText(v, ctx) {
    switch (v.from) {
      case "url": return urlText(ctx.url);
      case "title": return ctx.title;
      case "element": return v.selector ? ctx.elementText(v.selector) : null;
      case "page": return ctx.pageText();
      case "meta": return v.selector && ctx.meta ? ctx.meta(v.selector) : null;
      case "label": return v.selector && ctx.labelValue ? ctx.labelValue(v.selector) : null;
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

  // ctx: { url, title, elementText(selector), pageText(), meta(key), labelValue(label) }
  // Returns { matched: true, vars, title, badge } or { matched: false, reason }.
  function evaluate(rule, ctx) {
    const fail = (reason) => ({ matched: false, reason });
    if (!rule.host) return fail("Choose a site for this rule.");
    let url;
    try { url = new URL(ctx.url); } catch { return fail("Enter a valid URL to test with."); }
    if (!hostMatches(rule.host, url.hostname)) return fail(`This URL isn't on ${rule.host}.`);
    if (rule.path && !pathMatches(rule.path, url.pathname)) return fail(`This page isn't one of the rule's pages (${rule.path}).`);
    if (rule.urlFilter) {
      const re = toRegex(rule.urlFilter);
      if (!re) return fail("The URL filter isn't a valid pattern.");
      if (!re.test(ctx.url)) return fail("The URL filter doesn't match this URL.");
    }

    const vars = { title: ctx.title, url: ctx.url, host: url.hostname, path: url.pathname };
    const optional = optionalNames(rule.title);
    for (const v of rule.vars) {
      if (!NAME_RE.test(v.name) || BUILT_INS.includes(v.name)) continue;
      vars[v.name] = extract(v, ctx);
      if (v.required && !optional.has(v.name) && !vars[v.name]) return fail(`{${v.name}} wasn't found, and the rule requires it.`);
    }

    const title = (rule.title.trim() && render(rule.title, vars)) || ctx.title;
    const { badge, caseId } = chooseBadge(rule, vars);
    return { matched: true, vars, title, badge: resolveBadge(badge, vars, ctx), caseId };
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
  // badge text and, on a page, the color it takes from an element. Returns
  // null when there's nothing to change.
  function resolveBadge(b, vars, ctx) {
    const look = newLook(b);
    const color = look.colorFrom && ctx?.elementColor?.(look.colorFrom);
    if (color) Object.assign(look, { color, outlineColor: color, tintColor: color });
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

  // ---------- Colors on the page ----------

  // A label's color as #rrggbb if it's sized like a label and clearly
  // colored, else null. Usually that's its background; for pale pastel pills
  // with darker colored text it's the text color, and for outlined ones the
  // border's.
  function labelColor(el) {
    const box = el.getBoundingClientRect();
    if (!box.width || box.height > 48 || box.width > 240) return null;
    const style = getComputedStyle(el);
    const bg = parseColor(style.backgroundColor);
    const fg = parseColor(style.color);
    if (!bg || bg.a < 0.5) {
      const border = parseColor(style.borderTopColor);
      if (!border || parseFloat(style.borderTopWidth) < 1 || saturation(border) < 0.3 || !fg || saturation(fg) < 0.3) return null;
      return toHex(fg);
    }
    if (saturation(bg) >= 0.25 && Math.max(bg.r, bg.g, bg.b) >= 40) return toHex(bg);
    if (saturation(bg) >= 0.05 && fg && saturation(fg) >= 0.3) return toHex(fg);
    return null;
  }

  // The color of the element a selector finds: its own label color, or that
  // of the pill around it (the selector may point at the text inside), or
  // failing that its text color if that's clearly colored.
  function elementColor(selector) {
    let el;
    try { el = document.querySelector(selector); } catch { return null; }
    return el ? colorOf(el) : null;
  }

  function colorOf(el) {
    for (let e = el, up = 0; e && up < 3; e = e.parentElement, up++) {
      const c = labelColor(e);
      if (c) return c;
    }
    const fg = parseColor(getComputedStyle(el).color);
    return fg && saturation(fg) >= 0.3 && Math.max(fg.r, fg.g, fg.b) >= 40 ? toHex(fg) : null;
  }

  function parseColor(css) {
    const m = String(css).match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const [r, g, b, a = 1] = m.map(Number);
    return { r, g, b, a };
  }
  const saturation = ({ r, g, b }) => {
    const max = Math.max(r, g, b);
    return max ? (max - Math.min(r, g, b)) / max : 0;
  };
  const toHex = ({ r, g, b }) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

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

  // Several selectors that each find exactly this element, most robust
  // first, so teaching can keep whichever also works on the other pages.
  const optionsCache = new WeakMap();
  function selectorOptions(target, max = 6) {
    if (optionsCache.has(target)) return optionsCache.get(target);
    const out = [];
    const add = (sel) => sel && out.length < max && !out.includes(sel) && isUnique(sel, target) && out.push(sel);
    add(bestSelector(target));
    const own = candidates(target);
    own.forEach(add);
    let anc = target.parentElement;
    for (let depth = 0; anc && anc !== document.documentElement && depth < 4 && out.length < max; depth++, anc = anc.parentElement) {
      for (const a of candidates(anc).slice(0, 2)) for (const c of own.slice(0, 2)) add(`${a} ${c}`);
    }
    add(structuralPath(target));
    optionsCache.set(target, out);
    return out;
  }

  // ---------- Page metadata ----------
  // Keys: "og:title" and other <meta> property/name keys, "canonical", and
  // "jsonld:<path>" for schema.org data, like "jsonld:name" or "jsonld:offers.price".

  const cssString = (s) => s.replace(/["\\]/g, "\\$&");

  function readMeta(key) {
    if (key === "canonical") return document.querySelector('link[rel="canonical"]')?.href ?? null;
    if (key.startsWith("jsonld:")) return jsonLd()[key.slice(7)] ?? null;
    const el = document.querySelector(`meta[property="${cssString(key)}"], meta[name="${cssString(key)}"]`);
    return el?.getAttribute("content") ?? null;
  }

  // Every JSON-LD value as a flat path → text map (first value wins).
  function jsonLd() {
    const out = {};
    const walk = (o, path, depth) => {
      if (o == null || depth > 4) return;
      if (Array.isArray(o)) return o.slice(0, 6).forEach((x) => walk(x, path, depth + 1));
      if (typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          if (k === "@graph") walk(v, path, depth + 1);
          else if (!k.startsWith("@")) walk(v, path ? `${path}.${k}` : k, depth + 1);
        }
        return;
      }
      const text = squash(String(o));
      if (text && text.length <= 200 && !(path in out)) out[path] = text;
    };
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { walk(JSON.parse(el.textContent), "", 0); } catch {}
    }
    return out;
  }

  function listMeta(max = 40) {
    const out = {};
    for (const el of document.querySelectorAll("meta[property], meta[name]")) {
      const key = el.getAttribute("property") || el.getAttribute("name");
      const value = squash(el.getAttribute("content"));
      if (/^(og|twitter|article|product|book|music|video):|^(description|application-name|author|keywords)$/i.test(key) && value && value.length <= 300) {
        out[key] ??= value;
      }
    }
    const canonical = readMeta("canonical");
    if (canonical) out.canonical = canonical;
    for (const [path, value] of Object.entries(jsonLd())) out[`jsonld:${path}`] = value;
    return Object.fromEntries(Object.entries(out).slice(0, max));
  }

  // ---------- Text next to a label ----------
  // "Status" → "In Review" for <dt>/<dd>, table header cells, <label>s,
  // a label followed by its value, or "Status: In Review" in one piece.

  const LABEL_MAX = 32;
  const ownText = (el) => squash([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" "));
  const labelKey = (t) => squash(t).replace(/\s*[:：]\s*$/, "");
  // Elements that are never labels: code, headings, and the value side of pairs.
  const NOT_LABELS = new Set(["script", "style", "noscript", "template", "svg", "h1", "h2", "h3", "h4", "h5", "h6",
    "dd", "td", "option", "button", "a", "input", "select", "textarea"]);
  const INLINE_LABEL = /^([^:：]{1,32})[:：]\s*(.{1,200})$/;

  // The label this element is, or null. Labels are <dt>, <th>, <label>, text
  // ending in ":", or the first of a pair of elements ("<span>Owner</span>
  // <span>Sam</span>").
  function labelOf(el) {
    if (NOT_LABELS.has(el.localName) || el.children.length > 2) return null;
    const own = ownText(el);
    if (!own || own.length > 60) return null;
    const key = labelKey(own);
    if (!key || key.length > LABEL_MAX || key.split(" ").length > 4 || !/[a-z]/i.test(key)) return null;
    const explicit = ["dt", "th", "label"].includes(el.localName) || /[:：]\s*$/.test(own);
    const parent = el.parentElement;
    const pairStart = parent && parent.children.length === 2 && parent.firstElementChild === el;
    return explicit || pairStart ? { key, explicit } : null;
  }

  // The visible text of an element, with spaces between its parts.
  const textOf = (el) => squash([...el.querySelectorAll("*")].length ? el.innerText ?? el.textContent : el.textContent);

  function valueNextTo(el, explicit) {
    const own = labelKey(ownText(el)).toLowerCase();
    const tries = [];
    if (el.localName === "dt") tries.push(el.nextElementSibling);
    if (el.localName === "th" && el.parentElement) {
      const cells = [...el.parentElement.children];
      tries.push(cells[cells.indexOf(el) + 1]);
    }
    if (el.localName === "label" && el.htmlFor) tries.push(document.getElementById(el.htmlFor));
    tries.push(el.nextElementSibling);
    if (explicit) tries.push(el.parentElement?.nextElementSibling);
    for (const t of tries) {
      if (!t || NOT_LABELS.has(t.localName) && !["dd", "td", "input", "select", "textarea", "a"].includes(t.localName)) continue;
      const v = squash(t.value ?? textOf(t));
      if (v && v.length <= 200 && labelKey(v).toLowerCase() !== own) return v;
    }
    return null;
  }

  // "Status: In Review" in one element, as a label and value.
  function inlinePair(el) {
    if (NOT_LABELS.has(el.localName) || el.children.length > 2) return null;
    const m = INLINE_LABEL.exec(ownText(el));
    return m && m[1].split(" ").length <= 4 && /[a-z]/i.test(m[1]) ? { key: labelKey(m[1]), value: squash(m[2]) } : null;
  }

  function labelValue(label) {
    const want = labelKey(label).toLowerCase();
    for (const el of document.body?.querySelectorAll("*") ?? []) {
      const inline = inlinePair(el);
      if (inline?.key.toLowerCase() === want) return inline.value;
      const l = labelOf(el);
      if (l?.key.toLowerCase() === want) {
        const v = valueNextTo(el, l.explicit);
        if (v) return v;
      }
    }
    return null;
  }

  // Every label → value pair on the page, for teaching.
  function listLabels(max = 60) {
    const out = [];
    const seen = new Set();
    for (const el of document.body?.querySelectorAll("*") ?? []) {
      if (out.length >= max) break;
      let pair = inlinePair(el);
      if (!pair) {
        const l = labelOf(el);
        const value = l && valueNextTo(el, l.explicit);
        pair = value ? { key: l.key, value } : null;
      }
      if (!pair || seen.has(pair.key.toLowerCase())) continue;
      seen.add(pair.key.toLowerCase());
      out.push({ label: pair.key, value: pair.value });
    }
    return out;
  }

  return {
    BUILT_INS, COLORS, NAME_RE, SOURCES, PICKS,
    CASE_OPS,
    uid, newLook, newVar, newCase, newRule, normalizeRule,
    normalizeHost, hostMatches, originFor, siteUrl, normalizePath, pathMatches, pathSpecificity, pathSegments,
    regexError, render, optionalNames, extract, transformValue, urlText, evaluate, resolveBadge, firstMatch, decorate, bestSelector, selectorOptions, elementKind,
    readMeta, listMeta, labelValue, listLabels, labelColor, elementColor, colorOf,
  };
})();
