// Share format tests: every setting survives a code and JSON round trip, old
// codes still import, and damaged or hostile input fails cleanly.
//
//   node tests/share.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
globalThis.self = globalThis;
require("../tab-retitler/shared.js");
require("../tab-retitler/share.js");

let failed = 0;
let passed = 0;
const check = (ok, label, detail = "") => {
  if (ok) passed++;
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
};

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const any = (list) => list[Math.floor(rand() * list.length)];
const color = () => (rand() < 0.5 ? any(TR.COLORS) : "#" + Math.floor(rand() * 0xffffff).toString(16).padStart(6, "0"));
const text = () => any(["", "a", "Order #(\\d+)", "ünïcødé ✓", "{num}{? [{status}]}", "x".repeat(150), "emoji 🎉"]);
const look = () => TR.newLook({
  style: any(["none", "dot", "text"]), color: color(), text: any(["", "!", "✓", "NEW"]),
  shape: any(["round", "square", "corner"]), position: any(["br", "bl", "tr", "tl"]), size: any(["s", "m", "l"]),
  outline: any(["none", "thin", "thick"]), outlineColor: color(), tint: any(["none", "color", "gray", "fade"]),
  tintColor: color(), tintAmount: Math.floor(rand() * 101),
});
const randomRule = () => TR.normalizeRule({
  ...TR.newRule(), name: (text() || "Rule").slice(0, 200), enabled: rand() < 0.7,
  host: any(["example.com", "*.example.com", "localhost"]), urlFilter: any(["", "/items/"]), title: text(),
  path: any(["", "/products/*", "/*/*/pull/*", "/guide/**", "/browse/ABC-*"]),
  vars: Array.from({ length: Math.floor(rand() * 4) }, () => ({
    ...TR.newVar(), name: any(["num", "name", "status"]), from: any(TR.SOURCES),
    selector: any(["h1", "og:title", "Status", "jsonld:offers.price"]), regex: text(),
    required: rand() < 0.5, spaces: rand() < 0.5, transform: any(["none", "lower", "upper", "capitalize", "title"]),
    pick: any(TR.PICKS), nozeros: rand() < 0.5, max: any([0, 0, 12, 40]),
    map: rand() < 0.5 ? [] : [{ from: "In Progress", to: "WIP" }, { from: "Done", to: "✓" }],
    mapElse: any(["keep", "empty"]), how: any(["", "segment:-1", "query:id", "split: · :0"]),
  })),
  badge: look(),
  badgeSwitch: rand() < 0.5 ? { enabled: false, on: "", cases: [] } : {
    enabled: rand() < 0.8, on: "status",
    cases: Array.from({ length: Math.floor(rand() * 3) }, () => ({ ...TR.newCase(), op: any(TR.CASE_OPS), value: text(), badge: look() })),
  },
});
// What travels: everything except local ids, and selectors only where used.
const norm = (r) => {
  const p = JSON.parse(JSON.stringify(TR.normalizeRule(r)));
  delete p.id;
  p.vars.forEach((v) => { delete v.id; if (!["element", "meta", "label"].includes(v.from)) v.selector = ""; });
  p.badgeSwitch.cases.forEach((c) => delete c.id);
  return JSON.stringify(p);
};

let mismatches = 0;
for (let n = 0; n < 300; n++) {
  const rules = Array.from({ length: 1 + Math.floor(rand() * 3) }, randomRule);
  const viaCode = await Share.decode(await Share.encode(rules));
  const viaJson = await Share.parse(Share.toJSON(rules));
  rules.forEach((r, i) => {
    if (norm(r) !== norm(viaCode[i])) mismatches++;
    if (norm(r) !== norm(viaJson[i])) mismatches++;
  });
}
check(mismatches === 0, "300 random batches survive code and JSON round trips", `${mismatches} mismatches`);

// A code made by version 0.6.0 (format 2), from before page scopes.
const [v2Rule] = await Share.parse("TR2:Y2Jk5ArOyC9QyCxJzS0WKM7IL9BLrUjMLchJ1UvOz-VIyy0xKirNSeWpLs4urVWozkvMTa1lYi7OLmUx4Moqzs_LSbEqzi7ljYt21I2K1dbViEnR1mRgYGABKWRlYA8oyk8pTS5hYGAUcE8sSknNUyjJz88pVihOLWENAbEYGOb7AAA");
check(v2Rule?.name === "Shop items" && v2Rule.path === "" && v2Rule.vars[0].from === "meta" && v2Rule.vars[0].nozeros
  && v2Rule.vars[1].map[0]?.to === "Tools", "format 2 codes still import", JSON.stringify(v2Rule));

// A code made by the previous version (format 1).
const old = "TR2:Y2Rk5A0pSkzOTi1SKEkszi4WLoHw9FIrEnMLclL1kvNzObKNsywrjBKT-KvzSnNrFQ5tV6jOS8xNrWVizivNdeCL0QdrjdHXiEnR1mQBSTnxZBjqgUR1QTwGhvofAA";
const [oldRule] = await Share.parse(old);
check(oldRule?.name === "Tracker tasks" && oldRule.title === "{num} · {name}" && oldRule.vars.length === 2
  && oldRule.vars[1].selector === "h1.task-name" && oldRule.vars[1].pick === "all", "format 1 codes still import", JSON.stringify(oldRule));

const good = await Share.encode([randomRule()]);
for (const [label, input, want] of [
  ["cut-off code", good.slice(0, -10), /damaged/],
  ["one character changed", good.slice(0, 20) + (good[20] === "A" ? "B" : "A") + good.slice(21), /damaged/],
  ["newer prefix", "TR3:abc", /newer version/],
  ["not a code", "hello", /isn't a Tab Retitler code/],
]) {
  let message = "";
  try { await Share.parse(input); } catch (e) { message = e.message; }
  check(want.test(message), `${label} is refused`, message || "it imported");
}
const hostile = await Share.parse(JSON.stringify({ rules: [{ name: 5, host: "<script>", vars: [{ from: "evil", max: -9, map: "x", pick: "boom" }], badge: { color: "red" } }] }));
check(hostile.length === 1 && hostile[0].vars[0].from === "url" && hostile[0].vars[0].max === 0 && hostile[0].vars[0].pick === "all",
  "hostile JSON is cleaned up", JSON.stringify(hostile[0]?.vars));

let junkOk = 0;
for (let n = 0; n < 500; n++) {
  const junk = "TR2:" + Buffer.from(Array.from({ length: 1 + Math.floor(rand() * 60) }, () => Math.floor(rand() * 256))).toString("base64url");
  try { await Share.parse(junk); junkOk++; } catch (e) { if (/damaged|newer|too large/.test(e.message)) junkOk++; }
}
check(junkOk === 500, "500 random junk codes fail cleanly", `${junkOk}/500`);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
