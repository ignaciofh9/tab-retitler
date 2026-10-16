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

// ---------- Which pages a rule is for ----------

const scopes = (name, examples, wantPaths, notCovered = [], covered = []) => {
  console.log(`• ${name}`);
  const r = Infer.fit(examples);
  check(JSON.stringify(r.paths) === JSON.stringify(wantPaths), `pages: ${wantPaths.join("  |  ")}`, `got ${JSON.stringify(r.paths)}`);
  for (const u of notCovered) check(!TR.pathMatches(r.path, new URL(u).pathname), `doesn't cover ${u}`);
  for (const u of covered) check(TR.pathMatches(r.path, new URL(u).pathname), `covers ${u}`);
};

scopes("one pull request", [
  { ...page("https://code.example.com/acme/web/pull/42", "Fix login"), want: "#42 Fix login" },
], ["/acme/web/pull/*", "/*/*/pull/*", "/*/*/pull/**", ""],
["https://code.example.com/acme/web/issues/7", "https://code.example.com/acme/web/pulls"], ["https://code.example.com/acme/web/pull/43"]);

scopes("pull requests in two repositories", [
  { ...page("https://code.example.com/acme/web/pull/42", "Fix login"), want: "#42 Fix login" },
  { ...page("https://code.example.com/globex/api/pull/7", "Add tests"), want: "#7 Add tests" },
], ["/*/*/pull/*", "/*/*/pull/**", ""], ["https://code.example.com/acme/web/issues/7"], ["https://code.example.com/initech/app/pull/1"]);

scopes("tracker tickets", [
  { ...page("https://track.example.com/browse/ABC-12", "Fix login"), want: "12 Fix login" },
], ["/browse/*", "/browse/**", ""], ["https://track.example.com/dashboard"], ["https://track.example.com/browse/WEB-7"]);

scopes("docs at different depths", [
  { ...page("https://docs.example.com/guide/setup", "Setup · Docs"), want: "Setup" },
  { ...page("https://docs.example.com/guide/advanced/caching", "Caching · Docs"), want: "Caching" },
], ["/guide/**", ""], ["https://docs.example.com/blog/news"], ["https://docs.example.com/guide/a/b/c"]);

scopes("value read from a plain word in the path", [
  { ...page("https://shop.example.com/category/lamps", "Shop"), want: "Lamps" },
  { ...page("https://shop.example.com/category/chairs", "Shop"), want: "Chairs" },
], ["/category/*", "/category/**", ""], [], ["https://shop.example.com/category/desks"]);

// ---------- Icons ----------

// The icon a taught rule gives a page, through the real rule engine, the way
// the panel saves it: title values, plus the ones the icon needs.
function iconOn(r, lf, p) {
  const vars = [...r.vars, ...(lf.textVars ?? []), ...(lf.newVar ? [lf.newVar] : [])].map((v) => ({ ...TR.newVar(), ...v }));
  const rule = TR.normalizeRule({
    host: r.host, title: r.title, vars,
    badge: lf.mode === "always" ? lf.look : TR.newLook(),
    badgeSwitch: lf.mode === "switch"
      ? { enabled: true, on: lf.on, cases: lf.cases.map((c) => ({ ...TR.newCase(), value: c.value, badge: c.look })) }
      : { enabled: false, on: "", cases: [] },
  });
  const all = [...p.elements, ...p.styled, ...(p.picked ?? [])];
  const find = (s) => all.find((e) => e.selector === s || e.selectors?.includes(s));
  const res = TR.evaluate(rule, {
    url: p.url, title: p.title,
    elementText: (s) => find(s)?.text ?? null,
    pageText: () => "",
    meta: (k) => p.meta[k] ?? null,
    labelValue: (l) => p.labels.find((x) => x.label.toLowerCase() === l.toLowerCase())?.value ?? null,
    elementColor: (s) => find(s)?.color ?? null,
  });
  return res.matched ? res.badge : "(no match)";
}

function iconTest(name, examples, heldOut, extra) {
  console.log(`• ${name}`);
  const r = Infer.fit(examples);
  const lf = Infer.fitLook(examples, r);
  check(lf && lf.mode !== "unknown", "learns an icon", JSON.stringify(lf));
  if (!lf || lf.mode === "unknown") return;
  for (const [i, ex] of examples.entries()) {
    const seen = (l) => l && JSON.stringify({
      style: l.style, text: l.text, color: l.style !== "none" && l.color,
      outline: l.outline, outlineColor: l.outline !== "none" && l.outlineColor,
    });
    const got = seen(iconOn(r, lf, ex));
    check(got === seen(TR.resolveBadge(ex.look, {})), `example ${i + 1} gets its icon`, `got ${got}`);
  }
  for (const [p, want] of heldOut) {
    const got = iconOn(r, lf, p);
    const ok = Object.entries(want).every(([k, v]) => got?.[k] === v);
    check(ok, `new page gets ${JSON.stringify(want)}`, `got ${JSON.stringify(got && { style: got.style, color: got.color, text: got.text })} from ${JSON.stringify(lf)}`);
  }
  extra?.(lf, r);
}

