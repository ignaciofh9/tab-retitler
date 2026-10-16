// Sharing rules: a compact code to paste anywhere, and readable JSON for
// files and for checking a rule before importing it. Teaching examples never
// go in either: they hold text copied from your pages.
//
// Code format, "TR2:" + base64url(deflate-raw(payload)). The payload is a
// fixed-order binary layout with no field names: choices are small numbers,
// palette colors one byte, and an icon's unchanged parts are skipped using a
// bitmask. Any change to the layout needs a new FORMAT number, and decode()
// must keep reading the old ones so existing codes still import.

self.Share = (() => {
  const PREFIX = "TR2:";
  // 2 added metadata and label sources and the newer value changes (pick,
  // leading zeros, length limit, lookups); 3 added page scopes ("/products/*").
  // Older codes still import.
  const FORMAT = 3;
  const MAX_PAYLOAD = 1 << 20; // refuse anything that inflates past 1 MB

  const FROM = ["url", "title", "element", "page"]; // format 1's sources
  const SOURCES = TR.SOURCES;
  const PICKS = TR.PICKS;
  const KEYED = new Set(["element", "meta", "label"]);
  const CASES = ["none", "lower", "upper", "capitalize", "title"];
  const STYLES = ["none", "dot", "text"];
  const SHAPES = ["round", "square", "corner"];
  const POSITIONS = ["br", "bl", "tr", "tl"];
  const SIZES = ["s", "m", "l"];
  const OUTLINES = ["none", "thin", "thick"];
  const TINTS = ["none", "color", "gray", "fade"];
  const OPS = TR.CASE_OPS;
  const CUSTOM_COLOR = 15;

  const index = (list, value) => Math.max(0, list.indexOf(value));
  const pick = (list, value, fallback = list[0]) => (list.includes(value) ? value : fallback);
  const isHex = (c) => /^#[0-9a-f]{6}$/i.test(String(c));

  // ---------- Binary writer and reader ----------

  class Writer {
    constructor() { this.bytes = []; }
    uint(n) {
      n = Math.max(0, Math.floor(n)) >>> 0;
      do {
        let b = n & 127;
        n >>>= 7;
        if (n) b |= 128;
        this.bytes.push(b);
      } while (n);
    }
    str(s) {
      const b = new TextEncoder().encode(String(s ?? ""));
      this.uint(b.length);
      for (const x of b) this.bytes.push(x);
    }
    color(c) {
      const hex = isHex(c) ? c.toLowerCase() : TR.COLORS[4];
      const i = TR.COLORS.indexOf(hex);
      if (i >= 0) return this.uint(i);
      this.uint(CUSTOM_COLOR);
      for (let k = 1; k < 7; k += 2) this.bytes.push(parseInt(hex.slice(k, k + 2), 16));
    }
  }

  // Reading checks every length and range, so a damaged code fails cleanly.
  class Reader {
    constructor(bytes) { this.b = bytes; this.i = 0; }
    byte() {
      if (this.i >= this.b.length) throw new Error("ended early");
      return this.b[this.i++];
    }
    uint() {
      let n = 0;
      for (let shift = 0; ; shift += 7) {
        if (shift > 28) throw new Error("number too long");
        const b = this.byte();
        n |= (b & 127) << shift;
        if (!(b & 128)) return n >>> 0;
      }
    }
    str() {
      const len = this.uint();
      if (this.i + len > this.b.length) throw new Error("text runs past the end");
      const s = new TextDecoder().decode(this.b.subarray(this.i, this.i + len));
      this.i += len;
      return s;
    }
    color() {
      const n = this.uint();
      if (n < TR.COLORS.length) return TR.COLORS[n];
      if (n !== CUSTOM_COLOR) throw new Error("bad color");
      return "#" + [this.byte(), this.byte(), this.byte()].map((v) => v.toString(16).padStart(2, "0")).join("");
    }
    choice(list) {
      const n = this.uint();
      if (n >= list.length) throw new Error("bad choice");
      return list[n];
    }
  }

  // ---------- Layout ----------

  function writeLook(w, l) {
    const d = TR.newLook();
    const parts = [
      l.style !== d.style || l.color !== d.color || l.text !== d.text,
      l.shape !== d.shape || l.position !== d.position || l.size !== d.size,
      l.outline !== d.outline || l.outlineColor !== d.outlineColor,
      l.tint !== d.tint || l.tintColor !== d.tintColor || l.tintAmount !== d.tintAmount,
    ];
    w.uint(parts.reduce((mask, on, i) => mask | (on ? 1 << i : 0), 0));
    if (parts[0]) { w.uint(index(STYLES, l.style)); w.color(l.color); w.str(l.text); }
    if (parts[1]) w.uint(index(SHAPES, l.shape) | (index(POSITIONS, l.position) << 2) | (index(SIZES, l.size) << 4));
    if (parts[2]) { w.uint(index(OUTLINES, l.outline)); w.color(l.outlineColor); }
    if (parts[3]) { w.uint(index(TINTS, l.tint)); w.color(l.tintColor); w.uint(Math.min(100, l.tintAmount)); }
  }

  function readLook(r) {
    const l = TR.newLook();
    const mask = r.uint();
    if (mask > 15) throw new Error("bad icon");
    if (mask & 1) { l.style = r.choice(STYLES); l.color = r.color(); l.text = r.str(); }
    if (mask & 2) {
      const n = r.uint();
      l.shape = SHAPES[n & 3] ?? fail();
      l.position = POSITIONS[(n >> 2) & 3];
      l.size = SIZES[(n >> 4) & 3] ?? fail();
    }
    if (mask & 4) { l.outline = r.choice(OUTLINES); l.outlineColor = r.color(); }
    if (mask & 8) { l.tint = r.choice(TINTS); l.tintColor = r.color(); l.tintAmount = Math.min(100, r.uint()); }
    return l;
  }

  function fail() { throw new Error("bad value"); }

  function writeRule(w, rule) {
    const sw = rule.badgeSwitch;
    const hasSwitch = sw.enabled || sw.cases.length > 0 || !!sw.on;
    w.uint((rule.enabled ? 1 : 0) | (rule.urlFilter ? 2 : 0) | (hasSwitch ? 4 : 0) | (sw.enabled ? 8 : 0) | (rule.path ? 16 : 0));
    w.str(rule.name);
    w.str(rule.host);
    w.str(rule.shareId);
    w.str(rule.title);
    if (rule.urlFilter) w.str(rule.urlFilter);
    if (rule.path) w.str(rule.path);
    w.uint(rule.vars.length);
    for (const v of rule.vars) {
      w.str(v.name);
      w.uint(index(SOURCES, v.from));
      w.uint(index(CASES, v.transform) | (v.spaces ? 8 : 0) | (v.required ? 16 : 0) | (v.nozeros ? 32 : 0)
        | (index(PICKS, v.pick) << 6) | (v.mapElse === "empty" ? 256 : 0));
      if (KEYED.has(v.from)) w.str(v.selector);
      w.str(v.regex);
      w.uint(v.max || 0);
      w.uint(v.map.length);
      for (const m of v.map) { w.str(m.from); w.str(m.to); }
      w.str(v.how || "");
    }
    writeLook(w, rule.badge);
    if (hasSwitch) {
      w.str(sw.on);
      w.uint(sw.cases.length);
      for (const c of sw.cases) {
        w.uint(index(OPS, c.op));
        w.str(c.value);
        writeLook(w, c.badge);
      }
    }
  }

  function readRule(r, format) {
    const flags = r.uint();
    if (flags > (format >= 3 ? 31 : 15)) throw new Error("bad rule");
    const rule = { enabled: !!(flags & 1), name: r.str(), host: r.str(), shareId: r.str(), title: r.str() };
    rule.urlFilter = flags & 2 ? r.str() : "";
    rule.path = flags & 16 ? r.str() : "";
    rule.vars = [];
    for (let n = r.uint(); n > 0; n--) rule.vars.push(format === 1 ? readVar1(r) : readVar2(r));
    rule.badge = readLook(r);
    rule.badgeSwitch = { enabled: !!(flags & 8), on: "", cases: [] };
    if (flags & 4) {
      rule.badgeSwitch.on = r.str();
      for (let n = r.uint(); n > 0; n--) {
        rule.badgeSwitch.cases.push({ op: r.choice(OPS), value: r.str(), badge: readLook(r) });
      }
    }
    return rule;
  }

  function readVar1(r) {
    const name = r.str();
    const bits = r.uint();
    if (bits > 127) throw new Error("bad value");
    const from = FROM[bits & 3];
    const transform = CASES[(bits >> 2) & 7] ?? fail();
    return {
      name, from, transform, spaces: !!(bits & 32), required: !!(bits & 64),
      selector: from === "element" ? r.str() : "",
      regex: r.str(),
    };
  }

  function readVar2(r) {
    const name = r.str();
    const from = r.choice(SOURCES);
    const bits = r.uint();
    if (bits > 511) throw new Error("bad value");
    const v = {
      name, from,
      transform: CASES[bits & 7] ?? fail(),
      spaces: !!(bits & 8), required: !!(bits & 16), nozeros: !!(bits & 32),
      pick: PICKS[(bits >> 6) & 3], mapElse: bits & 256 ? "empty" : "keep",
      selector: KEYED.has(from) ? r.str() : "",
    };
    v.regex = r.str();
    v.max = r.uint();
    v.map = [];
    for (let n = r.uint(); n > 0; n--) v.map.push({ from: r.str(), to: r.str() });
    v.how = r.str();
    return v;
  }

  // ---------- Checksum ----------

  // Fletcher-16 over the payload, appended as two bytes. Compressed data has
  // no check of its own, so without this a mistyped character could quietly
  // import a slightly different rule.
  function checksum(bytes) {
    let a = 0;
    let b = 0;
    for (const x of bytes) {
      a = (a + x) % 255;
      b = (b + a) % 255;
    }
    return [a, b];
  }

  // ---------- Compression and text ----------

  async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function inflate(bytes) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PAYLOAD) {
        reader.cancel();
        throw new Error("too large");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  function toBase64Url(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function fromBase64Url(text) {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  // ---------- Cleaning up what comes in ----------

  // Whatever arrives, from a code, JSON or an old export, becomes a valid
  // rule: known choices only, strings where strings belong, fresh local id.
  function clean(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const str = (v, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
    const look = (l) => {
      const d = TR.newLook();
      const x = l && typeof l === "object" ? l : {};
      return {
        style: pick(STYLES, x.style), color: isHex(x.color) ? x.color.toLowerCase() : d.color, text: str(x.text, 12),
        shape: pick(SHAPES, x.shape), position: pick(POSITIONS, x.position), size: pick(SIZES, x.size, "m"),
        outline: pick(OUTLINES, x.outline), outlineColor: isHex(x.outlineColor) ? x.outlineColor.toLowerCase() : d.outlineColor,
        tint: pick(TINTS, x.tint), tintColor: isHex(x.tintColor) ? x.tintColor.toLowerCase() : d.tintColor,
        tintAmount: Number.isFinite(x.tintAmount) ? Math.min(100, Math.max(0, x.tintAmount)) : d.tintAmount,
      };
    };
    const sw = r.badgeSwitch && typeof r.badgeSwitch === "object" ? r.badgeSwitch : {};
    return TR.normalizeRule({
      id: TR.uid(),
      shareId: str(r.shareId, 40) || TR.uid(),
      name: str(r.name, 200) || "Imported rule",
      enabled: r.enabled !== false,
      host: TR.normalizeHost(str(r.host)),
      urlFilter: str(r.urlFilter),
      path: TR.normalizePath(str(r.path, 500)),
      title: str(r.title),
      vars: (Array.isArray(r.vars) ? r.vars : []).slice(0, 50).map((v) => ({
        ...TR.newVar(),
        name: str(v?.name, 60),
        from: pick(SOURCES, v?.from),
        selector: str(v?.selector),
        regex: str(v?.regex),
        required: !!v?.required,
        spaces: !!v?.spaces,
        transform: pick(CASES, v?.transform),
        pick: pick(PICKS, v?.pick),
        nozeros: !!v?.nozeros,
        max: Number.isFinite(v?.max) ? Math.min(500, Math.max(0, Math.floor(v.max))) : 0,
        map: (Array.isArray(v?.map) ? v.map : []).slice(0, 100)
          .filter((m) => m && typeof m === "object")
          .map((m) => ({ from: str(m.from, 200), to: str(m.to, 200) })),
        mapElse: v?.mapElse === "empty" ? "empty" : "keep",
        how: str(v?.how, 80),
      })),
      badge: look(r.badge),
      badgeSwitch: {
        enabled: !!sw.enabled,
        on: str(sw.on, 60),
        cases: (Array.isArray(sw.cases) ? sw.cases : []).slice(0, 50).map((c) => ({
          ...TR.newCase(), op: pick(OPS, c?.op), value: str(c?.value), badge: look(c?.badge),
        })),
      },
    });
  }

  // ---------- Readable JSON ----------

  // Only what differs from a new rule's defaults, so files stay short and
  // easy to read. Local ids and teaching examples are left out.
  function portable(rule) {
    const dropDefaults = (obj, defaults) =>
      Object.fromEntries(Object.entries(obj).filter(([k, v]) => k !== "id" && JSON.stringify(v) !== JSON.stringify(defaults[k])));
    const out = { name: rule.name, host: rule.host, shareId: rule.shareId };
    if (!rule.enabled) out.enabled = false;
    if (rule.path) out.path = rule.path;
    if (rule.urlFilter) out.urlFilter = rule.urlFilter;
    if (rule.title) out.title = rule.title;
    if (rule.vars.length) out.vars = rule.vars.map((v) => dropDefaults(v, { ...TR.newVar(), name: undefined }));
    const badge = dropDefaults(rule.badge, TR.newLook());
    if (Object.keys(badge).length) out.badge = badge;
    const sw = rule.badgeSwitch;
    if (sw.enabled || sw.cases.length || sw.on) {
      out.badgeSwitch = {
        enabled: sw.enabled,
        on: sw.on,
        cases: sw.cases.map((c) => ({ op: c.op, value: c.value, badge: dropDefaults(c.badge, TR.newLook()) })),
      };
    }
    return out;
  }

  function toJSON(rules) {
    return JSON.stringify({ app: "tab-retitler", format: FORMAT, rules: rules.map(portable) }, null, 2);
  }

  // ---------- Public ----------

  async function encode(rules) {
    const w = new Writer();
    w.uint(FORMAT);
    w.uint(rules.length);
    for (const rule of rules) writeRule(w, TR.normalizeRule(rule));
    w.bytes.push(...checksum(w.bytes));
    return PREFIX + toBase64Url(await deflate(new Uint8Array(w.bytes)));
  }

  async function decode(code) {
    let bytes;
    try {
      bytes = await inflate(fromBase64Url(code.slice(PREFIX.length).replace(/\s+/g, "")));
    } catch (e) {
      throw new Error(e.message === "too large" ? "That code is too large to import." : "That code looks incomplete or damaged. Check it was copied in full.");
    }
    try {
      if (bytes.length < 3) throw new Error("ended early");
      const body = bytes.subarray(0, bytes.length - 2);
      const [a, b] = checksum(body);
      if (bytes[bytes.length - 2] !== a || bytes[bytes.length - 1] !== b) throw new Error("checksum");
      const r = new Reader(body);
      const format = r.uint();
      if (format < 1 || format > FORMAT) throw new Error("format");
      const rules = [];
      for (let n = r.uint(); n > 0; n--) rules.push(readRule(r, format));
      if (r.i !== body.length) throw new Error("extra data");
      return rules.map(clean);
    } catch (e) {
      throw new Error(e.message === "format"
        ? "That code was made by a newer version of Tab Retitler. Update the extension, then try again."
        : "That code looks incomplete or damaged. Check it was copied in full.");
    }
  }

  // Reads a share code or JSON: this format, older full exports, or a bare
  // list of rules.
  async function parse(text) {
    const t = String(text ?? "").trim();
    if (!t) return [];
    if (t.startsWith(PREFIX)) return decode(t);
    if (/^TR\d+:/.test(t)) throw new Error("That code was made by a newer version of Tab Retitler. Update the extension, then try again.");
    let data;
    try {
      data = JSON.parse(t);
    } catch {
      throw new Error("That isn't a Tab Retitler code or JSON. Codes start with “TR2:”.");
    }
    const list = Array.isArray(data) ? data : data?.rules;
    if (!Array.isArray(list)) throw new Error("That JSON doesn't contain any Tab Retitler rules.");
    return list.filter((r) => r && typeof r === "object").map(clean);
  }

  // Two rules with the same settings, ignoring local ids and on/off.
  const sameRule = (a, b) => JSON.stringify({ ...portable(a), enabled: 0 }) === JSON.stringify({ ...portable(b), enabled: 0 });

  return { encode, decode, parse, toJSON, portable, sameRule, PREFIX };
})();
