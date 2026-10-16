// Rule inference tests: each case gives examples (a page and the title wanted
// for it), checks every example comes out right, and checks the rule on
// pages it never saw, to make sure it generalizes rather than memorizes.
//
//   node tests/infer.test.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
globalThis.self = globalThis;
require("../tab-retitler/shared.js");
require("../tab-retitler/infer.js");

let failed = 0;
let passed = 0;
const check = (ok, label, detail = "") => {
  if (ok) passed++;
  else { failed++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
};

const page = (url, title, more = {}) => ({ url, title, elements: [], styled: [], meta: {}, labels: [], ...more });
const el = (text, ...selectors) => ({ text, selector: selectors[0], selectors });

// What a fitted rule gives on a page, using the real rule engine.
function apply(r, p) {
  const rule = TR.normalizeRule({ host: r.host, title: r.title, vars: r.vars.map((v) => ({ ...TR.newVar(), ...v })) });
  const ctx = {
    url: p.url, title: p.title,
    elementText: (s) => [...p.elements, ...p.styled].find((e) => e.selector === s || e.selectors?.includes(s))?.text ?? null,
    pageText: () => "",
    meta: (k) => p.meta[k] ?? null,
    labelValue: (l) => p.labels.find((x) => x.label.toLowerCase() === l.toLowerCase())?.value ?? null,
  };
  const res = TR.evaluate(rule, ctx);
  return res.matched ? res.title : `(no match: ${res.reason})`;
}

function test(name, examples, heldOut = [], extra) {
  console.log(`• ${name}`);
  const r = Infer.fit(examples);
  check(!!r && r.results.every((x) => x.ok), "fits every example",
    r && r.results.map((x, i) => `${x.ok ? "ok" : "BAD"} "${x.got}" (wanted "${examples[i].want}")`).join("; "));
  if (!r) return;
  for (const [p, want] of heldOut) {
    const got = apply(r, p);
    check(got === want, `new page gives "${want}"`, `got "${got}" with ${r.title} ${JSON.stringify(r.vars.map((v) => [v.from, v.selector, v.regex, v.how]))}`);
  }
  extra?.(r);
  return r;
}

// ---------- Generalizing across examples ----------

test("text around a value differs between pages", [
  { ...page("https://track.example.com/browse/ABC-12", "Fix login"), want: "12 Fix login" },
  { ...page("https://track.example.com/issues/WEB-7", "Bump deps"), want: "7 Bump deps" },
], [
  [page("https://track.example.com/tickets/OPS-99", "Write docs"), "99 Write docs"],
]);

test("codes with letters and numbers", [
  { ...page("https://shop.example.com/p/AB12", "Lamp"), want: "AB12 · Lamp" },
  { ...page("https://shop.example.com/p/X9Y", "Chair"), want: "X9Y · Chair" },
], [
  [page("https://shop.example.com/p/ZZ123", "Desk"), "ZZ123 · Desk"],
]);

test("query parameter, in any order", [
  { ...page("https://shop.example.com/item?id=4521&ref=home", "Garden tools – Shop"), want: "4521 · Garden tools" },
  { ...page("https://shop.example.com/item?ref=mail&id=77", "Hose – Shop"), want: "77 · Hose" },
], [
  [page("https://shop.example.com/item?id=5", "Rake – Shop"), "5 · Rake"],
  [page("https://shop.example.com/item?sort=new&id=12&ref=x", "Pots – Shop"), "12 · Pots"],
]);

test("title parts split on a separator", [
  { ...page("https://t.example.com/1", "Fix login · Web app · Tracker"), want: "Web app: Fix login" },
  { ...page("https://t.example.com/2", "Bump deps · Mobile · Tracker"), want: "Mobile: Bump deps" },
], [
  [page("https://t.example.com/3", "Write docs · Public API · Tracker"), "Public API: Write docs"],
]);

test("URL folders counted from the end", [
  { ...page("https://docs.example.com/guide/setup", "Docs"), want: "setup" },
  { ...page("https://docs.example.com/guide/advanced/caching", "Docs"), want: "caching" },
], [
  [page("https://docs.example.com/api/v2/auth/tokens", "Docs"), "tokens"],
]);

test("page metadata", [
  { ...page("https://shop.example.com/a", "Shop – Garden tools set – Free shipping", { meta: { "og:title": "Garden tools set", "jsonld:sku": "GT-1" } }), want: "GT-1 Garden tools set" },
  { ...page("https://shop.example.com/b", "Big sale! Hose", { meta: { "og:title": "Hose", "jsonld:sku": "HS-9" } }), want: "HS-9 Hose" },
], [
  [page("https://shop.example.com/c", "Rakes and more", { meta: { "og:title": "Rake", "jsonld:sku": "RK-3" } }), "RK-3 Rake"],
]);

test("text next to a label, when classes change", [
  { ...page("https://t.example.com/1", "Fix login", { elements: [el("In Review", "div.css-a1b > span")], labels: [{ label: "Status", value: "In Review" }] }), want: "[In Review] Fix login" },
  { ...page("https://t.example.com/2", "Bump deps", { elements: [el("Done", "div.css-z9y > span")], labels: [{ label: "Status", value: "Done" }] }), want: "[Done] Bump deps" },
], [
  [page("https://t.example.com/3", "Write docs", { labels: [{ label: "Status", value: "Blocked" }] }), "[Blocked] Write docs"],
]);

test("element found by a selector shared across pages", [
  { ...page("https://t.example.com/1", "Tracker", { elements: [el("Fix login", "div.css-1x > h1", '[data-testid="name"]')] }), want: "Fix login" },
  { ...page("https://t.example.com/2", "Tracker", { elements: [el("Bump deps", "div.css-9z > h1", '[data-testid="name"]')] }), want: "Bump deps" },
], [
  [page("https://t.example.com/3", "Tracker", { elements: [el("Write docs", '[data-testid="name"]')] }), "Write docs"],
]);

test("leading zeros dropped", [
  { ...page("https://shop.example.com/order/0042", "Order"), want: "Order 42" },
  { ...page("https://shop.example.com/order/0105", "Order"), want: "Order 105" },
], [
  [page("https://shop.example.com/order/0007", "Order"), "Order 7"],
]);

// ---------- Optional parts, lookups, separate rules ----------

test("optional part when a value is missing", [
  { ...page("https://t.example.com/tasks/1", "Fix login", { elements: [el("Fix login", "h1"), el("In Review", "span.status")] }), want: "1 · Fix login [In Review]" },
  { ...page("https://t.example.com/tasks/2", "Bump deps", { elements: [el("Bump deps", "h1")] }), want: "2 · Bump deps" },
], [
  [page("https://t.example.com/tasks/3", "Write docs", { elements: [el("Write docs", "h1"), el("Done", "span.status")] }), "3 · Write docs [Done]"],
  [page("https://t.example.com/tasks/4", "Plan", { elements: [el("Plan", "h1")] }), "4 · Plan"],
], (r) => check(/\{\?/.test(r.title), "template has an optional part", r.title));

test("lookup from a page value", [
  { ...page("https://t.example.com/tasks/1", "Fix login", { elements: [el("Fix login", "h1")], labels: [{ label: "Status", value: "In Progress" }] }), want: "WIP · Fix login" },
  { ...page("https://t.example.com/tasks/2", "Bump deps", { elements: [el("Bump deps", "h1")], labels: [{ label: "Status", value: "Done" }] }), want: "✓ · Bump deps" },
  { ...page("https://t.example.com/tasks/3", "Write docs", { elements: [el("Write docs", "h1")], labels: [{ label: "Status", value: "In Progress" }] }), want: "WIP · Write docs" },
], [
  [page("https://t.example.com/tasks/4", "Plan", { elements: [el("Plan", "h1")], labels: [{ label: "Status", value: "Done" }] }), "✓ · Plan"],
  [page("https://t.example.com/tasks/5", "Ship", { elements: [el("Ship", "h1")], labels: [{ label: "Status", value: "Blocked" }] }), "Blocked · Ship"],
], (r) => check(r.vars.some((v) => v.map.length), "learned a lookup", JSON.stringify(r.vars)));

{
  console.log("• separate rules for different kinds of page");
  const r = Infer.fit([
    { ...page("https://code.example.com/acme/web/pull/42", "Fix login"), want: "PR 42: Fix login" },
    { ...page("https://code.example.com/acme/web/pull/43", "Add tests"), want: "PR 43: Add tests" },
    { ...page("https://code.example.com/acme/web/issues/7", "Crash on start"), want: "Issue 7: Crash on start" },
  ]);
  check(r.count === 0 && r.split?.length === 2, "suggests two rules", JSON.stringify(r.split?.map((g) => [g.filter, g.examples.length])));
  check(r.split?.[0].fit.results.every((x) => x.ok) && r.split?.[1].fit.results.every((x) => x.ok), "each rule fits its examples");
}

// ---------- Earlier behavior still holds ----------

test("number and summary from a tracker", [
  { ...page("https://acme.example.net/browse/ABC-6285", "[ABC-6285] Fix checkout button alignment - Tracker", { elements: [el("Fix checkout button alignment", "h1")] }), want: "6285 · Fix checkout button alignment" },
  { ...page("https://acme.example.net/browse/ABC-17", "[ABC-17] Update copy on pricing page - Tracker", { elements: [el("Update copy on pricing page", "h1")] }), want: "17 · Update copy on pricing page" },
], [
  [page("https://acme.example.net/browse/ABC-900?focus=1", "[ABC-900] Ship it - Tracker", { elements: [el("Ship it", "h1")] }), "900 · Ship it"],
]);

test("slug to Sentence case", [
  { ...page("https://blog.example.com/posts/fix-login-redirect", "Blog"), want: "Fix login redirect" },
], [
  [page("https://blog.example.com/posts/bump-deps-to-latest", "Blog"), "Bump deps to latest"],
]);

test("trailing space in the wanted title", [
  { ...page("https://x.example.com/units/sothe", "Sothe (Unit) · Docs", { elements: [el("Rogue", "a.entity-text")] }), want: "Sothe - Rogue " },
  { ...page("https://x.example.com/units/micaiah", "Micaiah (Unit) · Docs", { elements: [el("Shaman", "a.entity-text")] }), want: "Micaiah - Shaman" },
]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
