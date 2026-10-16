// Builds a rule from examples. Each example is what a page had (URL, original
// title, element texts with selectors) plus the title the user wants for it.
// Works out which parts of the wanted title are fixed text and which come
// from the page, and for each of those, a selector and pattern that pull it
// out on every example.

self.Infer = (() => {
  const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ""; } };

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

  // Text around the value. Numbers and CAPS codes (ids, product codes) likely
  // change from page to page, so they're generalized; other words like
  // "items" are kept as they are.
  function contextPart(t) {
    switch (kind(t)) {
      case "num": return "\\d+";
      case "caps": return t.length > 1 ? "[A-Z]+" : esc(t);
      case "space": return t === " " ? " " : "\\s+";
      default: return esc(t);
    }
  }

  // The value itself: every word or number generalized.
  function capturePart(t) {
    switch (kind(t)) {
      case "num": return "\\d+";
      case "caps": return "[A-Z]+";
      case "word": return "[A-Za-z]+";
      case "space": return "\\s+";
      default: return esc(t);
    }
  }

  // ---------- Patterns for one value in one piece of text ----------

  // How much a choice of left context is worth avoiding. Best: starts at a
  // delimiter and includes a word, like "/[A-Z]+-" before a number.
  function leftCost(ctx, atStart) {
    if (atStart) return 0.15 * ctx.length;
    if (!ctx.length) return 3;
    return (isDelim(ctx[0].t) ? 0 : 1) + (ctx.some((c) => isWordy(c.t)) ? 0 : 0.7) + 0.25 * ctx.length;
  }

  function rightCost(ctx, atEnd, lazy) {
    if (!lazy) return atEnd ? 0.1 : 0.05 * ctx.length;
    if (atEnd) return 0.2 * ctx.length - 0.3;
    return (ctx.some((c) => isWordy(c.t)) ? 0 : 0.7) + 0.25 * ctx.length;
  }

  // Patterns that capture exactly `piece`, found at [from, to) in `text`.
  // The piece has to line up with whole tokens. Returns them cheapest first.
  // In URLs, a value can also be "the rest of this path segment".
  function patterns(text, from, to, piece, isUrl = false) {
    const toks = tokens(text);
    const a = toks.findIndex((t) => t.start === from);
    const b = toks.findIndex((t) => t.end === to);
    if (a < 0 || b < a) return [];
    const inner = toks.slice(a, b + 1);
    // Long or multi-word values become "anything up to the right context".
    const lazy = inner.length > 5 || inner.some((t) => kind(t.t) === "space");
    const captures = [{ src: lazy ? ".+?" : inner.map((t) => capturePart(t.t)).join(""), lazy, cost: 0 }];
    // For multi-word slugs ("fix-login-redirect") the whole segment is the
    // better guess: it fits slugs with any number of words.
    if (isUrl && !/[/?#&]/.test(piece)) captures.push({ src: "[^/?#&]+", lazy: false, cost: inner.length > 1 ? -0.5 : 0.1 });

    const lefts = [];
    for (let k = 0; k <= 4 && a - k >= 0; k++) {
      const ctx = toks.slice(a - k, a);
      const atStart = a - k === 0;
      lefts.push({ src: (atStart ? "^" : "") + ctx.map((c) => contextPart(c.t)).join(""), cost: leftCost(ctx, atStart) });
    }
    const out = [];
    for (const C of captures) {
      const rights = [];
      for (let k = 0; k <= 4 && b + 1 + k <= toks.length; k++) {
        const ctx = toks.slice(b + 1, b + 1 + k);
        const atEnd = b + 1 + k === toks.length;
        const src = ctx.map((c) => contextPart(c.t)).join("");
        rights.push({ src: src + (atEnd ? "$" : ""), cost: rightCost(ctx, atEnd, C.lazy) });
        // Numbers, codes and path segments stop by themselves, so they don't
        // need pinning to the end (which breaks if a URL gains ?query=...).
        if (atEnd && !C.lazy) rights.push({ src, cost: 0.05 * ctx.length });
      }
      for (const L of lefts) {
        for (const R of rights) {
          if (C.lazy && !R.src) continue; // a lazy capture needs something to stop at
          const regex = `${L.src}(${C.src})${R.src}`;
          let m;
          try { m = new RegExp(regex).exec(text); } catch { continue; }
          if (m && squash(m[1]) === squash(piece)) out.push({ regex, cost: L.cost + R.cost + C.cost });
        }
      }
    }
    return out.sort((x, y) => x.cost - y.cost);
  }

  // ---------- Where a piece of the wanted title can come from ----------

  // Pieces are found ignoring case and treating - _ + like spaces, so
  // "fix-login" in a URL can give "Fix login". This keeps every character in
  // place, so positions in the loose text match positions in the real one.
  const loose = (s) => s.toLowerCase().replace(/[-_+]/g, " ");

  // The changes (see TR.transformValue) that turn `raw` into `piece`, simplest
  // first. If the text is already right as it is, no change is offered.
  const CHANGES = [["none", 0], ["lower", 0.3], ["upper", 0.3], ["capitalize", 0.3], ["title", 0.35]];
  function changesFor(raw, piece) {
    for (const spaces of [false, true]) {
      if (spaces && !/[-_+]/.test(raw)) continue;
      const out = CHANGES
        .filter(([transform]) => TR.transformValue(raw, { spaces, transform }) === piece)
        .map(([transform, cost]) => ({ spaces, transform, cost: cost + (spaces ? 0.2 : 0) }));
      if (out.some((c) => c.transform === "none")) return out.filter((c) => c.transform === "none");
      if (out.length) return out;
    }
    return [];
  }

  // The folder a URL value sits in, as a name: "/units/sothe" gives "unit".
  function folderName(text, i) {
    const m = /\/([A-Za-z]+)\/$/.exec(text.slice(0, i));
    return m ? m[1].toLowerCase().replace(/(ies)$/, "y").replace(/([^s])s$/, "$1") : "";
  }

  // Every place in the example's page that contains `piece`, with a pattern
  // and any change needed for each. Cheapest (most robust) first.
  function sourcesFor(piece, ex) {
    const out = [];
    if (piece === squash(ex.title)) out.push({ from: "builtin", name: "title", cost: -1 });
    if (piece === hostOf(ex.url)) out.push({ from: "builtin", name: "host", cost: -1 });

    const texts = [
      { from: "url", text: TR.urlText(ex.url), penalty: 0 },
      { from: "title", text: ex.title, penalty: 0.5 },
      ...[...ex.elements, ...(ex.styled ?? []).filter((st) => !ex.elements.some((e) => e.selector === st.selector))].map((e) => ({
        from: "element",
        text: e.text,
        selector: e.selector,
        // Prefer elements found by id or test attribute over a position path.
        penalty: 0.6 + (/nth-of-type/.test(e.selector) ? 0.8 : 0) + (e.selector.length > 60 ? 0.3 : 0),
      })),
    ];
    const needle = loose(piece);
    for (const src of texts) {
      const hay = loose(src.text);
      if (hay.length !== src.text.length) continue; // rare letters that change length when lowercased
      for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
        const raw = src.text.slice(i, i + piece.length);
        const changes = changesFor(raw, piece);
        if (!changes.length) continue;
        const hint = src.from === "url" ? folderName(src.text, i) : "";
        const found = src.from === "element" && raw === src.text
          ? [{ regex: "", cost: 0 }]
          : patterns(src.text, i, i + raw.length, raw, src.from === "url").slice(0, 4);
        for (const p of found) {
          for (const c of changes) {
            out.push({
              from: src.from, selector: src.selector, regex: p.regex, spaces: c.spaces, transform: c.transform, hint,
              cost: src.penalty + p.cost + c.cost,
            });
          }
        }
      }
    }
    const seen = new Set();
    return out
      .sort((x, y) => x.cost - y.cost)
      .filter((c) => !seen.has(sourceKey(c)) && seen.add(sourceKey(c)));
  }

  // What a source gives on an example's page ("" if it's not there).
  function run(src, ex) {
    if (src.from === "builtin") return src.name === "title" ? squash(ex.title) : hostOf(ex.url);
    const text = src.from === "url" ? TR.urlText(ex.url)
      : src.from === "title" ? ex.title
      : elementText(ex, src.selector);
    if (text == null) return "";
    if (!src.regex) return TR.transformValue(text, src);
    const m = new RegExp(src.regex).exec(text);
    return m ? TR.transformValue(m[1] ?? m[0], src) : "";
  }

  // An element's text on an example's page, from either list read from it.
  function elementText(ex, selector) {
    return (ex.elements.find((e) => e.selector === selector) ?? ex.styled?.find((e) => e.selector === selector))?.text;
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
    const pageTexts = [TR.urlText(ex.url), ex.title, ...ex.elements.map((e) => e.text), ...(ex.styled ?? []).map((e) => e.text)].map(loose);
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

  // Splits another example's wanted title along the fixed text of `parts`,
  // giving the value each part should produce there. null if it doesn't fit.
  function expectedValues(parts, want) {
    const re = new RegExp("^" + parts.map((p) => (p.lit !== undefined ? esc(p.lit) : "(.+?)")).join("") + "$");
    const m = re.exec(want);
    return m ? m.slice(1) : null;
  }

  function fitFrom(base, examples) {
    const parts = segment(base);
    const valueParts = parts.filter((p) => p.lit === undefined);
    const expected = examples.map((ex) => (ex === base ? valueParts.map((p) => p.piece) : expectedValues(parts, ex.want)));

    // For each value, the cheapest source that's right on the most examples.
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

    const results = examples.map((ex) => {
      const got = parts.map((p) => (p.lit !== undefined ? p.lit : run(p.source, ex))).join("");
      return { ok: got === ex.want, got };
    });
    const passed = results.filter((r) => r.ok).length;
    const cost = valueParts.reduce((sum, p) => sum + p.source.cost, 0);
    return { parts, results, passed, score: passed * 100 - cost };
  }

  // ---------- The possible rules ----------
  //
  // Rather than picking one rule, keep every rule that gets all the examples
  // right (a "version space"). Each new example rules some out. A rule here is
  // a split of the title into fixed text and values, plus a source for each
  // value. Sources are grouped by place (the URL, the page title, one
  // element): different patterns on the same text nearly always agree, so
  // they count as one way.

  // A different change (case, spaces) gives different text, so it counts as
  // a different way even from the same place.
  function sourceKey(src) {
    return `${placeKey(src)}|${src.regex ?? ""}`;
  }
  function placeKey(src) {
    return `${src.from}|${src.selector ?? ""}|${src.name ?? ""}|${src.transform ?? "none"}|${src.spaces ? 1 : 0}`;
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

  // Keeps, for each value, the places that give the right text on every
  // example (with the cheapest pattern that does). Returns null if the split
  // doesn't fit some example or a value has no place left.
  function narrow(parts, examples) {
    const expected = examples.map((ex) => expectedValues(parts, ex.want));
    if (expected.some((e) => !e)) return null;
    let k = 0;
    for (const p of parts) {
      if (p.lit !== undefined) continue;
      const places = new Map();
      for (const src of [...p.sources].sort((a, b) => a.cost - b.cost)) {
        const place = placeKey(src);
        if (!places.has(place) && examples.every((ex, e) => run(src, ex) === expected[e][k])) places.set(place, src);
      }
      p.options = [...places.values()];
      if (!p.options.length) return null;
      p.source = p.options[0];
      k++;
    }
    return parts;
  }

  const splitCost = (parts) => parts.reduce((sum, p) => sum + (p.lit !== undefined ? 0 : p.source.cost), 0);
  const ruleCount = (parts) => parts.reduce((n, p) => n * (p.options?.length ?? 1), 1);

  // Concrete rules from the possible ones, simplest first, at most `limit`.
  // Each is a list of parts: { lit } or { source }.
  function variants(result, limit = 40) {
    const out = [];
    for (const parts of result.space) {
      const walk = (i, chosen) => {
        if (out.length >= limit) return;
        if (i === parts.length) return void out.push(chosen);
        const p = parts[i];
        if (p.lit !== undefined) return walk(i + 1, [...chosen, { lit: p.lit }]);
        for (const src of p.options) walk(i + 1, [...chosen, { source: src }]);
      };
      walk(0, []);
    }
    return out;
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
    "pill", "badge", "chip", "tag", "lozenge"]);

  function nameFor(part, used) {
    const { piece, source } = part;
    // A word from an element's selector (#status-val gives "status") says
    // the most: the value's own element if it comes from one, else the first
    // element it could also come from. Otherwise go by what the value looks like.
    const wordsOf = (o) => (o.selector.match(/[a-z]{3,}/gi) || []).map((w) => w.toLowerCase()).filter((w) => !NAME_SKIP.has(w));
    const own = source.from === "element" ? wordsOf(source) : [];
    const other = (part.options || []).filter((o) => o.from === "element").map(wordsOf).find((w) => w.length) || [];
    const words = own.length ? [own[own.length - 1]] : other.slice(0, 1);
    let name = "value";
    if (/^\d+$/.test(piece)) name = "num";
    else if (/^[A-Z]+-\d+$/.test(piece)) name = "key";
    else if (words.length) name = words[0];
    else if (source.from === "url" && source.hint?.length >= 3) name = source.hint;
    else if (piece.includes(" ")) name = "summary";
    else if (source.from === "url") name = "part";
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
  //             where options are all the places that value could come from
  //   results - for each example, whether that rule gets it right
  //   count   - how many possible rules fit every example (0 if none do)
  //   space   - those possible rules, for variants()
  function fit(examples) {
    // Titles always come out with spaces collapsed and trimmed, so compare
    // against the wanted title the same way. Otherwise a trailing space, or a
    // non-breaking space copied from the page, makes a correct rule look wrong.
    examples = examples.filter((ex) => ex.want && ex.want.trim()).map((ex) => ({ ...ex, want: squash(ex.want) }));
    if (!examples.length) return null;

    const space = splits(examples).map((parts) => narrow(parts, examples)).filter(Boolean);
    space.sort((a, b) => splitCost(a) - splitCost(b));
    const count = space.reduce((n, parts) => n + ruleCount(parts), 0);

    // If nothing fits every example, use the split that fits the most, so
    // it's clear which examples are the problem.
    const best = space.length
      ? { parts: space[0] }
      : examples.map((base) => fitFrom(base, examples)).sort((a, b) => b.score - a.score)[0];
    for (const p of best.parts) if (p.lit === undefined && !p.options) p.options = [p.source];
    const results = examples.map((ex) => {
      const got = best.parts.map((p) => (p.lit !== undefined ? p.lit : run(p.source, ex))).join("");
      return { ok: got === ex.want, got };
    });

    const used = new Set();
    const vars = [];
    let title = "";
    for (const p of best.parts) {
      if (p.lit !== undefined) {
        title += p.lit;
      } else if (p.source.from === "builtin") {
        p.name = p.source.name;
        title += `{${p.name}}`;
      } else {
        p.name = nameFor(p, used);
        title += `{${p.name}}`;
        vars.push({
          name: p.name,
          from: p.source.from,
          selector: p.source.selector ?? "",
          regex: p.source.regex,
          spaces: !!p.source.spaces,
          transform: p.source.transform || "none",
          required: true,
        });
      }
    }
    return { host: hostFor(examples), title, vars, parts: best.parts, results, count, space };
  }

  // ---------- Icons ----------
  //
  // Examples can also say what icon their tab should get (ex.look). If they
  // all agree, that's the icon for every tab. If not, find something on the
  // pages that explains the difference, like a status label, and switch the
  // icon on it.

  const lookKey = (look) => JSON.stringify(TR.newLook(look));

  // Returns null when no example has an icon, else one of:
  //   { mode: "always", look }
  //   { mode: "switch", on, newVar, cases: [{ value, look }] }
  //     on is the value the icon depends on; newVar is set when that value
  //     isn't in the title and has to be added to the rule.
  //   { mode: "unknown" } when nothing on the pages explains the difference
  function fitLook(examples, titleFit) {
    const taught = examples.filter((ex) => ex.look);
    if (!taught.length) return null;
    const looks = new Set(taught.map((ex) => lookKey(ex.look)));
    if (looks.size === 1) return { mode: "always", look: TR.newLook(taught[0].look) };

    // What could explain it: values already in the title, and elements that
    // are on every taught page. Elements the user picked a suggestion from
    // (ex.hint) and colored labels are the likeliest.
    const candidates = [];
    for (const p of titleFit?.parts ?? []) {
      if (p.lit === undefined && p.source.from !== "builtin") candidates.push({ name: p.name, source: p.source, cost: 0.5 });
    }
    const selectorsOn = (ex) => new Set([...ex.elements, ...(ex.styled ?? [])].map((e) => e.selector));
    const everywhere = taught.map(selectorsOn).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
    for (const selector of everywhere) {
      const styled = taught.every((ex) => ex.styled?.some((e) => e.selector === selector));
      const hinted = taught.some((ex) => ex.hint === selector);
      candidates.push({ source: { from: "element", selector, regex: "" }, cost: 1 - (styled ? 0.5 : 0) - (hinted ? 1.5 : 0) });
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
        const look = lookKey(taught[i].look);
        if (lookFor.has(k) && lookFor.get(k) !== look) consistent = false;
        lookFor.set(k, look);
      });
      if (!consistent) continue;
      // A value different on every page while some pages share an icon (an
      // id, a title) would only memorize the examples, not explain them.
      if (lookFor.size === taught.length && looks.size < taught.length) continue;
      // Prefer values that repeat, like a status, over numbers and long text.
      const score = c.cost + 0.5 * (lookFor.size - looks.size)
        + (values.every((v) => /^\d+$/.test(v)) ? 1.5 : 0)
        + (values.some((v) => v.split(" ").length > 3) ? 1 : 0);
      if (!best || score < best.score) best = { ...c, values, score };
    }
    if (!best) return { mode: "unknown" };

    const cases = [];
    best.values.forEach((value, i) => {
      if (!cases.some((c) => c.value.toLowerCase() === value.toLowerCase())) cases.push({ value, look: TR.newLook(taught[i].look) });
    });
    if (best.name) return { mode: "switch", on: best.name, newVar: null, cases };
    const words = (best.source.selector.match(/[a-z]{3,}/gi) || []).map((w) => w.toLowerCase()).filter((w) => !NAME_SKIP.has(w));
    const used = new Set((titleFit?.parts ?? []).map((p) => p.name).filter(Boolean));
    let name = words.at(-1) || "label";
    for (let i = 2; used.has(name); i++) name = `${words.at(-1) || "label"}${i}`;
    return {
      mode: "switch",
      on: name,
      newVar: { name, from: "element", selector: best.source.selector, regex: "", spaces: false, transform: "none", required: false },
      cases,
    };
  }

  return { fit, fitLook, run, variants, sourceKey, tokens, patterns };
})();
