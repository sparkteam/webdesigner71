// Local checks for the site Worker (CMS Phase 1). Run from the repo root with wrangler on PATH:  node site-worker/test/check.mjs
// Uses `wrangler dev --local` with a throwaway KV store; never touches production.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const persist = mkdtempSync(join(tmpdir(), "wd71site-"));
const ORIGINAL = readFileSync("public/index.html", "utf8");
const SEED = {
  heroTitle: "আপনার ব্যবসার ওয়েবসাইট, মাত্র", heroHighlight: "৩৯০০ টাকায়",
  heroSub: "ডোমেইন, হোস্টিং, ডিজাইন — সব এক প্যাকেজে", accentColor: "#D4A017",
  updatedAt: "2026-11-01T00:00:00.000Z", updatedBy: "seed", version: 1,
};
const STYLE_DEFAULT = '<style id="wd71-cms">:root{--gold:#D4A017;--gold-2:#E9B930}</style>';

const kv = (...args) => execFileSync("wrangler", ["kv", "key", ...args, "--binding", "CONTENT", "--local", "--persist-to", persist], { stdio: "pipe" });
const putKV = (obj) => { const f = join(persist, "v.json"); writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj)); kv("put", "content:homepage", "--path", f); };
const delKV = () => kv("delete", "content:homepage");

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + String(extra).slice(0, 300)}`); };
const hero = (html) => (html.match(/<h1 id="hero-title">([\s\S]*?)<\/h1>/) || [])[1];
const sub = (html) => (html.match(/<p class="sub" id="hero-sub">([\s\S]*?)<\/p>/) || [])[1];
const get = async (p, h = {}) => { const r = await fetch(BASE + p, { headers: h, redirect: "manual" }); return { r, t: await r.text() }; };

putKV(SEED);
const dev = spawn("wrangler", ["dev", "--local", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persist], { stdio: ["ignore", "pipe", "pipe"], detached: true });
let logs = ""; dev.stdout.on("data", (d) => (logs += d)); dev.stderr.on("data", (d) => (logs += d));

try {
  for (let i = 0; i < 60; i++) { try { await fetch(BASE + "/old-homepage/"); break; } catch {} await new Promise((r) => setTimeout(r, 1000)); }

  // shared mapping
  const block = (s) => (s.match(/\/\* CMS_TARGETS:BEGIN[\s\S]*?CMS_TARGETS:END \*\//) || [""])[0];
  const a = block(readFileSync("site-worker/src/index.js", "utf8")), b = block(readFileSync("public/admin/index.html", "utf8"));
  check("CMS_TARGETS identical in site Worker and admin panel", a && a === b);

  // 1. seeded content: page identical except the injected style tag
  let { r, t } = await get("/");
  check("GET / with seed -> 200", r.status === 200, r.status);
  check("seeded hero title byte-identical", hero(t) === hero(ORIGINAL), hero(t));
  check("seeded sub line byte-identical", sub(t) === sub(ORIGINAL), sub(t));
  check("accent style injected before </head>", t.includes(STYLE_DEFAULT + "</head>"));
  check("whole page = original + style tag only", t === ORIGINAL.replace("</head>", STYLE_DEFAULT + "</head>"));
  check("cache-control must-revalidate, no etag", r.headers.get("cache-control") === "public, max-age=0, must-revalidate" && !r.headers.get("etag"));
  ({ r, t } = await get("/index.html"));
  check("/index.html handled (200 rewritten or redirect to /)", (r.status === 200 && t.includes(STYLE_DEFAULT)) || (r.status >= 300 && r.status < 400), r.status);
  ({ r, t } = await get("/", { "if-none-match": '"anything"', "if-modified-since": new Date().toUTCString() }));
  check("conditional request still gets full rewritten page", r.status === 200 && t.includes(STYLE_DEFAULT));

  // 2. KV change shows
  putKV({ ...SEED, heroTitle: "নতুন <b>শিরোনাম</b> & মূল্য", heroHighlight: "৪৯০০ টাকায়", heroSub: "নতুন সাব-টেক্সট", accentColor: "#0B7A55", version: 2 });
  ({ t } = await get("/"));
  check("KV change -> new title (HTML escaped)", hero(t) === "নতুন &lt;b&gt;শিরোনাম&lt;/b&gt; &amp; মূল্য <em>৪৯০০ টাকায়</em>", hero(t));
  check("KV change -> new sub", sub(t) === "নতুন সাব-টেক্সট", sub(t));
  check("KV change -> new accent + 10% lighter --gold-2", t.includes('<style id="wd71-cms">:root{--gold:#0B7A55;--gold-2:#238766}</style>'), (t.match(/<style id="wd71-cms">[^<]*<\/style>/) || [])[0]);
  putKV({ ...SEED, heroHighlight: "", version: 3 });
  ({ t } = await get("/"));
  check("empty highlight -> no <em>", hero(t) === SEED.heroTitle, hero(t));

  // 3. preview ignores KV
  ({ r, t } = await get("/?cms_preview=1"));
  check("cms_preview=1 ignores KV (original hero)", hero(t) === hero(ORIGINAL) && !t.includes("wd71-cms"));
  check("cms_preview=1 adds noindex meta + no-store", t.includes('<meta name="robots" content="noindex"></head>') && r.headers.get("cache-control") === "no-store");
  check("cms_preview=1 page = original + noindex only", t === ORIGINAL.replace("</head>", '<meta name="robots" content="noindex"></head>'));

  // 4. fail-safe
  putKV({ ...SEED, accentColor: "red;}body{display:none" });
  ({ t } = await get("/"));
  check("invalid KV data -> original page", t === ORIGINAL);
  putKV("not json{");
  ({ r, t } = await get("/"));
  check("corrupt KV value -> original page", r.status === 200 && t === ORIGINAL);
  delKV();
  ({ r, t } = await get("/"));
  check("deleted key -> original page byte-identical", r.status === 200 && t === ORIGINAL);

  // 5. other paths untouched
  for (const [p, f] of [["/admin/", "public/admin/index.html"], ["/old-homepage/", "public/old-homepage/index.html"], ["/old-homepage/style.css", "public/old-homepage/style.css"], ["/old-homepage/script.js", "public/old-homepage/script.js"], ["/CNAME", "public/CNAME"]]) {
    ({ r, t } = await get(p));
    check(`${p} -> 200, identical to file`, r.status === 200 && t === readFileSync(f, "utf8"), r.status);
  }
  for (const p of ["/wrangler.jsonc", "/.gitignore", "/docs/cms-phase1.md", "/admin-worker/src/index.js", "/admin-worker/wrangler.jsonc", "/site-worker/src/index.js", "/public/index.html"]) {
    ({ r } = await get(p));
    check(`${p} -> 404`, r.status === 404, r.status);
  }
  putKV(SEED);
} catch (e) {
  fail++; console.error("ERROR", e, logs.slice(-1500));
} finally {
  try { process.kill(-dev.pid, "SIGTERM"); } catch {}
  setTimeout(() => { rmSync(persist, { recursive: true, force: true }); console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, 500);
}