const pill = (text, color, selector = ".status-pill") => ({ text, selector, selectors: [selector], color, more: [] });
const dot = (color) => TR.newLook({ style: "dot", color });
const RED = "#d93f0b", GREEN = "#1f883d", BLUE = "#0969da";

iconTest("one icon for every tab", [
  { ...page("https://track.example.com/browse/ABC-12", "Fix login"), want: "Fix login", look: dot(TR.COLORS[4]) },
  { ...page("https://track.example.com/browse/ABC-13", "Add tests"), want: "Add tests", look: dot(TR.COLORS[4]) },
], [[page("https://track.example.com/browse/ABC-14", "Docs"), { style: "dot", color: TR.COLORS[4] }]],
(lf) => check(lf.mode === "always" && !lf.colorFrom, "always, with a fixed color"));

iconTest("own colors per status switch on the status", [
  { ...page("https://track.example.com/browse/ABC-12", "Fix login", { styled: [pill("Done", GREEN)] }), want: "Fix login", look: dot(TR.COLORS[0]) },
  { ...page("https://track.example.com/browse/ABC-13", "Add tests", { styled: [pill("In Review", BLUE)] }), want: "Add tests", look: dot(TR.COLORS[2]) },
], [[page("https://track.example.com/browse/ABC-14", "Docs", { styled: [pill("Done", GREEN)] }), { color: TR.COLORS[0] }]],
(lf) => check(lf.mode === "switch" && !lf.colorFrom, "a switch, not page colors", JSON.stringify(lf)));

iconTest("color taken from a label the user chose", [
  { ...page("https://track.example.com/browse/ABC-12", "Fix login", { styled: [pill("In Review", BLUE)] }), want: "Fix login", look: dot(BLUE), hint: ".status-pill" },
], [
  [page("https://track.example.com/browse/ABC-14", "Docs", { styled: [pill("Blocked", RED)] }), { style: "dot", color: RED }],
  [page("https://track.example.com/browse/ABC-15", "No label"), { style: "dot", color: TR.COLORS[7] }],
], (lf) => check(lf.mode === "always" && lf.colorFrom?.selector === ".status-pill", "follows the label's color", JSON.stringify(lf)));

iconTest("colors that follow a label across tabs, without choosing it", [
  { ...page("https://track.example.com/browse/ABC-12", "Fix login", { styled: [pill("Done", GREEN)] }), want: "Fix login", look: dot(GREEN) },
  { ...page("https://track.example.com/browse/ABC-13", "Add tests", { styled: [pill("In Review", BLUE)] }), want: "Add tests", look: dot(BLUE) },
], [[page("https://track.example.com/browse/ABC-14", "Docs", { styled: [pill("Blocked", RED)] }), { color: RED }]],
(lf) => check(lf.mode === "always" && !!lf.colorFrom, "one look with page colors", JSON.stringify(lf)));

iconTest("picked element's color, outline only", [
  { ...page("https://track.example.com/browse/ABC-12", "Fix login", { picked: [pill("P1", RED, "#priority")] }), want: "Fix login",
    look: TR.newLook({ outline: "thin", outlineColor: RED }), hint: "#priority" },
], [[page("https://track.example.com/browse/ABC-14", "Docs", { picked: [pill("P3", BLUE, "#priority")] }), { outline: "thin", outlineColor: BLUE }]]);

iconTest("badge text read from the URL", [
  { ...page("https://track.example.com/browse/ABC-12", "Fix login"), want: "Fix login", look: TR.newLook({ style: "text", text: "12" }) },
  { ...page("https://track.example.com/browse/ABC-7", "Add tests"), want: "Add tests", look: TR.newLook({ style: "text", text: "7" }) },
], [[page("https://track.example.com/browse/ABC-99", "Docs"), { style: "text", text: "99" }]],
(lf) => check(lf.mode === "always" && /^\{\w+\}$/.test(lf.look.text) && lf.textVars.length === 1, "a template with one new value", JSON.stringify(lf)));

iconTest("badge text the title also uses keeps its name", [
  { ...page("https://track.example.com/browse/ABC-12", "Fix login"), want: "12 Fix login", look: TR.newLook({ style: "text", text: "12" }) },
  { ...page("https://track.example.com/browse/ABC-7", "Add tests"), want: "7 Add tests", look: TR.newLook({ style: "text", text: "7" }) },
], [[page("https://track.example.com/browse/ABC-99", "Docs"), { text: "99" }]],
(lf, r) => check(!lf.textVars.length && r.vars.some((v) => `{${v.name}}` === lf.look.text), "reuses the title's value", JSON.stringify(lf)));

iconTest("badge text and color both from the page", [
  { ...page("https://track.example.com/browse/ABC-12", "Fix login", { styled: [pill("P1", RED, ".prio")] }), want: "Fix login", look: TR.newLook({ style: "text", text: "P1", color: RED }) },
  { ...page("https://track.example.com/browse/ABC-13", "Add tests", { styled: [pill("P2", BLUE, ".prio")] }), want: "Add tests", look: TR.newLook({ style: "text", text: "P2", color: BLUE }) },
], [[page("https://track.example.com/browse/ABC-14", "Docs", { styled: [pill("P3", GREEN, ".prio")] }), { text: "P3", color: GREEN }]]);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
