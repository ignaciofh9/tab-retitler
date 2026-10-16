// Builds a rule from examples. Each example is what a page had (URL, original
// title, element texts with selectors, metadata, label/value pairs) plus the
// title the user wants for it. Works out which parts of the wanted title are
// fixed text and which come from the page, and for each of those, every way to
// pull it out that's right on all the examples.
//
// How it stays general:
// - Candidates are made from every example, not just one. The text around a
//   value is lined up across examples and generalized where it differs
//   ("/browse/ABC-" and "/issues/WEB-" become "/[a-z]+/[A-Z]+-").
// - Values get a ladder of patterns from exact to loose, plus structured ways
//   that hold up across pages: URL folder n, a query parameter, a subdomain,
//   part n of a title split on " · ", page metadata, the text next to a label.
// - Elements carry several selectors; any that finds the element everywhere
//   is kept.
// - When no single rule fits, it tries optional parts ("{num}{? [{status}]}"),
//   then lookups ("In Progress" shows as "WIP"), then suggests separate rules
//   for different kinds of URL.

self.Infer = (() => {
  const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ""; } };
  const byCost = (a, b) => a.cost - b.cost;

  // ---------- Tokens ----------

  // Runs of digits, CAPITALS, words, whitespace, or single other characters.
  const TOKEN_RE = /\d+|[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\s+|[^\sA-Za-z\d]/g;

  function tokens(s) {
    const out = [];
    for (const m of s.matchAll(TOKEN_RE)) out.push({ t: m[0], start: m.index, end: m.index + m[0].length });
    return out;
  }

  function kind(t) {
    if (/^\d+$/.test(t)) return "num";
    if (/^[A-Z]+$/.test(t)) return "caps";
    if (/^[A-Za-z]+$/.test(t)) return "word";
    if (/^\s+$/.test(t)) return "space";
    return "punct";
  }
  const isWordy = (t) => ["num", "caps", "word"].includes(kind(t));
  const isDelim = (t) => ["punct", "space"].includes(kind(t));

  // One token of context seen on a single page. Numbers and CAPS codes (ids,
  // product codes) likely change from page to page, so they're generalized;
  // other words like "items" are kept as they are.
  function contextPart(t) {
    switch (kind(t)) {
      case "num": return "\\d+";
      case "caps": return t.length > 1 ? "[A-Z]+" : esc(t);
      case "space": return t === " " ? " " : "\\s+";
      default: return esc(t);
    }
  }

  // The same position of context on several pages: kept if it's the same
  // everywhere, generalized to the narrowest class that covers them all, or
  // null if they're too different to line up.
  function contextAcross(ts) {
    if (ts.every((t) => t === ts[0])) return contextPart(ts[0]);
    const kinds = new Set(ts.map(kind));
    if (kinds.size === 1) {
      const k = [...kinds][0];
      if (k === "num") return "\\d+";
      if (k === "caps") return "[A-Z]+";
      if (k === "word") return ts.every((t) => t === t.toLowerCase()) ? "[a-z]+" : "[A-Za-z]+";
      if (k === "space") return "\\s+";
      return null;
    }
    return ts.every(isWordy) ? "[A-Za-z0-9]+" : null;
  }

  // The value itself on one page: every word or number generalized.
  function capturePart(t) {
    switch (kind(t)) {
      case "num": return "\\d+";
      case "caps": return "[A-Z]+";
      case "word": return "[A-Za-z]+";
      case "space": return "\\s+";
      default: return esc(t);
    }
  }

  // ---------- Patterns from one page ----------

  // How much a choice of left context is worth avoiding. Best: starts at a
  // delimiter and includes a word, like "/[A-Z]+-" before a number.
  function leftCost(ctx, atStart) {
    if (atStart) return 0.15 * ctx.length;
    if (!ctx.length) return 3;
    return (isDelim(ctx[0]) ? 0 : 1) + (ctx.some(isWordy) ? 0 : 0.7) + 0.25 * ctx.length;
  }

  function rightCost(ctx, atEnd, lazy) {
    if (!lazy) return atEnd ? 0.1 : 0.05 * ctx.length;
    if (atEnd) return 0.2 * ctx.length - 0.3;
    return (ctx.some(isWordy) ? 0 : 0.7) + 0.25 * ctx.length;
  }

  // Patterns that capture exactly `raw`, found at [from, to) in `text`, using
  // only this page. The value has to line up with whole tokens.
  function patterns(text, from, to, raw, isUrl = false) {
    const toks = tokens(text);
    const a = toks.findIndex((t) => t.start === from);
    const b = toks.findIndex((t) => t.end === to);
    if (a < 0 || b < a) return [];
    const inner = toks.slice(a, b + 1).map((t) => t.t);
    const lazy = inner.length > 5 || inner.some((t) => kind(t) === "space");
    const captures = [{ src: lazy ? ".+?" : inner.map(capturePart).join(""), lazy, cost: 0 }];
    if (isUrl && !/[/?#&]/.test(raw)) captures.push({ src: "[^/?#&]+", lazy: false, cost: inner.length > 1 ? -0.5 : 0.1 });
    const lefts = [];
    for (let k = 0; k <= 4 && a - k >= 0; k++) {
      const ctx = toks.slice(a - k, a).map((t) => t.t);
      const atStart = a - k === 0;
      lefts.push({ src: (atStart ? "^" : "") + ctx.map(contextPart).join(""), cost: leftCost(ctx, atStart) });
    }
    const out = [];
    for (const C of captures) {
      const rights = [];
      for (let k = 0; k <= 4 && b + 1 + k <= toks.length; k++) {
        const ctx = toks.slice(b + 1, b + 1 + k).map((t) => t.t);
        const atEnd = b + 1 + k === toks.length;
        const src = ctx.map(contextPart).join("");
        rights.push({ src: src + (atEnd ? "$" : ""), cost: rightCost(ctx, atEnd, C.lazy) + (atEnd && isUrl ? 0.8 : 0) });
        if (atEnd && !C.lazy) rights.push({ src, cost: 0.05 * ctx.length });
      }
      for (const L of lefts) {
        for (const R of rights) {
          if (C.lazy && !R.src) continue; // a lazy capture needs something to stop at
          out.push({ regex: `${L.src}(${C.src})${R.src}`, cost: L.cost + R.cost + C.cost, how: "" });
        }
      }
    }
    return out.sort(byCost);
  }

  // ---------- Patterns lined up across pages ----------

  // Loosest-first ladder of value patterns that cover every raw value seen.
  function captureLadder(raws, isUrl) {
    const out = [];
    const seqs = raws.map((r) => tokens(r).map((t) => t.t));
    if (seqs.every((s) => s.length === seqs[0].length) && seqs[0].length <= 5) {
      const parts = seqs[0].map((_, i) => {
        const ts = seqs.map((s) => s[i]);
        if (ts.every((t) => t === ts[0]) && kind(ts[0]) === "punct") return esc(ts[0]);
        const kinds = new Set(ts.map(kind));
        if (kinds.size === 1) return capturePart(ts[0]);
        return ts.every(isWordy) ? "[A-Za-z0-9]+" : null;
      });
      if (parts.every(Boolean)) out.push({ src: parts.join(""), lazy: false, cost: 0 });
    }
    const all = (re) => raws.every((r) => re.test(r));
    if (all(/^[A-Za-z0-9]+$/)) out.push({ src: "[A-Za-z0-9]+", lazy: false, cost: 0.1 });
    if (all(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)) out.push({ src: "[A-Za-z0-9][A-Za-z0-9_.-]*", lazy: false, cost: 0.15 });
    if (isUrl && all(/^[^/?#&\s]+$/)) out.push({ src: "[^/?#&]+", lazy: false, cost: seqs.some((s) => s.length > 1) ? -0.4 : 0.15 });
    if (!isUrl && all(/^\S+$/)) out.push({ src: "\\S+", lazy: false, cost: 0.3 });
    // "Anything up to ..." is the fallback: cheap only when nothing tighter fits.
    out.push({ src: ".+?", lazy: true, cost: out.length ? 0.6 : 0.2 });
    return out;
  }

  // Patterns for a value at aligned positions on several pages. `occs` holds
  // one occurrence per page: { text, start, end, raw }.
  function alignedPatterns(occs, isUrl) {
    const toks = occs.map((o) => tokens(o.text));
    const a = occs.map((o, i) => toks[i].findIndex((t) => t.start === o.start));
    const b = occs.map((o, i) => toks[i].findIndex((t) => t.end === o.end));
    if (a.some((x) => x < 0) || b.some((x, i) => x < a[i])) return [];

    const lefts = [];
    let leftSrc = "";
    for (let k = 0; k <= 5; k++) {
      if (k > 0) {
        if (a.some((x) => x - k < 0)) break;
        const part = contextAcross(a.map((x, i) => toks[i][x - k].t));
        if (part == null) break;
        leftSrc = part + leftSrc;
      }
      const atStart = a.every((x) => x - k === 0);
      const ctx = toks[0].slice(a[0] - k, a[0]).map((t) => t.t);
      lefts.push({ src: (atStart ? "^" : "") + leftSrc, cost: leftCost(ctx, atStart) });
      if (atStart) break;
    }
    const rights = [];
    let rightSrc = "";
    for (let k = 0; k <= 5; k++) {
      if (k > 0) {
        if (b.some((x, i) => x + k >= toks[i].length)) break;
        const part = contextAcross(b.map((x, i) => toks[i][x + k].t));
        if (part == null) break;
        rightSrc += part;
      }
      const atEnd = b.every((x, i) => x + k === toks[i].length - 1);
      const ctx = toks[0].slice(b[0] + 1, b[0] + 1 + k).map((t) => t.t);
      rights.push({ src: rightSrc, atEnd, ctx });
      if (atEnd) rights.push({ src: rightSrc + "$", atEnd, ctx, anchored: true });
    }

    const out = [];
    for (const C of captureLadder(occs.map((o) => o.raw), isUrl)) {
      for (const L of lefts) {
        for (const R of rights) {
          if (C.lazy && !R.src) continue;
          // Pinning to the end of a URL breaks as soon as it gains ?query=...
          const cost = L.cost + C.cost + (R.anchored ? rightCost(R.ctx, true, C.lazy) + (isUrl ? 0.8 : 0) : rightCost(R.ctx, false, C.lazy));
          out.push({ regex: `${L.src}(${C.src})${R.src}`, cost, how: "" });
        }
      }
    }
    return out;
  }

  // ---------- Structured ways to find a value ----------

  const DELIMS = [" · ", " | ", " - ", " – ", " — ", " :: ", " / ", " » ", " › ", ": "];

  // Ways that hold up across pages better than surrounding text: the URL's
  // folders (counting from either end), query parameters and subdomains, and
  // the parts of a title split on a separator.
  function structured(from, text, start, end) {
    const out = [];
    if (from === "url") {
      const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(text);
      if (m) {
        const hostStart = m[1].length;
        const pathStart = hostStart + m[2].length;
        const queryStart = pathStart + m[3].length;
        const hashStart = queryStart + (m[4]?.length ?? 0);
        // Folders.
        const segs = [];
        for (let pos = 0; pos < m[3].length;) {
          const next = m[3].indexOf("/", pos + 1);
          const segEnd = next < 0 ? m[3].length : next;
          segs.push({ start: pathStart + pos + 1, end: pathStart + segEnd });
          pos = segEnd;
        }
        const nonEmpty = segs.filter((s) => s.end > s.start);
        const n = nonEmpty.findIndex((s) => s.start === start && s.end === end);
        if (n >= 0) {
          const fromEnd = nonEmpty.length - 1 - n;
          out.push({ regex: `^[^:]+://[^/?#]+(?:/[^/?#]+){${n}}/([^/?#]+)`, how: `segment:${n + 1}`, cost: 0.25 });
          out.push({ regex: `/([^/?#]+)(?:/[^/?#]+){${fromEnd}}/?(?:[?#]|$)`, how: `segment:-${fromEnd + 1}`, cost: 0.3 });
        }
        // Query parameters.
        if (m[4] && start > queryStart && end <= hashStart) {
          for (const pm of m[4].slice(1).matchAll(/([^&=]+)=([^&]*)/g)) {
            const vs = queryStart + 1 + pm.index + pm[1].length + 1;
            if (vs === start && vs + pm[2].length === end) {
              out.push({ regex: `[?&]${esc(pm[1])}=([^&#]*)`, how: `query:${pm[1]}`, cost: 0.1 });
            }
          }
        }
        // Subdomains.
        if (start >= hostStart && end <= pathStart) {
          const labels = m[2].split(".");
          let pos = hostStart;
          labels.forEach((label, j) => {
            if (pos === start && pos + label.length === end && j < labels.length - 2) {
              out.push({ regex: `^[^:]+://(?:[^./?#]+\\.){${j}}([^./?#]+)\\.`, how: `host:${j}`, cost: 0.3 });
            }
            pos += label.length + 1;
          });
        }
      }
      return out;
    }
    // Text split on a separator, counting parts from either end.
    for (const D of DELIMS) {
      if (!text.includes(D)) continue;
      const pieces = text.split(D);
      let pos = 0;
      pieces.forEach((piece, p) => {
        const lead = piece.length - piece.trimStart().length;
        const s = pos + lead;
        const e = pos + piece.trimEnd().length;
        if (s === start && e === end) {
          const d = esc(D);
          const part = `(?:(?!${d}).)+`;
          out.push({ regex: `^(?:${part}${d}){${p}}((?:(?!${d}).)+)`, how: `split:${D}:${p}`, cost: 0.35 });
          // Anchored to the start or a separator, so it can't begin mid-part.
          out.push({ regex: `(?:^|${d})((?:(?!${d}).)+)(?:${d}${part}){${pieces.length - 1 - p}}$`, how: `split:${D}:-${pieces.length - p}`, cost: 0.3 });
        }
        pos += piece.length + D.length;
      });
    }
    return out;
  }

  // ---------- Where values can come from on a page ----------

  // Pieces are found ignoring case and treating - _ + like spaces, so
  // "fix-login" in a URL can give "Fix login". This keeps every character in
  // place, so positions in the loose text match positions in the real one.
  const loose = (s) => s.toLowerCase().replace(/[-_+]/g, " ");

  // The changes (see TR.transformValue) that turn `raw` into `piece`, simplest
  // first. If the text is already right as it is, no change is offered.
  const CASES = [["none", 0], ["lower", 0.3], ["upper", 0.3], ["capitalize", 0.3], ["title", 0.35]];
  function changesFor(raw, piece) {
    for (const nozeros of [false, true]) {
      if (nozeros && !/(^|\D)0\d/.test(raw)) continue;
      for (const spaces of [false, true]) {
        if (spaces && !/[-_+]/.test(raw)) continue;
        const out = CASES
          .filter(([transform]) => TR.transformValue(raw, { spaces, transform, nozeros }) === piece)
          .map(([transform, cost]) => ({ spaces, transform, nozeros, cost: cost + (spaces ? 0.2 : 0) + (nozeros ? 0.2 : 0) }));
        if (out.some((c) => c.transform === "none")) return out.filter((c) => c.transform === "none");
        if (out.length) return out;
      }
    }
    return [];
  }

  // Where `piece` appears in `text`, with the changes each spot needs. "42"
  // inside "0042" takes the zeros too, and drops them as a change.
  function occurrences(text, piece) {
    if (text == null) return [];
    const hay = loose(text);
    const needle = loose(piece);
    if (!needle || hay.length !== text.length) return [];
    const out = [];
    for (let i = hay.indexOf(needle); i >= 0 && out.length < 4; i = hay.indexOf(needle, i + 1)) {
      let start = i;
      if (/^\d/.test(piece)) while (start > 0 && text[start - 1] === "0") start--;
      const raw = text.slice(start, i + piece.length);
      const changes = changesFor(raw, piece);
      if (changes.length) out.push({ text, start, end: i + piece.length, raw, changes });
    }
    return out;
  }

  // Prefer elements found by id or test attribute over a position path.
  const selectorPenalty = (sel) =>
    0.6 + (/nth-of-type/.test(sel) ? 0.8 : 0) + (sel.length > 60 ? 0.3 : 0) - (/^#|\[data-/.test(sel) ? 0.15 : 0);

  // The texts a page offers, each with the ids that find it again on another
  // page (selectors for elements, the key for metadata, the label for labels).
  const fieldCache = new WeakMap();
  // Elements read from a page: ones whose text matched the wanted title,
  // colored labels, and ones the user picked.
  const pageElements = (ex) => [...(ex.elements ?? []), ...(ex.styled ?? []), ...(ex.picked ?? [])];

  function fields(ex) {
    if (fieldCache.has(ex)) return fieldCache.get(ex);
    const out = [
      { from: "url", ids: [""], text: TR.urlText(ex.url), penalty: 0 },
      { from: "title", ids: [""], text: ex.title, penalty: 0.5 },
    ];
    const seen = new Set();
    for (const e of pageElements(ex)) {
      const ids = e.selectors?.length ? e.selectors : [e.selector];
      if (seen.has(ids[0])) continue;
      seen.add(ids[0]);
      out.push({ from: "element", ids, text: e.text });
    }
    for (const [key, value] of Object.entries(ex.meta ?? {})) out.push({ from: "meta", ids: [key], text: value, penalty: 0.25 });
    for (const l of ex.labels ?? []) out.push({ from: "label", ids: [l.label], text: l.value, penalty: 0.45 });
    fieldCache.set(ex, out);
    return out;
  }

  const penaltyOf = (from, id, field) => (from === "element" ? selectorPenalty(id) : field?.penalty ?? 0.5);

  // A field's text on another page, found by its id.
  function fieldText(ex, from, id) {
    switch (from) {
      case "url": return TR.urlText(ex.url);
      case "title": return ex.title;
      case "element": return elementText(ex, id);
      case "meta": return ex.meta?.[id] ?? null;
      case "label": return labelText(ex, id);
    }
    return null;
  }

  function elementText(ex, selector) {
    for (const e of pageElements(ex)) {
      if (e.selector === selector || e.selectors?.includes(selector)) return e.text;
    }
    return null;
  }

  const labelText = (ex, label) => ex.labels?.find((l) => l.label.toLowerCase() === label.toLowerCase())?.value ?? null;

  // The folder a URL value sits in, as a name: "/units/sothe" gives "unit".
  function folderName(text, i) {
    const m = /\/([A-Za-z]+)\/$/.exec(text.slice(0, i));
    return m ? m[1].toLowerCase().replace(/(ies)$/, "y").replace(/([^s])s$/, "$1") : "";
  }

  // Every place on one example's page that contains `piece`, cheapest first.
  // Used while splitting the title; alignedSources() adds more once every
  // example's value is known.
  function sourcesFor(piece, ex) {
    const out = [];
    if (piece === squash(ex.title)) out.push({ from: "builtin", name: "title", cost: -1 });
    if (piece === hostOf(ex.url)) out.push({ from: "builtin", name: "host", cost: -1 });
    for (const f of fields(ex)) {
      for (const occ of occurrences(f.text, piece)) {
        const hint = f.from === "url" ? folderName(f.text, occ.start) : "";
        const whole = occ.start === 0 && occ.end === f.text.length && f.from !== "url" && f.from !== "title";
        const found = [
          // The whole text, with no pattern: clearest, so it wins ties.
          ...(whole ? [{ regex: "", cost: -0.2, how: "" }] : []),
          ...structured(f.from, f.text, occ.start, occ.end),
          ...patterns(f.text, occ.start, occ.end, occ.raw, f.from === "url").slice(0, 6),
        ];
        for (const id of f.ids.slice(0, 3)) {
          for (const p of found) {
            for (const c of occ.changes) {
              out.push(source(f.from, id, p, c, penaltyOf(f.from, id, f), hint));
            }
          }
        }
      }
    }
    return dedupe(out);
  }

  function source(from, id, p, c, penalty, hint = "") {
    return {
      from, selector: from === "url" || from === "title" ? "" : id, regex: p.regex, how: p.how ?? "",
      spaces: c.spaces, transform: c.transform, nozeros: c.nozeros, hint, cost: penalty + p.cost + c.cost,
    };
  }

  function dedupe(list) {
    const seen = new Set();
    return list.sort(byCost).filter((c) => !seen.has(sourceKey(c)) && seen.add(sourceKey(c)));
  }

  // Once a value is known on every example, candidates that line up across
  // all of them. `values[e]` is "" where the value is missing on purpose
  // (an optional part); those examples don't shape the patterns.
  function alignedSources(examples, values) {
    const present = examples.map((_, e) => e).filter((e) => values[e]);
    if (!present.length) return [];
    const out = [];
    const base = examples[present[0]];
    if (present.every((e) => values[e] === squash(examples[e].title))) out.push({ from: "builtin", name: "title", cost: -1 });
    if (present.every((e) => values[e] === hostOf(examples[e].url))) out.push({ from: "builtin", name: "host", cost: -1 });

    for (const f of fields(base)) {
      for (const id of f.ids) {
        const texts = present.map((e) => fieldText(examples[e], f.from, id));
        if (texts.some((t) => t == null)) continue;
        const occs = present.map((e, i) => occurrences(texts[i], values[e]));
        if (occs.some((o) => !o.length)) continue;
        // On each page, the occurrence whose surroundings best match the first page's.
        const first = occs[0][0];
        const aligned = occs.map((list) => list.reduce((best, o) => (similarity(o, first) > similarity(best, first) ? o : best)));
        const isUrl = f.from === "url";
        const found = [
          ...(aligned.every((o) => o.start === 0 && o.end === o.text.length) && !isUrl ? [{ regex: "", cost: -0.2, how: "" }] : []),
          ...structured(f.from, first.text, first.start, first.end),
          ...alignedPatterns(aligned, isUrl),
        ];
        const hint = isUrl ? folderName(first.text, first.start) : "";
        for (const p of found) {
          for (const c of first.changes) out.push(source(f.from, id, p, c, penaltyOf(f.from, id, f), hint));
        }
      }
    }
    return dedupe(out);
  }

  // How alike the text just before two occurrences is.
  function similarity(a, b) {
    let n = 0;
    while (n < 12 && a.start - n > 0 && b.start - n > 0 && a.text[a.start - n - 1] === b.text[b.start - n - 1]) n++;
    return n;
  }

  // What a source gives on an example's page ("" if it's not there). Uses the
  // same extraction as real tabs, with the example standing in for the page.
  const ctxCache = new WeakMap();
  function exampleCtx(ex) {
    if (!ctxCache.has(ex)) {
      ctxCache.set(ex, {
        url: ex.url,
        title: ex.title,
        elementText: (sel) => elementText(ex, sel),
        pageText: () => pageElements(ex).map((e) => e.text).join("\n"),
        meta: (key) => ex.meta?.[key] ?? null,
        labelValue: (label) => labelText(ex, label),
      });
    }
    return ctxCache.get(ex);
  }

  const asVar = (src) => ({ ...TR.newVar(), ...src, map: src.map ?? [], mapElse: src.mapElse ?? "keep" });

  function run(src, ex) {
    if (src.from === "builtin") return src.name === "title" ? squash(ex.title) : hostOf(ex.url);
    return TR.extract(asVar(src), exampleCtx(ex));
  }

  // ---------- Splitting the wanted title into fixed text and values ----------

  // Typing a character as fixed text vs. taking a value from the page.
  // Digits are almost always meant to vary (ids, counts), so keeping them
  // fixed costs more.
  const literalCost = (ch) => (/\d/.test(ch) ? 1.2 : 0.35);
  const VALUE_COST = 1;
  // Values start and end with a letter or digit; punctuation around them is
  // fixed text, so "[42]" becomes "[" + {num} + "]".
  const goodValue = (piece) => /^[A-Za-z0-9]/.test(piece) && /[A-Za-z0-9]$/.test(piece);

  // Cheapest way to write `want` as fixed text plus values from the page.
  // Values start and end on token boundaries of `want`.
  function segment(ex) {
    const want = ex.want;
    const n = want.length;
    const bounds = new Set([0, n, ...tokens(want).flatMap((t) => [t.start, t.end])]);
    const pageTexts = fields(ex).map((f) => loose(f.text));
    const cache = new Map();
    const best = Array(n + 1).fill(Infinity);
    const back = Array(n + 1);
    best[0] = 0;

    for (let i = 0; i < n; i++) {
      if (best[i] === Infinity) continue;
      const lit = literalCost(want[i]);
      if (best[i] + lit < best[i + 1]) {
        best[i + 1] = best[i] + lit;
        back[i + 1] = { from: i, lit: true };
      }
      if (!bounds.has(i)) continue;
      for (let j = i + 1; j <= n; j++) {
        const piece = want.slice(i, j);
        if (!pageTexts.some((t) => t.includes(loose(piece)))) break; // longer ones won't be found either
        if (!bounds.has(j) || !goodValue(piece) || (piece.length < 2 && !/\d/.test(piece))) continue;
        if (!cache.has(piece)) cache.set(piece, sourcesFor(piece, ex));
        const sources = cache.get(piece);
        if (!sources.length) continue;
        const cost = best[i] + VALUE_COST + 0.1 * sources[0].cost;
        if (cost < best[j]) {
          best[j] = cost;
          back[j] = { from: i, sources };
        }
      }
    }

    const parts = [];
    for (let j = n; j > 0; j = back[j].from) {
      const step = back[j];
      const text = want.slice(step.from, j);
      if (step.lit) {
        if (parts[0]?.lit !== undefined) parts[0].lit = text + parts[0].lit;
        else parts.unshift({ lit: text });
      } else {
        parts.unshift({ piece: text, sources: step.sources });
      }
    }
    return parts;
  }

  // ---------- Fitting all examples ----------

  // Splits a wanted title along the fixed text of `parts`, giving the value
  // each part should produce. Optional parts (p.opt) may be missing, which
  // gives "". null if the title doesn't fit.
  function expectedValues(parts, want) {
    let src = "^";
    parts.forEach((p, i) => {
      if (p.opt !== undefined && parts[i - 1]?.opt !== p.opt) src += "(?:";
      src += p.lit !== undefined ? esc(p.lit) : "(.+?)";
      if (p.opt !== undefined && parts[i + 1]?.opt !== p.opt) src += ")?";
    });
    const m = new RegExp(src + "$").exec(want);
    return m ? m.slice(1).map((v) => v ?? "") : null;
  }

  // Rather than picking one rule, keep every rule that gets all the examples
  // right (a "version space"). Each new example rules some out. A rule here is
  // a split of the title into fixed text and values, plus a source for each
  // value. Sources are grouped by place (the URL, the page title, one
  // element, a metadata key, a label, each with its change): different
  // patterns on the same text nearly always agree, so they count as one way.
  function sourceKey(src) {
    return `${placeKey(src)}|${src.regex ?? ""}`;
  }
  function placeKey(src) {
    const map = src.map?.length ? JSON.stringify(src.map) : "";
    return `${src.from}|${src.selector ?? ""}|${src.name ?? ""}|${src.transform ?? "none"}|${src.spaces ? 1 : 0}|${src.nozeros ? 1 : 0}|${map}`;
  }

  // Every distinct split found from any example, each value carrying all the
  // sources found for it on any of the examples.
  function splits(examples) {
    const bySignature = new Map();
    for (const base of examples) {
      const parts = segment(base);
      const signature = parts.map((p) => (p.lit !== undefined ? `L${p.lit}` : "V")).join("\u0000");
      const known = bySignature.get(signature);
      if (known) {
        parts.forEach((p, i) => p.lit === undefined && known[i].sources.push(...p.sources));
      } else {
        bySignature.set(signature, parts.map((p) => (p.lit !== undefined ? { lit: p.lit } : { piece: p.piece, sources: [...p.sources] })));
      }
    }
    return [...bySignature.values()];
  }

  const cloneParts = (parts) => parts.map((p) => ({ ...p }));

  // Keeps, for each value, the places that give the right text on every
  // example, adding candidates lined up across all examples. Returns null if
  // the split doesn't fit some example or a value has no place left.
  function narrow(parts, examples) {
    const expected = examples.map((ex) => expectedValues(parts, ex.want));
    if (expected.some((e) => !e)) return null;
    let k = 0;
    for (const p of parts) {
      if (p.lit !== undefined) continue;
      const values = expected.map((e) => e[k]);
      const pool = p.fixed ? p.options : [...p.sources, ...alignedSources(examples, values)];
      const places = new Map();
      for (const src of [...pool].sort(byCost)) {
        const place = placeKey(src);
        if (!places.has(place) && examples.every((ex, e) => run(src, ex) === values[e])) places.set(place, src);
      }
      p.options = [...places.values()].slice(0, 12);
      if (!p.options.length) return null;
      p.source = p.options[0];
      k++;
    }
    return parts;
  }

  // ---------- Fixed text that turns out to vary ----------

  // Typing "GT-" can look cheaper than reading "GT" from the page, until
  // another example says "WC-". When fixed text differs between titles,
  // try reading its words from the page instead, one piece of fixed text at
  // a time and then all of them together.
  function withValues(parts, examples) {
    const cores = parts
      .map((p, i) => ({ i, m: p.lit !== undefined && p.opt === undefined ? /^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/s.exec(p.lit) : null }))
      .filter((x) => x.m && x.m[2]);
    const out = [];
    const attempt = (chosen) => {
      const next = [];
      parts.forEach((p, i) => {
        const c = chosen.find((x) => x.i === i);
        if (!c) return next.push({ ...p });
        if (c.m[1]) next.push({ lit: c.m[1] });
        next.push({ piece: c.m[2], sources: [] });
        if (c.m[3]) next.push({ lit: c.m[3] });
      });
      const fitted = narrow(mergeLits(next), examples);
      if (fitted) out.push(fitted);
    };
    cores.forEach((c) => attempt([c]));
    if (cores.length > 1 && !out.length) attempt(cores);
    return out;
  }

  // ---------- Optional parts ----------

  // When some titles leave a value out, try making it optional, along with
  // the fixed text that belongs to it: "{num}{? [{status}]} · {name}". Only
  // fits if the value is really missing on those pages.
  const CLOSING = /^[)\]}>»"'”’]+/;
  function withOptional(parts, examples) {
    const valueAt = parts.map((p, i) => (p.lit === undefined ? i : -1)).filter((i) => i >= 0);
    const tries = [...valueAt.map((i) => [i]), ...(valueAt.length <= 4 ? pairs(valueAt) : [])];
    const out = [];
    for (const group of tries) {
      let next = cloneParts(parts);
      let shift = 0;
      group.forEach((vi, g) => {
        const i = vi + shift;
        const members = [i];
        const pre = next[i - 1]?.lit !== undefined && next[i - 1].opt === undefined ? i - 1 : -1;
        if (pre >= 0) members.unshift(pre);
        const after = next[i + 1];
        if (after?.lit !== undefined) {
          const close = pre < 0 ? after.lit : CLOSING.exec(after.lit)?.[0];
          if (close && close !== after.lit) {
            next.splice(i + 1, 1, { lit: close }, { lit: after.lit.slice(close.length) });
            shift++;
          }
          if (close) members.push(i + 1);
        }
        members.forEach((m) => (next[m].opt = g));
      });
      const fitted = narrow(next, examples);
      if (fitted && examples.some((ex) => expectedValues(fitted, ex.want).some((v) => v === ""))) out.push(fitted);
    }
    return out;
  }

  function pairs(list) {
    const out = [];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) out.push([list[i], list[j]]);
    return out;
  }

  // ---------- Lookups ----------

  // When fixed text differs between titles ("WIP · Fix login", "✓ · Bump
  // deps"), look for something on the pages it follows ("In Progress",
  // "Done") and learn a lookup from one to the other.
  function withLookups(parts, examples) {
    const out = [];
    parts.forEach((p, i) => {
      if (p.lit === undefined || p.opt !== undefined) return;
      // The varying part is the words in the fixed text; the punctuation and
      // spaces around them (" · ") stay fixed, so the slot has edges.
      const m = /^([^A-Za-z0-9]*)(.*?)([^A-Za-z0-9]*)$/s.exec(p.lit);
      if (!m[2]) return;
      const slot = cloneParts(parts);
      slot.splice(i, 1, ...(m[1] ? [{ lit: m[1] }] : []), { piece: "", sources: [], slot: true }, ...(m[3] ? [{ lit: m[3] }] : []));
      const at = slot.findIndex((q) => q.slot);
      const texts = examples.map((ex) => expectedValues(slot, ex.want)?.[slot.slice(0, at).filter((q) => q.lit === undefined).length]);
      if (texts.some((t) => t == null) || texts.every((t) => t === texts[0])) return;

      // Keep the shared start and end as fixed text, cut at word edges.
      let pre = commonPrefix(texts);
      let suf = commonPrefix(texts.map((t) => [...t].reverse().join(""))).split("").reverse().join("");
      while (pre && /[A-Za-z0-9]$/.test(pre)) pre = pre.slice(0, -1);
      while (suf && /^[A-Za-z0-9]/.test(suf)) suf = suf.slice(1);
      const looked = texts.map((t) => t.slice(pre.length, t.length - suf.length));
      if (looked.some((t) => !t.trim())) return;

      const key = lookupKey(examples, looked);
      if (!key) return;
      const value = { piece: looked[0], sources: [], fixed: true, options: [key], lookup: true };
      const next = mergeLits([...slot.slice(0, at), ...(pre ? [{ lit: pre }] : []), value, ...(suf ? [{ lit: suf }] : []), ...slot.slice(at + 1)]);
      const fitted = narrow(next, examples);
      if (fitted) out.push(fitted);
    });
    return out;
  }

  // Joins neighboring fixed-text parts into one.
  function mergeLits(parts) {
    const out = [];
    for (const p of parts) {
      const last = out[out.length - 1];
      if (p.lit !== undefined && last?.lit !== undefined && last.opt === p.opt) last.lit += p.lit;
      else out.push({ ...p });
    }
    return out;
  }

  function commonPrefix(list) {
    let n = 0;
    while (list.every((t) => n < t.length && t[n] === list[0][n])) n++;
    return list[0].slice(0, n);
  }

  // A page value that maps to the looked-up text consistently: the same
  // value always gives the same text. Prefers labels and colored labels, and
  // values that repeat over ones unique to each page.
  function lookupKey(examples, looked) {
    let best = null;
    for (const f of fields(examples[0])) {
      if (f.from === "url" || f.from === "title") continue;
      for (const id of f.ids.slice(0, 3)) {
        const keys = examples.map((ex) => fieldText(ex, f.from, id));
        if (keys.some((k) => !k || k.length > 60)) continue;
        const map = new Map();
        let ok = true;
        keys.forEach((k, e) => {
          const low = squash(k).toLowerCase();
          if (map.has(low) && map.get(low).to !== looked[e]) ok = false;
          map.set(low, { from: squash(k), to: looked[e] });
        });
        if (!ok || keys.every((k, e) => squash(k) === looked[e])) continue;
        const distinct = new Set(looked).size;
        if (map.size === examples.length && distinct < examples.length) continue; // only memorizing
        const styled = examples.every((ex) => ex.styled?.some((s) => s.selector === id || s.selectors?.includes(id)));
        const cost = penaltyOf(f.from, id, f) + 0.5 * (map.size - distinct) - (styled ? 0.4 : 0) - (f.from === "label" ? 0.3 : 0);
        if (!best || cost < best.cost) {
          best = {
            from: f.from, selector: id, regex: "", how: "", spaces: false, transform: "none", nozeros: false,
            map: [...map.values()], mapElse: "keep", cost: cost + 1,
          };
        }
      }
    }
    return best;
  }

  // ---------- Which pages a rule is for ----------

  const urlPath = (url) => { try { return new URL(url).pathname; } catch { return "/"; } };

  // Path parts that look like ids or slugs, which change from page to page.
  const looksVariable = (s) => /\d/.test(s) || s.length > 24 || s.split(/[-_]/).length >= 3 || /^[0-9a-f]{8,}$/i.test(s);

  // Path parts (by position) that the title reads a value from.
  function readParts(parts, ex) {
    const segs = TR.pathSegments(urlPath(ex.url));
    const read = new Set();
    for (const p of parts ?? []) {
      if (p.lit !== undefined || p.source?.from !== "url") continue;
      const value = run(p.source, ex);
      if (value) segs.forEach((seg, i) => { if (occurrences(seg, value).length) read.add(i); });
    }
    return read;
  }

  // Page patterns for a rule, narrowest first. The narrowest lines up the
  // examples' paths: parts that are the same everywhere stay, parts that
  // differ or that the title reads become "*". With one example, parts that
  // look like ids or slugs become "*" too. Wider options keep only the last
  // fixed part (the kind of page, like "pull"), then anything below it, then
  // every page ("").
  function pathScopes(examples, parts) {
    const all = examples.map((ex) => TR.pathSegments(urlPath(ex.url)));
    const reads = examples.map((ex) => readParts(parts, ex));
    let specific;
    if (all.every((segs) => segs.length === all[0].length)) {
      specific = all[0].map((seg, i) => {
        const same = all.every((segs) => segs[i].toLowerCase() === seg.toLowerCase());
        const read = reads.some((r) => r.has(i));
        return same && !read && !(examples.length === 1 && looksVariable(seg)) ? seg : "*";
      });
    } else {
      specific = [];
      for (let i = 0; all.every((segs) => segs[i] !== undefined && segs[i].toLowerCase() === all[0][i].toLowerCase())
        && !looksVariable(all[0][i]) && !reads.some((r) => r.has(i)); i++) specific.push(all[0][i]);
      specific.push("**");
    }
    const options = [];
    const add = (segs) => {
      const p = TR.normalizePath("/" + segs.join("/"));
      if (!options.includes(p)) options.push(p);
    };
    add(specific);
    const fixed = specific.map((seg, i) => (seg !== "*" && seg !== "**" ? i : -1)).filter((i) => i >= 0);
    const last = fixed.at(-1);
    if (last !== undefined) {
      add(specific.map((seg, i) => (i < last ? "*" : seg)));
      add([...specific.slice(0, last + 1).map((seg, i) => (i < last ? "*" : seg)), "**"]);
    }
    add([]);
    return options;
  }

  // ---------- Separate rules for different kinds of page ----------

  // If no single rule fits, look for a URL folder that tells the examples
  // apart ("/pull/" vs "/issues/") and check each group fits a rule of its own.
  function splitByUrl(examples) {
    if (examples.length < 2) return null;
    const segsOf = (ex) => { try { return new URL(ex.url).pathname.split("/").filter(Boolean); } catch { return []; } };
    const segs = examples.map(segsOf);
    const features = new Map();
    segs.forEach((list) => list.forEach((s, i) => {
      if (/^[a-z][a-z_-]{1,30}$/i.test(s)) features.set(`${i}|${s}`, { index: i, word: s });
    }));
    let best = null;
    for (const { index, word } of features.values()) {
      const inA = examples.map((_, e) => segs[e][index] === word);
      const A = examples.filter((_, e) => inA[e]);
      const B = examples.filter((_, e) => !inA[e]);
      if (!A.length || !B.length) continue;
      const fa = solve(A);
      const fb = solve(B);
      if (!fa.length || !fb.length) continue;
      const cost = splitCost(fa[0]) + splitCost(fb[0]) - (A.length > 1 ? 0.5 : 0) - (B.length > 1 ? 0.5 : 0);
      if (!best || cost < best.cost) {
        const bWord = B.every((ex) => segsOf(ex)[index] === segsOf(B[0])[index]) ? segsOf(B[0])[index] : "";
        best = {
          cost,
          groups: [
            { filter: `/${esc(word)}/`, label: word, examples: A },
            { filter: bWord && /^[a-z]/i.test(bWord) ? `/${esc(bWord)}/` : "", label: bWord || "other pages", examples: B },
          ],
        };
      }
    }
    return best ? best.groups.map((g) => ({ ...g, fit: fit(g.examples, { noSplit: true }) })) : null;
  }

  // ---------- Putting it together ----------

  function solve(examples) {
    const base = splits(examples);
    let space = base.map((parts) => narrow(cloneParts(parts), examples)).filter(Boolean);
    if (!space.length) space = base.flatMap((parts) => withValues(parts, examples));
    if (!space.length) space = base.flatMap((parts) => withOptional(parts, examples));
    if (!space.length) space = base.flatMap((parts) => withLookups(parts, examples));
    return space.sort((a, b) => splitCost(a) - splitCost(b));
  }

  function fitFrom(base, examples) {
    const parts = segment(base);
    const valueParts = parts.filter((p) => p.lit === undefined);
    const expected = examples.map((ex) => (ex === base ? valueParts.map((p) => p.piece) : expectedValues(parts, ex.want)));
    valueParts.forEach((p, k) => {
      let bestScore = -1;
      for (const src of p.sources) {
        const score = examples.filter((ex, e) => expected[e] && run(src, ex) === expected[e][k]).length;
        if (score > bestScore) {
          bestScore = score;
          p.source = src;
        }
        if (score === examples.length) break;
      }
    });
    const results = examples.map((ex) => ({ ok: assemble(parts, ex) === ex.want }));
    const passed = results.filter((r) => r.ok).length;
    return { parts, passed, score: passed * 100 - splitCost(parts) };
  }

  const splitCost = (parts) => parts.reduce((sum, p) => sum + (p.lit !== undefined ? 0 : p.source.cost), 0);
  const ruleCount = (parts) => parts.reduce((n, p) => n * (p.options?.length ?? 1), 1);

  // The title a split gives on an example, honoring optional parts.
  function assemble(parts, ex) {
    const vars = {};
    parts.forEach((p, i) => { if (p.lit === undefined) vars[`v${i}`] = run(p.source, ex); });
    return TR.render(templateOf(parts, (p, i) => `v${i}`), vars);
  }

  // Template text for a split, with {? ...} around optional groups.
  function templateOf(parts, nameOf) {
    let t = "";
    parts.forEach((p, i) => {
      if (p.opt !== undefined && parts[i - 1]?.opt !== p.opt) t += "{?";
      t += p.lit !== undefined ? p.lit.replace(/[{}]/g, "") : `{${nameOf(p, i)}}`;
      if (p.opt !== undefined && parts[i + 1]?.opt !== p.opt) t += "}";
    });
    return t;
  }

  // Concrete rules from the possible ones, simplest first, at most `limit`.
  // Each is a list of parts: { lit } or { source }, keeping p.opt.
  function variants(result, limit = 40) {
    const out = [];
    for (const parts of result.space) {
      const walk = (i, chosen) => {
        if (out.length >= limit) return;
        if (i === parts.length) return void out.push(chosen);
        const p = parts[i];
        if (p.lit !== undefined) return walk(i + 1, [...chosen, { lit: p.lit, opt: p.opt }]);
        for (const src of p.options) walk(i + 1, [...chosen, { source: src, opt: p.opt }]);
      };
      walk(0, []);
    }
    return out;
  }

  // The title one variant gives, from a function that reads a source's value.
  function renderVariant(variant, valueOf) {
    const vars = {};
    variant.forEach((p, i) => { if (p.source) vars[`v${i}`] = valueOf(p.source); });
    return TR.render(templateOf(variant, (p, i) => `v${i}`), vars);
  }

  // ---------- Turning the result into rule settings ----------

  // Words in selectors that say nothing about what the value is: tags,
  // selector syntax, generic names, and common utility classes (Tailwind etc.).
  const NAME_SKIP = new Set(["div", "span", "a", "p", "li", "td", "nth", "of", "type", "data", "testid", "test", "id",
    "val", "value", "field", "item", "text", "label", "content", "title", "view", "views", "base", "the",
    "truncate", "flex", "grid", "block", "inline", "hidden", "max", "min", "prose", "font", "bold", "semibold",
    "medium", "small", "large", "center", "left", "right", "top", "bottom", "items", "justify", "gap", "rounded",
    "border", "shadow", "wrap", "nowrap", "relative", "absolute", "sticky", "container", "wrapper", "inner", "outer",
    "col", "row", "cell", "link", "muted", "primary", "secondary", "xs", "sm", "md", "lg", "xl",
    "pill", "badge", "chip", "tag", "lozenge", "section", "main", "article", "header", "footer", "nav", "aside",
    "bdi", "bdo", "strong", "em", "small", "mark", "abbr", "cite", "code", "time"]);

  const META_NAMES = { "og:title": "name", "twitter:title": "name", "og:site_name": "site", description: "summary",
    "og:description": "summary", canonical: "link" };

  function nameFor(part, used) {
    const { piece, source } = part;
    const wordsOf = (o) => (o.selector.match(/[a-z]{3,}/gi) || []).map((w) => w.toLowerCase()).filter((w) => !NAME_SKIP.has(w));
    const own = source.from === "element" ? wordsOf(source) : [];
    const other = (part.options || []).filter((o) => o.from === "element").map(wordsOf).find((w) => w.length) || [];
    const words = own.length ? [own[own.length - 1]] : other.slice(0, 1);
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").replace(/^(\d)/, "_$1");
    let name = "value";
    if (source.from === "label") name = slug(source.selector) || "value";
    else if (source.from === "meta") {
      // "jsonld:brand.name" is the brand: skip generic last words.
      const words = source.selector.split(/[.:]/).filter((w) => !["name", "value", "text", "id", "jsonld", "og", "twitter"].includes(w.toLowerCase()));
      name = META_NAMES[source.selector] ?? (slug(words.pop() || "") || "value");
    }
    else if (/^query:/.test(source.how)) name = slug(source.how.slice(6)) || "param";
    else if (/^\d+$/.test(piece)) name = "num";
    else if (/^[A-Z]+-\d+$/.test(piece)) name = "key";
    else if (words.length) name = words[0];
    else if (source.from === "url" && source.hint?.length >= 3) name = source.hint;
    else if (piece.includes(" ")) name = "summary";
    else if (source.from === "url") name = "part";
    if (TR.BUILT_INS.includes(name)) name = `${name}2`;
    let unique = name;
    for (let i = 2; used.has(unique); i++) unique = `${name}${i}`;
    used.add(unique);
    return unique;
  }

  // The narrowest site pattern that covers every example: the host itself, or
  // *.shared.suffix when examples come from different subdomains.
  function hostFor(examples) {
    const hosts = [...new Set(examples.map((ex) => hostOf(ex.url)))];
    if (hosts.length === 1) return hosts[0];
    const split = hosts.map((h) => h.split(".").reverse());
    const common = [];
    for (let i = 0; split.every((s) => s[i] !== undefined && s[i] === split[0][i]); i++) common.push(split[0][i]);
    return common.length >= 2 ? `*.${common.reverse().join(".")}` : hosts[0];
  }

  // Main entry point. Returns null with no usable examples, else
  //   host, title, vars - settings for the simplest rule that fits
  //   parts   - each piece of the title: { lit } or { name, source, options },
  //             with p.opt on optional parts and p.lookup on looked-up values
  //   results - for each example, whether that rule gets it right
  //   count   - how many possible rules fit every example (0 if none do)
  //   space   - those possible rules, for variants()
  //   path    - the narrowest page pattern covering every example, and
  //   paths   - wider options, ending with "" (every page)
  //   split   - when nothing fits, groups that each fit a rule of their own:
  //             [{ filter, label, examples, fit }], each fit with its own path
  function fit(examples, opts = {}) {
    // Titles always come out with spaces collapsed and trimmed, so compare
    // against the wanted title the same way. Otherwise a trailing space, or a
    // non-breaking space copied from the page, makes a correct rule look wrong.
    examples = examples.filter((ex) => ex.want && ex.want.trim()).map((ex) => ({ ...ex, want: squash(ex.want) }));
    if (!examples.length) return null;

    const space = solve(examples);
    const count = space.reduce((n, parts) => n + ruleCount(parts), 0);
    const best = space.length
      ? { parts: space[0] }
      : examples.map((base) => fitFrom(base, examples)).sort((a, b) => b.score - a.score)[0];
    for (const p of best.parts) if (p.lit === undefined && !p.options) p.options = [p.source];
    const results = examples.map((ex) => {
      const got = assemble(best.parts, ex);
      return { ok: got === ex.want, got };
    });

    const used = new Set();
    const vars = [];
    for (const p of best.parts) {
      if (p.lit !== undefined) continue;
      if (p.source.from === "builtin") {
        p.name = p.source.name;
        continue;
      }
      p.name = nameFor(p, used);
      const s = p.source;
      vars.push({
        name: p.name,
        from: s.from,
        selector: s.selector ?? "",
        regex: s.regex,
        how: s.how ?? "",
        spaces: !!s.spaces,
        transform: s.transform || "none",
        nozeros: !!s.nozeros,
        map: s.map ?? [],
        mapElse: s.mapElse ?? "keep",
        required: p.opt === undefined,
      });
    }
    const title = templateOf(best.parts, (p) => p.name);
    const split = !count && !opts.noSplit ? splitByUrl(examples) : null;
    const paths = pathScopes(examples, best.parts);
    return { host: hostFor(examples), path: paths[0], paths, title, vars, parts: best.parts, results, count, space, split };
  }

  // ---------- Icons ----------
  //
  // Examples can also say what icon their tab should get (ex.look). Before
  // comparing them, two things that change from tab to tab are generalized:
  // badge text read from the page like the title is ("42" here and "43"
  // there is {num}), and colors that are a label's color on each page (the
  // badge takes that label's color wherever it is). If the icons then all
  // agree, that's the icon for every tab. If not, find something on the pages
  // that explains the difference, like a status label, and switch the icon
  // on it.

  const lookKey = (look) => JSON.stringify(TR.newLook(look));

  // Returns null when no example has an icon, else one of:
  //   { mode: "always", look }
  //   { mode: "switch", on, newVar, cases: [{ value, look }] }
  //     on is the value the icon depends on; newVar is set when that value
  //     isn't in the title and has to be added to the rule.
  //   { mode: "unknown" } when nothing on the pages explains the difference
  // "always" and "switch" also have
  //   textVars  - values the badge text uses that the title doesn't
  //   colorFrom - { selector, text } when colors come from a label
  function fitLook(examples, titleFit) {
    const taught = examples.filter((ex) => ex.look);
    if (!taught.length) return null;
    let looks = taught.map((ex) => TR.newLook({ ...ex.look, colorFrom: "" }));

    const text = fitBadgeText(taught, looks, titleFit);
    if (text) looks = looks.map((l) => ({ ...l, text: text.template }));
    const page = fitPageColor(taught, looks);
    if (page) {
      looks = looks.map((l) => TR.newLook({
        ...l,
        colorFrom: page.selector,
        // Where the label isn't on a page: gray, rather than one tab's color.
        color: GRAY, outlineColor: GRAY, tintColor: GRAY,
      }));
    }
    const extras = { textVars: text?.vars ?? [], colorFrom: page ? { selector: page.selector, text: page.text } : null };

    const keys = looks.map(lookKey);
    const distinct = new Set(keys);
    if (distinct.size === 1) return { mode: "always", look: looks[0], ...extras };

    // What could explain it: values already in the title, and elements,
    // labels and metadata on every taught page. Elements the user picked or
    // took a suggestion from (ex.hint) and colored labels are the likeliest.
    const candidates = [];
    for (const p of titleFit?.parts ?? []) {
      if (p.lit === undefined && p.source.from !== "builtin") candidates.push({ name: p.name, source: p.source, cost: 0.5 });
    }
    for (const f of fields(taught[0])) {
      if (f.from === "url" || f.from === "title") continue;
      for (const id of f.ids.slice(0, 4)) {
        if (!taught.every((ex) => fieldText(ex, f.from, id) != null)) continue;
        const styled = f.from === "element" && taught.every((ex) => ex.styled?.some((e) => e.selector === id || e.selectors?.includes(id)));
        const hinted = taught.some((ex) => ex.hint === id);
        const cost = (f.from === "label" ? 0.6 : f.from === "meta" ? 0.9 : 1) - (styled ? 0.5 : 0) - (hinted ? 1.5 : 0);
        candidates.push({ source: { from: f.from, selector: id, regex: "" }, cost });
      }
    }

    let best = null;
    for (const c of candidates) {
      const values = taught.map((ex) => run(c.source, ex));
      if (values.some((v) => !v)) continue;
      // The same value must always mean the same icon.
      const lookFor = new Map();
      let consistent = true;
      values.forEach((v, i) => {
        const k = v.toLowerCase();
        if (lookFor.has(k) && lookFor.get(k) !== keys[i]) consistent = false;
        lookFor.set(k, keys[i]);
      });
      if (!consistent) continue;
      // A value different on every page while some pages share an icon (an
      // id, a title) would only memorize the examples, not explain them.
      if (lookFor.size === taught.length && distinct.size < taught.length) continue;
      const score = c.cost + 0.5 * (lookFor.size - distinct.size)
        + (values.every((v) => /^\d+$/.test(v)) ? 1.5 : 0)
        + (values.some((v) => v.split(" ").length > 3) ? 1 : 0);
      if (!best || score < best.score) best = { ...c, values, score };
    }
    if (!best) return { mode: "unknown" };

    const cases = [];
    best.values.forEach((value, i) => {
      if (!cases.some((c) => c.value.toLowerCase() === value.toLowerCase())) cases.push({ value, look: looks[i] });
    });
    if (best.name) return { mode: "switch", on: best.name, newVar: null, cases, ...extras };
    const used = new Set([...(titleFit?.parts ?? []).map((p) => p.name), ...extras.textVars.map((v) => v.name)].filter(Boolean));
    const name = nameFor({ piece: best.values[0], source: best.source, options: [] }, used);
    return {
      mode: "switch",
      on: name,
      newVar: { name, from: best.source.from, selector: best.source.selector, regex: "", required: false },
      cases,
      ...extras,
    };
  }

  const GRAY = TR.COLORS[7];

  // Text badges whose text differs between tabs: learned like a title, as a
  // template with values from the page. Values the title already reads keep
  // its names; the rest are new values for the rule (textVars), never
  // required. null when the text is the same everywhere or can't be read
  // from the pages.
  function fitBadgeText(taught, looks, titleFit) {
    if (!looks.every((l) => l.style === "text" && l.text.trim())) return null;
    if (new Set(looks.map((l) => l.text)).size === 1) return null;
    const f = fit(taught.map((ex, i) => ({ ...ex, want: looks[i].text })), { noSplit: true });
    if (!f?.count || !f.results.every((r) => r.ok)) return null;
    const titleParts = (titleFit?.parts ?? []).filter((p) => p.lit === undefined && p.name);
    const used = new Set(titleParts.map((p) => p.name));
    const rename = new Map();
    const vars = [];
    for (const p of f.parts) {
      if (p.lit !== undefined || p.source.from === "builtin") continue;
      const same = titleParts.find((t) => t.source.from !== "builtin" && sourceKey(t.source) === sourceKey(p.source));
      if (same) {
        rename.set(p, same.name);
        continue;
      }
      let name = p.name;
      for (let i = 2; used.has(name); i++) name = `${p.name}${i}`;
      used.add(name);
      rename.set(p, name);
      const v = f.vars.find((x) => x.name === p.name);
      vars.push({ ...v, name, required: false });
    }
    return { template: templateOf(f.parts, (p) => rename.get(p) ?? p.name), vars };
  }

  // The colors a look actually uses.
  function colorsOf(l) {
    const out = [];
    if (l.style !== "none") out.push(l.color);
    if (l.outline !== "none") out.push(l.outlineColor);
    if (l.tint === "color") out.push(l.tintColor);
    return out.map((c) => c.toLowerCase());
  }

  // An element's color on an example's page, from the colored labels found
  // there or the elements the user picked.
  function colorAt(ex, selector) {
    for (const e of [...(ex.picked ?? []), ...(ex.styled ?? [])]) {
      if ((e.selector === selector || e.selectors?.includes(selector)) && e.color) return { color: e.color.toLowerCase(), text: e.text };
    }
    return null;
  }

  // A label whose color on every page is the color its icon uses. Taken
  // when the user pointed at that label (a suggestion or a pick), or when the
  // colors differ between pages and the label's follow along: then the icon
  // should follow the label on pages it hasn't seen too.
  function fitPageColor(taught, looks) {
    const used = looks.map(colorsOf);
    if (used.some((c) => !c.length || new Set(c).size > 1)) return null;
    const varies = new Set(used.map((c) => c[0])).size > 1;
    const hints = taught.map((ex) => ex.hint).filter(Boolean);
    const options = [...new Set([
      ...hints,
      ...(varies ? [...(taught[0].picked ?? []), ...(taught[0].styled ?? [])].flatMap((e) => e.selectors ?? [e.selector]) : []),
    ])];
    for (const selector of options) {
      const at = taught.map((ex) => colorAt(ex, selector));
      if (at.every((a, i) => a && a.color === used[i][0])) return { selector, text: at[0].text };
    }
    return null;
  }

  return { fit, fitLook, run, variants, renderVariant, sourceKey, tokens, patterns, structured };
})();
